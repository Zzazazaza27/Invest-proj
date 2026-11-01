-- M154 — происхождение «monitoring» для служебных учёток и объектов
-- наблюдения (5Э MVP, работа 2.1-W08a; замечание Тэнка при приёмке W08a).
--
-- Требование 2.5: в рабочей среде — отдельная служебная учётная запись
-- мониторинга с минимальными правами, только на чтение контрольных данных; не
-- общая учётка испытательных прогонов. Учётка и её проверки исключаются из
-- продуктовой статистики и обычных пользовательских списков; служебный аудит
-- сохраняется.
--
-- Отдельное происхождение отличает её и контрольный проект от людей и от
-- следов прогонов: уборка прогонов (M135) их не трогает, а список
-- пользователей админки по умолчанию их не показывает (PROBE_ORIGINS).

ALTER TABLE identity.users DROP CONSTRAINT IF EXISTS users_origin_check;
ALTER TABLE identity.users ADD CONSTRAINT users_origin_check CHECK (origin IN (
    'self_registration', 'invite', 'seed_demo', 'seed_acceptance',
    'staff_check', 'render_check', 'load_test', 'test_session', 'monitoring', 'unknown'));

ALTER TABLE lab.projects DROP CONSTRAINT IF EXISTS projects_origin_check;
ALTER TABLE lab.projects ADD CONSTRAINT projects_origin_check CHECK (origin IN (
    'self_registration', 'invite', 'seed_demo', 'seed_acceptance',
    'staff_check', 'render_check', 'load_test', 'test_session', 'monitoring', 'unknown'));
