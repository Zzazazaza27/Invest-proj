/**
 * Оценка отказов при отключении служебной учётки мониторинга
 * (scripts/monitor-probe-disable.mjs; замечание Тэнка 2026-11-02).
 *
 * Блокировка подтверждается только ожидаемым отказом по причине блокировки,
 * а не любым «не 200»: недоступность сервиса (503), ограничение частоты
 * (429), неверный адрес (404) запрет входа не доказывают.
 *
 * Вход: ядро сначала проверяет пароль (неверный — 401), затем статус учётки
 * (заблокирована — 403 `forbidden`, причина `account-status` во внутренних
 * подробностях, наружу не выдаётся). Поэтому подтверждение входа — это сразу
 * три условия: HTTP 403, тип ответа `…/forbidden` (не `step_up_required`) и
 * статус учётки в базе `suspended`.
 */

const typeOf = (body) => (body && typeof body === 'object' ? String(body.type ?? '') : '');

/** Отказ входа паролем пробы подтверждает блокировку? */
export function loginDenialVerdict(status, body, dbStatus) {
  if (status !== 403)
    return { ok: false, reason: `вход: HTTP ${status} — ожидался 403 по блокировке учётки` };
  if (!/\/forbidden$/.test(typeOf(body)))
    return {
      ok: false,
      reason: `вход: 403, но тип ответа «${typeOf(body) || 'нет'}» — не блокировка`,
    };
  if (dbStatus !== 'suspended')
    return {
      ok: false,
      reason: `вход: 403, но статус учётки в базе «${dbStatus}», а не suspended`,
    };
  return { ok: true, reason: 'вход отклонён: 403 forbidden, учётка в базе suspended' };
}

/** Отказ сохранённой сессией подтверждает отзыв сессий? */
export function sessionDenialVerdict(status, body) {
  if (status !== 401)
    return { ok: false, reason: `сессия: HTTP ${status} — ожидался 401 (сессия отозвана)` };
  if (!/\/unauthenticated$/.test(typeOf(body)))
    return { ok: false, reason: `сессия: 401, но тип ответа «${typeOf(body) || 'нет'}»` };
  return { ok: true, reason: 'сохранённая сессия отклонена: 401 unauthenticated' };
}
