-- M170 — единая проверка ссылок из писем без расхода (Томас, Тэнк, 09.11).
--
-- M158 дала проверку при открытии только ссылке смены пароля. Подтверждение почты
-- расходовало ссылку уже при загрузке страницы: почтовые сервисы, открывающие ссылки для
-- проверки, могли израсходовать её раньше человека. Теперь страница любой ссылки сначала
-- спрашивает, действует ли она, а действие выполняется по нажатию.
--
-- Назначение — обязательная часть вопроса: ссылка подтверждения не годится для смены
-- пароля и наоборот. Неизвестное назначение — «не действует». Ответ один на просроченную,
-- использованную и несуществующую. Окончательное действие по-прежнему расходует токен
-- одним UPDATE с условием used_at IS NULL (M060): эта проверка его не заменяет.

CREATE OR REPLACE FUNCTION identity.link_token_alive(
    p_token_sha256 BYTEA,
    p_purpose TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, identity, pg_temp
AS $$
    SELECT p_purpose IN ('password_reset', 'email_verify')
       AND EXISTS (
        SELECT 1
          FROM identity.verification_tokens
         WHERE token_sha256 = p_token_sha256
           AND purpose = p_purpose
           AND used_at IS NULL
           AND expires_at > now()
    );
$$;

REVOKE ALL ON FUNCTION identity.link_token_alive(BYTEA, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.link_token_alive(BYTEA, TEXT) TO app_auth;
