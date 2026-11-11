import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '../src/config/env';
import { UploadCopyCleanupService } from '../src/lab/upload-copy-cleanup.service';

/**
 * Очистка служебных копий (3.3, работа № 8): удаление — внутри транзакции claim; ошибка
 * хранилища отмечается и не считается удалением; отложенный материал не трогается.
 */
const ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://app:pw@localhost:5433/db',
  AUTH_MODE: 'local',
  LOCAL_AUTH_SIGNING_KEY: 'k'.repeat(64),
  CSRF_SIGNING_KEY: 'c'.repeat(64),
  KMS_MODE: 'local',
  KEK_SEARCH_INDEX: Buffer.alloc(32, 7).toString('base64'),
  KEK_PASSPORT_SENSITIVE: Buffer.alloc(32, 8).toString('base64'),
  KEK_KYB_DOCUMENTS: Buffer.alloc(32, 9).toString('base64'),
  KEK_WEBHOOK_SECRETS: Buffer.alloc(32, 11).toString('base64'),
};
const saved = { ...process.env };
beforeEach(() => {
  process.env = { ...saved, ...ENV };
  resetEnvCache();
});
afterEach(() => {
  process.env = saved;
  resetEnvCache();
});

function setup(claims: Record<string, Array<Record<string, string | null>>>, fail: string[] = []) {
  const events: string[] = [];
  const done: Array<{ id: string; results: Array<{ ok: boolean; error?: string }> }> = [];
  const db = {
    asServiceRole: async (_r: string, _c: unknown, work: (tx: unknown) => unknown) => {
      events.push('begin');
      const tx = {
        query: async (sql: string, params: unknown[]) => {
          if (sql.includes('upload_cleanup_candidates')) {
            return { rows: Object.keys(claims).map((id) => ({ id })) };
          }
          if (sql.includes('upload_cleanup_claim')) {
            events.push(`claim ${params[0]}`);
            return { rows: claims[params[0] as string] };
          }
          if (sql.includes('upload_cleanup_done')) {
            events.push(`done ${params[0]}`);
            done.push({ id: params[0] as string, results: JSON.parse(params[1] as string) });
            return { rows: [] };
          }
          throw new Error(`неожиданный запрос ${sql}`);
        },
      };
      const r = await work(tx);
      events.push('commit');
      return r;
    },
  };
  const s3 = {
    isConfigured: true,
    deleteObject: vi.fn(async (key: string) => {
      events.push(`delete ${key}`);
      if (fail.includes(key)) throw new Error('хранилище ответило 503 на DELETE');
    }),
  };
  const service = new UploadCopyCleanupService(db as never, s3 as never, {} as never);
  return { service, events, done, s3 };
}

describe('очистка служебных копий (работа № 8)', () => {
  it('удаление внутри транзакции claim, отметка той же транзакцией', async () => {
    const { service, events, done } = setup({
      m1: [
        { target: 'upload', ref: 'm1', object_key: 'p/m1/upload', defer_reason: null },
        { target: 'attempt', ref: 'a1', object_key: 'p/m1/final/a1', defer_reason: null },
      ],
    });
    const r = await service.pass(new AbortController().signal);
    expect(r).toEqual({ deleted: 2, deferred: 0, failed: 0 });
    const i = events.indexOf('claim m1');
    expect(events.slice(i, i + 5)).toEqual([
      'claim m1',
      'delete p/m1/upload',
      'delete p/m1/final/a1',
      'done m1',
      'commit',
    ]);
    expect(done[0]!.results.every((x) => x.ok)).toBe(true);
  });

  it('отложенный материал: ни удаления, ни отметки', async () => {
    const { service, s3, done } = setup({
      m1: [{ target: null, ref: 'm1', object_key: null, defer_reason: 'запрет очистки' }],
    });
    const r = await service.pass(new AbortController().signal);
    expect(r).toEqual({ deleted: 0, deferred: 1, failed: 0 });
    expect(s3.deleteObject).not.toHaveBeenCalled();
    expect(done).toHaveLength(0);
  });

  it('ошибка хранилища: ключ отмечен ошибкой, не удалением; остальные — дальше', async () => {
    const { service, done } = setup(
      {
        m1: [
          { target: 'attempt', ref: 'a1', object_key: 'bad', defer_reason: null },
          { target: 'attempt', ref: 'a2', object_key: 'good', defer_reason: null },
        ],
      },
      ['bad'],
    );
    const r = await service.pass(new AbortController().signal);
    expect(r).toEqual({ deleted: 1, deferred: 0, failed: 1 });
    expect(done[0]!.results[0]).toMatchObject({ ok: false });
    expect(done[0]!.results[0]!.error).toContain('503');
    expect(done[0]!.results[1]).toMatchObject({ ok: true });
  });
});
