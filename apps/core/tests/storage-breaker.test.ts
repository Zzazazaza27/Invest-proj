import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '../src/config/env';
import { resetStorageBreaker, storageBreaker } from '../src/availability/storage-health';
import {
  AvailabilityService,
  READ_CONTROL_BODY,
  READ_CONTROL_KEY,
} from '../src/availability/availability.service';
import { S3Service, putObject } from '../src/storage/s3.service';

/**
 * Размыкатель «Файлов» видит все обращения к хранилищу (4.11, замечания Тэнка 08.11):
 * настоящие методы S3Service, хранилище подменено заглушкой fetch. И проба чтения
 * подтверждает чтение только известным содержимым контрольного объекта.
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
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'unicorn-launch',
  S3_ACCESS_KEY_ID: 'probe',
  S3_SECRET_ACCESS_KEY: 'probe-secret',
  S3_FORCE_PATH_STYLE: 'true',
};
const saved = { ...process.env };

/** Тело, которое обрывается после заголовков 200. */
const brokenBody = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(new Error('соединение сброшено'));
      },
    }),
    { status: 200 },
  );

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetEnvCache();
  process.env = { ...ENV };
  resetStorageBreaker();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...saved };
  resetEnvCache();
  resetStorageBreaker();
});

const s3 = new S3Service();
const thrice = async (fn: () => Promise<unknown>) => {
  for (let i = 0; i < 3; i += 1) await fn().catch(() => undefined);
};

describe('Размыкатель видит все пути чтения', () => {
  it.each([
    ['headObject', () => s3.headObject('k')],
    ['getObject', () => s3.getObject('k')],
    ['getObjectDigest', () => s3.getObjectDigest('k')],
  ])('%s: три ответа 500 размыкают чтение, запись не затронута', async (_name, call) => {
    fetchMock.mockImplementation(async () => new Response('x', { status: 500 }));
    await thrice(call);
    expect(storageBreaker().isOpen('read')).toBe(true);
    expect(storageBreaker().isOpen('write')).toBe(false);
  });

  it.each([
    ['getObject', () => s3.getObject('k')],
    ['getObjectDigest', () => s3.getObjectDigest('k')],
    ['readObjectDigest', () => s3.readObjectDigest('k', { idleMs: 1000, totalMs: 5000 })],
  ])('%s: обрыв тела после 200 — отказ, а не успех', async (_name, call) => {
    fetchMock.mockImplementation(async () => brokenBody());
    await thrice(call);
    expect(storageBreaker().isOpen('read')).toBe(true);
  });

  it('сетевой отказ HEAD считается; 404 — нет', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));
    await thrice(() => s3.headObject('k'));
    expect(storageBreaker().isOpen('read')).toBe(false);
    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    await thrice(() => s3.headObject('k'));
    expect(storageBreaker().isOpen('read')).toBe(true);
  });

  it('остановка вызывающим не считается отказом хранилища', async () => {
    const stop = new AbortController();
    stop.abort();
    fetchMock.mockImplementation(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    await thrice(() =>
      s3.readObjectDigest('k', { idleMs: 1000, totalMs: 5000, signal: stop.signal }),
    );
    expect(storageBreaker().isOpen('read')).toBe(false);
  });
});

describe('Размыкатель видит все пути записи', () => {
  it('deleteObject: три ответа 500 размыкают запись, чтение не затронуто', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 500 }));
    await thrice(() => s3.deleteObject('k'));
    expect(storageBreaker().isOpen('write')).toBe(true);
    expect(storageBreaker().isOpen('read')).toBe(false);
  });

  it('putObject (медиа и аватары): три ответа 503 размыкают запись', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 503 }));
    await thrice(() => putObject({ key: 'k', body: Buffer.from('x'), contentType: 'image/webp' }));
    expect(storageBreaker().isOpen('write')).toBe(true);
  });

  it('copyObject: обрыв тела ответа — отказ записи', async () => {
    fetchMock.mockImplementation(async () => brokenBody());
    await thrice(() => s3.copyObject({ sourceKey: 'a', destinationKey: 'b', timeoutMs: 1000 }));
    expect(storageBreaker().isOpen('write')).toBe(true);
  });
});

describe('Проба чтения подтверждает чтение содержимым', () => {
  type Store = Map<string, Buffer>;
  const storageFetch = (store: Store, opts: { denyWrite?: boolean } = {}) =>
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const key = decodeURIComponent(new URL(url).pathname.replace('/unicorn-launch/', ''));
      if (init.method === 'PUT') {
        if (opts.denyWrite) return new Response(null, { status: 403 });
        store.set(key, Buffer.from(init.body as Uint8Array));
        return new Response(null, { status: 200 });
      }
      const value = store.get(key);
      return value ? new Response(new Uint8Array(value)) : new Response(null, { status: 404 });
    });

  function service() {
    const tx = { query: vi.fn(async () => ({ rows: [] })) };
    const db = {
      transaction: vi.fn(async (_c: unknown, fn: (t: typeof tx) => unknown) => fn(tx)),
      readOnly: vi.fn(async (_c: unknown, fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const jobs = { instanceId: 'core-test', register: vi.fn() };
    return new AvailabilityService(db as any, s3, jobs as any, {} as any);
  }
  const puts = () =>
    fetchMock.mock.calls.filter(
      ([u, i]) => i.method === 'PUT' && String(u).includes('read-control'),
    );

  it('объекта нет — готовится один раз и перечитывается; дальше записи нет', async () => {
    const store: Store = new Map();
    storageFetch(store);
    const svc = service();
    await svc.observe();
    expect((await svc.localStatus()).read).toMatchObject({ allowed: true, reason: 'ok' });
    expect(puts()).toHaveLength(1);
    await svc.observe();
    await svc.observe();
    expect(puts()).toHaveLength(1);
  });

  it('объекта нет и подготовить нельзя — чтение не подтверждено', async () => {
    storageFetch(new Map(), { denyWrite: true });
    const svc = service();
    await svc.observe();
    expect((await svc.localStatus()).read).toMatchObject({
      allowed: false,
      reason: 'dependency_failure',
    });
  });

  it('содержимое не совпало — отказ чтения', async () => {
    storageFetch(new Map([[READ_CONTROL_KEY, Buffer.from('чужое')]]));
    const svc = service();
    await svc.observe();
    expect((await svc.localStatus()).read.allowed).toBe(false);
  });

  it('совпало — исправно, без записи контрольного объекта', async () => {
    storageFetch(new Map([[READ_CONTROL_KEY, READ_CONTROL_BODY]]));
    const svc = service();
    await svc.observe();
    expect((await svc.localStatus()).read.allowed).toBe(true);
    expect(puts()).toHaveLength(0);
  });
});
