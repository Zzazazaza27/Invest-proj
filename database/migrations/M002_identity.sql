-- =============================================================================
-- M002 — identity
-- Аккаунты, роли, связь с проверенным IdP, согласия (append-only), шаблоны
-- документов, согласия на публичный контур, профили инвесторов.
-- Источник: docs/architecture/Database_Launch.md §2, §2.1, §15.
--
-- ВАЖНО: сессии, refresh-токены, WebAuthn-креды, MFA-факторы, коды
-- восстановления, ключи подписи и OAuth-клиенты здесь ОТСУТСТВУЮТ намеренно —
-- они принадлежат БД проверенного IdP (ADR-003).
-- =============================================================================

-- --------------------------------------------------------------------- users
CREATE TABLE identity.users (
    id                  UUID PRIMARY KEY,                    -- UUIDv7
    email_ciphertext    BYTEA,
    phone_ciphertext    BYTEA,
    contact_wrapped_dek BYTEA,
    email_hmac          BYTEA,                               -- blind index HMAC-SHA256 (KEK search_index)
    phone_hmac          BYTEA,
    password_hash       TEXT,                                -- Argon2id; NULL при соц-входе и при внешнем IdP
    display_name        TEXT NOT NULL DEFAULT '',
    primary_role        TEXT NOT NULL DEFAULT 'founder' CHECK (primary_role IN
                        ('founder','investor','expert','corporate','organizer','admin','showrunner')),
                        -- corporate/showrunner зарезервированы под Capital и Шоу
    status              TEXT NOT NULL DEFAULT 'pending_consents' CHECK (status IN
                        ('pending_consents','active','suspended','deleted')),
                        -- 'active' только после platform_rules+tos+pdn+commission_terms
    locale              TEXT NOT NULL DEFAULT 'ru-RU',
    currency_pref       CHAR(3) NOT NULL DEFAULT 'RUB',
    home_contour        TEXT NOT NULL DEFAULT 'ru' CHECK (home_contour IN ('ru','cis','hub')),
    mfa_enabled         BOOLEAN NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ,
    CHECK (email_ciphertext IS NOT NULL OR phone_ciphertext IS NOT NULL),
    CHECK ((email_ciphertext IS NULL) = (email_hmac IS NULL)),
    CHECK ((phone_ciphertext IS NULL) = (phone_hmac IS NULL)),
    CHECK (contact_wrapped_dek IS NOT NULL)
);
CREATE UNIQUE INDEX users_email_hmac_uq ON identity.users (email_hmac) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX users_phone_hmac_uq ON identity.users (phone_hmac) WHERE deleted_at IS NULL;
CREATE INDEX users_status ON identity.users (status) WHERE deleted_at IS NULL;

COMMENT ON COLUMN identity.users.email_hmac IS
    'Blind index: поиск по email без расшифровки. Ключ — KEK search_index, ротация по отдельной процедуре.';

-- --------------------------------------------------------------------- роли
CREATE TABLE identity.user_roles (
    user_id     UUID NOT NULL REFERENCES identity.users(id),
    role        TEXT NOT NULL CHECK (role IN
                ('founder','investor','expert','corporate','organizer','admin','showrunner')),
    granted_by  UUID REFERENCES identity.users(id),
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at  TIMESTAMPTZ,
    PRIMARY KEY (user_id, role, granted_at),
    CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE UNIQUE INDEX user_roles_active_uq ON identity.user_roles (user_id, role) WHERE revoked_at IS NULL;

-- ------------------------------------------------------- связь с внешним IdP
CREATE TABLE identity.auth_identities (
    id           UUID PRIMARY KEY,
    user_id      UUID NOT NULL REFERENCES identity.users(id),
    provider     TEXT NOT NULL CHECK (provider IN ('email','phone','telegram','google','vk','apple')),
    provider_uid TEXT NOT NULL,                              -- неизменяемый subject проверенного IdP
    verified_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_uid)
);
CREATE INDEX auth_identities_user ON identity.auth_identities (user_id);

COMMENT ON COLUMN identity.auth_identities.provider_uid IS
    'sub из токена IdP. Launch не реализует OIDC сам и не дублирует секреты IdP (ADR-003).';

-- ----------------------------------------------- версионируемые тексты документов
CREATE TABLE identity.consent_templates (
    kind          TEXT NOT NULL CHECK (kind IN
                  ('platform_rules','tos','pdn','commission_terms',
                   'marketing_communications','pdn_biometric')),
    version       TEXT NOT NULL,
    locale        TEXT NOT NULL DEFAULT 'ru-RU',
    body_sha256   BYTEA NOT NULL,                            -- хеш текста; тело — в S3/репозитории
    s3_key        TEXT,
    published_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    superseded_at TIMESTAMPTZ,
    PRIMARY KEY (kind, version, locale),
    CHECK (superseded_at IS NULL OR superseded_at >= published_at)
);
CREATE UNIQUE INDEX consent_templates_current_uq
    ON identity.consent_templates (kind, locale) WHERE superseded_at IS NULL;

-- ------------------------------------------------------ согласия (APPEND-ONLY)
-- Исторический факт акцепта неизменяем. Отзыв отзываемого ПДн-согласия —
-- новая запись в consent_events, а не UPDATE.
CREATE TABLE identity.consents (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES identity.users(id),
    kind            TEXT NOT NULL CHECK (kind IN
                    ('platform_rules','tos','pdn','commission_terms',
                     'marketing_communications','pdn_biometric')),
                    -- commission_terms: «Тарифы и комиссионные условия» — ОБЯЗАТЕЛЕН
                    -- для активации аккаунта обеих ролей (Architect_Launch §5.4)
    version         TEXT NOT NULL,
    locale          TEXT NOT NULL DEFAULT 'ru-RU',
    accepted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip_hash         BYTEA NOT NULL,
    user_agent_hash BYTEA,
    revoked_at      TIMESTAMPTZ,                             -- legacy-поле; новые отзывы — consent_events
    UNIQUE (user_id, kind, version),
    CHECK (kind NOT IN ('platform_rules','tos','pdn','commission_terms') OR revoked_at IS NULL),
    CONSTRAINT consents_template_fk
        FOREIGN KEY (kind, version, locale)
        REFERENCES identity.consent_templates(kind, version, locale)
);
CREATE INDEX consents_user_kind ON identity.consents (user_id, kind, accepted_at DESC);

CREATE OR REPLACE FUNCTION identity.forbid_consent_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, identity, public
AS $$
BEGIN
    RAISE EXCEPTION 'consents are immutable (kind=%)', OLD.kind USING ERRCODE = '42501';
END $$;

CREATE TRIGGER consents_immutable
    BEFORE UPDATE OR DELETE ON identity.consents
    FOR EACH ROW EXECUTE FUNCTION identity.forbid_consent_mutation();

-- APPEND-ONLY события жизненного цикла согласия.
CREATE TABLE identity.consent_events (
    id          UUID PRIMARY KEY,
    consent_id  UUID NOT NULL REFERENCES identity.consents(id),
    event_type  TEXT NOT NULL CHECK (event_type IN
                ('withdrawn','processing_stopped','legal_basis_changed')),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason      TEXT,
    actor_id    UUID REFERENCES identity.users(id),
    UNIQUE (consent_id, event_type, occurred_at)
);
CREATE INDEX consent_events_consent ON identity.consent_events (consent_id, occurred_at DESC);

CREATE TRIGGER consent_events_immutable
    BEFORE UPDATE OR DELETE ON identity.consent_events
    FOR EACH ROW EXECUTE FUNCTION identity.forbid_consent_mutation();

-- --------------------------------- проверка полноты акцептов (инвариант активации)
-- users.status='active' допустим только при наличии акцептов АКТУАЛЬНЫХ версий
-- platform_rules + tos + pdn + commission_terms. Функция — источник правды и
-- для сервисного слоя, и для CI-теста.
CREATE OR REPLACE FUNCTION identity.has_required_consents(p_user_id UUID, p_locale TEXT DEFAULT 'ru-RU')
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, identity, public
AS $$
    SELECT NOT EXISTS (
        SELECT 1
        FROM identity.consent_templates t
        WHERE t.superseded_at IS NULL
          AND t.locale = p_locale
          AND t.kind IN ('platform_rules','tos','pdn','commission_terms')
          AND NOT EXISTS (
              SELECT 1 FROM identity.consents c
              WHERE c.user_id = p_user_id
                AND c.kind = t.kind
                AND c.version = t.version
                AND c.locale = t.locale
                AND c.revoked_at IS NULL
          )
    );
$$;

COMMENT ON FUNCTION identity.has_required_consents(UUID, TEXT) IS
    'Блокирующий инвариант активации аккаунта. Architect_Launch §4.1, §5.4.';

-- Триггер-страховка: перевод в active без полного набора акцептов невозможен
-- даже при ошибке в сервисном слое (defense in depth).
CREATE OR REPLACE FUNCTION identity.enforce_activation_consents()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, identity, public
AS $$
BEGIN
    IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'active') THEN
        IF NOT identity.has_required_consents(NEW.id, NEW.locale) THEN
            RAISE EXCEPTION
                'account activation requires accepted current versions of platform_rules, tos, pdn, commission_terms'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER users_activation_requires_consents
    BEFORE INSERT OR UPDATE OF status ON identity.users
    FOR EACH ROW EXECUTE FUNCTION identity.enforce_activation_consents();

-- --------------------------------------- согласия на публичный контур (шов к Шоу)
CREATE TABLE identity.publication_consents (
    id               UUID PRIMARY KEY,
    user_id          UUID NOT NULL REFERENCES identity.users(id),
    project_id       UUID NOT NULL,                          -- FK → lab.projects добавляется в M004
    scope            TEXT NOT NULL CHECK (scope IN
                     ('episode_selection','episode_bootcamp','final_live','top100_public')),
    disclosed_fields JSONB NOT NULL DEFAULT '[]',
    document_version TEXT NOT NULL,
    document_sha256  BYTEA NOT NULL,
    accepted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at       TIMESTAMPTZ,                            -- отзыв → lab.consent.publication_revoked
    CHECK (revoked_at IS NULL OR revoked_at >= accepted_at)
);
CREATE INDEX publication_consents_project ON identity.publication_consents (project_id)
    WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX publication_consents_active_uq
    ON identity.publication_consents (user_id, project_id, scope) WHERE revoked_at IS NULL;

-- --------------------------------------------------------- профили инвесторов
CREATE TABLE identity.investor_profiles (
    user_id            UUID PRIMARY KEY REFERENCES identity.users(id),
    about              TEXT,
    focus_taxonomy_ids UUID[],
    check_size_min     NUMERIC(14,2),
    check_size_max     NUMERIC(14,2),
    currency           CHAR(3) NOT NULL DEFAULT 'RUB',
    entity_id          UUID,                                 -- FK → kyc.business_entities в M003
    kyc_status         TEXT NOT NULL DEFAULT 'none' CHECK (kyc_status IN
                       ('none','pending','approved','rejected')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (check_size_min IS NULL OR check_size_max IS NULL OR check_size_max >= check_size_min)
);

-- ------------------------------------------------------------------------ RLS
ALTER TABLE identity.users                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.users                 FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.user_roles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.user_roles            FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.auth_identities       ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.auth_identities       FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.consents              ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.consents              FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.consent_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.consent_events        FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.consent_templates     ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.consent_templates     FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.publication_consents  ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.publication_consents  FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.investor_profiles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.investor_profiles     FORCE  ROW LEVEL SECURITY;

-- ПРИНЦИП МОДЕЛИ ПОЛИТИК (действует во всех миграциях):
--
--  1. app_backend — роль, под которой обслуживаются ЗАПРОСЫ ПОЛЬЗОВАТЕЛЕЙ.
--     Она обязана быть полностью подчинена построчным политикам. Ни одной
--     политики вида `FOR ALL TO app_backend USING (true)`: такая политика
--     объединяется по ИЛИ с остальными и обнуляет всю изоляцию.
--     Сервисные права выдаются узко: FOR INSERT / FOR UPDATE, но не FOR ALL.
--
--  2. Пользовательские политики получают явный список `TO`, а не умолчание
--     PUBLIC. Иначе их выражения вычисляются и для app_public_read, которому
--     недоступны таблицы членства, — запрос падает по привилегиям.
--
--  3. Системные роли без пользовательского контекста (app_investments —
--     банковские события, app_billing — денежные операции, app_notifications —
--     доставка, app_integration — service-to-service) получают собственные
--     явные политики.

CREATE POLICY users_select ON identity.users FOR SELECT TO app_backend USING (
    id = app.current_user_id()
    OR app.has_role('admin')
    OR app.has_role('organizer'));

CREATE POLICY users_update_self ON identity.users FOR UPDATE TO app_backend USING (
    id = app.current_user_id() OR app.has_role('admin'))
WITH CHECK (
    id = app.current_user_id() OR app.has_role('admin'));

-- Регистрация: строка пользователя создаётся до того, как появился контекст
-- сессии, поэтому INSERT — сервисная операция. Только INSERT, не FOR ALL.
CREATE POLICY users_insert_service ON identity.users FOR INSERT TO app_backend WITH CHECK (true);

-- Системные роли читают профиль для доставки уведомлений и денежных операций.
CREATE POLICY users_system_read ON identity.users FOR SELECT
    TO app_investments, app_billing, app_notifications USING (true);

CREATE POLICY user_roles_select ON identity.user_roles FOR SELECT TO app_backend USING (
    user_id = app.current_user_id() OR app.has_role('admin') OR app.has_role('organizer'));
CREATE POLICY user_roles_insert ON identity.user_roles FOR INSERT TO app_backend
    WITH CHECK (true);
CREATE POLICY user_roles_revoke ON identity.user_roles FOR UPDATE TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));
CREATE POLICY user_roles_system_read ON identity.user_roles FOR SELECT
    TO app_investments, app_billing, app_notifications USING (true);

CREATE POLICY auth_identities_own ON identity.auth_identities FOR SELECT TO app_backend USING (
    user_id = app.current_user_id() OR app.has_role('admin'));
CREATE POLICY auth_identities_insert ON identity.auth_identities FOR INSERT TO app_backend
    WITH CHECK (true);
CREATE POLICY auth_identities_update ON identity.auth_identities FOR UPDATE TO app_backend
    USING (user_id = app.current_user_id() OR app.has_role('admin'))
    WITH CHECK (user_id = app.current_user_id() OR app.has_role('admin'));

CREATE POLICY consents_own ON identity.consents FOR SELECT TO app_backend USING (
    user_id = app.current_user_id() OR app.has_role('admin'));
-- INSERT разрешён только за себя: чужой акцепт подделать нельзя.
CREATE POLICY consents_insert_self ON identity.consents FOR INSERT TO app_backend WITH CHECK (
    user_id = app.current_user_id());

CREATE POLICY consent_events_own ON identity.consent_events FOR SELECT TO app_backend USING (
    EXISTS (SELECT 1 FROM identity.consents c
            WHERE c.id = consent_events.consent_id
              AND (c.user_id = app.current_user_id() OR app.has_role('admin'))));
CREATE POLICY consent_events_insert_service ON identity.consent_events FOR INSERT TO app_backend
    WITH CHECK (true);

-- Шаблоны документов публичны: правила и тарифы видны до регистрации
-- (принцип радикальной прозрачности). ПДн здесь нет — только хеши текстов.
CREATE POLICY consent_templates_public_read ON identity.consent_templates FOR SELECT
    TO app_public_read, app_backend, app_integration, app_notifications USING (true);
CREATE POLICY consent_templates_admin_write ON identity.consent_templates FOR ALL
    TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

CREATE POLICY publication_consents_own ON identity.publication_consents FOR ALL
    TO app_backend
    USING (user_id = app.current_user_id() OR app.has_role('admin') OR app.has_role('organizer'))
    WITH CHECK (user_id = app.current_user_id() OR app.has_role('admin'));
CREATE POLICY publication_consents_integration_read ON identity.publication_consents FOR SELECT
    TO app_integration USING (revoked_at IS NULL);

CREATE POLICY investor_profiles_own ON identity.investor_profiles FOR ALL
    TO app_backend
    USING (user_id = app.current_user_id() OR app.has_role('admin') OR app.has_role('organizer'))
    WITH CHECK (user_id = app.current_user_id() OR app.has_role('admin'));
CREATE POLICY investor_profiles_system_read ON identity.investor_profiles FOR SELECT
    TO app_investments USING (true);

-- ---------------------------------------------------------------------- права
GRANT SELECT, INSERT, UPDATE ON identity.users, identity.user_roles,
    identity.auth_identities, identity.investor_profiles, identity.publication_consents TO app_backend;
GRANT SELECT, INSERT ON identity.consents, identity.consent_events TO app_backend;
GRANT SELECT ON identity.consent_templates TO app_backend, app_public_read, app_integration;
GRANT INSERT, UPDATE ON identity.consent_templates TO app_backend;
GRANT SELECT ON identity.users, identity.user_roles TO app_investments, app_billing, app_notifications;
GRANT SELECT ON identity.investor_profiles TO app_investments;
