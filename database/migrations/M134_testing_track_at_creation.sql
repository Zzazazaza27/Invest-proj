-- M134: принадлежность записывается в момент создания, а не вторым шагом.
--
-- ЗАЧЕМ. Раньше прогон сначала создавал человека, а потом отдельным запросом
-- записывал его за своим запуском. Между этими действиями есть окно: упав в
-- нём, прогон оставлял запись, по которой уже нельзя установить, чей это
-- след, — и уборка её не находила. Теперь обе строки появляются в одной
-- транзакции регистрации.
--
-- ПОЧЕМУ ФУНКЦИЯ. Регистрация — публичный маршрут: пользователя в запросе
-- ещё нет, а политики `testing.session_objects` построены на нём, и прямая
-- вставка отвергается RLS. Функция-владелец делает ровно одну вещь и
-- проверяет всё сама.
--
-- ЧТО ОНА НЕ ПОЗВОЛИТ:
--   * писать в чужую или неактивную сессию — проверка статуса внутри;
--   * назвать произвольную таблицу — список закрыт;
--   * подменить владельца уже учтённого объекта — ON CONFLICT DO NOTHING.
CREATE OR REPLACE FUNCTION testing.track_run_object(
    p_session_id UUID,
    p_table      TEXT,
    p_row_id     UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = testing, pg_temp
AS $$
BEGIN
    IF p_table NOT IN ('identity.users', 'lab.projects') THEN
        RAISE EXCEPTION 'недопустимая таблица для учёта запуска: %', p_table
            USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM testing.sessions WHERE id = p_session_id AND status = 'active'
    ) THEN
        RETURN FALSE;
    END IF;

    INSERT INTO testing.session_objects (session_id, table_name, row_id)
    VALUES (p_session_id, p_table, p_row_id)
    ON CONFLICT DO NOTHING;

    RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION testing.track_run_object(UUID, TEXT, UUID) IS
    'Записать объект за действующим запуском в момент его создания. Нужна '
    'публичной регистрации, у которой нет пользователя в контексте, а значит '
    'нет и права писать в testing.session_objects напрямую.';

GRANT EXECUTE ON FUNCTION testing.track_run_object(UUID, TEXT, UUID) TO app_backend;
