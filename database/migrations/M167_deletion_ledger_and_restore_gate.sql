-- M167 — учёт удалений и ворота восстановленной среды (2.1.5; пакет согласован Тэнком 09.11.2026).
--
-- ops.database_identity — идентификатор базы. Создаётся один раз и переезжает с копией
--   (дамп его содержит): восстановление на другой машине не делает события чужими.
-- ops.restore_gate — ворота среды. Пока они закрыты, ядро не обслуживает людей: 503 на всё,
--   кроме проверок живости. Ворота открыты только для ОТПЕЧАТКА базы, при котором их открыли:
--   идентификатор кластера, линия времени WAL и oid базы (ops.database_fingerprint). Любое
--   восстановление меняет хотя бы одно: дамп — новую базу или кластер, pgBackRest — новую
--   линию времени. Поэтому восстановленная база закрыта сама, без ручного шага. Открывает
--   только итоговая проверка применения журнала удалений. Смена кластера при крупном
--   обновлении PostgreSQL или переключение на реплику тоже закрывают ворота — открытие тем же
--   шагом проверки.
--   base_* — последнее звено цепочки аудита восстановленной базы: граница, после которой
--   применяются события из источника.
-- ops.deletions_applied — какие события источника применены после восстановления; запись
--   идёт в той же транзакции, что и применение, повтор ничего не меняет.
--
-- Ничего не удаляется физически: ни объекты хранилища, ни комплекты копий.

CREATE TABLE ops.database_identity (
    singleton  BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    id         UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO ops.database_identity (id) VALUES (public.uuid_generate_v7());

CREATE TABLE ops.restore_gate (
    singleton     BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    state         TEXT NOT NULL CHECK (state IN ('open', 'closed')),
    restore_id    TEXT,
    base_event_id UUID,
    base_row_hash BYTEA,
    fingerprint   TEXT,
    reason        TEXT,
    changed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Отпечаток базы. SECURITY DEFINER: функции управляющего файла доступны не всем ролям.
CREATE FUNCTION ops.database_fingerprint() RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
    SELECT (SELECT system_identifier::text FROM pg_control_system()) || ':' ||
           substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8) || ':' ||
           (SELECT oid::text FROM pg_database WHERE datname = current_database())
$$;

-- Состояние ворот для ядра: открыто, только если строка открыта И отпечаток совпал.
CREATE FUNCTION ops.restore_gate_state() RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, ops
AS $$
    SELECT CASE WHEN g.state = 'open' AND g.fingerprint = ops.database_fingerprint()
                THEN 'open' ELSE 'closed' END
      FROM (SELECT 1) AS one
      LEFT JOIN ops.restore_gate AS g ON true
$$;

INSERT INTO ops.restore_gate (state, fingerprint, reason)
VALUES ('open', ops.database_fingerprint(), 'M167: действующая среда');

CREATE TABLE ops.deletions_applied (
    event_id   UUID PRIMARY KEY,
    restore_id TEXT NOT NULL,
    category   TEXT NOT NULL,
    identity   TEXT NOT NULL,
    result     TEXT NOT NULL
               CHECK (result IN ('applied', 'unchanged', 'closed', 'not-recreated', 'superseded')),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX deletions_applied_restore ON ops.deletions_applied (restore_id, applied_at);

-- Ядро читает ворота и идентификатор базы; выгрузка аудита — идентификатор базы.
GRANT USAGE ON SCHEMA ops TO app_backend, app_archive;
GRANT SELECT ON ops.database_identity TO app_backend;
REVOKE ALL ON FUNCTION ops.database_fingerprint(), ops.restore_gate_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.restore_gate_state() TO app_backend, app_readonly;
GRANT SELECT ON ops.database_identity TO app_archive;
GRANT SELECT ON ops.database_identity, ops.restore_gate, ops.deletions_applied TO app_readonly;

ALTER TABLE ops.database_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.database_identity FORCE ROW LEVEL SECURITY;
ALTER TABLE ops.restore_gate ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.restore_gate FORCE ROW LEVEL SECURITY;
ALTER TABLE ops.deletions_applied ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.deletions_applied FORCE ROW LEVEL SECURITY;

CREATE POLICY database_identity_read ON ops.database_identity
    FOR SELECT TO app_backend, app_archive, app_readonly USING (true);
CREATE POLICY restore_gate_read ON ops.restore_gate
    FOR SELECT TO app_readonly USING (true);
CREATE POLICY deletions_applied_read ON ops.deletions_applied
    FOR SELECT TO app_readonly USING (true);

-- Виды событий: отключение подписки и отзыв устройства раньше в журнал не попадали;
-- повторное применение и открытие ворот пишет служебная процедура восстановления.
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('integration.webhook.disabled', 'Внешняя система отключила подписку на события',
     ARRAY['system']),
    ('comms.device.revoked', 'Отозвано устройство уведомлений',
     ARRAY['founder', 'investor', 'expert', 'organizer', 'admin']),
    ('ops.restore.reapplied', 'После восстановления применено итоговое состояние объекта',
     ARRAY['system']),
    ('ops.restore.opened', 'Восстановленная среда открыта после проверки журнала удалений',
     ARRAY['system'])
ON CONFLICT (verb) DO NOTHING;
