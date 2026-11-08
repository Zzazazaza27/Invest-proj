#!/usr/bin/env node
/**
 * Предел перезапусков зависшего ядра на настоящем Docker (блок 2, 2.4; решение Томаса
 * 09.11.2026).
 *
 *   node scripts/check-core-hang-limit.mjs
 *
 * Тот же базовый образ, что у ядра, и та же проверка здоровья (infra/images/core-health.mjs
 * и core-health-policy.mjs, интервал 5 с), init и `restart: unless-stopped`. Вместо ядра —
 * заглушка по пути apps/core/dist/main.js с /live: проверяется механизм, а не ядро.
 * Заморозка — SIGSTOP заглушке. Сценарий:
 *   1. три зависания — три автоматических перезапуска;
 *   2. четвёртое — без перезапуска, unhealthy, recovery=stopped, recoveryStopped в выгрузке;
 *   3. ручной перезапуск — после трёх успешных /live отметка снята;
 *   4. перезапущенный процесс со «старым» журналом не убит во время медленного старта.
 *   5. зависания W23 через обёртку запуска падениями не считаются;
 *   6. петля падений: три быстрых перезапуска, затем редкий режим (mode=slow, crashLoop в
 *      выгрузке), docker stop во время ожидания — сразу, без запуска; поправилась — после
 *      трёх /live обычный режим, история падений сохранена; штатный перезапуск — не падение;
 *      SIGTERM ядру мимо обёртки — падение, и сразу снова редкий режим.
 *   7. зависание при запуске (свежий контейнер): два зависания в работе, затем процесс без
 *      /live снят по пределу запуска (stage=start) — третье снятие, общий счёт с W23; следующий
 *      такой запуск — остановка автовосстановления; падением это не считается; после ручного
 *      перезапуска — обычный запуск, время запуска в строке (startup=).
 * Ожидание редкого режима в пробе — CORE_START_SLOW_MS=20000 вместо 10 минут, предел запуска —
 * CORE_STARTUP_DEADLINE_MS=20000 вместо 5 минут.
 * Контейнер и образ пробы удаляются.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { containerRecord } from './lib/monitor-containers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = 'fifth-probe/core-hang:local';
const NAME = 'fifth-probe-core-hang';
const env = { ...process.env, MSYS_NO_PATHCONV: '1' };
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else failed += 1;
  console.warn(`  ${condition ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
// Таймаут на каждый вызов: проба не должна виснуть ни при каком исходе.
const docker = (...args) =>
  spawnSync('docker', args, { encoding: 'utf8', env, timeout: 60_000 }).stdout?.trim() ?? '';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const inspect = () => JSON.parse(docker('inspect', NAME) || '[]')[0];
const restarts = () => inspect()?.RestartCount ?? -1;
const lastHealth = () => {
  const log = inspect()?.State?.Health?.Log ?? [];
  return String(log.at(-1)?.Output ?? '').trim();
};
async function waitFor(fn, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(1_000);
  }
  return false;
}
const healthy = () => inspect()?.State?.Health?.Status === 'healthy';
/** Заморозить «ядро» внутри контейнера. */
const freeze = () =>
  docker(
    'exec',
    NAME,
    'node',
    '-e',
    "const fs=require('fs');for(const p of fs.readdirSync('/proc').filter((d)=>/^\\d+$/.test(d)&&d!=='1')){try{if(fs.readFileSync('/proc/'+p+'/cmdline','utf8').startsWith('node\\0apps/core/dist/main.js')){process.kill(Number(p),'SIGSTOP');console.log(p)}}catch{}}",
  );

const work = mkdtempSync(join(tmpdir(), 'core-hang-'));
try {
  console.warn('\n=== ПРЕДЕЛ ПЕРЕЗАПУСКОВ ЗАВИСШЕГО ЯДРА (Docker) ===\n');
  copyFileSync(join(ROOT, 'infra/images/core-health.mjs'), join(work, 'core-health.mjs'));
  copyFileSync(
    join(ROOT, 'infra/images/core-health-policy.mjs'),
    join(work, 'core-health-policy.mjs'),
  );
  copyFileSync(join(ROOT, 'infra/images/core-start.mjs'), join(work, 'core-start.mjs'));
  copyFileSync(
    join(ROOT, 'infra/images/core-start-policy.mjs'),
    join(work, 'core-start-policy.mjs'),
  );
  // Заглушка: STUB_SLOW_MS — задержка перед /live (медленный старт после перезапуска).
  writeFileSync(
    join(work, 'main.js'),
    `const fs=require('fs');const slow=fs.existsSync('/tmp/slow-start')?8000:0;const noLive=fs.existsSync('/tmp/no-live');
if(!noLive)setTimeout(()=>require('http').createServer((q,s)=>{s.writeHead(q.url==='/live'?200:404);s.end('ok')}).listen(4400,'127.0.0.1'),slow);
setInterval(()=>{if(fs.existsSync('/tmp/crash-mode'))process.exit(1)},500);`,
  );
  writeFileSync(
    join(work, 'Dockerfile'),
    `FROM node:22.23.2-bookworm-slim
WORKDIR /app
COPY core-health.mjs core-health-policy.mjs core-start.mjs core-start-policy.mjs ./
COPY main.js ./apps/core/dist/main.js
ENV CORE_START_SLOW_MS=20000 CORE_STARTUP_DEADLINE_MS=20000
USER node
HEALTHCHECK --interval=5s --timeout=4s --start-period=30s --retries=3 CMD ["node", "core-health.mjs"]
CMD ["node", "core-start.mjs"]
`,
  );
  execFileSync('docker', ['build', '-q', '-t', IMAGE, work], { env, stdio: 'ignore' });
  docker('rm', '-f', NAME);
  docker('run', '-d', '--name', NAME, '--init', '--restart', 'unless-stopped', IMAGE);
  check('контейнер поднялся и здоров', await waitFor(healthy, 60_000));

  console.warn('[1] Три зависания — три автоматических перезапуска');
  for (let n = 1; n <= 3; n += 1) {
    const before = restarts();
    freeze();
    const restarted = await waitFor(() => restarts() > before, 60_000);
    const back = restarted && (await waitFor(healthy, 60_000));
    check(`зависание ${n}: перезапущен и снова здоров`, back, `перезапусков ${restarts()}`);
  }

  console.warn('[2] Четвёртое — остановка автовосстановления');
  const before4 = restarts();
  freeze();
  const stopped = await waitFor(() => /recovery=stopped/.test(lastHealth()), 60_000);
  check('строка проверки — recovery=stopped', stopped, lastHealth());
  await sleep(20_000);
  check(
    'процесс не убит, перезапусков не прибавилось',
    restarts() === before4,
    `перезапусков ${restarts()}`,
  );
  check('контейнер unhealthy', inspect()?.State?.Health?.Status === 'unhealthy');
  check(
    'выгрузка наблюдения: recoveryStopped',
    containerRecord(inspect()).recoveryStopped === true,
  );

  console.warn('[3] Ручной перезапуск — отметка снимается после трёх успешных /live');
  docker('restart', NAME);
  const cleared = await waitFor(() => /recovery=active/.test(lastHealth()), 90_000);
  const okRun = (inspect()?.State?.Health?.Log ?? [])
    .slice(-3)
    .every((l) => /live=1/.test(String(l.Output)));
  check('recovery=active после трёх успешных подряд', cleared && okRun, lastHealth());
  check(
    'выгрузка наблюдения: признака больше нет',
    containerRecord(inspect()).recoveryStopped === false,
  );

  console.warn('[4] Медленный старт перезапущенного процесса не добивается');
  // Новый процесс со «старым» журналом отказов: старт 8 с, дольше одного интервала проверки.
  docker('exec', NAME, 'sh', '-c', 'touch /tmp/slow-start');
  const before5 = restarts();
  docker('restart', NAME);
  const up = await waitFor(healthy, 60_000);
  check(
    'медленный старт — без убийства, затем здоров',
    up && restarts() === before5,
    `перезапусков ${restarts()}`,
  );

  const startState = () => {
    try {
      return JSON.parse(docker('exec', NAME, 'cat', '/tmp/core-start.json') || '{}');
    } catch {
      return {};
    }
  };
  const crashes = () => (startState().crashes ?? []).length;
  const running = () => inspect()?.State?.Status === 'running';

  console.warn('[5] Зависания W23 через обёртку — не падения');
  check(
    'после трёх убийств зависшего и ручных перезапусков падений нет',
    crashes() === 0,
    `падений ${crashes()}`,
  );

  console.warn('[6] Петля падений');
  docker('exec', NAME, 'sh', '-c', 'touch /tmp/crash-mode');
  const slowSeen = await waitFor(() => /mode=slow/.test(lastHealth()), 120_000);
  check(
    'три падения — затем редкий режим, mode=slow',
    slowSeen && crashes() === 3,
    `${lastHealth()}; падений ${crashes()}`,
  );
  check('выгрузка наблюдения: crashLoop', containerRecord(inspect()).crashLoop === true);
  const waiting = Boolean(startState().nextStart);
  const r0 = restarts();
  await sleep(8_000);
  check(
    'во время ожидания перезапусков нет, контейнер работает',
    waiting && restarts() === r0 && running(),
    `перезапусков ${restarts()}`,
  );
  const t0 = Date.now();
  docker('stop', '-t', '30', NAME);
  const stopSec = Math.round((Date.now() - t0) / 1000);
  check(
    'docker stop во время ожидания — сразу, без запуска ядра',
    stopSec < 5 && !running(),
    `${stopSec} с`,
  );
  docker('start', NAME);
  docker('exec', NAME, 'sh', '-c', 'rm -f /tmp/crash-mode');
  const normal = await waitFor(() => /live=1.*mode=normal/.test(lastHealth()), 120_000);
  check('поправилась: после трёх /live обычный режим', normal, lastHealth());
  check('история падений сохранена', crashes() === 3, `падений ${crashes()}`);
  check('выгрузка наблюдения: признака петли нет', containerRecord(inspect()).crashLoop === false);
  docker('restart', NAME);
  await waitFor(healthy, 60_000);
  check('штатный перезапуск — не падение', crashes() === 3, `падений ${crashes()}`);
  docker(
    'exec',
    NAME,
    'node',
    '-e',
    "const fs=require('fs');for(const p of fs.readdirSync('/proc').filter((d)=>/^\\d+$/.test(d)&&d!=='1')){try{if(fs.readFileSync('/proc/'+p+'/cmdline','utf8').startsWith('node\\0apps/core/dist/main.js'))process.kill(Number(p),'SIGTERM')}catch{}}",
  );
  const again = await waitFor(() => /mode=slow/.test(lastHealth()) && crashes() === 4, 60_000);
  check(
    'SIGTERM ядру мимо обёртки — падение, сразу снова редкий режим',
    again,
    `${lastHealth()}; падений ${crashes()}`,
  );

  console.warn('[7] Зависание при запуске — общий счёт с W23');
  docker('rm', '-f', NAME);
  docker('run', '-d', '--name', NAME, '--init', '--restart', 'unless-stopped', IMAGE);
  check(
    'свежий контейнер здоров, время запуска в строке',
    await waitFor(() => healthy() && /startup=/.test(lastHealth()), 60_000),
    lastHealth(),
  );
  for (let n = 1; n <= 2; n += 1) {
    const before = restarts();
    freeze();
    const back =
      (await waitFor(() => restarts() > before, 60_000)) && (await waitFor(healthy, 60_000));
    check(`зависание в работе ${n}: снят и снова здоров`, back, `перезапусков ${restarts()}`);
  }
  docker('exec', NAME, 'sh', '-c', 'touch /tmp/no-live');
  // Ручной перезапуск обнуляет счётчик Docker: база сравнения — после него.
  docker('restart', NAME);
  const r7 = restarts();
  const startKill = await waitFor(() => restarts() > r7, 90_000);
  check(
    'процесс без /live снят по пределу запуска — третье снятие',
    startKill,
    `перезапусков ${restarts()}`,
  );
  const stopped7 = await waitFor(() => /recovery=stopped.*stage=start/.test(lastHealth()), 90_000);
  check(
    'следующий запуск без /live — остановка автовосстановления, stage=start',
    stopped7,
    lastHealth(),
  );
  const r8 = restarts();
  await sleep(25_000);
  check('после остановки процесс не снимается', restarts() === r8, `перезапусков ${restarts()}`);
  check('снятия при запуске падениями не считаются', crashes() === 0, `падений ${crashes()}`);
  docker('exec', NAME, 'sh', '-c', 'rm -f /tmp/no-live');
  docker('restart', NAME);
  const back7 = await waitFor(() => /live=1 recovery=active.*startup=/.test(lastHealth()), 90_000);
  check('ручной перезапуск — обычный запуск, отметка снята', back7, lastHealth());
} finally {
  docker('rm', '-f', NAME);
  docker('rmi', '-f', IMAGE);
  rmSync(work, { recursive: true, force: true });
}
console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===`);
process.exit(failed === 0 ? 0 : 1);
