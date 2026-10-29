#!/usr/bin/env node
/**
 * Общий механизм фоновой работы ядра (блок 1, 1.4) — проверка фактом.
 *
 * Юнит-тесты (`apps/core/tests/background.test.ts`) проверяют оболочку на
 * подменённых блокировках. Здесь — то, что подменой не доказать:
 *
 *  1. АРЕНДА на настоящем PostgreSQL. Полный сценарий потери: срок истёк →
 *     второй исполнитель взял новый захват → первый пытается подтвердить и
 *     получает отказ. Отдельно — истёкшая аренда без нового захвата.
 *  2. ADVISORY-БЛОКИРОВКА: второй экземпляр её не получает; обрыв соединения,
 *     держащего блокировку, прерывает `lost` — работа узнаёт о потере.
 *  3. ПРОЦЕССЫ CORE: выключенный фон и роль `http` не делают ни одного прохода,
 *     включая стартовые; два процесса в роли `worker` выполняют обслуживание
 *     без отказов, публичный порт у них закрыт, `/live` отвечает.
 *
 * Чего прогон не проверяет: штатную остановку по SIGTERM. На Windows сигнал
 * не доходит до обработчика — процесс снимается сразу. Логика завершения с
 * общим пределом проверена юнит-тестами; на процессе — в контейнерах (блок 4).
 *
 * Нужны: собранный core (`npm run build -w apps/core`) и база стенда.
 * Прогон убирает за собой: временная таблица живёт в сессии, процессы
 * останавливаются при любом исходе.
 *
 * Запуск: node scripts/probe-background-jobs.mjs
 */
import pg from 'pg';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

function loadDotEnv() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[trimmed.slice(0, eq).trim()] ??= value;
  }
}

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.warn(`  OK    ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.warn(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const DIST = join(ROOT, 'apps/core/dist');
if (!existsSync(join(DIST, 'background/lease.js'))) {
  console.error('нет apps/core/dist/background — сначала npm run build -w apps/core');
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { claimLeases, completeUnderLease, renewLease } = require(join(DIST, 'background/lease.js'));
const { pgAdvisoryLocks } = require(join(DIST, 'background/advisory.js'));

const children = [];

try {
  await leaseScenarios();
  await advisoryScenarios();
  await processScenarios();
} catch (error) {
  check('прогон выполнен', false, error instanceof Error ? error.stack : String(error));
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
}

console.warn(`\nпройдено: ${passed}, отказов: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);

// --- 1. Аренда ------------------------------------------------------------

async function leaseScenarios() {
  console.warn('\n▸ Аренда строк (lease.ts) на PostgreSQL');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await client.connect();
  try {
    await client.query(
      `CREATE TEMP TABLE probe_work (
         id int PRIMARY KEY, done boolean NOT NULL DEFAULT false,
         lease_id uuid, lease_until timestamptz)`,
    );
    await client.query('INSERT INTO probe_work (id) VALUES (1), (2), (3)');
    const T = 'probe_work';
    const claim = (id, seconds) =>
      claimLeases(client, {
        table: T,
        where: 'id = $1 AND NOT done',
        params: [id],
        limit: 1,
        seconds,
      });
    const complete = (lease) => completeUnderLease(client, { table: T, lease, set: 'done = true' });

    // Потеря аренды с новым захватом.
    const [first] = await claim(1, 1);
    check('первый исполнитель захватил строку', Boolean(first));
    const busy = await claim(1, 1);
    check('занятая строка не выдаётся второму', busy.length === 0);
    await sleep(1_300);
    const [second] = await claim(1, 30);
    check('после истечения срока строку получает второй', Boolean(second));
    check('у нового захвата новый идентификатор', second && second.leaseId !== first.leaseId);
    check('первый не может подтвердить результат', (await complete(first)) === false);
    check(
      'первый не может продлить аренду',
      (await renewLease(client, { table: T, lease: first, seconds: 30 })) === false,
    );
    check('второй подтверждает результат', (await complete(second)) === true);
    const { rows: one } = await client.query('SELECT done, lease_id FROM probe_work WHERE id = 1');
    check('подтверждение сняло аренду', one[0].done === true && one[0].lease_id === null);

    // Истёкшая аренда без нового захвата.
    const [stale] = await claim(2, 1);
    await sleep(1_300);
    check(
      'истёкшая аренда не продлевается',
      (await renewLease(client, { table: T, lease: stale, seconds: 30 })) === false,
    );
    check('истёкшая аренда не подтверждает результат', (await complete(stale)) === false);
    const { rows: two } = await client.query('SELECT done FROM probe_work WHERE id = 2');
    check('строка осталась несделанной для повтора', two[0].done === false);

    // Живая аренда.
    const [alive] = await claim(3, 30);
    check(
      'живая аренда продлевается',
      (await renewLease(client, { table: T, lease: alive, seconds: 30 })) === true,
    );
  } finally {
    await client.end();
  }
}

// --- 2. Advisory-блокировка ----------------------------------------------

async function advisoryScenarios() {
  console.warn('\n▸ Advisory-блокировка обслуживания');
  const name = `probe.advisory.${process.pid}`;
  const lock = await pgAdvisoryLocks.tryAcquire(name);
  check('первый экземпляр получил блокировку', Boolean(lock));
  const other = await pgAdvisoryLocks.tryAcquire(name);
  check('второй экземпляр блокировку не получил', other === null);

  // Обрыв соединения, держащего блокировку: администратор БД рвёт сессию.
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await admin.connect();
  try {
    const { rows } = await admin.query(
      `SELECT pg_terminate_backend(l.pid) AS ok
         FROM pg_locks l
        WHERE l.locktype = 'advisory' AND l.classid = 5001
          AND l.objid = hashtext($1)::oid AND l.granted`,
      [name],
    );
    check('соединение с блокировкой оборвано', rows.length === 1 && rows[0].ok === true);
    const deadline = Date.now() + 5_000;
    while (!lock.lost.aborted && Date.now() < deadline) await sleep(50);
    check('обрыв прервал работу (lost)', lock.lost.aborted);
    await lock.release();

    const again = await pgAdvisoryLocks.tryAcquire(name);
    check('после обрыва блокировка свободна', Boolean(again));
    await again?.release();
  } finally {
    await admin.end();
  }
}

// --- 3. Процессы core ------------------------------------------------------

function startCore(label, overrides) {
  const child = spawn(process.execPath, [join(DIST, 'main.js')], {
    cwd: ROOT,
    env: { ...process.env, ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  children.push(child);
  return { label, child, output: () => output, internal: Number(overrides.CORE_INTERNAL_PORT) };
}

async function getJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return { status: response.status, body: await response.json() };
  } catch {
    return { status: 0, body: null };
  }
}

async function waitLive(core) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (core.child.exitCode !== null) break;
    const live = await getJson(`http://127.0.0.1:${core.internal}/live`);
    if (live.status === 200) return true;
    await sleep(300);
  }
  console.warn(core.output().slice(-2_000));
  return false;
}

async function processScenarios() {
  console.warn('\n▸ Процессы core');
  const off = startCore('выключенный фон', {
    CORE_PORT: '4311',
    CORE_INTERNAL_PORT: '4411',
    BACKGROUND_JOBS_ENABLED: 'false',
  });
  const http = startCore('роль http', {
    CORE_PORT: '4312',
    CORE_INTERNAL_PORT: '4412',
    CORE_ROLE: 'http',
  });
  const workerA = startCore('worker A', {
    CORE_PORT: '4313',
    CORE_INTERNAL_PORT: '4413',
    CORE_ROLE: 'worker',
  });
  const workerB = startCore('worker B', {
    CORE_PORT: '4314',
    CORE_INTERNAL_PORT: '4414',
    CORE_ROLE: 'worker',
  });

  for (const core of [off, http, workerA, workerB]) {
    check(`${core.label}: /live отвечает`, await waitLive(core));
  }
  // Стартовые проходы обслуживания идут сразу после запуска фона; даём время.
  await sleep(4_000);

  for (const core of [off, http]) {
    const { body } = await getJson(`http://127.0.0.1:${core.internal}/jobs`);
    const ran = (body?.jobs ?? []).filter((job) => job.lastStartedAt !== null);
    check(`${core.label}: фон не запущен`, body?.backgroundEnabled === false);
    check(
      `${core.label}: ни одного прохода, включая стартовые`,
      body && body.jobs.length > 0 && ran.length === 0,
      ran.map((job) => job.name).join(', '),
    );
  }
  const httpHealth = await getJson('http://127.0.0.1:4312/v1/health');
  check('роль http: публичный API отвечает', httpHealth.status === 200);

  for (const core of [workerA, workerB]) {
    const publicPort = core === workerA ? 4313 : 4314;
    const health = await getJson(`http://127.0.0.1:${publicPort}/v1/health`);
    check(`${core.label}: публичный порт закрыт`, health.status === 0);
    const { body } = await getJson(`http://127.0.0.1:${core.internal}/jobs`);
    const maintenance = (body?.jobs ?? []).filter((job) => job.name.startsWith('maintenance.'));
    const failedJobs = (body?.jobs ?? []).filter((job) => job.lastStatus === 'failed');
    check(
      `${core.label}: обслуживание прошло`,
      // С 2.1-W03 уборки незавершённых загрузок нет: три задачи обслуживания.
      maintenance.length === 3 &&
        maintenance.every((job) => ['done', 'idle', 'skipped'].includes(job.lastStatus)),
      maintenance.map((job) => `${job.name}=${job.lastStatus}`).join(', '),
    );
    check(
      `${core.label}: отказов нет`,
      failedJobs.length === 0,
      failedJobs.map((job) => `${job.name}: ${job.lastError}`).join(' | '),
    );
    const reconcile = (body?.jobs ?? []).find((job) => job.name === 'uploads.reconcile');
    check(
      `${core.label}: сверка загрузок зарегистрирована и без отказов`,
      reconcile !== undefined && reconcile.lastStatus !== 'failed',
      reconcile ? `${reconcile.lastStatus}` : 'нет задачи',
    );
    const publish = (body?.jobs ?? []).find((job) => job.name === 'outbox.publish');
    check(
      `${core.label}: публикатор делает проходы`,
      publish?.lastStartedAt !== null && publish?.lastStartedAt !== undefined,
    );
  }
}
