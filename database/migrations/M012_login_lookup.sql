-- =============================================================================
-- M012 — поиск учётной записи при входе
--
-- Проблема, которую решает миграция: RLS-политика `users_select` требует
-- сессионного контекста (`app.current_user_id`), а при входе этого контекста
-- ещё нет — пользователь как раз доказывает, кто он. Без отдельной функции
-- логин видел бы ноль строк и всегда отвечал «неверные данные».
--
-- Решение — не ослабление политики, а НАРРОУ-функция: она возвращает ровно
-- три поля, необходимые для проверки пароля, и ничего больше. Ни email, ни
-- телефон, ни роли, ни персональные данные через неё не утекают.
-- =============================================================================

CREATE OR REPLACE FUNCTION identity.find_login_candidate(
    p_email_hmac BYTEA DEFAULT NULL,
    p_phone_hmac BYTEA DEFAULT NULL
) RETURNS TABLE (user_id UUID, password_hash TEXT, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, identity, public
AS $$
BEGIN
    IF p_email_hmac IS NULL AND p_phone_hmac IS NULL THEN
        RAISE EXCEPTION 'login lookup requires an email or phone blind index'
            USING ERRCODE = '22023';
    END IF;
    IF p_email_hmac IS NOT NULL AND p_phone_hmac IS NOT NULL THEN
        -- Ровно один идентификатор за вызов: иначе функция превращается в
        -- инструмент перебора «есть ли пользователь хоть с чем-то из этого».
        RAISE EXCEPTION 'login lookup accepts exactly one identifier'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT u.id, u.password_hash, u.status
      FROM identity.users u
     WHERE u.deleted_at IS NULL
       AND ((p_email_hmac IS NOT NULL AND u.email_hmac = p_email_hmac)
         OR (p_phone_hmac IS NOT NULL AND u.phone_hmac = p_phone_hmac))
     LIMIT 1;
END $$;

COMMENT ON FUNCTION identity.find_login_candidate(BYTEA, BYTEA) IS
    'Поиск кандидата на вход по blind index. Возвращает только id, хеш пароля и '
    'статус — ровно то, что нужно для проверки пароля. Вызов возможен только '
    'ролью app_backend; частота ограничена rate-limit класса auth.';

-- Выдаётся только роли основного API. Ни публичная, ни интеграционная роль
-- вызвать её не могут.
REVOKE ALL ON FUNCTION identity.find_login_candidate(BYTEA, BYTEA) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.find_login_candidate(BYTEA, BYTEA) TO app_backend;

-- Роли пользователя после успешной проверки пароля: контекст сессии ещё не
-- установлен, поэтому политика user_roles_select тоже не пропустила бы чтение.
CREATE OR REPLACE FUNCTION identity.get_active_roles(p_user_id UUID)
RETURNS TABLE (role TEXT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, identity, public
AS $$
    SELECT ur.role FROM identity.user_roles ur
     WHERE ur.user_id = p_user_id AND ur.revoked_at IS NULL;
$$;

REVOKE ALL ON FUNCTION identity.get_active_roles(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.get_active_roles(UUID) TO app_backend;
