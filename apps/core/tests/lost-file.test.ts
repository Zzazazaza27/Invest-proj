import { describe, expect, it, vi } from 'vitest';
import { ProjectsService } from '../src/lab/projects.service';
import { AppError } from '../src/common/errors';

/**
 * Утрата готового файла (3.2, работа № 7): только ответ «нет объекта» по ключу видимой готовой
 * записи — утрата; отказ хранилища утратой не считается и в учёт не попадает.
 */
const PROJECT = '01a00000-0000-7000-8000-000000000001';
const MATERIAL = '01a00000-0000-7000-8000-000000000002';
const ctx = { userId: 'u', roles: ['founder'], traceId: 't' } as never;

function setup(opts: {
  keys: string[];
  objects: Record<string, Buffer | null | Error>;
  report?: Array<'opened' | 'repeated' | 'stale' | Error>;
}) {
  const keys = [...opts.keys];
  const reports = [...(opts.report ?? [])];
  const asServiceRole = vi.fn(
    async (_role: string, _c: unknown, work: (tx: unknown) => unknown) => {
      const next = reports.shift();
      if (next instanceof Error) throw next;
      return work({ query: async () => ({ rows: [{ r: next }] }) });
    },
  );
  const db = {
    readOnly: async (_c: unknown, work: (tx: unknown) => unknown) =>
      work({ query: async () => ({ rows: [{ s3_key: keys.shift() ?? null, type: 'deck' }] }) }),
    asServiceRole,
  };
  const s3 = {
    getObject: vi.fn(async (key: string) => {
      const o = opts.objects[key];
      if (o instanceof Error) throw o;
      return o ? { body: o, contentType: 'application/pdf' } : null;
    }),
  };
  const service = new ProjectsService(db as never, {} as never, s3 as never, {} as never);
  return { service, asServiceRole, s3 };
}

describe('утрата готового файла (работа № 7)', () => {
  it('отказ хранилища — не утрата: ошибка как есть, учёта нет', async () => {
    const { service, asServiceRole } = setup({
      keys: ['k1'],
      objects: { k1: new Error('хранилище ответило 503 на GET') },
    });
    await expect(service.getMaterialContent(ctx, PROJECT, MATERIAL)).rejects.toThrow('503');
    expect(asServiceRole).not.toHaveBeenCalled();
  });

  it('объекта нет — 500 stored_file_missing и учёт служебной ролью', async () => {
    const { service, asServiceRole } = setup({
      keys: ['k1'],
      objects: { k1: null },
      report: ['opened'],
    });
    const error = await service.getMaterialContent(ctx, PROJECT, MATERIAL).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('stored_file_missing');
    expect(error.status).toBe(500);
    expect(asServiceRole).toHaveBeenCalledTimes(1);
    expect(asServiceRole.mock.calls[0]![0]).toBe('app_maintenance');
  });

  it('ключ уже сменился (stale) — одно повторное чтение отдаёт восстановленный файл', async () => {
    const { service, asServiceRole } = setup({
      keys: ['old', 'new'],
      objects: { old: null, new: Buffer.from('%PDF') },
      report: ['stale'],
    });
    const file = await service.getMaterialContent(ctx, PROJECT, MATERIAL);
    expect(file.body.toString()).toBe('%PDF');
    expect(asServiceRole).toHaveBeenCalledTimes(1);
  });

  it('учёт не записался — всё равно техническая ошибка, не 404', async () => {
    const { service } = setup({
      keys: ['k1'],
      objects: { k1: null },
      report: [new Error('база недоступна')],
    });
    const error = await service.getMaterialContent(ctx, PROJECT, MATERIAL).catch((e) => e);
    expect(error.code).toBe('stored_file_missing');
  });
});
