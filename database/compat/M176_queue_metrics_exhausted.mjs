/**
 * M176 — audit.queue_metrics(): исчерпанные события outbox отдельно от рабочей очереди.
 *
 * Прежнее ядро лишь вызывает функцию пулом приложения (роль app_backend) и отдаёт ответ на
 * служебный порт `/queues`; наблюдение читает ключи по имени. На новой схеме прежние ключи
 * обязаны остаться (outbox.pending, oldestAgeSec, exhausted, withError; uploads.*), а
 * функция — доступной роли ядра. Кандидат дополнительно видит exhaustedOldestAgeSec.
 *
 * Вызывается scripts/check-migration-compat.mjs в фазах `rollback` и `forward`.
 */
export default async function probe({ phase, sql, check }) {
  const raw = sql('BEGIN; SET LOCAL ROLE app_backend; SELECT audit.queue_metrics()::text; COMMIT;');
  const line = raw.split('\n').find((l) => l.trim().startsWith('{')) ?? '';
  let m = null;
  try {
    m = JSON.parse(line);
  } catch {
    /* ниже — отказ проверки */
  }
  check('функция очередей доступна роли ядра и отвечает JSON', m !== null, line.slice(0, 120));
  const outbox = m?.outbox ?? {};
  const uploads = m?.uploads ?? {};
  for (const key of ['pending', 'oldestAgeSec', 'exhausted', 'withError']) {
    check(
      `прежний ключ outbox.${key} на месте`,
      typeof outbox[key] === 'number',
      String(outbox[key]),
    );
  }
  for (const key of ['pending', 'oldestPendingAgeSec', 'needsAttention']) {
    check(
      `прежний ключ uploads.${key} на месте`,
      typeof uploads[key] === 'number',
      String(uploads[key]),
    );
  }
  if (phase === 'forward') {
    check(
      'кандидат видит возраст старейшего исчерпанного',
      typeof outbox.exhaustedOldestAgeSec === 'number',
      String(outbox.exhaustedOldestAgeSec),
    );
  }
}
