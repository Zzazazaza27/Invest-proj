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
  // Заглушка: STUB_SLOW_MS — задержка перед /live (медленный старт после перезапуска).
  writeFileSync(
    join(work, 'main.js'),
    `const fs=require('fs');const slow=fs.existsSync('/tmp/slow-start')?8000:0;
setTimeout(()=>require('http').createServer((q,s)=>{s.writeHead(q.url==='/live'?200:404);s.end('ok')}).listen(4400,'127.0.0.1'),slow);`,
  );
  writeFileSync(
    join(work, 'Dockerfile'),
    `FROM node:22.23.2-bookworm-slim
WORKDIR /app
COPY core-health.mjs core-health-policy.mjs ./
COPY main.js ./apps/core/dist/main.js
USER node
HEALTHCHECK --interval=5s --timeout=4s --start-period=30s --retries=3 CMD ["node", "core-health.mjs"]
CMD ["node", "apps/core/dist/main.js"]
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
} finally {
  docker('rm', '-f', NAME);
  docker('rmi', '-f', IMAGE);
  rmSync(work, { recursive: true, force: true });
}
console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===`);
process.exit(failed === 0 ? 0 : 1);
