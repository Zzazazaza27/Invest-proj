-- M181 — автоматическое ограничение группы «Файлы» по месту на диске (работа № 4 раздела 01,
-- 06 Load «Место на диске», 6.4; решение Томаса 12.11: «через ограничение «Файлы»»).
--
-- Ядро диск хоста не видит. Его видит служба хоста (`scripts/disk-guard.mjs`, таймер раз в
-- минуту): она измеряет занятость файловой системы с данными и сообщает её сюда. Правило:
--  * занято ≥ 85 % (или прогноз исчерпания < суток, его считает служба) — запись группы
--    «Файлы» закрывается: новые загрузки и изменения файлов не выдаются, чтение остаётся;
--  * ниже 80 % — ограничение снимается само (разрыв в 5 п. п. — без дребезга у порога);
--  * пользовательские данные не удаляются ничем из этого.
-- Это ОТДЕЛЬНЫЙ источник: ручное ограничение (M161) им не меняется и не снимается, и
-- наоборот. Каждое введение и снятие — событие журнала действий (автор — система, основание —
-- служба хоста с измерением).
--
-- Служба вызывает функцию от владельца таблиц (как прочие операции хоста); EXECUTE не выдан
-- никому. Ядро только читает действующее ограничение.
--
-- migrate:compat-none: новая таблица и функция; прежний код таблицу не читает — у него автоограничения просто нет (как до миграции).

CREATE TABLE availability.auto_restrictions (
    group_id     TEXT        NOT NULL CHECK (group_id IN ('files')),
    source       TEXT        NOT NULL CHECK (source IN ('disk')),
    mode         TEXT        NOT NULL CHECK (mode IN ('read_only')),
    used_pct     NUMERIC(5,2) NOT NULL CHECK (used_pct BETWEEN 0 AND 100),
    forecast_h   NUMERIC,
    mount        TEXT        NOT NULL CHECK (length(mount) BETWEEN 1 AND 200),
    set_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, source)
);

COMMENT ON TABLE availability.auto_restrictions IS
    'Автоматические ограничения групп функций (M181): источник — служба хоста (диск). '
    'Отдельно от ручных ограничений; снимаются сами при возврате ниже порога.';

ALTER TABLE availability.auto_restrictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability.auto_restrictions FORCE ROW LEVEL SECURITY;
CREATE POLICY auto_restrictions_owner ON availability.auto_restrictions
    FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
CREATE POLICY auto_restrictions_read ON availability.auto_restrictions
    FOR SELECT TO app_backend USING (true);
CREATE POLICY auto_restrictions_read_ops ON availability.auto_restrictions
    FOR SELECT TO app_readonly USING (true);
GRANT SELECT ON availability.auto_restrictions TO app_backend, app_readonly;

INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('ops.function_restriction.auto_set',
     'Введено автоматическое ограничение группы функций (мало места на диске, M181)',
     ARRAY['system']),
    ('ops.function_restriction.auto_cleared',
     'Снято автоматическое ограничение группы функций (место на диске вернулось, M181)',
     ARRAY['system'])
ON CONFLICT (verb) DO NOTHING;

-- Сообщение службы хоста. Ответ: set | kept | cleared | none.
CREATE FUNCTION availability.report_disk_usage(
    p_used_pct   NUMERIC,
    p_mount      TEXT,
    p_forecast_h NUMERIC,
    p_trace_id   TEXT,
    p_set_pct    NUMERIC DEFAULT 85,
    p_clear_pct  NUMERIC DEFAULT 80
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, availability, audit, pg_temp
AS $$
DECLARE
    v_active  BOOLEAN;
    v_crit    BOOLEAN;
    v_context JSONB;
BEGIN
    IF p_used_pct IS NULL OR p_used_pct < 0 OR p_used_pct > 100 THEN
        RAISE EXCEPTION 'занятость диска вне 0–100: %', p_used_pct USING ERRCODE = '22023';
    END IF;
    IF p_clear_pct >= p_set_pct THEN
        RAISE EXCEPTION 'порог снятия % не ниже порога введения %', p_clear_pct, p_set_pct
            USING ERRCODE = '22023';
    END IF;
    -- Один отчёт за раз: два прохода службы не введут ограничение дважды.
    PERFORM pg_advisory_xact_lock(hashtext('availability.disk'));
    SELECT true INTO v_active FROM availability.auto_restrictions
     WHERE group_id = 'files' AND source = 'disk' FOR UPDATE;
    v_active := coalesce(v_active, false);
    v_crit := p_used_pct >= p_set_pct OR (p_forecast_h IS NOT NULL AND p_forecast_h < 24);
    v_context := jsonb_build_object(
        'group', 'files', 'mode', 'read_only', 'source', 'disk', 'mount', p_mount,
        'usedPct', p_used_pct, 'forecastHours', p_forecast_h,
        'setPct', p_set_pct, 'clearPct', p_clear_pct,
        'actor', jsonb_build_object('v', 1, 'kind', 'system', 'userId', NULL, 'role', 'system',
                                    'operationId', p_trace_id,
                                    'basis', jsonb_build_object('check', 'job',
                                                                'name', 'host.disk-guard')));

    IF v_crit THEN
        IF v_active THEN
            UPDATE availability.auto_restrictions
               SET used_pct = p_used_pct, forecast_h = p_forecast_h, mount = p_mount,
                   refreshed_at = now()
             WHERE group_id = 'files' AND source = 'disk';
            RETURN 'kept';
        END IF;
        INSERT INTO availability.auto_restrictions (group_id, source, mode, used_pct, forecast_h, mount)
        VALUES ('files', 'disk', 'read_only', p_used_pct, p_forecast_h, p_mount);
        PERFORM audit.app_emit_event('ops.function_restriction.auto_set', NULL, 'system',
            'function_group', NULL, v_context, p_trace_id);
        RETURN 'set';
    END IF;

    IF v_active THEN
        IF p_used_pct < p_clear_pct THEN
            DELETE FROM availability.auto_restrictions WHERE group_id = 'files' AND source = 'disk';
            PERFORM audit.app_emit_event('ops.function_restriction.auto_cleared', NULL, 'system',
                'function_group', NULL, v_context, p_trace_id);
            RETURN 'cleared';
        END IF;
        -- Между порогами — держать, как было.
        UPDATE availability.auto_restrictions
           SET used_pct = p_used_pct, forecast_h = p_forecast_h, refreshed_at = now()
         WHERE group_id = 'files' AND source = 'disk';
        RETURN 'kept';
    END IF;
    RETURN 'none';
END $$;

REVOKE ALL ON FUNCTION availability.report_disk_usage(NUMERIC, TEXT, NUMERIC, TEXT, NUMERIC, NUMERIC)
    FROM PUBLIC;
COMMENT ON FUNCTION availability.report_disk_usage(NUMERIC, TEXT, NUMERIC, TEXT, NUMERIC, NUMERIC) IS
    'Отчёт службы хоста о месте на диске: ≥ порога (или прогноз < 24 ч) — «Файлы» только '
    'чтение; ниже порога снятия — снять (M181). Только владелец таблиц.';
