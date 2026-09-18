-- M086 — раскрытие раунда: статус отдельно от суммы; версия условий у раунда.
--
-- Уточнения владельца 2026-09-18 (после 5.6.4д):
--
--  1. Статус привлечения («привлекает / приостановлено / не привлекает») —
--     ОТДЕЛЬНАЯ настройка, не привязанная к investment_ask: можно показывать
--     статус, скрывая сумму. Ключ настройки — `raising_status` в блоке
--     `disclosure` конфигурации формы (те же четыре уровня видимости, та же
--     публикация версии с основанием). Сумма и валюта остаются группой под
--     `investment_ask`; сумма без статуса не показывается (нет смысла).
--
--  2. Чтение активной конфигурации для всех раундов создавало риск
--     ретроспективного раскрытия: смена investors → public молча открыла бы
--     ранее закрытые суммы. До 5.7 (связь административной политики,
--     разрешения владельца и версии условий) действует правило:
--     эффективная видимость поля раунда = СТРОЖЕ из (активная конфигурация,
--     версия условий раскрытия раунда). Версия условий фиксируется у раунда
--     при открытии (`disclosure_version`), до открытия — версия
--     конфигурации черновика. Итог: ограничение применяется сразу и без
--     остатка прежней утечки; расширение публичности не касается уже
--     открытых раундов — только раундов, открытых после публикации.
--
--  3. Версия без блока `disclosure` (старые версии): статус берёт видимость
--     `investment_ask` той же версии — так правило действовало до M086; нет и
--     вопроса — `private` (fail-closed).

ALTER TABLE lab.funding_rounds ADD COLUMN IF NOT EXISTS disclosure_version INTEGER;
COMMENT ON COLUMN lab.funding_rounds.disclosure_version IS
    'Версия конфигурации формы, действовавшая при открытии раунда — версия условий раскрытия (M086). '
    'NULL у черновика: тогда берётся schema_version.';

-- ---------------------------------------------------------------- правило
-- Строже из двух видимостей; неизвестное значение — private (fail-closed).
CREATE OR REPLACE FUNCTION lab.stricter_visibility(p_a TEXT, p_b TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    WITH ranked AS (
        SELECT v, CASE v WHEN 'public' THEN 0 WHEN 'investors' THEN 1 WHEN 'platform' THEN 2 ELSE 3 END AS r
          FROM (VALUES (p_a), (p_b)) AS t(v)
    )
    SELECT CASE (SELECT MAX(r) FROM ranked)
             WHEN 0 THEN 'public'
             WHEN 1 THEN 'investors'
             WHEN 2 THEN 'platform'
             ELSE 'private'
           END;
$$;
GRANT EXECUTE ON FUNCTION lab.stricter_visibility(TEXT, TEXT) TO PUBLIC;

-- Видимость ключа в КОНКРЕТНОЙ версии конфигурации.
CREATE OR REPLACE FUNCTION lab.version_field_visibility(p_version INTEGER, p_key TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab
AS $$
    WITH v AS (
        SELECT config_jsonb FROM lab.application_form_versions WHERE version = p_version LIMIT 1
    ),
    q AS (
        SELECT q->>'visibility' AS vis
          FROM v, jsonb_array_elements(v.config_jsonb->'questions') q
         WHERE q->>'key' = p_key AND q->>'archivedAt' IS NULL
         LIMIT 1
    ),
    d AS (
        SELECT v.config_jsonb->'disclosure'->>p_key AS vis FROM v
    ),
    legacy AS (
        -- До M086 статус шёл вместе с суммой: для версий без блока disclosure
        -- статус наследует видимость investment_ask той же версии.
        SELECT q->>'visibility' AS vis
          FROM v, jsonb_array_elements(v.config_jsonb->'questions') q
         WHERE p_key = 'raising_status' AND q->>'key' = 'investment_ask' AND q->>'archivedAt' IS NULL
         LIMIT 1
    )
    SELECT COALESCE((SELECT vis FROM q), (SELECT vis FROM d), (SELECT vis FROM legacy), 'private');
$$;
REVOKE ALL ON FUNCTION lab.version_field_visibility(INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.version_field_visibility(INTEGER, TEXT)
    TO app_public_read, app_backend, app_integration;
COMMENT ON FUNCTION lab.version_field_visibility(INTEGER, TEXT) IS
    'Видимость ключа в версии конфигурации: вопрос → блок disclosure → (для raising_status) investment_ask → private.';

-- Активная конфигурация — через ту же функцию (сигнатура M085 сохранена).
CREATE OR REPLACE FUNCTION lab.field_visibility(p_key TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab
AS $$
    SELECT lab.version_field_visibility(
        (SELECT version FROM lab.application_form_versions WHERE is_active LIMIT 1), p_key);
$$;

-- Эффективная видимость поля раунда: строже из активной и версии условий
-- раунда. Без раунда (NULL) — активная.
CREATE OR REPLACE FUNCTION lab.round_field_visibility(p_key TEXT, p_round_version INTEGER)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab
AS $$
    SELECT CASE
             WHEN p_round_version IS NULL THEN lab.field_visibility(p_key)
             ELSE lab.stricter_visibility(lab.field_visibility(p_key),
                                          lab.version_field_visibility(p_round_version, p_key))
           END;
$$;
REVOKE ALL ON FUNCTION lab.round_field_visibility(TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.round_field_visibility(TEXT, INTEGER)
    TO app_public_read, app_backend, app_integration;
COMMENT ON FUNCTION lab.round_field_visibility(TEXT, INTEGER) IS
    'Строже из активной конфигурации и версии условий раскрытия раунда (M086): '
    'ограничение действует сразу, расширение — только на раунды, открытые после публикации.';

-- ---------------------------------------------------------------- проекция
CREATE OR REPLACE FUNCTION lab.round_projection(p_project UUID, p_audience TEXT, p_full BOOLEAN)
RETURNS TABLE (
    raising            TEXT,
    target             NUMERIC,
    currency           CHAR(3),
    funding_scope      TEXT,
    funding_scope_note TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab
AS $$
    WITH r AS (
        SELECT r.status, r.target, r.currency, r.funding_scope, r.funding_scope_note,
               COALESCE(r.disclosure_version, r.schema_version) AS dv
          FROM lab.funding_rounds r
         WHERE r.project_id = p_project
           AND r.status IN ('open', 'paused')
         LIMIT 1
    ),
    vis AS (
        SELECT p_full OR lab.visible_to(lab.round_field_visibility('raising_status', r.dv), p_audience)     AS status_ok,
               p_full OR lab.visible_to(lab.round_field_visibility('investment_ask', r.dv), p_audience)     AS ask_ok,
               p_full OR lab.visible_to(lab.round_field_visibility('funding_scope', r.dv), p_audience)      AS scope_ok,
               p_full OR lab.visible_to(lab.round_field_visibility('funding_scope_note', r.dv), p_audience) AS note_ok
          FROM (SELECT (SELECT dv FROM r) AS dv) r
    )
    SELECT CASE WHEN NOT vis.status_ok THEN 'undisclosed' ELSE COALESCE(r.status, 'none') END,
           CASE WHEN vis.status_ok AND vis.ask_ok THEN r.target END,
           CASE WHEN vis.status_ok AND vis.ask_ok THEN r.currency END,
           CASE WHEN vis.status_ok AND vis.scope_ok THEN r.funding_scope END,
           CASE WHEN vis.status_ok AND vis.scope_ok AND vis.note_ok THEN r.funding_scope_note END
      FROM vis
      LEFT JOIN r ON true;
$$;
COMMENT ON FUNCTION lab.round_projection(UUID, TEXT, BOOLEAN) IS
    'Внутренняя проекция незавершённого раунда: статус по raising_status, сумма и валюта по '
    'investment_ask (только вместе со статусом), предмет по funding_scope; эффективная видимость — '
    'строже из активной конфигурации и версии условий раунда (M086).';
