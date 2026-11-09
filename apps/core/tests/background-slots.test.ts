import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { BackgroundJobsService } from '../src/background/background-jobs.service';
import { readGrant } from '../src/background/grant';
import { startInternalServer } from '../src/background/internal-server';
import { resultOf } from '../src/background/job';
import { resetEnvCache } from '../src/config/env';

/**
 * Два ядра при выпуске (блок 09, задание 3; уточнения Тэнка 09.11): обратимая пауза фона и
 * подтверждённое разрешение фона слоту. Переключение и перезапуски слотов целиком — в
 * испытании на временной среде.
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
let dir: string;

beforeEach(() => {
  saved = { ...process.env };
  process.env = { ...saved, ...BASE_ENV };
  resetEnvCache();
  dir = mkdtempSync(join(tmpdir(), 'fifth-grant-'));
});

afterEach(async () => {
  for (const jobs of services) await jobs.stop(0);
  services = [];
  process.env = saved;
  resetEnvCache();
  rmSync(dir, { recursive: true, force: true });
});

function service(): BackgroundJobsService {
  const jobs = new BackgroundJobsService();
  services.push(jobs);
  return jobs;
}

/** Задача, проход которой длится `ms` и сигнал прерывания не слушает. */
function stubborn(jobs: BackgroundJobsService, name: string, ms: number) {
  const counter = { started: 0, finished: 0 };
  jobs.register({
    name,
    intervalMs: 20,
    coordination: 'local',
    runAtStart: true,
    run: async () => {
      counter.started += 1;
      await sleep(ms);
      counter.finished += 1;
      return resultOf(1);
    },
  });
  return counter;
}

describe('фон: обратимая пауза', () => {
  it('paused — только после фактического окончания прохода, сигнал этого не доказывает', async () => {
    const jobs = service();
    const c = stubborn(jobs, 'долгая', 400);
    jobs.start();
    await sleep(30);
    expect(c.started).toBe(1);
    const mode = await jobs.pause(100, 50);
    // Прерывание отправлено, проход его не слушает и ещё идёт.
    expect(mode).toBe('pausing');
    expect(jobs.pendingPasses).toEqual(['долгая']);
    await sleep(450);
    expect(c.finished).toBe(1);
    expect(jobs.mode).toBe('paused');
  });

  it('во время pausing продолжение отклоняется: второй тот же проход не начинается', async () => {
    const jobs = service();
    const c = stubborn(jobs, 'долгая', 300);
    jobs.start();
    await sleep(30);
    await jobs.pause(60, 30);
    expect(jobs.resume()).toBe('pausing');
    await sleep(350);
    expect(c.started).toBe(1);
  });

  it('на паузе новые проходы не начинаются; продолжение возобновляет работу', async () => {
    const jobs = service();
    const c = stubborn(jobs, 'короткая', 5);
    jobs.start();
    await sleep(60);
    expect(await jobs.pause(1000)).toBe('paused');
    const before = c.started;
    await sleep(120);
    expect(c.started).toBe(before);
    expect(jobs.resume()).toBe('running');
    await sleep(120);
    expect(c.started).toBeGreaterThan(before);
  });

  it('прерывание паузой проходит в задачу как сигнал и не считается отказом', async () => {
    const jobs = service();
    let sawAbort = false;
    jobs.register({
      name: 'слушает',
      intervalMs: 1000,
      coordination: 'local',
      runAtStart: true,
      run: async ({ signal }) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            sawAbort = true;
            resolve();
          });
        });
        signal.throwIfAborted();
        return resultOf(1);
      },
    });
    jobs.start();
    await sleep(20);
    expect(await jobs.pause(500, 10)).toBe('paused');
    expect(sawAbort).toBe(true);
    const state = jobs.snapshot().find((j) => j.name === 'слушает')!;
    expect(state.lastStatus).toBe('interrupted');
    expect(state.consecutiveFailures).toBe(0);
  });

  it('остановка процесса после паузы — окончательна, продолжение ничего не запускает', async () => {
    const jobs = service();
    const c = stubborn(jobs, 'короткая', 5);
    jobs.start();
    await sleep(40);
    await jobs.pause(500);
    await jobs.stop(100);
    expect(jobs.resume()).toBe('stopping');
    const before = c.started;
    await sleep(80);
    expect(c.started).toBe(before);
  });

  it('пауза до запуска: фон не стартует, пока не продолжат', async () => {
    const jobs = service();
    const c = stubborn(jobs, 'стартовая', 5);
    expect(await jobs.pause(0)).toBe('paused');
    jobs.start();
    await sleep(60);
    expect(c.started).toBe(0);
    jobs.resume();
    await sleep(60);
    expect(c.started).toBeGreaterThan(0);
  });
});

describe('фон: служебные команды на внутреннем порту', () => {
  const TOKEN = 't'.repeat(40);
  async function server(extra: NodeJS.ProcessEnv) {
    process.env = {
      ...process.env,
      CORE_INTERNAL_PORT: String(20000 + Math.floor(Math.random() * 20000)),
      BACKGROUND_CONTROL_TOKEN: TOKEN,
      BACKGROUND_PAUSE_WAIT_MS: '2000',
      ...extra,
    };
    // `undefined` в extra — убрать переменную: пустой токен — ошибка настройки, а не «закрыто».
    for (const [key, value] of Object.entries(extra))
      if (value === undefined) delete process.env[key];
    resetEnvCache();
    const jobs = service();
    stubborn(jobs, 'короткая', 5);
    jobs.start();
    const internal = await startInternalServer(jobs, undefined, { activeRequests: () => 3 });
    const url = (path: string) => `http://127.0.0.1:${internal.port}${path}`;
    return { jobs, internal, url };
  }
  const post = (url: string, token?: string) =>
    fetch(url, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  it('изменение состояния — только POST и только с токеном', async () => {
    const { jobs, internal, url } = await server({});
    try {
      expect((await fetch(url('/background/pause'))).status).toBe(405);
      expect((await post(url('/background/pause'))).status).toBe(403);
      expect((await post(url('/background/pause'), 'x'.repeat(40))).status).toBe(403);
      expect(jobs.mode).toBe('running');
      const paused = await post(url('/background/pause'), TOKEN);
      expect(paused.status).toBe(200);
      expect(jobs.mode).toBe('paused');
      const state = await (await fetch(url('/state'))).json();
      expect(state).toMatchObject({ activeRequests: 3, background: 'paused' });
    } finally {
      await internal.close();
    }
  });

  it('продолжение в режиме слотов — только при разрешении этому слоту', async () => {
    const grant = join(dir, 'grant.json');
    writeFileSync(grant, JSON.stringify({ format: 1, owner: null }));
    const { jobs, internal, url } = await server({
      BACKGROUND_START: 'grant',
      CORE_SLOT: 'core-b',
      BACKGROUND_GRANT_PATH: grant,
    });
    try {
      await post(url('/background/pause'), TOKEN);
      const refused = await post(url('/background/resume'), TOKEN);
      expect(refused.status).toBe(409);
      expect(jobs.mode).toBe('paused');
      writeFileSync(grant, JSON.stringify({ format: 1, owner: 'core-b', op: 'op-3' }));
      const ok = await post(url('/background/resume'), TOKEN);
      expect(ok.status).toBe(200);
      expect(jobs.mode).toBe('running');
    } finally {
      await internal.close();
    }
  });

  it('без настроенного токена команды закрыты', async () => {
    const { internal, url } = await server({ BACKGROUND_CONTROL_TOKEN: undefined });
    try {
      expect((await post(url('/background/pause'), TOKEN)).status).toBe(404);
    } finally {
      await internal.close();
    }
  });
});

describe('фон: подтверждённое разрешение слоту', () => {
  const write = (body: unknown) => {
    const file = join(dir, 'grant.json');
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
    return file;
  };

  it('владелец — этот слот: разрешено', () => {
    const v = readGrant(write({ format: 1, owner: 'core-b', op: 'op-1' }), 'core-b');
    expect(v).toEqual({ granted: true, op: 'op-1' });
  });

  it('неоднозначное состояние — фон не запускается', () => {
    expect(readGrant(join(dir, 'нет-файла.json'), 'core-a').granted).toBe(false);
    expect(readGrant(write('{не json'), 'core-a').granted).toBe(false);
    expect(readGrant(write({ format: 2, owner: 'core-a' }), 'core-a').granted).toBe(false);
    expect(readGrant(write({ format: 1 }), 'core-a').granted).toBe(false);
  });

  it('кандидат перезапущен после записи маршрута, до подтверждения: разрешения ещё нет', () => {
    // Установщик пишет owner=null до паузы старого слота; кандидату разрешение выдаётся
    // только после подтверждения переключения запросом через nginx. Файл маршрута уже
    // указывает кандидата — это не разрешение.
    writeFileSync(join(dir, 'route.conf'), 'set $core_slot core-b;');
    const v = readGrant(write({ format: 1, owner: null, op: 'op-2' }), 'core-b');
    expect(v.granted).toBe(false);
  });

  it('старое ядро перезапущено после паузы: пауза сохраняется', () => {
    const v = readGrant(write({ format: 1, owner: null, op: 'op-2' }), 'core-a');
    expect(v).toEqual({ granted: false, reason: 'фон на паузе' });
  });

  it('разрешение другому слоту — этот без фона', () => {
    const v = readGrant(write({ format: 1, owner: 'core-a' }), 'core-b');
    expect(v).toEqual({ granted: false, reason: 'фон разрешён слоту core-a' });
  });
});
