-- M131 — уборка сессии помечает и её проекты, а не только участников.
--
-- ОТКУДА ЗАДАЧА. Сценарный прогон на механизме сессий завёл заявку от лица
-- участника; уборка сессии участников пометила, а проект остался. Снаружи
-- это выглядит как «уборка не убирает»: в каталоге остаётся проект, которого
-- быть не должно, и объяснить, почему одно убралось, а другое нет, нельзя.
--
-- ПОЧЕМУ ПОМЕТКА, А НЕ УДАЛЕНИЕ. У проекта висят версии, участники, раунды,
-- материалы — физическое удаление упрётся в первый же внешний ключ и оставит
-- уборку в состоянии «не удалась». Пометка удалённым убирает проект из всех
-- выдач (каждая фильтрует `deleted_at IS NULL`), и это тот же приём, что для
-- учётных записей.
--
-- ГРАНИЦЫ ТЕ ЖЕ. Функция ограничивает круг строк перечнем объектов сессии И
-- происхождением `test_session`: рабочий проект не пометит даже испорченный
-- перечень. Право выдано функции, а не роли приложения.

CREATE OR REPLACE FUNCTION testing.cleanup_mark_projects(p_session_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = testing, lab, pg_catalog, pg_temp
AS $$
DECLARE
    v_marked INTEGER;
BEGIN
    IF NOT app.has_capability('testing.sessions.manage') THEN
        RAISE EXCEPTION 'нет полномочия распоряжаться тестовыми сессиями'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    UPDATE lab.projects p
       SET deleted_at = now()
     WHERE p.deleted_at IS NULL
       AND p.origin = 'test_session'
       AND EXISTS (
           SELECT 1 FROM testing.session_objects o
            WHERE o.session_id = p_session_id
              AND o.table_name = 'lab.projects'
              AND o.row_id = p.id
       );
    GET DIAGNOSTICS v_marked = ROW_COUNT;
    RETURN v_marked;
END;
$$;

COMMENT ON FUNCTION testing.cleanup_mark_projects(UUID) IS
    'Пометить удалёнными проекты тестовой сессии. Узкое право вместо выдачи '
    'UPDATE (deleted_at) роли приложения на lab.projects.';

GRANT EXECUTE ON FUNCTION testing.cleanup_mark_projects(UUID) TO app_backend;
