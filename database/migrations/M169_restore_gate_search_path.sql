-- M169 — путь поиска функций ворот (2.1.5): pg_temp последним (check-definer-privileges,
-- CI 42601521421). SECURITY DEFINER без pg_temp в конце позволил бы подменить объект
-- временной схемой вызывающего. Тела функций не меняются; M167 не правится.

CREATE OR REPLACE FUNCTION ops.database_fingerprint() RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT (SELECT system_identifier::text FROM pg_control_system()) || ':' ||
           substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8) || ':' ||
           (SELECT oid::text FROM pg_database WHERE datname = current_database())
$$;

CREATE OR REPLACE FUNCTION ops.restore_gate_state() RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, ops, pg_temp
AS $$
    SELECT CASE WHEN g.state = 'open' AND g.fingerprint = ops.database_fingerprint()
                THEN 'open' ELSE 'closed' END
      FROM (SELECT 1) AS one
      LEFT JOIN ops.restore_gate AS g ON true
$$;

REVOKE ALL ON FUNCTION ops.database_fingerprint(), ops.restore_gate_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.restore_gate_state() TO app_backend, app_readonly;
