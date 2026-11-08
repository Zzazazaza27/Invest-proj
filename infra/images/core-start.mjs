// Обёртка запуска ядра (блок 2, 2.4; петля падений, решение Томаса 09.11.2026).
//
// Цепочка процессов: init контейнера → эта обёртка → `node apps/core/dist/main.js` (ядро).
// Обёртка ядро НЕ перезапускает: любой выход ядра — выход обёртки с тем же кодом, контейнер
// перезапускает Docker (`restart: unless-stopped`), как и до неё. Поэтому:
//   * зависание (W23): проверка здоровья убивает ядро → обёртка выходит → Docker поднимает
//     контейнер; на четвёртом зависании ядро не убивается, обёртка просто ждёт — остановку
//     автовосстановления она не обходит;
//   * падение: выход ядра записывается в журнал (файл контейнера: переживает перезапуск,
//     обнуляется при выпуске), обёртка выходит; при следующем запуске правило
//     core-start-policy.mjs решает, сразу ли запускать ядро или ждать (редкий режим).
// Запрос остановки (SIGTERM/SIGINT от init) обёртка передаёт ядру и отмечает до его выхода —
// такой выход не падение. Во время ожидания редкого режима запрос остановки завершает
// контейнер сразу, без запуска ядра.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { beforeStart, exited, initialStartState, started } from './core-start-policy.mjs';

const STATE = '/tmp/core-start.json';
const HEALTH = '/tmp/core-health.json';
const SLOW_MS = Number(process.env.CORE_START_SLOW_MS || 10 * 60_000);
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

const read = (file, fallback) => {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
};
const save = (state) => {
  writeFileSync(`${STATE}.tmp`, JSON.stringify(state));
  renameSync(`${STATE}.tmp`, STATE);
};
const say = (line) => process.stderr.write(`core-start: ${line}\n`);
const processId = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return `${pid}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
  } catch {
    return null;
  }
};

let stopRequested = false;
let child = null;
let wakeUp = null;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopRequested = true;
    if (child) child.kill(signal);
    else if (wakeUp) wakeUp();
    else process.exit(0);
  });
}

const decision = beforeStart(read(STATE, initialStartState()), Date.now(), SLOW_MS);
let state = decision.state;
if (decision.delayMs > 0) {
  state = { ...state, nextStart: Date.now() + decision.delayMs };
  save(state);
  say(`редкий режим: запуск через ${Math.round(decision.delayMs / 1000)} с`);
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, decision.delayMs);
    wakeUp = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  if (stopRequested) process.exit(0);
}

child = spawn('node', ['apps/core/dist/main.js'], { stdio: 'inherit' });
const childId = processId(child.pid);
state = started({ ...state, nextStart: null }, Date.now(), childId);
save(state);

child.on('exit', (code, signal) => {
  const health = read(HEALTH, {});
  const killedByHealth = signal === 'SIGKILL' && childId !== null && health.lastKill === childId;
  const result = exited(read(STATE, state), Date.now(), { stopRequested, killedByHealth });
  save(result.state);
  if (result.crash) say(`ядро вышло без запроса остановки (${signal ?? `код ${code}`})`);
  process.exit(code ?? 128 + (SIGNALS[signal] ?? 1));
});
