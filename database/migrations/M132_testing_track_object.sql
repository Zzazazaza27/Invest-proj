-- M132 — участник сессии записывает созданное за своей сессией.
--
-- ОТКУДА ЗАДАЧА. Проект, созданный участником, должен числиться за сессией,
-- иначе уборка уберёт людей и оставит их проекты в каталоге. Но писать в
-- `testing.session_objects` участник не может и не должен: политика схемы
-- отдаёт её администратору, и ослаблять это нельзя — иначе любой сможет
-- приписать чужую запись к своей сессии.
--
-- РЕШЕНИЕ. Право выдано функции, а не роли. Функция сама проверяет, что
-- пишущий — участник ИМЕННО ЭТОЙ сессии, и что сессия ещё жива. Приписать
-- объект к чужой сессии нельзя; приписать что-либо к убранной — тоже.
--
-- ПОЧЕМУ ЭТО БЕЗОПАСНО, ДАЖЕ ЕСЛИ ЗАПИСАТЬ ЧУЖОЙ ИДЕНТИФИКАТОР. Уборка
-- помечает только строки с происхождением `test_session` (M130, M131):
-- рабочий проект в перечне ничего не изменит. То есть худшее, чего добьётся
-- испорченная запись, — лишняя строка в перечне созданного.

CREATE OR REPLACE FUNCTION testing.track_object(
    p_session_id UUID,
    p_table TEXT,
    p_row_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = testing, pg_catalog, pg_temp
AS $$
BEGIN
    -- Пишет либо участник этой сессии, либо администратор (он и так может
    -- писать в таблицу напрямую — здесь это ради единственного пути).
    IF NOT (
        app.has_role('admin')
        OR EXISTS (
            SELECT 1 FROM testing.session_participants p
             WHERE p.session_id = p_session_id
               AND p.user_id = app.current_user_id()
        )
    ) THEN
        RAISE EXCEPTION 'записать объект может только участник этой сессии'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Во время уборки и после неё перечень не пополняется: иначе запоздавшая
    -- запись осталась бы неубранной и без объяснения.
    IF NOT EXISTS (
        SELECT 1 FROM testing.sessions s
         WHERE s.id = p_session_id AND s.status IN ('active', 'finished')
    ) THEN
        RETURN false;
    END IF;

    INSERT INTO testing.session_objects (session_id, table_name, row_id)
    VALUES (p_session_id, p_table, p_row_id)
    ON CONFLICT DO NOTHING;
    RETURN true;
END;
$$;

COMMENT ON FUNCTION testing.track_object(UUID, TEXT, UUID) IS
    'Записать созданный объект за тестовой сессией. Узкое право вместо '
    'доступа участника к таблице: проверяет участие и состояние сессии.';

GRANT EXECUTE ON FUNCTION testing.track_object(UUID, TEXT, UUID) TO app_backend;
