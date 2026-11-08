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
import { crashMode } from './core-start-policy.mjs';

const PORT = process.env.CORE_INTERNAL_PORT || '4400';
const STATE = '/tmp/core-health.json';
const START = '/tmp/core-start.json';

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
const now = Date.now();
const prev = load();
// Запись обёртки о запуске (core-start.mjs): время запуска и опознание процесса.
const readStart = () => {
  try {
    return existsSync(START) ? JSON.parse(readFileSync(START, 'utf8')) : {};
  } catch {
    return {};
  }
};
const start = readStart();
// Предел запуска — только для процесса, о запуске которого есть запись обёртки.
const startedAt = proc && start.startId === proc.id ? (start.lastStart ?? null) : null;
const result = decide(prev, {
  now,
  live,
  proc: proc?.id ?? null,
  startedAt,
  // Короче — только в пробе (check-core-hang-limit); в образе не задаётся.
  deadlineMs: Number(process.env.CORE_STARTUP_DEADLINE_MS) || undefined,
});
// Петля падений (core-start.mjs): редкий режим и его снятие после трёх успехов этого процесса.
const crash = crashMode(start, prev.slowClearedFor ?? null, {
  now,
  procId: proc?.id ?? null,
  okStreak: result.state.okStreak,
});
const next = { ...result.state, slowClearedFor: crash.cleared };
// Убитый как зависший процесс отмечается: обёртка не считает его выход падением.
if (result.action === 'kill' && proc) next.lastKill = proc.id;
writeFileSync(`${STATE}.tmp`, JSON.stringify(next));
renameSync(`${STATE}.tmp`, STATE);
if (result.action === 'kill' && proc) process.kill(proc.pid, 'SIGKILL');
// В stdout: Docker хранит вывод проверки в журнале здоровья контейнера.
const crashPart =
  ` mode=${crash.slow ? 'slow' : 'normal'} crashes=${crash.crashes}/30m` +
  (crash.nextStart ? ` next_start=${new Date(crash.nextStart).toISOString()}` : '');
const line = `${result.status}${crashPart}${result.action === 'kill' ? ' action=kill' : ''}`;
process.stdout.write(`${line}\n`);
process.exit(result.exitCode);
