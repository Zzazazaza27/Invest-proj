-- =============================================================================
-- M060 — восстановление пароля и подтверждение почты
--
-- Ни того, ни другого в платформе не было: забывший пароль не мог войти
-- никогда, а адрес почты никто не подтверждал — регистрация принимала любой
-- синтаксически верный. Оба сценария анонимны по построению (у человека нет
-- сессии: он именно потому и пришёл), поэтому одной таблицей дело не
-- ограничивается — нужен способ выполнить их, не выдавая анонимной роли прав
-- на пользователей.
--
-- РЕШЕНИЕ: хеш в таблице + четыре функции SECURITY DEFINER.
--
--  1. **В базе лежит только SHA-256 токена.** Чтение таблицы не даёт войти ни
--     в один аккаунт: по хешу ссылку не восстановить. Сам токен существует
--     ровно в одном месте — в отправленном письме.
--  2. **Права анонимной роли не расширяются.** `app_auth` (M046) видит две
--     колонки пользователя и реестр отзывов; выдать ей SELECT по контактам или
--     UPDATE пароля значило бы отдать анонимному пути ровно то, ради чего
--     существует RLS. Вместо этого — четыре узкие функции, каждая делает одну
--     операцию целиком и возвращает только идентификатор.
--  3. **Однократность токена обеспечивает БД, а не код.** Пометка
--     использования и полезное действие происходят одним UPDATE с условием
--     `used_at IS NULL`: два одновременных перехода по одной ссылке дают
--     ровно один успех, потому что второй не найдёт строки.
--  4. **Смена пароля гасит все сессии.** `sessions_valid_from` сдвигается в
--     той же операции: сброс пароля, после которого чужая сессия продолжает
--     работать, не является восстановлением доступа.
--
-- ЧЕГО ЗДЕСЬ НЕТ: перечисления пользователей. Функция выдачи токена по
-- контакту возвращает NULL, если такого пользователя нет, — и вызывающий
-- обязан ответить одинаково в обоих случаях. Это его часть работы, но
-- возможность отличить один случай от другого база не даёт: разных ошибок,
-- разных кодов и разных задержек здесь не предусмотрено.
-- =============================================================================

CREATE TABLE identity.verification_tokens (
    id                 UUID PRIMARY KEY,                    -- UUIDv7
    user_id            UUID NOT NULL REFERENCES identity.users(id),
    purpose            TEXT NOT NULL CHECK (purpose IN ('password_reset', 'email_verify')),
    -- ХЕШ, а не токен. Значение токена живёт только в письме.
    token_sha256       BYTEA NOT NULL,
    expires_at         TIMESTAMPTZ NOT NULL,
    used_at            TIMESTAMPTZ,
    request_trace_hash BYTEA,                               -- отпечаток запроса, не адрес (SEC-16)
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at),
    CHECK (used_at IS NULL OR used_at >= created_at)
);

-- Поиск по предъявленному токену — единственный горячий путь.
CREATE UNIQUE INDEX verification_tokens_hash_uq ON identity.verification_tokens (token_sha256);
-- Живой токен цели: по нему гасятся прежние ссылки при повторном запросе.
CREATE INDEX verification_tokens_live
    ON identity.verification_tokens (user_id, purpose) WHERE used_at IS NULL;
-- Уборка просроченного.
CREATE INDEX verification_tokens_expiry ON identity.verification_tokens (expires_at);

COMMENT ON COLUMN identity.verification_tokens.token_sha256 IS
    'SHA-256 токена из письма. Сам токен в базу не попадает: чтение таблицы не должно '
    'давать вход. Соль не нужна — токен и так 256 бит случайности, перебор невозможен.';

ALTER TABLE identity.verification_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.verification_tokens FORCE  ROW LEVEL SECURITY;

-- Прямой доступ к таблице нужен ровно двум ролям и в двух узких видах.
-- Всё остальное идёт через функции ниже — они исполняются с правами владельца
-- и политик не касаются.
--
-- Человек видит СОСТОЯНИЕ своих подтверждений (когда истекает, использовано ли),
-- но не значение хеша: колонка не входит в GRANT.
CREATE POLICY verification_tokens_own ON identity.verification_tokens FOR SELECT
    TO app_backend USING (user_id = app.current_user_id());

-- Уборка: просроченное и использованное. Живой токен уборщик не трогает —
-- иначе он молча ломал бы восстановление доступа тому, кто как раз идёт по
-- ссылке.
CREATE POLICY verification_tokens_janitor ON identity.verification_tokens FOR DELETE
    TO app_maintenance USING (expires_at < now() OR used_at IS NOT NULL);

GRANT SELECT (id, user_id, purpose, expires_at, used_at, created_at)
    ON identity.verification_tokens TO app_backend;
GRANT SELECT, DELETE ON identity.verification_tokens TO app_maintenance;

-- ---------------------------------------------------------------------------
-- 1. Выдача токена по контакту — анонимный путь «забыл пароль».
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION identity.issue_verification_token(
    p_id UUID,
    p_purpose TEXT,
    p_email_hmac BYTEA,
    p_token_sha256 BYTEA,
    p_ttl_seconds INTEGER,
    p_trace_hash BYTEA
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, identity, pg_temp
AS $$
DECLARE
    v_user UUID;
BEGIN
    IF p_purpose NOT IN ('password_reset', 'email_verify') THEN
        RAISE EXCEPTION 'unknown verification purpose' USING ERRCODE = '22023';
    END IF;
    -- Верхняя граница срока — часть контракта функции, а не забота вызывающего:
    -- ссылка на сброс пароля, живущая неделю, эквивалентна второму паролю.
    IF p_ttl_seconds < 60 OR p_ttl_seconds > 86400 THEN
        RAISE EXCEPTION 'verification ttl out of range' USING ERRCODE = '22023';
    END IF;

    SELECT u.id INTO v_user
      FROM identity.users u
     WHERE u.email_hmac = p_email_hmac
       AND u.deleted_at IS NULL
     LIMIT 1;

    -- Пользователя нет — NULL. Не исключение: разница в поведении и есть
    -- перечисление пользователей.
    IF v_user IS NULL THEN
        RETURN NULL;
    END IF;

    -- Прежние живые ссылки той же цели гасятся. Иначе каждый повторный запрос
    -- добавлял бы ещё одну действующую ссылку, и отозвать их разом было бы
    -- нечем: у человека, чью почту читает посторонний, накапливался бы веер
    -- рабочих входов.
    UPDATE identity.verification_tokens
       SET used_at = now()
     WHERE user_id = v_user
       AND purpose = p_purpose
       AND used_at IS NULL;

    INSERT INTO identity.verification_tokens
        (id, user_id, purpose, token_sha256, expires_at, request_trace_hash)
    VALUES (p_id, v_user, p_purpose, p_token_sha256,
            now() + make_interval(secs => p_ttl_seconds), p_trace_hash);

    RETURN v_user;
END $$;

COMMENT ON FUNCTION identity.issue_verification_token(UUID, TEXT, BYTEA, BYTEA, INTEGER, BYTEA) IS
    'Выдача токена подтверждения по blind index контакта. Возвращает NULL, если '
    'пользователя нет: отличить это от успеха вызывающий не должен.';

REVOKE ALL ON FUNCTION identity.issue_verification_token(UUID, TEXT, BYTEA, BYTEA, INTEGER, BYTEA)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.issue_verification_token(UUID, TEXT, BYTEA, BYTEA, INTEGER, BYTEA)
    TO app_auth;

-- ---------------------------------------------------------------------------
-- 2. Выдача токена подтверждения почты СЕБЕ — путь с открытой сессией.
-- ---------------------------------------------------------------------------
--
-- Идентификатор пользователя НЕ параметр: он берётся из контекста запроса.
-- Параметром его сделать нельзя — функция исполняется с правами владельца, и
-- ошибка в одной строке контроллера означала бы выпуск ссылки подтверждения на
-- чужой адрес.
CREATE OR REPLACE FUNCTION identity.issue_email_verification_token(
    p_id UUID,
    p_token_sha256 BYTEA,
    p_ttl_seconds INTEGER,
    p_trace_hash BYTEA
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, identity, app, pg_temp
AS $$
DECLARE
    v_user UUID := app.current_user_id();
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'email verification requires a session' USING ERRCODE = '28000';
    END IF;
    IF p_ttl_seconds < 60 OR p_ttl_seconds > 86400 THEN
        RAISE EXCEPTION 'verification ttl out of range' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM identity.users u
         WHERE u.id = v_user AND u.deleted_at IS NULL AND u.email_hmac IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'no email to verify' USING ERRCODE = '22023';
    END IF;

    UPDATE identity.verification_tokens
       SET used_at = now()
     WHERE user_id = v_user AND purpose = 'email_verify' AND used_at IS NULL;

    INSERT INTO identity.verification_tokens
        (id, user_id, purpose, token_sha256, expires_at, request_trace_hash)
    VALUES (p_id, v_user, 'email_verify', p_token_sha256,
            now() + make_interval(secs => p_ttl_seconds), p_trace_hash);

    RETURN v_user;
END $$;

REVOKE ALL ON FUNCTION identity.issue_email_verification_token(UUID, BYTEA, INTEGER, BYTEA)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.issue_email_verification_token(UUID, BYTEA, INTEGER, BYTEA)
    TO app_backend;

-- ---------------------------------------------------------------------------
-- 3. Смена пароля по токену.
-- ---------------------------------------------------------------------------
--
-- Пометка токена использованным и смена пароля — ОДИН UPDATE и одна
-- транзакция. Проверка «токен ещё жив» отдельным запросом от последующей
-- записи означала бы окно, в котором два перехода по одной ссылке дают две
-- смены пароля (TOCTOU): выигрывает последний, а первый считает, что пароль
-- сменил он.
CREATE OR REPLACE FUNCTION identity.reset_password_with_token(
    p_token_sha256 BYTEA,
    p_password_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, identity, pg_temp
AS $$
DECLARE
    v_user UUID;
BEGIN
    UPDATE identity.verification_tokens
       SET used_at = now()
     WHERE token_sha256 = p_token_sha256
       AND purpose = 'password_reset'
       AND used_at IS NULL
       AND expires_at > now()
    RETURNING user_id INTO v_user;

    IF v_user IS NULL THEN
        RETURN NULL;
    END IF;

    -- Рубеж сессий сдвигается вместе с паролем: восстановление доступа, после
    -- которого чужая открытая сессия продолжает работать, доступ не
    -- восстанавливает. Форма сдвига та же, что в SessionEpochService, —
    -- начало следующей секунды (у `iat` точность в секунду).
    UPDATE identity.users
       SET password_hash = p_password_hash,
           sessions_valid_from = date_trunc('second', now()) + interval '1 second',
           updated_at = now()
     WHERE id = v_user;

    -- Прочие живые ссылки на сброс тоже гасятся: пароль уже сменён, и вторая
    -- ссылка из того же почтового ящика сменила бы его снова.
    UPDATE identity.verification_tokens
       SET used_at = now()
     WHERE user_id = v_user AND purpose = 'password_reset' AND used_at IS NULL;

    RETURN v_user;
END $$;

REVOKE ALL ON FUNCTION identity.reset_password_with_token(BYTEA, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.reset_password_with_token(BYTEA, TEXT) TO app_auth;

-- ---------------------------------------------------------------------------
-- 4. Подтверждение почты по токену.
-- ---------------------------------------------------------------------------
--
-- Факт подтверждения хранится там, где для него с самого начала есть место, —
-- `identity.auth_identities` с provider='email' и колонкой `verified_at`.
-- Заводить вторую колонку в `users` значило бы иметь два ответа на вопрос
-- «подтверждён ли адрес».
--
-- `provider_uid` — HEX blind-индекса, а не сам адрес: таблица не место для
-- контакта открытым текстом, а уникальность индекса ровно та же.
CREATE OR REPLACE FUNCTION identity.confirm_email_with_token(
    p_token_sha256 BYTEA,
    p_identity_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, identity, pg_temp
AS $$
DECLARE
    v_user UUID;
    v_uid  TEXT;
BEGIN
    UPDATE identity.verification_tokens
       SET used_at = now()
     WHERE token_sha256 = p_token_sha256
       AND purpose = 'email_verify'
       AND used_at IS NULL
       AND expires_at > now()
    RETURNING user_id INTO v_user;

    IF v_user IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT encode(u.email_hmac, 'hex') INTO v_uid
      FROM identity.users u WHERE u.id = v_user;

    IF v_uid IS NULL THEN
        -- Адрес сняли между выдачей ссылки и переходом по ней. Подтверждать
        -- нечего, и притворяться успехом нельзя.
        RETURN NULL;
    END IF;

    INSERT INTO identity.auth_identities (id, user_id, provider, provider_uid, verified_at)
    VALUES (p_identity_id, v_user, 'email', v_uid, now())
    ON CONFLICT (provider, provider_uid)
    DO UPDATE SET user_id = EXCLUDED.user_id, verified_at = now();

    RETURN v_user;
END $$;

REVOKE ALL ON FUNCTION identity.confirm_email_with_token(BYTEA, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.confirm_email_with_token(BYTEA, UUID) TO app_auth;

-- ------------------------------------------------- события в реестре журнала
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('identity.password.reset_requested', 'Запрошено восстановление пароля',  ARRAY['system']),
    ('identity.password.reset_completed', 'Пароль изменён по ссылке из письма', ARRAY['system']),
    ('identity.email.verification_sent',  'Отправлена ссылка подтверждения почты', ARRAY['system']),
    ('identity.email.verified',           'Адрес почты подтверждён',          ARRAY['system'])
ON CONFLICT (verb) DO NOTHING;
