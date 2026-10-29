import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { rateLimitStoreFor, type Counters, type HitResult } from '../src/cache/counters';
import { registerIpCeiling } from '../src/cache/ip-ceiling';
import { resetEnvCache } from '../src/config/env';

/**
 * Общие счётчики ограничений (4.8): адаптер `@fastify/rate-limit` и потолок по
 * адресу поверх общего контракта.
 *
 * Здесь — единицы времени, разделение ключей и отказ без обхода на
 * подменённом счётчике. Настоящий Valkey (окно, атомарность, обрыв,
 * неизвестный результат) — прогон `scripts/probe-valkey-counters.mjs`.
 */

/** Фиксированное окно в памяти; запоминает, какие окна и ключи пришли. */
function memoryCounters(options: { fail?: boolean } = {}) {
  const store = new Map<string, { used: number; until: number }>();
  const calls: Array<{ key: string; windowMs: number }> = [];
  const counters = {
    async hit(key: string, windowMs: number): Promise<HitResult> {
      calls.push({ key, windowMs });
      if (options.fail) throw new Error('ECONNREFUSED');
      const now = Date.now();
      const entry = store.get(key);
      if (!entry || entry.until <= now) {
        store.set(key, { used: 1, until: now + windowMs });
        return { used: 1, ttlMs: windowMs };
      }
      entry.used += 1;
      return { used: entry.used, ttlMs: entry.until - now };
    },
  };
  return { counters: counters as unknown as Counters, calls };
}

const BASE_ENV = {
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

let app: FastifyInstance | null = null;
const saved = { ...process.env };

afterEach(async () => {
  await app?.close();
  app = null;
  process.env = { ...saved };
  resetEnvCache();
});

async function limitedApp(counters: Counters): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(rateLimit, {
    global: true,
    store: rateLimitStoreFor(counters),
    skipOnError: false,
    max: (request) => (request.url.startsWith('/auth') ? 2 : 5),
    timeWindow: '1 minute',
    keyGenerator: (request) =>
      `${request.url.startsWith('/auth') ? 'auth' : 'default'}|${request.ip}`,
    addHeaders: { 'retry-after': true },
  });
  instance.get('/auth', async () => 'ok');
  instance.get('/other', async () => 'ok');
  await instance.ready();
  return instance;
}

describe('адаптер @fastify/rate-limit', () => {
  it('окно передаётся в миллисекундах, ключ — с префиксом общего модуля', async () => {
    const { counters, calls } = memoryCounters();
    app = await limitedApp(counters);
    await app.inject({ method: 'GET', url: '/auth' });
    expect(calls[0]).toEqual({ key: 'rl:auth|127.0.0.1', windowMs: 60_000 });
  });

  it('превышение — 429 и Retry-After в секундах по остатку окна', async () => {
    const { counters } = memoryCounters();
    app = await limitedApp(counters);
    await app.inject({ method: 'GET', url: '/auth' });
    await app.inject({ method: 'GET', url: '/auth' });
    const third = await app.inject({ method: 'GET', url: '/auth' });
    expect(third.statusCode).toBe(429);
    const retryAfter = Number(third.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(55);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('лимиты разных классов не делят счётчик', async () => {
    const { counters } = memoryCounters();
    app = await limitedApp(counters);
    for (let i = 0; i < 3; i += 1) await app.inject({ method: 'GET', url: '/auth' });
    const other = await app.inject({ method: 'GET', url: '/other' });
    expect(other.statusCode).toBe(200);
  });

  it('счётчик недоступен — 503, а не пропуск мимо лимита', async () => {
    const { counters } = memoryCounters({ fail: true });
    app = await limitedApp(counters);
    const response = await app.inject({ method: 'GET', url: '/auth' });
    expect(response.statusCode).toBe(503);
  });

  it('продление окна (continueExceeding) не принимается', () => {
    const { counters } = memoryCounters();
    const Store = rateLimitStoreFor(counters);
    expect(() => new Store({ continueExceeding: true } as never)).toThrow(/фиксированным окном/);
  });

  it('маршрут со своим лимитом получает свой префикс ключа; без окна счёта нет', () => {
    const { counters, calls } = memoryCounters();
    const Store = rateLimitStoreFor(counters);
    const child = new Store({} as never).child({
      routeInfo: { method: 'POST', url: '/v1/x' },
    } as never);
    child.incr('k', () => undefined);
    expect(calls).toEqual([]);
    (child.incr as (k: string, cb: () => void, w: number) => void)('k', () => undefined, 1_000);
    expect(calls[0]?.key).toBe('rl:POST/v1/x:k');
  });
});

describe('потолок по адресу', () => {
  async function ceilingApp(counters: Counters, limit: string): Promise<FastifyInstance> {
    process.env = { ...saved, ...BASE_ENV, RATE_LIMIT_IP_CEILING_PER_MIN: limit };
    resetEnvCache();
    const instance = Fastify();
    registerIpCeiling(instance, counters);
    instance.get('/x', async () => 'ok');
    await instance.ready();
    return instance;
  }

  it('окно 60 с передаётся в миллисекундах; превышение — 429 с Retry-After', async () => {
    const { counters, calls } = memoryCounters();
    app = await ceilingApp(counters, '10');
    for (let i = 0; i < 10; i += 1) await app.inject({ method: 'GET', url: '/x' });
    const third = await app.inject({ method: 'GET', url: '/x' });
    expect(calls[0]).toEqual({ key: 'ip-ceiling:127.0.0.1', windowMs: 60_000 });
    expect(third.statusCode).toBe(429);
    expect(Number(third.headers['retry-after'])).toBeLessThanOrEqual(60);
  });

  it('счётчик недоступен — 503', async () => {
    const { counters } = memoryCounters({ fail: true });
    app = await ceilingApp(counters, '100');
    const response = await app.inject({ method: 'GET', url: '/x' });
    expect(response.statusCode).toBe(503);
  });
});
