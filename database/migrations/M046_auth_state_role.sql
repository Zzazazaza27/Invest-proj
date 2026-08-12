-- =============================================================================
-- M046 — отдельная роль для чтения состояния сессий
--
-- Находка внешнего аудита (SEC-21). Рубеж сессий и реестр отозванных токенов
-- читались ролью `app_notifications` — той, что доставляет уведомления. У неё
-- есть `SELECT` по `identity.users` и `identity.user_roles` целиком, потому что
-- ей нужны получатели и их предпочтения. Проверке «действителен ли токен» столько
-- прав не нужно: ей хватает двух полей и одной маленькой таблицы.
--
-- Роль выбиралась не по задаче, а по тому, у кого уже подошли права. Это ровно
-- тот способ, каким привилегии расползаются: сегодня уведомления читают сессии,
-- завтра ошибка в коде доставки достаёт список пользователей.
--
-- Здесь заводится `app_auth` — роль ровно на то, что делает проверка входа:
--   * `identity.users` — только колонки `id` и `sessions_valid_from`;
--   * `identity.revoked_tokens` — только чтение.
-- Ни ролей, ни контактов, ни паролей она не видит: права выданы поколоночно, а
-- политики ограничивают строки.
--
-- Заодно у `app_notifications` отбирается доступ к реестру отозванных токенов:
-- после переезда проверки он ей не нужен, а невозвращённое право — это право.
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN
        CREATE ROLE app_auth NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
    ELSE
        ALTER ROLE app_auth NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;
    -- Владелец должен состоять в группе, иначе не сможет ни выдать её логин-роли,
    -- ни проверить её права.
    EXECUTE format('GRANT app_auth TO %I', current_user);
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_auth', current_database());
END $$;

GRANT USAGE ON SCHEMA app, identity TO app_auth;

-- Функции контекста запроса: без них политики ниже не вычисляются.
GRANT EXECUTE ON FUNCTION app.current_user_id() TO app_auth;

-- --------------------------------------------------------- рубеж сессий
--
-- Поколоночный GRANT — это и есть граница: `SELECT *` под этой ролью упадёт,
-- потому что права на остальные колонки нет.
GRANT SELECT (id, sessions_valid_from) ON identity.users TO app_auth;

CREATE POLICY users_auth_state ON identity.users FOR SELECT
    TO app_auth USING (deleted_at IS NULL);

-- ------------------------------------------------- реестр отозванных токенов
GRANT SELECT ON identity.revoked_tokens TO app_auth;

CREATE POLICY revoked_tokens_auth_read ON identity.revoked_tokens FOR SELECT
    TO app_auth USING (expires_at > now());

-- Право, которое больше не нужно доставке уведомлений. Проверка отзыва
-- переехала в `app_auth`, уборка — в `app_maintenance` (M039).
REVOKE SELECT, DELETE ON identity.revoked_tokens FROM app_notifications;
