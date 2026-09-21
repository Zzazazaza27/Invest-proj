-- M130 — уборка тестовой сессии помечает своих участников удалёнными.
--
-- ОТКУДА ЗАДАЧА. Уборка сессии падала с «permission denied for table users»:
-- у роли приложения поколоночная выдача на `identity.users` (M056), и
-- `deleted_at` в UPDATE не входит. Это не недосмотр — колонку намеренно не
-- выдавали, потому что удаления учётных записей в продукте нет
-- (docs/architecture/заявка-07-удаление-аккаунта.md).
--
-- ПОЧЕМУ НЕ ПРОСТО GRANT. Выдать `UPDATE (deleted_at)` роли приложения —
-- значит открыть пометку ЛЮБОЙ учётной записи из любого места кода, где
-- когда-нибудь найдётся подходящая политика. Задача же узкая: пометить
-- участников КОНКРЕТНОЙ тестовой сессии.
--
-- Поэтому право выдаётся не роли, а функции. Она проверяет два условия,
-- каждое из которых само по себе достаточно, чтобы не тронуть живого
-- человека:
--   1. запись числится в перечне созданного ЭТОЙ сессией;
--   2. её происхождение — `test_session`.
-- Даже если перечень испортят и в нём окажется рабочий пользователь, второе
-- условие его не пропустит. Это и есть требование владельца «рабочий
-- пользователь никогда не становится участником очистки тестовой сессии»,
-- выраженное там, где его нельзя обойти.

CREATE OR REPLACE FUNCTION testing.cleanup_mark_users(p_session_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = testing, identity, pg_catalog, pg_temp
AS $$
DECLARE
    v_marked INTEGER;
BEGIN
    -- Распоряжаться сессиями вправе администратор или обладатель
    -- полномочия: SECURITY DEFINER снимает RLS, поэтому проверка прав
    -- обязана стоять здесь явно, а не подразумеваться вызывающим.
    IF NOT app.has_capability('testing.sessions.manage') THEN
        RAISE EXCEPTION 'нет полномочия распоряжаться тестовыми сессиями'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    UPDATE identity.users u
       SET deleted_at = now(), updated_at = now()
     WHERE u.deleted_at IS NULL
       AND u.origin = 'test_session'
       AND EXISTS (
           SELECT 1 FROM testing.session_objects o
            WHERE o.session_id = p_session_id
              AND o.table_name = 'identity.users'
              AND o.row_id = u.id
       );
    GET DIAGNOSTICS v_marked = ROW_COUNT;
    RETURN v_marked;
END;
$$;

COMMENT ON FUNCTION testing.cleanup_mark_users(UUID) IS
    'Пометить удалёнными участников тестовой сессии. Узкое право вместо '
    'выдачи UPDATE (deleted_at) роли приложения: функция сама ограничивает '
    'круг строк перечнем объектов сессии И происхождением test_session.';

GRANT EXECUTE ON FUNCTION testing.cleanup_mark_users(UUID) TO app_backend;
