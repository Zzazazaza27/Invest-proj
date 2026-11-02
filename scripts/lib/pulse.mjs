/**
 * Оценка свежести контрольной отметки Zabbix для пульса (2.1-W08a).
 *
 * Свежая — только корректное время `lastclock` (целое число секунд > 0), не
 * старше порога и не из будущего сверх допуска на расхождение часов
 * (замечание Тэнка 2026-11-02: условие `age <= FRESH_SEC` принимало и
 * отметку из будущего, а публичный pulse.json с текущим временем это скрыл бы).
 */
export const PULSE_CLOCK_SKEW_SEC = 60;

export function pulseVerdict(lastclock, nowSec, freshSec, skewSec = PULSE_CLOCK_SKEW_SEC) {
  const clock = Number(lastclock);
  if (
    lastclock === null ||
    lastclock === undefined ||
    lastclock === '' ||
    !Number.isInteger(clock) ||
    clock <= 0
  )
    return { ok: false, reason: 'контрольная отметка без корректного времени' };
  const age = Math.round(nowSec - clock);
  if (age < -skewSec) return { ok: false, reason: `контрольная отметка из будущего: на ${-age} с` };
  if (age > freshSec) return { ok: false, reason: `контрольная отметка устарела: ${age} с` };
  return { ok: true, reason: `контрольная отметка ${Math.max(age, 0)} с назад` };
}
