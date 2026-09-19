/**
 * Восстановление условий страны после прогонов.
 *
 * Условия страны версионируются и не переписываются: «откатить» их нельзя,
 * прежнее значение возвращается НОВОЙ версией. Для локальных тестовых данных
 * лишние версии в истории — норма (решение владельца 2026-09-19), а вот
 * оставить включённой настройку, которую прогон включал временно, — нет:
 * следующий прогон и ручная проверка увидели бы чужое состояние.
 *
 * Восстановление идёт ПРЯМО В БАЗУ, а не через API, намеренно: это путь
 * уборки, и он обязан отработать даже тогда, когда проверка упала из-за
 * недоступного ядра или незалогиненной сессии. Идемпотентно: если активные
 * условия уже совпадают с исходными, новая версия не создаётся.
 */

/** Конфигурация действующей версии условий страны. */
export async function activePolicyConfig(sql, code = 'ru') {
  const [row] = await sql(
    `SELECT config_jsonb FROM billing.service_country_policies
      WHERE country_code = $1 AND is_active`,
    [code],
  );
  return row?.config_jsonb ?? null;
}

/**
 * Возвращает условия страны к `config`, если они изменились. Вызывать в
 * `finally` — тогда падение проверки не оставляет включённой настройку.
 */
export async function restoreCountryPolicy(
  sql,
  code,
  config,
  reason = 'прогон проверки: возврат исходных условий',
) {
  if (!config) return false;
  const current = await activePolicyConfig(sql, code);
  if (current && JSON.stringify(current) === JSON.stringify(config)) return false;

  // Снятие действующей версии и публикация исходной — ОДНИМ запросом.
  // Раздельными эти два действия уже подводили: вставка упала на пустом
  // основании, прежняя версия осталась снятой, и страна осталась вообще без
  // действующих условий — то есть неудачное восстановление сломало стенд
  // сильнее, чем сам прерванный прогон.
  await sql(
    `WITH closed AS (
       UPDATE billing.service_country_policies SET is_active = false
        WHERE country_code = $1 AND is_active
        RETURNING 1
     )
     INSERT INTO billing.service_country_policies
       (id, country_code, version, config_jsonb, is_active, reason)
     SELECT public.uuid_generate_v7(), $1,
            (SELECT COALESCE(MAX(version), 0) + 1 FROM billing.service_country_policies
              WHERE country_code = $1),
            $2, true, $3
       FROM (SELECT count(*) FROM closed) AS _`,
    [code, JSON.stringify(config), reason],
  );
  return true;
}
