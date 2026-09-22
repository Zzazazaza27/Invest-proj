-- M135: уборка сессии помечает и людей, заведённых браузерным прогоном.
--
-- ЗАЧЕМ. С M134 прогон, работающий под администратором, записывает
-- созданных им людей за своим запуском. Но уборка их не трогала: условие в
-- `cleanup_mark_users` пропускало только `origin = 'test_session'` —
-- участников, которых заводит сама сессия. Браузерные проходы участников не
-- создают, у их людей происхождение `render_check`, и уборка честно
-- отвечала «помечено 0», оставляя записи навсегда.
--
-- ЧТО МЕНЯЕТСЯ. Круг строк по-прежнему ограничен перечнем объектов ИМЕННО
-- этой сессии — то есть уборка не может тронуть ничего, чего запуск не
-- создавал. Расширяется только список допустимых происхождений: к
-- `test_session` добавлены `render_check` и `load_test` — ровно те, которые
-- M127 объявил удаляемыми уборкой. `seed_demo`, `seed_acceptance`,
-- `staff_check` и `self_registration` не попадают под пометку ни при каких
-- обстоятельствах: рабочий пользователь не становится участником очистки,
-- даже если кто-то внёс его в перечень.
--
-- ПРОВЕРКА ПОЛНОМОЧИЯ ОСТАЁТСЯ ЗДЕСЬ. SECURITY DEFINER снимает RLS, поэтому
-- право распоряжаться сессиями проверяется в самой функции, а не
-- подразумевается вызывающим.
CREATE OR REPLACE FUNCTION testing.cleanup_mark_users(p_session_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = testing, identity, pg_catalog, pg_temp
AS $$
DECLARE
    v_marked INTEGER;
BEGIN
    IF NOT app.has_capability('testing.sessions.manage') THEN
        RAISE EXCEPTION 'нет полномочия распоряжаться тестовыми сессиями'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    UPDATE identity.users u
       SET deleted_at = now(), updated_at = now()
     WHERE u.deleted_at IS NULL
       AND u.origin IN ('test_session', 'render_check', 'load_test')
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
    'Пометить удалёнными людей, созданных этой тестовой сессией: участников '
    '(test_session) и заведённых браузерным прогоном (render_check, '
    'load_test). Узкое право вместо выдачи UPDATE роли приложения: функция '
    'сама ограничивает круг строк перечнем объектов сессии И списком '
    'происхождений, которые уборка вправе удалять (M127).';
