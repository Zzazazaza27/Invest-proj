/**
 * M170 — общая проверка ссылок из писем (identity.link_token_alive).
 *
 * Прежнее ядро новую функцию не вызывает; его подтверждение почты идёт прежней функцией
 * identity.confirm_email_with_token (M060) — на новой схеме она обязана отвечать как раньше:
 * отказ ссылки, а не ошибка сервера. Кандидат — новая проверка доступна роли app_auth.
 *
 * Вызывается scripts/check-migration-compat.mjs в фазах `rollback` (прежнее ядро на новой
 * схеме) и `forward` (кандидат после возврата прежнего).
 */
export default async function probe({ phase, client, check }) {
  const bogus = 'c'.repeat(43);
  const c = client();
  const confirm = await c.call('/v1/auth/email/verify/confirm', {
    method: 'POST',
    body: { token: bogus },
  });
  check(
    'подтверждение почты по чужой ссылке — отказ ссылки, не сбой',
    confirm.status === 400,
    `HTTP ${confirm.status}`,
  );
  if (phase === 'forward') {
    const r = await c.call('/v1/auth/link/check', {
      method: 'POST',
      body: { purpose: 'email_verify', token: bogus },
    });
    check('общая проверка ссылки доступна кандидату', r.status === 400, `HTTP ${r.status}`);
  }
}
