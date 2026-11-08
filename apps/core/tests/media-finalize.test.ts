import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestHash } from '../src/db/request-keys';
import { ProjectMediaService } from '../src/lab/project-media.service';

/**
 * Подтверждение загрузки медиа проекта (2.6, пакет 7): исходник удаляется только после
 * фиксации; отказ фиксации после подготовки файлов оставляет повтору исходный файл;
 * повтор завершённой операции возвращает результат без повторной обработки.
 *
 * Настоящий `ProjectMediaService`; подставлены БД (транзакция с откатом и ключом повтора)
 * и хранилище.
 */
const puts: string[] = [];
vi.mock('../src/storage/s3.service', () => ({
  S3Service: class {},
  putObject: vi.fn(async ({ key }: { key: string }) => {
    puts.push(key);
  }),
}));

const PROJECT = '01a1bb00-0000-7000-8000-000000000001';
const UPLOAD = '01a1bb00-0000-7000-8000-0000000000aa';
const KEY = `media-${UPLOAD}`;
let image: Buffer;

/** Хранилище: временная точка загрузки и учёт удалений. */
function fakeS3() {
  const objects = new Map<string, Buffer>();
  const deleted: string[] = [];
  return {
    objects,
    deleted,
    s3: {
      isConfigured: true,
      getObject: vi.fn(async (key: string) =>
        objects.has(key) ? { body: objects.get(key)!, contentType: 'image/png' } : null,
      ),
      deleteObject: vi.fn(async (key: string) => {
        deleted.push(key);
        objects.delete(key);
      }),
    },
  };
}

/**
 * БД: зафиксированное переживает транзакцию только при успешной фиксации. `failCommit` —
 * отказ на фиксации после всей работы (как обрыв соединения на COMMIT).
 */
function fakeDb() {
  const committed = {
    keys: new Map<string, string>(),
    media: null as null | Record<string, unknown>,
  };
  let failCommit = false;
  const db = {
    setFailCommit: (v: boolean) => (failCommit = v),
    committed,
    readOnly: async (_c: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx(committed, { keys: new Map(), media: undefined })),
    transaction: async (_c: unknown, fn: (tx: unknown) => unknown) => {
      const pending = {
        keys: new Map<string, string>(),
        media: undefined as undefined | Record<string, unknown>,
      };
      const result = await fn(tx(committed, pending));
      if (failCommit) throw new Error('соединение потеряно на COMMIT');
      for (const [k, v] of pending.keys) committed.keys.set(k, v);
      if (pending.media) committed.media = pending.media;
      return result;
    },
  };
  return db;
}
function tx(
  committed: { keys: Map<string, string>; media: null | Record<string, unknown> },
  pending: { keys: Map<string, string>; media: undefined | Record<string, unknown> },
) {
  return {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('SHOW lock_timeout')) return { rows: [{ lock_timeout: '0' }] };
      if (sql.includes('can_edit')) return { rows: [{ can_edit: true }] };
      if (sql.includes('INSERT INTO requests.idempotency_keys')) {
        const key = String(params[1]);
        if (committed.keys.has(key)) return { rowCount: 0, rows: [] };
        pending.keys.set(key, String(params[4]));
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('FROM requests.idempotency_keys')) {
        return {
          rows: [
            {
              object_id: PROJECT,
              request_hash: requestHash({
                operation: 'lab.media.finalize',
                objectId: PROJECT,
                payload: { kind: 'logo', uploadId: UPLOAD, focusX: 0.5, focusY: 0.5 },
              }),
              result_id: committed.keys.get(String(params[1])),
              expired: false,
            },
          ],
        };
      }
      if (sql.includes('INSERT INTO lab.project_media')) {
        pending.media = {
          kind: 'logo',
          master_key: params[3],
          variants: JSON.parse(String(params[4])),
          mime: params[5],
          bytes: params[6],
          width: params[7],
          height: params[8],
          focus_x: params[9],
          focus_y: params[10],
          updated_at: new Date(),
        };
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('FROM lab.project_media')) {
        const row = pending.media ?? committed.media;
        return { rows: row ? [row] : [] };
      }
      return { rowCount: 1, rows: [] };
    }),
  };
}

beforeEach(async () => {
  puts.length = 0;
  image ??= await sharp({
    create: { width: 300, height: 300, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
});

const make = (db: ReturnType<typeof fakeDb>, s3: ReturnType<typeof fakeS3>['s3']) =>
  new ProjectMediaService(
    db as never,
    { emit: vi.fn(async () => undefined) } as never,
    s3 as never,
  );
const input = { uploadId: UPLOAD, focusX: 0.5, focusY: 0.5 };
const ctx = { userId: 'u1', roles: ['founder'], traceId: 't' };
const source = `projects/${PROJECT}/media/logo/upload/${UPLOAD}`;

describe('Подтверждение медиа проекта', () => {
  it('отказ фиксации после подготовки файлов — исходник остаётся, повтор проходит', async () => {
    const db = fakeDb();
    const store = fakeS3();
    store.objects.set(source, image);
    const svc = make(db, store.s3);

    db.setFailCommit(true);
    await expect(svc.finalize(ctx as never, PROJECT, 'logo', input, KEY)).rejects.toThrow(/COMMIT/);
    expect(puts.length).toBeGreaterThan(0);
    expect(store.deleted).not.toContain(source);
    expect(store.objects.has(source)).toBe(true);
    expect(db.committed.keys.size).toBe(0);

    db.setFailCommit(false);
    const media = await svc.finalize(ctx as never, PROJECT, 'logo', input, KEY);
    expect(media.width).toBe(300);
    expect(store.deleted).toContain(source);
    expect(db.committed.keys.get(KEY)).toBeTruthy();
  });

  it('повтор завершённой операции — прежний результат без повторной обработки', async () => {
    const db = fakeDb();
    const store = fakeS3();
    store.objects.set(source, image);
    const svc = make(db, store.s3);
    const first = await svc.finalize(ctx as never, PROJECT, 'logo', input, KEY);
    const reads = store.s3.getObject.mock.calls.length;
    const written = puts.length;

    const again = await svc.finalize(ctx as never, PROJECT, 'logo', input, KEY);
    expect(again).toEqual(first);
    expect(store.s3.getObject.mock.calls.length).toBe(reads);
    expect(puts.length).toBe(written);
  });

  it('повтор прежней загрузки не разбирает файл следующей', async () => {
    const db = fakeDb();
    const store = fakeS3();
    store.objects.set(source, image);
    const svc = make(db, store.s3);
    await svc.finalize(ctx as never, PROJECT, 'logo', input, KEY);
    // Новая загрузка — своя временная точка; прежний повтор её не читает.
    const nextSource = `projects/${PROJECT}/media/logo/upload/01a1bb00-0000-7000-8000-0000000000bb`;
    store.objects.set(nextSource, image);
    await svc.finalize(ctx as never, PROJECT, 'logo', input, KEY);
    expect(store.s3.getObject.mock.calls.map((c) => c[0])).not.toContain(nextSource);
    expect(store.objects.has(nextSource)).toBe(true);
  });
});
