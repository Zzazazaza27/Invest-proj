#!/usr/bin/env node
/**
 * Старт ядра при недоступной зависимости (блок 2, 2.4; план «петля падений», 09.11.2026).
 *
 *   node scripts/check-core-startup-deps.mjs
 *
 * Для базы, Valkey и NATS по очереди: зависимость остановлена → ядро запускается с
 * переменными стенда → 40 с: вышло ли оно само (и с каким кодом), отвечают ли /live и /ready →
 * зависимость возвращается → 90 с: становится ли ядро готовым само, без перезапуска.
 * Факт, а не ожидание: от него зависит, сколько падений даёт временный отказ зависимости.
 * Стендовое ядро на время прогона останавливается и в конце поднимается снова.
 */
import { spawn, spawnSync } from 'node:child_process';
import { openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portOwner, stopTree } from './lib/stand-processes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, MSYS_NO_PATHCONV: '1' };
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq > 0) env[t.slice(0, eq).trim()] ??= t.slice(eq + 1).trim();
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const code = async (url) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2_000) })).status;
  } catch {
    return 0;
  }
};
const docker = (...args) =>
  spawnSync('docker', args, { encoding: 'utf8', env, timeout: 60_000 }).status;

const DEPS = [
  { name: 'база (PostgreSQL)', container: 'fifth-postgres' },
  { name: 'Valkey', container: 'fifth-valkey' },
  { name: 'NATS', container: 'fifth-nats' },
];
const results = [];

const standPid = portOwner(4300);
if (standPid) stopTree(standPid);
try {
  for (const dep of DEPS) {
    console.warn(`\n▸ ${dep.name} остановлена`);
    docker('stop', dep.container);
    const log = openSync(join(ROOT, 'out', `startup-${dep.container}.log`), 'w');
    const child = spawn(process.execPath, [join(ROOT, 'apps/core/dist/main.js')], {
      cwd: ROOT,
      env,
      stdio: ['ignore', log, log],
    });
    let exit = null;
    child.on('exit', (c, s) => (exit = { code: c, signal: s, at: Date.now() }));
    const started = Date.now();
    let live = 0;
    let ready = 0;
    while (Date.now() - started < 40_000 && exit === null) {
      await sleep(2_000);
      live = await code('http://127.0.0.1:4400/live');
      ready = await code('http://127.0.0.1:4400/ready');
    }
    const r = {
      dep: dep.name,
      exited: exit !== null,
      exitCode: exit?.code ?? null,
      exitAfterSec: exit ? Math.round((exit.at - started) / 1000) : null,
      liveWhileDown: live,
      readyWhileDown: ready,
      readyAfterReturn: null,
    };
    docker('start', dep.container);
    if (exit === null) {
      const back = Date.now();
      while (Date.now() - back < 90_000 && exit === null) {
        await sleep(2_000);
        if ((await code('http://127.0.0.1:4400/ready')) === 200) {
          r.readyAfterReturn = Math.round((Date.now() - back) / 1000);
          break;
        }
      }
      if (exit !== null) {
        r.exited = true;
        r.exitCode = exit.code;
        r.exitAfterSec = Math.round((exit.at - started) / 1000);
      }
      child.kill('SIGTERM');
      await sleep(3_000);
      if (exit === null) child.kill('SIGKILL');
    }
    // Зависимость снова здорова перед следующей.
    for (let i = 0; i < 30; i += 1) {
      const h = spawnSync(
        'docker',
        [
          'inspect',
          '-f',
          '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
          dep.container,
        ],
        { encoding: 'utf8', env },
      ).stdout.trim();
      if (h === 'healthy' || h === 'running') break;
      await sleep(2_000);
    }
    results.push(r);
    console.warn(
      r.exited
        ? `  ядро вышло само через ${r.exitAfterSec} с, код ${r.exitCode}`
        : `  ядро не вышло: /live ${r.liveWhileDown}, /ready ${r.readyWhileDown} при отказе; ` +
            (r.readyAfterReturn === null
              ? 'после возврата готовность не наступила за 90 с'
              : `после возврата готово через ${r.readyAfterReturn} с без перезапуска`),
    );
  }
} finally {
  for (const dep of DEPS) docker('start', dep.container);
  spawnSync('npm', ['run', '-s', 'stand:up', '--', '--no-build'], {
    cwd: ROOT,
    shell: true,
    stdio: 'ignore',
    env: process.env,
  });
}
// Требование: временный отказ зависимости не роняет ядро, и оно само возвращается в готовность.
const failed = results.filter((r) => r.exited || r.readyAfterReturn === null);
for (const r of results) {
  const bad = r.exited || r.readyAfterReturn === null;
  console.warn(
    `  ${bad ? 'FAIL' : 'OK  '}  ${r.dep}: при старте не падает, после возврата готово само`,
  );
}
console.warn(`\n=== ИТОГ: ${results.length - failed.length} OK, ${failed.length} FAIL ===`);
console.warn(JSON.stringify(results));
process.exit(failed.length === 0 && results.length === DEPS.length ? 0 : 1);
