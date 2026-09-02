-- =============================================================================
-- M008 — comms
-- Устройства, версионируемые шаблоны, очередь уведомлений с дедупликацией,
-- пользовательские предпочтения по каналам и темам.
-- Источник: docs/architecture/Database_Launch.md §10.
--
-- Политика каналов: сервисные — push → telegram → email; security — sms + email;
-- биллинг-критичные (просрочка, счёт на вознаграждение) — push + email + sms;
-- маркетинг — только при consents(kind='marketing_communications').
-- =============================================================================

CREATE TABLE comms.user_devices (
    id            UUID PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES identity.users(id),
    platform      TEXT NOT NULL CHECK (platform IN ('ios','android','web_pwa')),
    push_provider TEXT NOT NULL CHECK (push_provider IN ('fcm','apns','web_push')),
    push_token    TEXT NOT NULL,
    device_name   TEXT,
    app_version   TEXT,
    locale        TEXT,
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_devices_token_uq
    ON comms.user_devices (push_provider, push_token) WHERE revoked_at IS NULL;
CREATE INDEX user_devices_active ON comms.user_devices (user_id) WHERE revoked_at IS NULL;

CREATE TABLE comms.notification_templates (
    id             UUID PRIMARY KEY,
    code           TEXT NOT NULL,
    channel        TEXT NOT NULL CHECK (channel IN ('push','telegram','email','sms','inapp')),
    locale         TEXT NOT NULL DEFAULT 'ru-RU',
    version        INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    title_template TEXT,
    body_template  TEXT NOT NULL,
    fallback_chain TEXT[] NOT NULL DEFAULT '{}',
    is_critical    BOOLEAN NOT NULL DEFAULT false,
    is_active      BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (code, channel, locale, version)
);
CREATE UNIQUE INDEX notification_templates_one_active
    ON comms.notification_templates (code, channel, locale) WHERE is_active;

CREATE TABLE comms.notifications (
    id            UUID PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES identity.users(id),
    device_id     UUID REFERENCES comms.user_devices(id),
    channel       TEXT NOT NULL CHECK (channel IN ('push','telegram','email','sms','inapp')),
    template_code TEXT NOT NULL,
    payload_jsonb JSONB NOT NULL DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
                  ('queued','sending','sent','failed','skipped_by_preference')),
    provider      TEXT,
    provider_ref  TEXT,
    dedup_key     TEXT,
    attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    error_detail  TEXT,
    sent_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);
CREATE UNIQUE INDEX notifications_dedup_uq
    ON comms.notifications (user_id, dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX notifications_queue ON comms.notifications (status, channel, created_at)
    WHERE status = 'queued';
CREATE INDEX notifications_user ON comms.notifications (user_id, created_at DESC);

COMMENT ON COLUMN comms.notifications.payload_jsonb IS
    'Только идентификаторы и безопасные для канала поля. ПДн в payload не кладутся: '
    'push и sms проходят через сторонних провайдеров.';

CREATE TABLE comms.notification_preferences (
    user_id        UUID NOT NULL REFERENCES identity.users(id),
    channel        TEXT NOT NULL CHECK (channel IN ('push','telegram','email','sms','inapp')),
    topic          TEXT NOT NULL DEFAULT 'all' CHECK (topic IN
                   ('all','projects','deals','billing','experts','seasons','messages','security','marketing')),
    enabled        BOOLEAN NOT NULL DEFAULT true,
    quiet_hours_tz TEXT,
    quiet_from     TIME,
    quiet_to       TIME,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, channel, topic),
    -- security и критичные биллинг-уведомления не отключаются
    CHECK (topic NOT IN ('security','billing') OR enabled = true),
    CHECK ((quiet_from IS NULL) = (quiet_to IS NULL)),
    CHECK (quiet_from IS NULL OR quiet_hours_tz IS NOT NULL)
);

-- ------------------------------------------------------------------------ RLS
ALTER TABLE comms.user_devices             ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.user_devices             FORCE  ROW LEVEL SECURITY;
ALTER TABLE comms.notification_templates   ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.notification_templates   FORCE  ROW LEVEL SECURITY;
ALTER TABLE comms.notifications            ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.notifications            FORCE  ROW LEVEL SECURITY;
ALTER TABLE comms.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.notification_preferences FORCE  ROW LEVEL SECURITY;

CREATE POLICY devices_own ON comms.user_devices FOR ALL TO app_backend USING (
    user_id = app.current_user_id())
WITH CHECK (user_id = app.current_user_id());
CREATE POLICY devices_delivery ON comms.user_devices FOR SELECT
    TO app_notifications USING (true);

CREATE POLICY notifications_own ON comms.notifications FOR SELECT TO app_backend USING (
    user_id = app.current_user_id());
CREATE POLICY notifications_delivery ON comms.notifications FOR ALL
    TO app_notifications USING (true) WITH CHECK (true);
CREATE POLICY notifications_enqueue ON comms.notifications FOR INSERT
    TO app_backend WITH CHECK (true);

CREATE POLICY prefs_own ON comms.notification_preferences FOR ALL TO app_backend USING (
    user_id = app.current_user_id() OR app.has_role('admin'))
WITH CHECK (user_id = app.current_user_id() OR app.has_role('admin'));
CREATE POLICY prefs_delivery ON comms.notification_preferences FOR SELECT
    TO app_notifications USING (true);


CREATE POLICY templates_delivery ON comms.notification_templates FOR SELECT
    TO app_notifications, app_backend USING (true);
CREATE POLICY templates_admin_write ON comms.notification_templates FOR ALL TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

-- ---------------------------------------------------------------------- права
GRANT SELECT, INSERT, UPDATE ON comms.user_devices, comms.notifications,
    comms.notification_preferences, comms.notification_templates TO app_backend;
GRANT SELECT, UPDATE ON comms.notifications TO app_notifications;
GRANT SELECT ON comms.user_devices, comms.notification_preferences,
    comms.notification_templates TO app_notifications;
