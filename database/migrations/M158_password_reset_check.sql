-- M158 — проверка ссылки смены пароля без расхода (Томас, 08.11).
--
-- Страница смены пароля открывалась и по просроченной ссылке: отказ приходил только
-- после ввода нового пароля. Функция только отвечает, действует ли ссылка; токен не
-- расходуется. Условия те же, что у reset_password_with_token (M060).

CREATE OR REPLACE FUNCTION identity.password_reset_token_alive(
    p_token_sha256 BYTEA
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, identity, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM identity.verification_tokens
         WHERE token_sha256 = p_token_sha256
           AND purpose = 'password_reset'
           AND used_at IS NULL
           AND expires_at > now()
    );
$$;

REVOKE ALL ON FUNCTION identity.password_reset_token_alive(BYTEA) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.password_reset_token_alive(BYTEA) TO app_auth;
