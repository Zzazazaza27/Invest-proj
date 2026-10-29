import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { BackgroundJobsService } from '../src/background/background-jobs.service';
import type { AdvisoryLock, AdvisoryLockProvider } from '../src/background/advisory';
import { resultOf } from '../src/background/job';
import { createShutdown } from '../src/background/shutdown';
import { resetEnvCache } from '../src/config/env';
import { TokenRevocationService } from '../src/auth/token-revocation.service';
import { PartitionMaintenanceService } from '../src/maintenance/partitions.service';

/**
 * Юнит-тесты общего механизма фоновой работы (блок 1, 1.4).
 *
 * Здесь — поведение оболочки: наложение, ошибки, выключатель, роли, остановка
 * и прерывание по потере блокировки. Настоящая блокировка PostgreSQL, аренда
 * и два процесса core проверяются прогоном `scripts/probe-background-jobs.mjs`.
 */

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

let saved: NodeJS.ProcessEnv;
let services: BackgroundJobsService[] = [];

function setEnv(extra: NodeJS.ProcessEnv = {}): void {
  process.env = { ...saved, ...BASE_ENV, ...extra };
  resetEnvCache();
}

function service(): BackgroundJobsService {
  const jobs = new BackgroundJobsService();
  services.push(jobs);
  return jobs;
}

/** Блокировка в памяти: одна на имя, `lose()` имитирует обрыв соединения. */
function memoryLocks(): AdvisoryLockProvider & { lose(name: string): void } {
  const held = new Map<string, AbortController>();
  return {
    async tryAcquire(name): Promise<AdvisoryLock | null> {
      if (held.has(name)) return null;
      const lost = new AbortController();
      held.set(name, lost);
      return {
        lost: lost.signal,
        release: async () => {
          held.delete(name);
        },
      };
    },
    lose(name) {
      held.get(name)?.abort(new Error('обрыв'));
    },
  };
}

const state = (jobs: BackgroundJobsService, name: string) =>
  jobs.snapshot().find((job) => job.name === name)!;

beforeEach(() => {
  saved = { ...process.env };
  setEnv();
});

afterEach(async () => {
  for (const jobs of services) await jobs.stop(0);
  services = [];
  process.env = saved;
  resetEnvCache();
});

describe('фоновые задачи: оболочка запуска', () => {
  it('проходы одной задачи не накладываются друг на друга', async () => {
    const jobs = service();
    let active = 0;
    let peak = 0;
    let passes = 0;
    jobs.register({
      name: 'slow',
      intervalMs: 5,
      coordination: 'local',
      runAtStart: true,
      run: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(40);
        active -= 1;
        passes += 1;
        return resultOf(1);
      },
    });
    jobs.start();
    await sleep(200);
    expect(passes).toBeGreaterThan(1);
    expect(peak).toBe(1);
  });

  it('ошибка прохода видна в состоянии и не останавливает следующие проходы', async () => {
    const jobs = service();
    let calls = 0;
    jobs.register({
      name: 'flaky',
      intervalMs: 10,
      coordination: 'local',
      runAtStart: true,
      run: async () => {
        calls += 1;
        if (calls <= 2) throw new Error('база недоступна');
        return resultOf(0);
      },
    });
    jobs.start();
    await sleep(15);
    const failed = state(jobs, 'flaky');
    expect(failed.lastStatus).toBe('failed');
    expect(failed.lastError).toBe('база недоступна');
    expect(failed.consecutiveFailures).toBeGreaterThanOrEqual(1);

    await sleep(80);
    const recovered = state(jobs, 'flaky');
    expect(recovered.lastStatus).toBe('idle');
    expect(recovered.consecutiveFailures).toBe(0);
    expect(recovered.lastErrorAt).not.toBeNull();
  });

  it('различает «сделано» и «работы не было»', async () => {
    const jobs = service();
    let processed = 3;
    jobs.register({
      name: 'counted',
      intervalMs: 60_000,
      coordination: 'local',
      run: async () => resultOf(processed),
    });
    await jobs.runNow('counted');
    expect(state(jobs, 'counted')).toMatchObject({ lastStatus: 'done', lastProcessed: 3 });
    processed = 0;
    await jobs.runNow('counted');
    expect(state(jobs, 'counted')).toMatchObject({ lastStatus: 'idle', lastProcessed: 0 });
  });

  it('задача, выключенная по имени, не выполняется ни разу', async () => {
    setEnv({ BACKGROUND_JOBS_DISABLED: 'off, other' });
    const jobs = service();
    let calls = 0;
    jobs.register({
      name: 'off',
      intervalMs: 5,
      coordination: 'local',
      runAtStart: true,
      run: async () => {
        calls += 1;
        return resultOf(0);
      },
    });
    jobs.start();
    await sleep(40);
    expect(calls).toBe(0);
    expect(state(jobs, 'off').enabled).toBe(false);
  });

  it('общий выключатель и роль http запрещают фон', () => {
    setEnv({ BACKGROUND_JOBS_ENABLED: 'false' });
    expect(BackgroundJobsService.allowedByConfig().allowed).toBe(false);
    setEnv({ CORE_ROLE: 'http' });
    expect(BackgroundJobsService.allowedByConfig().allowed).toBe(false);
    setEnv({ CORE_ROLE: 'worker' });
    expect(BackgroundJobsService.allowedByConfig().allowed).toBe(true);
    setEnv();
    expect(BackgroundJobsService.allowedByConfig().allowed).toBe(true);
  });

  it('без start() не выполняется ни один проход, включая стартовые', async () => {
    const jobs = service();
    let calls = 0;
    jobs.register({
      name: 'startup',
      intervalMs: 5,
      coordination: 'local',
      runAtStart: true,
      run: async () => {
        calls += 1;
        return resultOf(0);
      },
    });
    await sleep(40);
    expect(calls).toBe(0);
  });
});

describe('фоновые задачи: остановка', () => {
  it('после сигнала следующая запись пачки не берётся, начатая доводится', async () => {
    const jobs = service();
    const handled: number[] = [];
    jobs.register({
      name: 'batch',
      intervalMs: 60_000,
      coordination: 'local',
      runAtStart: true,
      run: async ({ signal }) => {
        for (let item = 1; item <= 10; item += 1) {
          if (signal.aborted) break;
          await sleep(20);
          handled.push(item);
        }
        return resultOf(handled.length);
      },
    });
    jobs.start();
    await sleep(30);
    const pending = await jobs.stop(1_000);
    expect(pending).toBe(0);
    // Первая запись завершена, вторая начата до сигнала и тоже доведена.
    expect(handled.length).toBeGreaterThanOrEqual(1);
    expect(handled.length).toBeLessThan(10);
    expect(state(jobs, 'batch').lastInterrupted).toBe(true);
  });

  it('зависшая задача не держит остановку дольше срока', async () => {
    const jobs = service();
    jobs.register({
      name: 'hung',
      intervalMs: 60_000,
      coordination: 'local',
      runAtStart: true,
      run: () => new Promise(() => undefined),
    });
    jobs.start();
    await sleep(10);
    const started = Date.now();
    const pending = await jobs.stop(100);
    expect(Date.now() - started).toBeLessThan(500);
    expect(pending).toBe(1);
  });

  it('после остановки новые проходы не начинаются', async () => {
    const jobs = service();
    let calls = 0;
    jobs.register({
      name: 'ticker',
      intervalMs: 10,
      coordination: 'local',
      runAtStart: true,
      run: async () => {
        calls += 1;
        return resultOf(0);
      },
    });
    jobs.start();
    await sleep(35);
    await jobs.stop(100);
    const after = calls;
    await sleep(50);
    expect(calls).toBe(after);
    expect(state(jobs, 'ticker').nextRunAt).toBeNull();
  });
});

describe('фоновые задачи: advisory-координация', () => {
  it('блокировку держит другой экземпляр — проход пропущен', async () => {
    const locks = memoryLocks();
    const first = service();
    const second = service();
    first.locks = locks;
    second.locks = locks;
    let calls = 0;
    const def = {
      name: 'maintenance.x',
      intervalMs: 60_000,
      coordination: 'advisory' as const,
      run: async () => {
        calls += 1;
        await sleep(50);
        return resultOf(1);
      },
    };
    first.register(def);
    second.register(def);
    await Promise.all([first.runNow('maintenance.x'), second.runNow('maintenance.x')]);
    expect(calls).toBe(1);
    const statuses = [state(first, def.name).lastStatus, state(second, def.name).lastStatus];
    expect(statuses.sort()).toEqual(['done', 'skipped']);
  });

  it('потеря блокировки прерывает проход: новых изменений нет', async () => {
    const locks = memoryLocks();
    const jobs = service();
    jobs.locks = locks;
    const handled: number[] = [];
    jobs.register({
      name: 'maintenance.y',
      intervalMs: 60_000,
      coordination: 'advisory',
      run: async ({ signal }) => {
        for (let item = 1; item <= 10; item += 1) {
          if (signal.aborted) break;
          await sleep(20);
          handled.push(item);
        }
        return resultOf(handled.length);
      },
    });
    const pass = jobs.runNow('maintenance.y');
    await sleep(30);
    locks.lose('maintenance.y');
    await pass;
    expect(handled.length).toBeLessThan(10);
    expect(state(jobs, 'maintenance.y').lastInterrupted).toBe(true);
  });
});

describe('завершение процесса: общий предел', () => {
  it('зависшее закрытие приложения не держит процесс дольше срока', async () => {
    const codes: number[] = [];
    const shutdown = createShutdown({
      jobs: { stop: async () => 0 },
      closers: [() => new Promise(() => undefined)],
      graceMs: 100,
      exit: (code) => codes.push(code),
      log: () => undefined,
    });
    void shutdown('SIGTERM');
    await sleep(200);
    expect(codes).toEqual([1]);
  });

  it('предел общий: ожидание фона и закрытие вместе укладываются в срок', async () => {
    const jobs = service();
    jobs.register({
      name: 'hung-on-stop',
      intervalMs: 60_000,
      coordination: 'local',
      runAtStart: true,
      run: () => new Promise(() => undefined),
    });
    jobs.start();
    await sleep(10);
    const codes: number[] = [];
    const started = Date.now();
    const shutdown = createShutdown({
      jobs,
      closers: [() => new Promise(() => undefined)],
      graceMs: 150,
      exit: (code) => codes.push(code),
      log: () => undefined,
    });
    void shutdown('SIGTERM');
    while (codes.length === 0 && Date.now() - started < 1_000) await sleep(10);
    expect(codes).toEqual([1]);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('штатное завершение — код 0, повторный сигнал не запускает второе', async () => {
    const codes: number[] = [];
    const closed: string[] = [];
    const shutdown = createShutdown({
      jobs: { stop: async () => 0 },
      closers: [async () => closed.push('app'), async () => closed.push('internal')],
      graceMs: 1_000,
      exit: (code) => codes.push(code),
      log: () => undefined,
    });
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    await sleep(20);
    expect(closed).toEqual(['app', 'internal']);
    expect(codes).toEqual([0]);
  });
});

describe('прерывание до начала прикладной работы', () => {
  /** Блокировка выдаётся с задержкой; учёт освобождений. */
  function slowLocks(options: { delayMs: number; lostOnAcquire?: boolean }) {
    const released: string[] = [];
    const provider: AdvisoryLockProvider = {
      async tryAcquire(name) {
        await sleep(options.delayMs);
        const lost = new AbortController();
        if (options.lostOnAcquire) lost.abort(new Error('обрыв'));
        return {
          lost: lost.signal,
          release: async () => {
            released.push(name);
          },
        };
      },
    };
    return { provider, released };
  }

  it('остановка во время получения блокировки: работа не начинается, блокировка освобождена', async () => {
    const jobs = service();
    const locks = slowLocks({ delayMs: 60 });
    jobs.locks = locks.provider;
    let calls = 0;
    jobs.register({
      name: 'maintenance.slow-lock',
      intervalMs: 60_000,
      coordination: 'advisory',
      run: async () => {
        calls += 1;
        return resultOf(1);
      },
    });
    const pass = jobs.runNow('maintenance.slow-lock');
    await sleep(10);
    await jobs.stop(1_000);
    await pass;
    expect(calls).toBe(0);
    expect(locks.released).toEqual(['maintenance.slow-lock']);
    expect(state(jobs, 'maintenance.slow-lock')).toMatchObject({
      lastStatus: 'interrupted',
      lastInterrupted: true,
      consecutiveFailures: 0,
    });
  });

  it('блокировка потеряна к моменту получения: работа не начинается, блокировка освобождена', async () => {
    const jobs = service();
    const locks = slowLocks({ delayMs: 0, lostOnAcquire: true });
    jobs.locks = locks.provider;
    let calls = 0;
    jobs.register({
      name: 'maintenance.lost-lock',
      intervalMs: 60_000,
      coordination: 'advisory',
      run: async () => {
        calls += 1;
        return resultOf(1);
      },
    });
    await jobs.runNow('maintenance.lost-lock');
    expect(calls).toBe(0);
    expect(locks.released).toEqual(['maintenance.lost-lock']);
    expect(state(jobs, 'maintenance.lost-lock').lastStatus).toBe('interrupted');
  });

  it('прерывание внутри задачи — не отказ: ошибки подряд не растут', async () => {
    const jobs = service();
    jobs.register({
      name: 'aborting',
      intervalMs: 60_000,
      coordination: 'local',
      runAtStart: true,
      run: async ({ signal }) => {
        await sleep(30);
        signal.throwIfAborted();
        return resultOf(1);
      },
    });
    jobs.start();
    await sleep(5);
    await jobs.stop(1_000);
    expect(state(jobs, 'aborting')).toMatchObject({
      lastStatus: 'interrupted',
      lastError: null,
      consecutiveFailures: 0,
    });
  });
});

describe('задачи обслуживания: сигнал перед изменением', () => {
  /** БД-подделка: соединение «получено», запросы записываются. */
  function fakeDb() {
    const queries: string[] = [];
    const tx = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [{ created: 0 }], rowCount: 0 };
      },
    };
    const db = {
      transaction: async (_ctx: unknown, work: (t: typeof tx) => Promise<unknown>) => work(tx),
      asServiceRole: async (_r: unknown, _c: unknown, work: (t: typeof tx) => Promise<unknown>) =>
        work(tx),
    };
    return { db, queries };
  }

  it('прерванный сигнал: ни одного изменяющего запроса, проход отклоняется прерыванием', async () => {
    const { db, queries } = fakeDb();
    const revocations = new TokenRevocationService(db as never);
    const maintenance = new PartitionMaintenanceService(db as never, revocations, service());
    const stopped = new AbortController();
    stopped.abort(new Error('остановка процесса'));

    await expect(maintenance.runOnce(stopped.signal)).rejects.toBe(stopped.signal.reason);
    await expect(maintenance.purgeRevocations(stopped.signal)).rejects.toBe(stopped.signal.reason);
    await expect(maintenance.purgeVerificationTokens(stopped.signal)).rejects.toBe(
      stopped.signal.reason,
    );
    expect(queries).toEqual([]);

    // Без прерывания те же задачи доходят до запроса.
    await maintenance.runOnce(new AbortController().signal);
    expect(queries.length).toBe(1);
  });
});
