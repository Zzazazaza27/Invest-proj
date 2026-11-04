-- M157 — реестр установок и фактических версий (блок 9, задание 1; работа 2.1-W09c).
--
-- Источник журнала выпуска: история установок и возвратов, цели, этапы и
-- подтверждённые версии экземпляров. У каждой среды реестр в своей базе: тестовое
-- ядро не получает доступ к рабочей.
--
-- Запись — только роль выпуска app_release, просмотр — app_readonly. Ядро реестр не
-- пишет. Этапы только добавляются: история сохраняется после ошибки и возврата.
--
-- Общая блокировка — частичный уникальный индекс: одна операция `running` на среду.
-- Захват подтверждает сама вставка; без неё выпуск не начинается.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_release') THEN
        CREATE ROLE app_release NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
    ELSE
        ALTER ROLE app_release NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;
    -- Владелец состоит в группе, чтобы выдавать её логин-роли.
    EXECUTE format('GRANT app_release TO %I', current_user);
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_release', current_database());
END $$;

CREATE SCHEMA ops;

CREATE TABLE ops.installations (
    id             UUID PRIMARY KEY,
    env            TEXT NOT NULL,
    build          TEXT NOT NULL,
    commit_sha     TEXT NOT NULL,
    kit_sha256     TEXT NOT NULL,
    expected_build TEXT,
    actor          TEXT NOT NULL,
    approved_by    TEXT NOT NULL,
    kind           TEXT NOT NULL DEFAULT 'install' CHECK (kind IN ('install', 'rollback')),
    status         TEXT NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running', 'succeeded', 'failed', 'interrupted')),
    detail         TEXT,
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX installations_one_running ON ops.installations (env)
    WHERE status = 'running';
CREATE INDEX installations_env_started ON ops.installations (env, started_at DESC);

CREATE TABLE ops.installation_targets (
    installation_id UUID NOT NULL REFERENCES ops.installations (id),
    instance_id     TEXT NOT NULL,
    component       TEXT NOT NULL,
    role            TEXT NOT NULL,
    expected_image  TEXT NOT NULL,
    PRIMARY KEY (installation_id, instance_id)
);

CREATE TABLE ops.installation_events (
    id              UUID PRIMARY KEY,
    installation_id UUID NOT NULL REFERENCES ops.installations (id),
    at              TIMESTAMPTZ NOT NULL,
    stage           TEXT NOT NULL,
    result          TEXT NOT NULL,
    detail          TEXT
);

CREATE INDEX installation_events_op ON ops.installation_events (installation_id, at);

CREATE TABLE ops.instances (
    instance_id  TEXT PRIMARY KEY,
    env          TEXT NOT NULL,
    component    TEXT NOT NULL,
    actual_image TEXT,
    state        TEXT NOT NULL,
    ready        BOOLEAN,
    confirmed_at TIMESTAMPTZ NOT NULL,
    source       TEXT NOT NULL
);

GRANT USAGE ON SCHEMA ops TO app_release, app_readonly;
GRANT SELECT, INSERT, UPDATE ON ops.installations, ops.instances TO app_release;
GRANT SELECT, INSERT ON ops.installation_targets, ops.installation_events TO app_release;
GRANT SELECT ON ALL TABLES IN SCHEMA ops TO app_readonly;
-- Сверка выпуска сравнивает применённые миграции с манифестом комплекта.
GRANT SELECT ON public.schema_migrations TO app_release;

ALTER TABLE ops.installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.installation_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.installation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.instances ENABLE ROW LEVEL SECURITY;

CREATE POLICY installations_release ON ops.installations TO app_release USING (true) WITH CHECK (true);
CREATE POLICY targets_release ON ops.installation_targets TO app_release USING (true) WITH CHECK (true);
CREATE POLICY events_release ON ops.installation_events TO app_release USING (true) WITH CHECK (true);
CREATE POLICY instances_release ON ops.instances TO app_release USING (true) WITH CHECK (true);
CREATE POLICY installations_read ON ops.installations FOR SELECT TO app_readonly USING (true);
CREATE POLICY targets_read ON ops.installation_targets FOR SELECT TO app_readonly USING (true);
CREATE POLICY events_read ON ops.installation_events FOR SELECT TO app_readonly USING (true);
CREATE POLICY instances_read ON ops.instances FOR SELECT TO app_readonly USING (true);

COMMENT ON ROLE app_release IS
    'Процесс выпуска и сверка версий: запись реестра ops. Прикладных схем не видит.';
