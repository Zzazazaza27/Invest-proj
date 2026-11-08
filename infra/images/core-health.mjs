// Проверка живости контейнера ядра: служебный /live, а не публичный /v1/health.
//
// Docker сам не перезапускает контейнер за «unhealthy», поэтому зависший процесс
// снимается здесь: SIGKILL главному процессу, дальше работает `restart: unless-stopped`.
// Нужен `init: true`: процесс №1 в контейнере убить изнутри нельзя. Готовность (/ready)
// здесь не смотрим: отказ базы выводит из готовности, но исправный процесс перезапускать
// незачем.
//
// Когда убивать и когда остановить автовосстановление — правило core-health-policy.mjs
// (предел перезапусков зависшего ядра, решение Томаса 09.11.2026). Состояние — в файле
// контейнера: оно переживает перезапуск контейнера (журнал убийств за окно) и обнуляется
// при пересоздании, то есть при выпуске. Строка состояния печатается каждый раз: Docker
// хранит её в журнале проверки, monitor-export выгружает recovery=stopped в наблюдение.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { decide, initialState } from './core-health-policy.mjs';

const PORT = process.env.CORE_INTERNAL_PORT || '4400';
const STATE = '/tmp/core-health.json';

/** Процесс ядра: «pid:время старта» (поле 22 /proc/<pid>/stat) — опознание переживает переиспользование pid. */
function coreProcess() {
  // Процесс №1 — `init` контейнера: его командная строка тоже содержит main.js, поэтому пропускается.
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d) && d !== '1')) {
    try {
      // Точно команда образа: процесс, у которого эта строка лишь среди аргументов
      // (диагностика через docker exec), за ядро не принимается.
      if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').startsWith('node\0apps/core/dist/main.js'))
        continue;
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      return { pid: Number(pid), id: `${pid}:${start}` };
    } catch {
      continue;
    }
  }
  return null;
}

function load() {
  try {
    return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : initialState();
  } catch {
    return initialState();
  }
}

let live;
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/live`, { signal: AbortSignal.timeout(2500) });
  live = r.ok;
} catch {
  live = false;
}
const proc = coreProcess();
const result = decide(load(), { now: Date.now(), live, proc: proc?.id ?? null });
writeFileSync(`${STATE}.tmp`, JSON.stringify(result.state));
renameSync(`${STATE}.tmp`, STATE);
if (result.action === 'kill' && proc) process.kill(proc.pid, 'SIGKILL');
// В stdout: Docker хранит вывод проверки в журнале здоровья контейнера.
const line = result.action === 'kill' ? `${result.status} action=kill` : result.status;
process.stdout.write(`${line}\n`);
process.exit(result.exitCode);
