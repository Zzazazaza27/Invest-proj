import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { BackgroundJobsService } from '../src/background/background-jobs.service';
import { resultOf, type JobResult } from '../src/background/job';
import { resetEnvCache } from '../src/config/env';

/**
 * Сон пустой очереди и пробуждение (расход в простое; Томас и Тэнк 10.11).
 * Настоящий сигнал PostgreSQL (M175) и задержка доставки — прогон check-queue-wake.
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
let jobs: BackgroundJobsService;

beforeEach(() => {
  saved = process.env;
  process.env = { ...saved, ...BASE_ENV };
  resetEnvCache();
  jobs = new BackgroundJobsService();
});
afterEach(async () => {
  await jobs.stop(100);
  process.env = saved;
  resetEnvCache();
});

const state = (name: string) => jobs.snapshot().find((j) => j.name === name)!;

describe('сон пустой очереди', () => {
  it('пустые проходы удваивают паузу до предела, работа возвращает интервал', async () => {
    let work = 0;
    const runs: number[] = [];
    jobs.register({
      name: 'q',
      intervalMs: 20,
      coordination: 'local',
      idle: { maxMs: 80, wake: 'q' },
      run: async () => {
        runs.push(Date.now());
        return resultOf(work > 0 ? work-- : 0);
      },
    });
    jobs.start();
    await sleep(400);
    const gaps = runs.slice(1).map((t, i) => t - runs[i]!);
    // 20 → 40 → 80 → 80: пауза растёт и упирается в предел.
    expect(Math.max(...gaps)).toBeLessThan(80 + 40);
    expect(gaps.some((g) => g >= 70)).toBe(true);
    expect(state('q').sleepMs).toBe(80);
    expect(state('q').phase).toBe('sleeping');
    expect(state('q').overdue).toBe(false);

    work = 1;
    jobs.wake('q');
    await sleep(15);
    expect(state('q').sleepMs).toBe(20);
  });

  it('пробуждение во сне запускает проход сразу', async () => {
    const runs: number[] = [];
    jobs.register({
      name: 'q',
      intervalMs: 50,
      coordination: 'local',
      idle: { maxMs: 5_000, wake: 'q' },
      run: async () => {
        runs.push(Date.now());
        return { status: 'idle' } as JobResult;
      },
    });
    jobs.start();
    await sleep(400); // 50 → 100 → 200 → 400: сон длинный
    const before = runs.length;
    const t = Date.now();
    expect(jobs.wake('q')).toBe(1);
    await sleep(30);
    expect(runs.length).toBe(before + 1);
    expect(runs.at(-1)! - t).toBeLessThan(30);
  });

  it('пробуждение во время прохода — следующий проход сразу после него', async () => {
    let calls = 0;
    jobs.register({
      name: 'q',
      intervalMs: 1_000,
      coordination: 'local',
      idle: { maxMs: 10_000, wake: 'q' },
      runAtStart: true,
      run: async () => {
        calls += 1;
        if (calls === 1) await sleep(60);
        return { status: 'idle' } as JobResult;
      },
    });
    jobs.start();
    await sleep(20);
    expect(state('q').phase).toBe('running');
    jobs.wake('q');
    await sleep(80);
    expect(calls).toBe(2); // без пробуждения второй был бы через секунду
  });

  it('чужая очередь и задача без сна не будятся', () => {
    jobs.register({
      name: 'plain',
      intervalMs: 1_000,
      coordination: 'local',
      run: async () => resultOf(0),
    });
    jobs.start();
    expect(jobs.wake('other')).toBe(0);
    expect(jobs.wakeQueues).toEqual([]);
    expect(state('plain').sleepMs).toBe(1_000);
  });

  it('отказ прохода сбрасывает сон к интервалу', async () => {
    let fail = false;
    jobs.register({
      name: 'q',
      intervalMs: 20,
      coordination: 'local',
      idle: { maxMs: 200 },
      run: async () => {
        if (fail) throw new Error('база недоступна');
        return { status: 'idle' } as JobResult;
      },
    });
    jobs.start();
    await sleep(200);
    expect(state('q').sleepMs).toBeGreaterThan(20);
    fail = true;
    await sleep(250);
    expect(state('q').sleepMs).toBe(20);
    expect(state('q').consecutiveFailures).toBeGreaterThan(0);
  });
});

describe('сон, зависание и остановленный исполнитель различаются', () => {
  it('долгий проход — stuck, сон — sleeping, просроченный план — late', () => {
    jobs.register({
      name: 'q',
      intervalMs: 1_000,
      coordination: 'local',
      idle: { maxMs: 10_000 },
      run: async () => ({ status: 'idle' }) as JobResult,
    });
    jobs.start();
    const now = Date.now();
    const entry = (jobs as any).jobs.get('q');
    // Сон: следующий проход через 8 с — не просрочен.
    entry.sleepMs = 8_000;
    entry.nextRunAt = now + 8_000;
    expect(jobs.snapshot(now)[0]).toMatchObject({ phase: 'sleeping', overdue: false });
    // Исполнитель не пошёл: план прошёл больше интервала назад.
    entry.nextRunAt = now - 5_000;
    expect(jobs.snapshot(now)[0]).toMatchObject({ phase: 'late', overdue: true });
    // Проход идёт дольше интервала.
    entry.runningSince = now - 3_000;
    expect(jobs.snapshot(now)[0]).toMatchObject({ phase: 'stuck', overdue: true });
    entry.runningSince = null;
  });

  it('остановка фона — stopped, а не late', async () => {
    jobs.register({
      name: 'q',
      intervalMs: 50,
      coordination: 'local',
      idle: { maxMs: 1_000 },
      run: async () => ({ status: 'idle' }) as JobResult,
    });
    jobs.start();
    await jobs.stop(50);
    expect(state('q').phase).toBe('stopped');
  });
});
