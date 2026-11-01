import { afterEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../src/config/env';
import { checkReadiness, type ReadinessProbes } from '../src/background/readiness';

/**
 * Готовность по зависимостям (блок 8, 8.2; 2.1-W08a): каждая зависимость —
 * ok / fail / not_configured, зависшая — fail в пределах ожидания, общий
 * ответ готов только без fail.
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
afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
});

const probes = (over: Partial<ReadinessProbes> = {}): ReadinessProbes => ({
  database: async () => true,
  storage: async () => true,
  valkey: null,
  nats: null,
  background: () => ({ required: true, running: true }),
  queues: async () => ({}),
  ...over,
});

describe('Готовность ядра', () => {
  it('всё настроенное ok, ненастроенное — not_configured: готово', async () => {
    process.env = { ...BASE_ENV };
    resetEnvCache();
    const r = await checkReadiness(probes());
    expect(r.ready).toBe(true);
    expect(r.checks).toEqual({
      database: 'ok',
      storage: 'ok',
      valkey: 'not_configured',
      nats: 'not_configured',
      background: 'ok',
    });
  });

  it('отказ одной зависимости — не готово, названа именно она', async () => {
    process.env = { ...BASE_ENV };
    resetEnvCache();
    const r = await checkReadiness(probes({ valkey: async () => false }));
    expect(r.ready).toBe(false);
    expect(r.checks.valkey).toBe('fail');
    expect(r.checks.database).toBe('ok');
  });

  it('зависшая зависимость — fail в пределах ожидания, а не висящий ответ', async () => {
    process.env = { ...BASE_ENV };
    resetEnvCache();
    const started = Date.now();
    const r = await checkReadiness(probes({ storage: () => new Promise<boolean>(() => {}) }));
    expect(r.checks.storage).toBe('fail');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('исключение проверки — fail, не падение', async () => {
    process.env = { ...BASE_ENV };
    resetEnvCache();
    const r = await checkReadiness(
      probes({ database: async () => Promise.reject(new Error('нет соединения')) }),
    );
    expect(r.checks.database).toBe('fail');
  });

  it('фон обязателен, но не запущен — не готово; фон не нужен — not_configured', async () => {
    process.env = { ...BASE_ENV };
    resetEnvCache();
    expect(
      (await checkReadiness(probes({ background: () => ({ required: true, running: false }) })))
        .checks.background,
    ).toBe('fail');
    expect(
      (await checkReadiness(probes({ background: () => ({ required: false, running: false }) })))
        .checks.background,
    ).toBe('not_configured');
  });
});
