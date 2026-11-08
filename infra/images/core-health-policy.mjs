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
//   * зависание при запуске — процесс не дал первого успешного /live за STARTUP_DEADLINE_MS от
//     СВОЕГО запуска (запись обёртки core-start.mjs о запуске именно этого процесса; ожидание
//     редкого режима W24 до запуска не входит). Снимается так же и входит в тот же счёт:
//     KILL_LIMIT за WINDOW_MS, дальше остановка (решение Тэнка и Томаса 09.11.2026). Первый
//     успешный /live переводит процесс под обычное правило зависания.
//
// Предел относится только к зависаниям. Процесс, упавший сам, перезапускает Docker — это
// отдельный открытый пункт.

export const FAIL_LIMIT = 3;
export const KILL_LIMIT = 3;
export const WINDOW_MS = 30 * 60_000;
export const CLEAR_AFTER = 3;
export const STARTUP_DEADLINE_MS = 5 * 60_000;

export function initialState() {
  return {
    proc: null,
    seen: false,
    fails: 0,
    okStreak: 0,
    kills: [],
    stoppedAt: null,
    startupMs: null,
    stage: null,
  };
}

/**
 * @param {ReturnType<typeof initialState>} prev
 * @param {{ now: number, live: boolean, proc: string | null, startedAt?: number | null,
 *   deadlineMs?: number }} probe
 *   proc — опознание текущего процесса ядра («pid:время старта»), null — процесса нет;
 *   startedAt — время запуска ЭТОГО процесса по записи обёртки (null — записи нет или она
 *   о другом процессе: тогда предела запуска нет).
 */
export function decide(prev, probe) {
  const state = { ...initialState(), ...prev, kills: [...(prev?.kills ?? [])] };
  const { now, live, proc } = probe;
  const startedAt = probe.startedAt ?? null;
  const deadlineMs = probe.deadlineMs ?? STARTUP_DEADLINE_MS;
  // Другой процесс — свой счёт отказов и свой «первый успех».
  if (proc !== state.proc) {
    state.proc = proc;
    state.seen = false;
    state.fails = 0;
    state.okStreak = 0;
    state.startupMs = null;
    state.stage = null;
  }
  state.kills = state.kills.filter((t) => now - t < WINDOW_MS);
  let action = 'none';

  if (live) {
    if (!state.seen && startedAt !== null) state.startupMs = now - startedAt;
    state.seen = true;
    state.stage = null;
    state.fails = 0;
    state.okStreak += 1;
    if (state.stoppedAt !== null && state.okStreak >= CLEAR_AFTER) state.stoppedAt = null;
  } else {
    state.okStreak = 0;
    let hung = false;
    if (state.seen && proc !== null) {
      state.fails += 1;
      hung = state.fails >= FAIL_LIMIT;
      if (hung) state.stage = 'run';
    } else if (proc !== null && startedAt !== null && now - startedAt >= deadlineMs) {
      // Ни одного успешного /live за предел от запуска этого процесса.
      hung = true;
      state.stage = 'start';
    }
    if (hung) {
      if (state.kills.length >= KILL_LIMIT) {
        state.stoppedAt ??= now;
      } else if (state.stoppedAt === null) {
        state.kills.push(now);
        action = 'kill';
      }
    }
  }

  const status =
    `core-health live=${live ? 1 : 0} recovery=${state.stoppedAt === null ? 'active' : 'stopped'} ` +
    `kills=${state.kills.length}/${Math.round(WINDOW_MS / 60_000)}m` +
    (state.stoppedAt === null ? '' : ` stopped_at=${new Date(state.stoppedAt).toISOString()}`) +
    (state.stage === 'start' ? ' stage=start' : '') +
    (state.startupMs === null ? '' : ` startup=${(state.startupMs / 1000).toFixed(1)}s`);
  return { state, action, status, exitCode: live ? 0 : 1 };
}
