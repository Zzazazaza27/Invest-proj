import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../src/config/env';
import {
  checkReadiness,
  runControl,
  type Lifecycle,
  type ReadinessProbes,
} from '../src/background/readiness';
import { createShutdown } from '../src/background/shutdown';

/**
 * Готовность по правилу блока 4.9 (2.1-W08a, замечания Тэнка): общая
 * готовность — завершён запуск, основная БД и обязательные счётчики;
 * хранилище и NATS видны отдельно и её не снимают; при остановке готовность
 * снимается первой. Контрольная операция — запись и файл со сверкой.
 */

const BASE_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://app:pw@localhost:5433/db',
  AUTH_MODE: 'local',
  LOCAL_AUTH_SIGNING_KEY: 'k'.repeat(64),
  CSRF_SIGNING_KEY: 'c'.repeat(64),
  KMS_MODE: 'local',
  KEK_SEARCH_INDEX: Buffer.alloc(32, 7).toString('base64'),
  KEK_PASSPORT_SENSITIVE: Buffer.alloc(32, 8).toString('base64'),
  KEK_KYB_DOCUMENTS: Buffer.alloc(32, 9).toString('base64'),
  KEK_WEBHOOK_SECRETS: Buffer.alloc(32, 11).toString('base64'),
  READINESS_CHECK_TIMEOUT_MS: '300',
};
const saved = { ...process.env };
beforeEach(() => {
  process.env = { ...BASE_ENV };
  resetEnvCache();
});
afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
});

const probes = (over: Partial<ReadinessProbes> = {}): ReadinessProbes => ({
  lifecycle: (): Lifecycle => 'running',
  database: async () => true,
  valkey: async () => true,
  storage: async () => true,
  nats: async () => true,
  background: () => ({ required: true, running: true }),
  queues: async () => ({}),
  control: async () => ({ ok: true, record: 'ok', file: 'ok', ms: 0 }),
  ...over,
});

describe('Общая готовность (4.9)', () => {
  it('всё в порядке — готово', async () => {
    const r = await checkReadiness(probes());
    expect(r.ready).toBe(true);
    expect(r.required).toEqual({ database: 'ok', valkey: 'ok' });
    expect(r.functions).toEqual({ storage: 'ok', nats: 'ok' });
  });

  it('отказ хранилища или NATS — общая готовность остаётся, отказ виден отдельно', async () => {
    const r = await checkReadiness(probes({ storage: async () => false, nats: async () => false }));
    expect(r.ready).toBe(true);
    expect(r.functions).toEqual({ storage: 'fail', nats: 'fail' });
  });

  it('отказ основной БД или обязательных счётчиков — не готово', async () => {
    expect((await checkReadiness(probes({ database: async () => false }))).ready).toBe(false);
    expect((await checkReadiness(probes({ valkey: async () => false }))).ready).toBe(false);
  });

  it('счётчики не настроены (локальный контур) — не условие готовности', async () => {
    const r = await checkReadiness(probes({ valkey: null }));
    expect(r.ready).toBe(true);
    expect(r.required.valkey).toBe('not_configured');
  });

  it('запуск не завершён — не готово; идёт остановка — не готово сразу', async () => {
    expect((await checkReadiness(probes({ lifecycle: () => 'starting' }))).ready).toBe(false);
    const stopping = await checkReadiness(probes({ lifecycle: () => 'stopping' }));
    expect(stopping.ready).toBe(false);
    expect(stopping.lifecycle).toBe('stopping');
  });

  it('роль http без фона — фон not_configured и готовность не снимает', async () => {
    const r = await checkReadiness(
      probes({ background: () => ({ required: false, running: false }) }),
    );
    expect(r.background).toBe('not_configured');
    expect(r.ready).toBe(true);
  });

  it('фон положен, но остановлен — виден отказ фона, общая готовность по 4.9 не снимается', async () => {
    const r = await checkReadiness(
      probes({ background: () => ({ required: true, running: false }) }),
    );
    expect(r.background).toBe('fail');
    expect(r.ready).toBe(true);
  });

  it('зависшая зависимость — fail в пределах ожидания', async () => {
    const started = Date.now();
    const r = await checkReadiness(probes({ database: () => new Promise<boolean>(() => {}) }));
    expect(r.required.database).toBe('fail');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('Остановка выводит из готовности первой', () => {
  it('beforeStop вызывается до остановки фона и закрытия соединений', async () => {
    const order: string[] = [];
    let lifecycle: Lifecycle = 'running';
    const shutdown = createShutdown({
      jobs: {
        stop: async () => {
          order.push(`stop:${lifecycle}`);
        },
      },
      closers: [async () => order.push(`close:${lifecycle}`)],
      graceMs: 1_000,
      exit: () => order.push('exit'),
      log: () => {},
      beforeStop: () => {
        lifecycle = 'stopping';
        order.push('beforeStop');
      },
    });
    await shutdown('SIGTERM');
    expect(order).toEqual(['beforeStop', 'stop:stopping', 'close:stopping', 'exit']);
  });
});

describe('Контрольная операция', () => {
  const record = { s3Key: 'control/probe-v1', sizeBytes: 4, sha256: 'a'.repeat(64) };

  it('запись и файл совпадают — успех', async () => {
    const r = await runControl(
      async () => record,
      async () => ({ exists: true, sizeBytes: 4, sha256: 'a'.repeat(64) }),
    );
    expect(r).toMatchObject({ ok: true, record: 'ok', file: 'ok' });
  });

  it('хранилище отвечает, но содержимое другое — провал mismatch', async () => {
    const r = await runControl(
      async () => record,
      async () => ({ exists: true, sizeBytes: 4, sha256: 'b'.repeat(64) }),
    );
    expect(r).toMatchObject({ ok: false, file: 'mismatch' });
  });

  it('файла нет — провал missing; записи нет — провал missing', async () => {
    expect(
      await runControl(
        async () => record,
        async () => ({ exists: false, sizeBytes: 0, sha256: null }),
      ),
    ).toMatchObject({ ok: false, file: 'missing' });
    expect(
      await runControl(
        async () => null,
        async () => ({ exists: true, sizeBytes: 4, sha256: 'a'.repeat(64) }),
      ),
    ).toMatchObject({ ok: false, record: 'missing' });
  });

  it('хранилище недоступно или БД отказала — провал, не исключение', async () => {
    expect(
      await runControl(
        async () => record,
        async () => Promise.reject(new Error('нет связи')),
      ),
    ).toMatchObject({ ok: false, file: 'fail' });
    expect(
      await runControl(
        async () => Promise.reject(new Error('нет БД')),
        async () => ({ exists: true, sizeBytes: 4, sha256: 'a'.repeat(64) }),
      ),
    ).toMatchObject({ ok: false, record: 'fail' });
  });
});
