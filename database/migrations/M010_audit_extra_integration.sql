-- =============================================================================
-- M010 — audit-extra + integration
-- Реестр KEK, фичефлаги, прогоны AI-графов; сервисные аккаунты будущих
-- платформ, вебхуки, доставки, внешние ссылки.
-- Источник: Database_Launch.md §12, §13.
-- =============================================================================

CREATE TABLE audit.encryption_keys_registry (
    id              UUID PRIMARY KEY,
    domain          TEXT NOT NULL CHECK (domain IN
                    ('kyc_documents','kyb_documents','passport_sensitive',
                     'investment_documents','nominal_account_evidence',
                     'billing_documents','search_index')),
    kms_key_id      TEXT NOT NULL,
    wrapped_dek     BYTEA,
    rotated_from_id UUID REFERENCES audit.encryption_keys_registry(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX keys_domain ON audit.encryption_keys_registry (domain, created_at DESC);

COMMENT ON TABLE audit.encryption_keys_registry IS
    'Реестр KEK-доменов и ротаций. Сам ключевой материал здесь НЕ хранится — '
    'только идентификатор в KMS и обёрнутый DEK.';

CREATE TABLE audit.feature_flags (
    key         TEXT PRIMARY KEY,
    enabled     BOOLEAN NOT NULL DEFAULT false,
    rules_jsonb JSONB NOT NULL DEFAULT '{}',
    updated_by  UUID REFERENCES identity.users(id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE audit.feature_flags IS
    'Инвестиционный контур закрыт флагами до гейта A (включение в реестр ОИП '
    'Банка России и согласование Правил платформы). Дефолт — выключено.';

CREATE TABLE audit.agent_runs (
    id                UUID PRIMARY KEY,
    graph_name        TEXT NOT NULL,
    project_id        UUID REFERENCES lab.projects(id),
    user_id           UUID REFERENCES identity.users(id),
    status            TEXT NOT NULL DEFAULT 'running' CHECK (status IN
                      ('running','succeeded','failed','cancelled')),
    model_id          UUID REFERENCES scoring.score_models(id),
    langfuse_trace_id TEXT,
    cost_usd          NUMERIC(10,4) CHECK (cost_usd IS NULL OR cost_usd >= 0),
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at       TIMESTAMPTZ,
    CHECK (finished_at IS NULL OR finished_at >= started_at),
    CHECK (status = 'running' OR finished_at IS NOT NULL)
);
CREATE INDEX agent_runs_project ON audit.agent_runs (project_id, started_at DESC);

CREATE TABLE audit.node_checkpoints (
    id          UUID PRIMARY KEY,
    run_id      UUID NOT NULL REFERENCES audit.agent_runs(id),
    node_name   TEXT NOT NULL,
    state_jsonb JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX node_checkpoints_run ON audit.node_checkpoints (run_id, created_at);

-- ---------------------------------------------------------------- integration
CREATE TABLE integration.service_accounts (
    id                    UUID PRIMARY KEY,
    client_id             TEXT NOT NULL UNIQUE,
    name                  TEXT NOT NULL,
    client_secret_hash    TEXT NOT NULL,                     -- Argon2id; ротация 90 дней
    mtls_cert_fingerprint TEXT NOT NULL,
    scopes                TEXT[] NOT NULL DEFAULT '{}',
    status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
    created_by            UUID NOT NULL REFERENCES identity.users(id),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    rotated_at            TIMESTAMPTZ,
    -- Скоупы — строгий allowlist, а не свободный текст.
    CHECK (scopes <@ ARRAY['graduates:read','passport:read','listing:create','deals:read',
                           'show:read','webhooks:manage','seasons:read']),
    CHECK (cardinality(scopes) > 0)
);

COMMENT ON COLUMN integration.service_accounts.client_secret_hash IS
    'Argon2id-хеш. Сравнение — только constant-time, никогда через = (RULES.md §4).';

CREATE TABLE integration.webhook_endpoints (
    id                 UUID PRIMARY KEY,
    service_account_id UUID NOT NULL REFERENCES integration.service_accounts(id),
    url                TEXT NOT NULL,
    subscribed_verbs   TEXT[] NOT NULL,
    secret_ciphertext  BYTEA NOT NULL,                       -- исходящий HMAC-secret
    secret_kms_key_id  TEXT NOT NULL,
    secret_fingerprint BYTEA NOT NULL,                       -- поиск/аудит без раскрытия секрета
    status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Только https и только внешний адрес: защита от SSRF через собственный вебхук.
    CHECK (url ~ '^https://[a-zA-Z0-9._~:/?#\[\]@!$&''()*+,;=%-]+$'),
    CHECK (url !~* '^https://(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|\[::1\]|metadata\.)'),
    CHECK (cardinality(subscribed_verbs) > 0)
);
CREATE INDEX webhook_endpoints_account ON integration.webhook_endpoints (service_account_id);

CREATE TABLE integration.webhook_deliveries (
    id            UUID PRIMARY KEY,
    endpoint_id   UUID NOT NULL REFERENCES integration.webhook_endpoints(id),
    event_id      UUID NOT NULL REFERENCES audit.outbox_events(id),
    status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
                  ('queued','delivered','failed','exhausted')),
    attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    response_code INTEGER,
    next_retry_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (endpoint_id, event_id)
);
CREATE INDEX webhook_deliveries_queue ON integration.webhook_deliveries (status, next_retry_at)
    WHERE status IN ('queued','failed');

CREATE TABLE integration.external_refs (
    id            UUID PRIMARY KEY,
    local_type    TEXT NOT NULL,
    local_id      UUID NOT NULL,
    remote_system TEXT NOT NULL,                             -- 'unicorn-capital','media-hub'
    remote_type   TEXT NOT NULL,                             -- 'listing','episode'
    remote_id     TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (remote_system, remote_type, remote_id),
    UNIQUE (local_type, local_id, remote_system, remote_type)
);

-- Отложенный FK из M004: ссылка проекта на внешний листинг Capital.
ALTER TABLE lab.projects
    ADD CONSTRAINT projects_capital_ref_fk
    FOREIGN KEY (capital_ref) REFERENCES integration.external_refs(id);

-- ------------------------------------------------------------------------ RLS
ALTER TABLE audit.encryption_keys_registry  ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.encryption_keys_registry  FORCE  ROW LEVEL SECURITY;
ALTER TABLE audit.feature_flags             ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.feature_flags             FORCE  ROW LEVEL SECURITY;
ALTER TABLE audit.agent_runs                ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.agent_runs                FORCE  ROW LEVEL SECURITY;
ALTER TABLE audit.node_checkpoints          ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.node_checkpoints          FORCE  ROW LEVEL SECURITY;
ALTER TABLE integration.service_accounts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.service_accounts    FORCE  ROW LEVEL SECURITY;
ALTER TABLE integration.webhook_endpoints   ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.webhook_endpoints   FORCE  ROW LEVEL SECURITY;
ALTER TABLE integration.webhook_deliveries  ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.webhook_deliveries  FORCE  ROW LEVEL SECURITY;
ALTER TABLE integration.external_refs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.external_refs       FORCE  ROW LEVEL SECURITY;

-- Реестр ключей — только админ и только через сервис.
CREATE POLICY keys_admin ON audit.encryption_keys_registry FOR SELECT TO app_backend USING (app.has_role('admin'));
CREATE POLICY keys_service_insert ON audit.encryption_keys_registry FOR INSERT
    TO app_backend WITH CHECK (true);
CREATE POLICY keys_service_update ON audit.encryption_keys_registry FOR UPDATE
    TO app_backend USING (true) WITH CHECK (true);

-- Флаги читают все сервисы, меняет только админ.

CREATE POLICY flags_admin_write ON audit.feature_flags FOR ALL TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));
CREATE POLICY flags_service_read ON audit.feature_flags FOR SELECT
    TO app_backend, app_investments, app_billing, app_integration, app_notifications USING (true);

CREATE POLICY agent_runs_read ON audit.agent_runs FOR SELECT TO app_backend USING (
    app.has_role('admin')
    OR user_id = app.current_user_id()
    OR (project_id IS NOT NULL AND lab.is_project_member(project_id, app.current_user_id())));
CREATE POLICY agent_runs_service_insert ON audit.agent_runs FOR INSERT
    TO app_backend WITH CHECK (true);
CREATE POLICY agent_runs_service_update ON audit.agent_runs FOR UPDATE
    TO app_backend USING (true) WITH CHECK (true);

CREATE POLICY checkpoints_admin ON audit.node_checkpoints FOR SELECT TO app_backend USING (app.has_role('admin'));
CREATE POLICY checkpoints_service_insert ON audit.node_checkpoints FOR INSERT
    TO app_backend WITH CHECK (true);
CREATE POLICY checkpoints_service_update ON audit.node_checkpoints FOR UPDATE
    TO app_backend USING (true) WITH CHECK (true);

CREATE POLICY service_accounts_admin ON integration.service_accounts FOR ALL TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));
CREATE POLICY service_accounts_read ON integration.service_accounts FOR SELECT
    TO app_integration USING (status = 'active');

CREATE POLICY webhook_endpoints_admin ON integration.webhook_endpoints FOR ALL TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));
CREATE POLICY webhook_endpoints_service ON integration.webhook_endpoints FOR ALL
    TO app_integration USING (true) WITH CHECK (true);

CREATE POLICY webhook_deliveries_service ON integration.webhook_deliveries FOR ALL
    TO app_integration USING (true) WITH CHECK (true);
CREATE POLICY webhook_deliveries_admin ON integration.webhook_deliveries FOR SELECT TO app_backend
    USING (app.has_role('admin'));

CREATE POLICY external_refs_service ON integration.external_refs FOR ALL
    TO app_integration USING (true) WITH CHECK (true);
CREATE POLICY external_refs_backend ON integration.external_refs FOR SELECT
    TO app_backend USING (true);
CREATE POLICY external_refs_admin ON integration.external_refs FOR SELECT TO app_backend
    USING (app.has_role('admin'));

-- ---------------------------------------------------------------------- права
GRANT SELECT, INSERT, UPDATE ON audit.encryption_keys_registry, audit.feature_flags,
    audit.agent_runs, audit.node_checkpoints TO app_backend;
GRANT SELECT ON audit.feature_flags
    TO app_investments, app_billing, app_integration, app_notifications;
GRANT SELECT, INSERT, UPDATE ON integration.service_accounts, integration.webhook_endpoints,
    integration.webhook_deliveries, integration.external_refs TO app_integration;
GRANT SELECT, INSERT, UPDATE ON integration.service_accounts, integration.webhook_endpoints,
    integration.external_refs TO app_backend;
