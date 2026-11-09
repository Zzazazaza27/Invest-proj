/**
 * M171 — контекст автора в журнале (блок 10).
 *
 * Функция журнала заменена: прежнее ядро пишет события БЕЗ `actor` и с прежними ролями —
 * на новой схеме это обязано проходить как раньше (реестр роли только добавляет).
 * Основная проверка — в самом прогоне совместимости: прежнее ядро создаёт проект A2
 * (`lab.project.created` в одной транзакции с изменением — отказ журнала уронил бы
 * создание). Здесь дополнительно — путь до входа: неудачный вход отвечает отказом входа.
 *
 * Вызывается scripts/check-migration-compat.mjs в фазах `rollback` и `forward`.
 */
export default async function probe({ client, check }) {
  const c = client();
  const r = await c.call('/v1/auth/login', {
    method: 'POST',
    body: { email: `nobody-${Date.now()}@example.test`, password: 'wrong-password-123' },
  });
  check('неудачный вход — отказ входа, не сбой', r.status === 401, `HTTP ${r.status}`);
}
