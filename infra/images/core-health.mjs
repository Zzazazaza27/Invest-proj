// Проверка живости контейнера ядра: служебный /live, а не публичный /v1/health.
//
// Docker сам не перезапускает контейнер за «unhealthy», поэтому зависший процесс
// снимается здесь: три отказа подряд после первого успеха — SIGKILL главному
// процессу, дальше работает `restart: unless-stopped`. Нужен `init: true`: процесс
// №1 в контейнере убить изнутри нельзя. До первого успеха ядро ещё стартует, и
// отказы не считаются. Готовность (/ready) здесь не смотрим: отказ базы выводит
// из готовности, но исправный процесс перезапускать незачем.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const PORT = process.env.CORE_INTERNAL_PORT || '4400';
const FAILS = '/tmp/core-live-fails';
const SEEN = '/tmp/core-live-seen';
const LIMIT = 3;

function killCore() {
  // Процесс №1 — `init` контейнера: его командная строка тоже содержит main.js.
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d) && d !== '1')) {
    let cmd;
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (cmd.includes('apps/core/dist/main.js')) process.kill(Number(pid), 'SIGKILL');
  }
}

let live;
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/live`, { signal: AbortSignal.timeout(2500) });
  live = r.ok;
} catch {
  live = false;
}
if (live) {
  writeFileSync(SEEN, '1');
  writeFileSync(FAILS, '0');
  process.exit(0);
}
if (existsSync(SEEN)) {
  const fails = Number(existsSync(FAILS) ? readFileSync(FAILS, 'utf8') : 0) + 1;
  writeFileSync(FAILS, String(fails));
  if (fails >= LIMIT) killCore();
}
process.exit(1);
