-- M155 — признаки служебной учётки мониторинга для ограничения её действий
-- (5Э MVP, работа 2.1-W08a; замечание Тэнка при приёмке W08a).
--
-- Требование 2.5: учётка мониторинга — только чтение контрольных данных.
-- Роль investor ей нужна, чтобы читать по выданному разрешению обычным
-- путём, но сама роль действий не ограничивает. Ограничение — в ядре
-- (AuthGuard): для учётки с происхождением `monitoring` разрешены только
-- сессия и чтение проектов с тем же происхождением.
--
-- Две функции только на чтение: проверка ядра не должна зависеть от RLS
-- (контекст пользователя ещё не установлен) и не должна давать ролям
-- приложения чтение самих таблиц шире нужного.

CREATE OR REPLACE FUNCTION identity.is_monitoring_user(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, identity, pg_temp
AS $$
    SELECT coalesce((SELECT origin = 'monitoring' FROM identity.users WHERE id = p_user_id), false)
$$;

CREATE OR REPLACE FUNCTION lab.is_monitoring_project(p_project_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, lab, pg_temp
AS $$
    SELECT coalesce((SELECT origin = 'monitoring' FROM lab.projects WHERE id = p_project_id), false)
$$;

COMMENT ON FUNCTION identity.is_monitoring_user(UUID) IS
    'Служебная учётка мониторинга (origin = monitoring) — для ограничения её действий в ядре (2.5; M155).';
COMMENT ON FUNCTION lab.is_monitoring_project(UUID) IS
    'Контрольный проект мониторинга (origin = monitoring) — единственное, что читает учётка мониторинга (M155).';

REVOKE ALL ON FUNCTION identity.is_monitoring_user(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION lab.is_monitoring_project(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.is_monitoring_user(UUID) TO app_backend;
GRANT EXECUTE ON FUNCTION lab.is_monitoring_project(UUID) TO app_backend;
