// Правило запуска ядра при петле падений (блок 2, 2.4; решение Томаса 09.11.2026). Чистые
// функции: состояние и событие на входе — новое состояние и решение на выходе. Процессы и файлы —
// в core-start.mjs.
//
//   * незапланированный выход — выход процесса ядра, который не вызван запросом остановки,
//     полученным обёрткой, и не убийство зависшего процесса проверкой здоровья (оно учтено
//     пределом зависаний, core-health-policy.mjs);
//   * после третьего незапланированного выхода за скользящие WINDOW_MS следующий запуск
//     откладывается до SLOW_MS после предыдущего запуска; при дальнейших падениях — не чаще
//     одного запуска за SLOW_MS (редкий режим, тревога);
//   * редкий режим снимается проверкой здоровья после трёх успешных /live подряд, но история
//     падений за окно НЕ стирается: краткое оживание не открывает снова частую петлю.

export const CRASH_LIMIT = 3;
export const WINDOW_MS = 30 * 60_000;
export const SLOW_MS_DEFAULT = 10 * 60_000;

export function initialStartState() {
  return { crashes: [], lastStart: null, slow: false, startId: null };
}

/** Перед запуском: сколько ждать и в редком ли режиме. */
export function beforeStart(prev, now, slowMs = SLOW_MS_DEFAULT) {
  const state = { ...initialStartState(), ...prev };
  state.crashes = (state.crashes ?? []).filter((t) => now - t < WINDOW_MS);
  if (state.crashes.length >= CRASH_LIMIT && state.lastStart !== null) {
    const next = state.lastStart + slowMs;
    return { state: { ...state, slow: true }, delayMs: Math.max(0, next - now), slow: true };
  }
  return { state: { ...state, slow: false }, delayMs: 0, slow: false };
}

/** Запуск состоялся: время и опознание процесса («pid:время старта»). */
export function started(prev, now, startId) {
  return { ...initialStartState(), ...prev, lastStart: now, startId };
}

/**
 * Процесс ядра вышел. stopRequested — обёртка получила запрос остановки ДО выхода;
 * killedByHealth — процесс убит проверкой здоровья как зависший.
 */
export function exited(prev, now, { stopRequested, killedByHealth }) {
  const state = { ...initialStartState(), ...prev, crashes: [...(prev?.crashes ?? [])] };
  const crash = !stopRequested && !killedByHealth;
  if (crash) state.crashes.push(now);
  state.crashes = state.crashes.filter((t) => now - t < WINDOW_MS);
  return { state, crash };
}

/**
 * Редкий режим для строки состояния проверки здоровья. Активен, пока обёртка ждёт следующего
 * запуска, и после запуска в редком режиме — до CLEAR_AFTER успешных /live подряд именно этого
 * процесса. Снятие помечается опознанием процесса (cleared): история падений не трогается.
 */
export const CLEAR_AFTER = 3;
export function crashMode(start, cleared, { now, procId, okStreak }) {
  const s = { ...initialStartState(), ...start };
  const waiting = s.nextStart !== null && s.nextStart !== undefined;
  let mark = cleared ?? null;
  if (s.slow && !waiting && procId !== null && procId === s.startId && okStreak >= CLEAR_AFTER) {
    mark = s.startId;
  }
  const slow = waiting || (s.slow && mark !== s.startId);
  const crashes = (s.crashes ?? []).filter((t) => now - t < WINDOW_MS).length;
  return { slow, cleared: mark, crashes, nextStart: waiting ? s.nextStart : null };
}
