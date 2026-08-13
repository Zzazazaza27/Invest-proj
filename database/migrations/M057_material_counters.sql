-- =============================================================================
-- M057 — служебные счётчики материалов поверх RLS (регрессия M056)
--
-- M056 добавил в SELECT-политику материалов условие `uploaded_at IS NOT NULL`
-- (вторая линия к утверждению «неподтверждённый материал наружу не выдаётся»).
-- Побочный эффект нашёлся зондом уборки: тем же SELECT под той же ролью
-- считаются СЛУЖЕБНЫЕ величины —
--
--   * квота незавершённых загрузок (`count(*) FILTER (uploaded_at IS NULL)`)
--     стала всегда нулём: предел, введённый против бесконтрольного роста
--     хранилища, перестал действовать;
--   * следующая версия материала (`max(version)+1`) считалась только по
--     подтверждённым — версия повторялась и вставка падала на UNIQUE.
--
-- Правильная граница: пользовательское ЧТЕНИЕ остаётся закрытым, а служебный
-- ПОДСЧЁТ выполняется узкими SECURITY DEFINER-функциями, которые не выдают ни
-- одной строки — только числа. Право на них — у роли приложения; проверка
-- принадлежности проекта остаётся на вызывающем (он уже под RLS проекта).
-- =============================================================================

CREATE OR REPLACE FUNCTION lab.material_counters(p_project_id UUID)
RETURNS TABLE (total BIGINT, pending BIGINT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, lab, pg_temp
AS $$
    SELECT count(*)::bigint,
           count(*) FILTER (WHERE m.uploaded_at IS NULL)::bigint
      FROM lab.project_materials m
     WHERE m.project_id = p_project_id;
$$;

CREATE OR REPLACE FUNCTION lab.next_material_version(p_project_id UUID, p_type TEXT)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, lab, pg_temp
AS $$
    SELECT COALESCE(MAX(m.version), 0) + 1
      FROM lab.project_materials m
     WHERE m.project_id = p_project_id AND m.type = p_type;
$$;

REVOKE ALL ON FUNCTION lab.material_counters(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION lab.next_material_version(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.material_counters(UUID) TO app_backend;
GRANT EXECUTE ON FUNCTION lab.next_material_version(UUID, TEXT) TO app_backend;

COMMENT ON FUNCTION lab.material_counters(UUID) IS
    'Числа для квоты загрузок поверх RLS: политика скрывает неподтверждённые '
    'материалы от чтения, но квота обязана их считать (M057).';
COMMENT ON FUNCTION lab.next_material_version(UUID, TEXT) IS
    'Следующая версия материала с учётом неподтверждённых: иначе версия '
    'повторяется и вставка падает на UNIQUE (M057).';
