import { describe, expect, it } from 'vitest';
import {
  UploadCompletion,
  type UploadRow,
  type UploadTarget,
} from '../src/storage/upload-completion';

/**
 * Прерывание общей функции завершения загрузки (2.1-W03, замечания Тэнка).
 *
 * Подменены БД и хранилище: так прерывание можно подать в точный момент —
 * во время ожидания соединения перед публикацией или до обращения к
 * хранилищу. Настоящие БД и MinIO — прогон `scripts/probe-upload-completion.mjs`.
 */

function baseRow(): UploadRow {
  return {
    id: 'm1',
    project_id: 'p1',
    type: 'deck',
    uploaded_by: 'u1',
    upload_state: 'pending',
    upload_state_reason: null,
    upload_key: 'projects/p1/materials/deck/m1/upload',
    upload_expires_at: new Date(Date.now() + 600_000),
    upload_max_bytes: '1000',
    object_received_at: null,
    not_received_at: null,
    s3_key: null,
    size_bytes: null,
    content_hash: null,
    check_failures: 0,
    unknown_since: null,
  };
}

/**
 * БД-подделка: запоминает запросы. `beforeWork(n)` вызывается при n-м
 * получении «соединения» — до начала работы транзакции.
 */
function fakeDb(beforeWork: (call: number) => void = () => undefined) {
  const queries: string[] = [];
  let calls = 0;
  const tx = {
    async query(sql: string) {
      queries.push(sql);
      if (/RETURNING t\.id/.test(sql)) return { rows: [{ id: 'm1' }], rowCount: 1 };
      if (/^\s*SELECT id, project_id/.test(sql)) return { rows: [baseRow()], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  const db = {
    async asServiceRole(_role: string, _ctx: unknown, work: (t: typeof tx) => Promise<unknown>) {
      calls += 1;
      beforeWork(calls);
      return work(tx);
    },
  };
  return { db, queries };
}

function fakeS3(options: { onHead?: () => Promise<void> } = {}) {
  const calls = { head: 0, copy: 0, read: 0 };
  const s3 = {
    async headObject() {
      calls.head += 1;
      await options.onHead?.();
      return { exists: true, sizeBytes: 10, etag: null };
    },
    async copyObject() {
      calls.copy += 1;
    },
    async readObjectDigest() {
      calls.read += 1;
      return { exists: true, sizeBytes: 10, sha256: 'ab', head: Buffer.from('%PDF-') };
    },
  };
  return { s3, calls };
}

const target: UploadTarget = {
  table: 'lab.project_materials',
  attemptsTable: 'lab.material_upload_attempts',
  finalKey: (_row, attemptId) => `final/${attemptId}`,
  validate: () => null,
  contentType: () => 'application/pdf',
  emitPublished: async () => undefined,
};

const failureWrites = (queries: string[]) => queries.filter((q) => /check_failures = \$1/.test(q));
const publishWrites = (queries: string[]) =>
  queries.filter((q) => /upload_state = 'ready'/.test(q));

describe('завершение загрузки: прерывание — не техническая неудача', () => {
  it('без прерывания файл публикуется', async () => {
    const { db, queries } = fakeDb();
    const { s3 } = fakeS3();
    const completion = new UploadCompletion(db as never, s3 as never, target);
    const outcome = await completion.complete('m1', {
      executor: 'reconcile',
      actorId: null,
      traceId: 't',
    });
    expect(outcome.state).toBe('ready');
    expect(publishWrites(queries)).toHaveLength(1);
  });

  it('остановка до обращения к хранилищу: HEAD нет, неудача не записана', async () => {
    const stop = new AbortController();
    // 1 — захват аренды, 2 — чтение строки: остановка приходит между ними.
    const { db, queries } = fakeDb((call) => {
      if (call === 2) stop.abort(new Error('остановка'));
    });
    const { s3, calls } = fakeS3();
    const completion = new UploadCompletion(db as never, s3 as never, target);
    const outcome = await completion.complete('m1', {
      executor: 'reconcile',
      actorId: null,
      traceId: 't',
      signal: stop.signal,
    });
    expect(calls.head).toBe(0);
    expect(failureWrites(queries)).toHaveLength(0);
    expect(outcome.state).toBe('pending');
  });

  it('сигнал прерван ещё до вызова: аренда не захватывается, записей нет', async () => {
    const stop = new AbortController();
    stop.abort(new Error('остановка'));
    const { db, queries } = fakeDb();
    const { s3, calls } = fakeS3();
    const completion = new UploadCompletion(db as never, s3 as never, target);
    const outcome = await completion.complete('m1', {
      executor: 'reconcile',
      actorId: null,
      traceId: 't',
      signal: stop.signal,
    });
    expect(calls.head).toBe(0);
    expect(queries.filter((q) => /RETURNING t\.id/.test(q))).toHaveLength(0);
    expect(failureWrites(queries)).toHaveLength(0);
    expect(outcome.state).toBe('pending');
  });

  it('остановка во время HEAD: неудача не записана, отсчёт неизвестности не начат', async () => {
    const stop = new AbortController();
    const { db, queries } = fakeDb();
    const { s3, calls } = fakeS3({
      onHead: async () => {
        stop.abort(new Error('остановка'));
        throw new DOMException('aborted', 'AbortError');
      },
    });
    const completion = new UploadCompletion(db as never, s3 as never, target);
    const outcome = await completion.complete('m1', {
      executor: 'reconcile',
      actorId: null,
      traceId: 't',
      signal: stop.signal,
    });
    expect(calls.head).toBe(1);
    expect(failureWrites(queries)).toHaveLength(0);
    expect(queries.some((q) => /unknown_since/.test(q) && /UPDATE/.test(q))).toBe(false);
    expect(outcome.state).toBe('pending');
  });

  it('остановка во время ожидания соединения перед публикацией: не опубликовано', async () => {
    const stop = new AbortController();
    // 1 — захват, 2 — чтение строки, 3 — попытка, 4 — отметка копии,
    // 5 — публикация: остановка приходит, пока ждём её соединение.
    const { db, queries } = fakeDb((call) => {
      if (call === 5) stop.abort(new Error('остановка'));
    });
    const { s3, calls } = fakeS3();
    const completion = new UploadCompletion(db as never, s3 as never, target);
    const outcome = await completion.complete('m1', {
      executor: 'reconcile',
      actorId: null,
      traceId: 't',
      signal: stop.signal,
    });
    expect(calls.read).toBe(1);
    expect(publishWrites(queries)).toHaveLength(0);
    expect(failureWrites(queries)).toHaveLength(0);
    expect(outcome.state).not.toBe('ready');
  });

  it('техническая ошибка без прерывания записывается как неудача', async () => {
    const { db, queries } = fakeDb();
    const { s3 } = fakeS3({
      onHead: async () => {
        throw new Error('хранилище ответило 500 на HEAD');
      },
    });
    const completion = new UploadCompletion(db as never, s3 as never, target);
    const outcome = await completion.complete('m1', {
      executor: 'reconcile',
      actorId: null,
      traceId: 't',
    });
    expect(failureWrites(queries)).toHaveLength(1);
    expect(outcome.state).toBe('pending');
  });
});
