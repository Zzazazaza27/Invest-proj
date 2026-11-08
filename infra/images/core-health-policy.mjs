// Правило проверки живости ядра (блок 2, 2.4; решение Томаса 09.11.2026). Чистая функция:
// состояние и итог опроса /live на входе — новое состояние, действие и строка состояния на
// выходе. Файлы, /proc и сигналы — в core-health.mjs.
//
//   * зависание — FAIL_LIMIT отказов /live подряд ПОСЛЕ первого успеха этого процесса;
//   * автоматический перезапуск зависшего — не больше KILL_LIMIT за скользящие WINDOW_MS;
//     следующее зависание — остановка автовосстановления: процесс не убивается (остаётся
//     для разбора), контейнер unhealthy, в строке состояния recovery=stopped — тревога;
//   * отметка остановки снимается после CLEAR_AFTER успешных /live подряд;
//   * счётчик отказов принадлежит процессу (pid и время старта): новый процесс после
//     перезапуска начинает с нуля и до своего первого успеха не убивается — иначе
//     перезапущенное ядро добивалось бы во время старта (журнал контейнера переживает
//     перезапуск).
//
// Предел относится только к зависаниям. Процесс, упавший сам, перезапускает Docker — это
// отдельный открытый пункт.

export const FAIL_LIMIT = 3;
export const KILL_LIMIT = 3;
export const WINDOW_MS = 30 * 60_000;
export const CLEAR_AFTER = 3;

export function initialState() {
  return { proc: null, seen: false, fails: 0, okStreak: 0, kills: [], stoppedAt: null };
}

/**
 * @param {ReturnType<typeof initialState>} prev
 * @param {{ now: number, live: boolean, proc: string | null }} probe
 *   proc — опознание текущего процесса ядра («pid:время старта»), null — процесса нет.
 */
export function decide(prev, probe) {
  const state = { ...initialState(), ...prev, kills: [...(prev?.kills ?? [])] };
  const { now, live, proc } = probe;
  // Другой процесс — свой счёт отказов и свой «первый успех».
  if (proc !== state.proc) {
    state.proc = proc;
    state.seen = false;
    state.fails = 0;
    state.okStreak = 0;
  }
  state.kills = state.kills.filter((t) => now - t < WINDOW_MS);
  let action = 'none';

  if (live) {
    state.seen = true;
    state.fails = 0;
    state.okStreak += 1;
    if (state.stoppedAt !== null && state.okStreak >= CLEAR_AFTER) state.stoppedAt = null;
  } else {
    state.okStreak = 0;
    if (state.seen && proc !== null) {
      state.fails += 1;
      if (state.fails >= FAIL_LIMIT) {
        if (state.kills.length >= KILL_LIMIT) {
          state.stoppedAt ??= now;
        } else if (state.stoppedAt === null) {
          state.kills.push(now);
          action = 'kill';
        }
      }
    }
  }

  const status =
    `core-health live=${live ? 1 : 0} recovery=${state.stoppedAt === null ? 'active' : 'stopped'} ` +
    `kills=${state.kills.length}/${Math.round(WINDOW_MS / 60_000)}m` +
    (state.stoppedAt === null ? '' : ` stopped_at=${new Date(state.stoppedAt).toISOString()}`);
  return { state, action, status, exitCode: live ? 0 : 1 };
}
