-- =============================================================================
-- M000 — baseline
-- Расширения, 11 доменных схем, роли БД без BYPASSRLS, базовые GRANT/REVOKE.
-- Источник: Database_Launch.md §1, §16.
-- =============================================================================

-- ---------------------------------------------------------------- расширения
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- pg_partman ставится в отдельную схему, если доступен в кластере.
-- Отсутствие расширения не блокирует миграцию: M001 использует нативное
-- обслуживание партиций (ADR-004).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_partman') THEN
        EXECUTE 'CREATE SCHEMA IF NOT EXISTS partman';
        EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_partman WITH SCHEMA partman';
        RAISE NOTICE 'M000: pg_partman включён';
    ELSE
        RAISE NOTICE 'M000: pg_partman недоступен — используется нативное обслуживание партиций';
    END IF;
END $$;

-- ------------------------------------------------------------------- UUIDv7
-- Основной путь генерации id — приложение (packages/contracts → uuidv7()).
-- Эта функция нужна там, где id рождается внутри транзакции БД: сиды,
-- app_emit_event(), confirm_first_tranche(). RFC 9562: 48 бит unix_ts_ms,
-- версия 7, вариант 10, остальное — CSPRNG.
CREATE OR REPLACE FUNCTION public.uuid_generate_v7()
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_bytes bytea;
    v_ms    bigint;
BEGIN
    v_ms := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    -- 16 случайных байт, затем перезапись первых 6 байт временной меткой
    v_bytes := gen_random_bytes(16);
    v_bytes := set_byte(v_bytes, 0, ((v_ms >> 40) & 255)::int);
    v_bytes := set_byte(v_bytes, 1, ((v_ms >> 32) & 255)::int);
    v_bytes := set_byte(v_bytes, 2, ((v_ms >> 24) & 255)::int);
    v_bytes := set_byte(v_bytes, 3, ((v_ms >> 16) & 255)::int);
    v_bytes := set_byte(v_bytes, 4, ((v_ms >> 8) & 255)::int);
    v_bytes := set_byte(v_bytes, 5, (v_ms & 255)::int);
    -- версия 7 в старших 4 битах байта 6
    v_bytes := set_byte(v_bytes, 6, ((get_byte(v_bytes, 6) & 15) | 112));
    -- вариант RFC 4122 (10xx) в старших 2 битах байта 8
    v_bytes := set_byte(v_bytes, 8, ((get_byte(v_bytes, 8) & 63) | 128));
    RETURN encode(v_bytes, 'hex')::uuid;
END $$;

COMMENT ON FUNCTION public.uuid_generate_v7() IS
    'UUIDv7 (RFC 9562) для серверных вставок. Приложение генерирует id само — см. ADR-004.';

-- --------------------------------------------------------------------- схемы
-- Схема = граница владения данными внутри модульного монолита.
CREATE SCHEMA IF NOT EXISTS identity;      -- аккаунты, роли, согласия, инвесторы
CREATE SCHEMA IF NOT EXISTS kyc;           -- верификация физлиц и юрлиц
CREATE SCHEMA IF NOT EXISTS lab;           -- проекты, листинги, материалы
CREATE SCHEMA IF NOT EXISTS investments;   -- предложения, договоры, транши, номинальный счёт
CREATE SCHEMA IF NOT EXISTS scoring;       -- паспорта, факты, IRS, роадмапы
CREATE SCHEMA IF NOT EXISTS experts;       -- экспертный совет
CREATE SCHEMA IF NOT EXISTS seasons;       -- сезонный метроном
CREATE SCHEMA IF NOT EXISTS comms;         -- уведомления
CREATE SCHEMA IF NOT EXISTS billing;       -- тарифы, подписки, вознаграждение ОИП
CREATE SCHEMA IF NOT EXISTS audit;         -- журнал, outbox, ключи, флаги
CREATE SCHEMA IF NOT EXISTS integration;   -- швы под Capital и Шоу

COMMENT ON SCHEMA investments IS
    'Регулируемый контур ОИП. Инвестиционный principal. НИКОГДА не смешивается с billing.*';
COMMENT ON SCHEMA billing IS
    'Выручка платформы: подписки и вознаграждение ОИП. Principal сюда не попадает.';

-- --------------------------------------------------------------------- роли
-- Групповые роли (NOLOGIN). Логин-пользователи с паролями создаются отдельным
-- bootstrap-скриптом из переменных окружения — секретов в миграциях нет.
-- Ни одна роль НЕ получает BYPASSRLS: RLS обязателен и для сервисных ролей.
DO $$
DECLARE
    r TEXT;
    app_roles TEXT[] := ARRAY[
        'app_public_read',    -- только allowlist тизера
        'app_backend',        -- OLTP основного API
        'app_notifications',  -- доставка уведомлений
        'app_investments',    -- предложения, договоры, банковские события
        'app_integration',    -- Integration API, read-mostly
        'app_billing',        -- начисления, инвойсы, платежи
        'app_readonly'        -- аналитика
    ];
BEGIN
    FOREACH r IN ARRAY app_roles LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('CREATE ROLE %I NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE', r);
        ELSE
            EXECUTE format('ALTER ROLE %I NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE', r);
        END IF;
    END LOOP;
END $$;

-- ------------------------------------------------- владелец и SECURITY DEFINER
-- FORCE ROW LEVEL SECURITY распространяет политики и на владельца таблиц.
-- Доменные команды (audit.app_emit_event, billing.confirm_first_tranche)
-- выполняются как SECURITY DEFINER от владельца, поэтому без членства в
-- сервисных ролях они упирались бы в собственные же политики `TO app_*`.
--
-- Это НЕ ослабление: владелец и так может изменить любую политику. Зато
-- появляется возможность честно тестировать RLS через SET ROLE app_backend —
-- то есть от лица той роли, под которой реально работает приложение.
DO $$
BEGIN
    EXECUTE format(
        'GRANT app_public_read, app_backend, app_notifications, app_investments, '
        'app_integration, app_billing, app_readonly TO %I', current_user);
END $$;

-- ------------------------------- сессионный контекст запроса (основа всех RLS)
-- Значения выставляет ТОЛЬКО middleware после проверки access-токена:
--   SET LOCAL app.current_user_id = '<uuid>';
--   SET LOCAL app.current_roles   = 'founder,investor';
-- Прямых подключений клиентов к БД не существует.
CREATE SCHEMA IF NOT EXISTS app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO app_public_read, app_backend, app_notifications,
                             app_investments, app_integration, app_billing, app_readonly;

-- Безопасный разбор контекста: неустановленное или пустое значение даёт NULL,
-- а не ошибку приведения типа. NULL никогда не равен ничему — политика закрыта.
CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS UUID
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT nullif(current_setting('app.current_user_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app.current_roles()
RETURNS TEXT[]
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT string_to_array(coalesce(nullif(current_setting('app.current_roles', true), ''), ''), ',');
$$;

CREATE OR REPLACE FUNCTION app.has_role(p_role TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, app
AS $$
    SELECT p_role = ANY(app.current_roles());
$$;

COMMENT ON FUNCTION app.has_role(TEXT) IS
    'Единая точка проверки роли в RLS. Не заменяет проверку в сервисном слое — defense in depth.';

GRANT EXECUTE ON FUNCTION app.current_user_id(), app.current_roles(), app.has_role(TEXT)
    TO app_public_read, app_backend, app_notifications, app_investments,
       app_integration, app_billing, app_readonly;

-- ------------------------------------------------------- базовые GRANT/REVOKE
-- Схема public не должна быть свалкой: создавать в ней объекты может только владелец.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

DO $$
BEGIN
    EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_public_read, app_backend, '
                   'app_notifications, app_investments, app_integration, app_billing, app_readonly',
                   current_database());
END $$;

DO $$
DECLARE
    s TEXT;
    domain_schemas TEXT[] := ARRAY['identity','kyc','lab','investments','scoring',
                                   'experts','seasons','comms','billing','audit','integration'];
BEGIN
    FOREACH s IN ARRAY domain_schemas LOOP
        -- Никаких неявных прав. Всё выдаётся точечно в доменных миграциях.
        EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', s);
        EXECUTE format('GRANT USAGE ON SCHEMA %I TO app_backend, app_readonly', s);
    END LOOP;

    -- Сервисные роли получают USAGE только на свои схемы.
    EXECUTE 'GRANT USAGE ON SCHEMA identity, lab, billing TO app_public_read';
    EXECUTE 'GRANT USAGE ON SCHEMA comms, identity TO app_notifications';
    EXECUTE 'GRANT USAGE ON SCHEMA investments, billing, lab, kyc, identity, audit TO app_investments';
    EXECUTE 'GRANT USAGE ON SCHEMA billing, investments, identity, kyc, audit TO app_billing';
    EXECUTE 'GRANT USAGE ON SCHEMA integration, lab, scoring, seasons, audit, investments, billing TO app_integration';
END $$;

GRANT EXECUTE ON FUNCTION public.uuid_generate_v7() TO app_backend, app_investments, app_billing,
                                                       app_notifications, app_integration;

-- ------------------------------------------------ реестр применённых миграций
CREATE TABLE IF NOT EXISTS public.schema_migrations (
    id          TEXT PRIMARY KEY,                    -- 'M000_baseline'
    checksum    BYTEA NOT NULL,                      -- sha256 файла на момент применения
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_by  TEXT NOT NULL DEFAULT current_user,
    duration_ms INTEGER
);
COMMENT ON TABLE public.schema_migrations IS
    'Изменение уже применённой миграции детектируется по checksum и роняет раннер.';
