-- =============================================================================
-- M052 — отдельная роль для выгрузки журнала в архив (остаток SEC-10)
--
-- Выгрузка журнала работала подключением ВЛАДЕЛЬЦА схем — суперпользователя
-- кластера, который обходит RLS и может всё, включая правку самого журнала.
-- Процедуре, которая ЧИТАЕТ журнал и ПИШЕТ строку в реестр выгрузок, столько
-- прав не нужно; скомпрометированный скрипт выгрузки не должен уметь трогать
-- сам журнал.
--
-- `app_archive` получает ровно рабочий набор:
--   * SELECT по audit.events ЦЕЛИКОМ — выгрузке нужен весь журнал, это её
--     назначение, а не расползание прав;
--   * SELECT + INSERT в audit.event_archives — реестр выгрузок: прочитать,
--     докуда выгружено, и записать новую строку. Ни UPDATE, ни DELETE:
--     реестр append-only для этой роли;
--   * EXECUTE audit.verify_event_chain — сверка цепочки до выгрузки.
--
-- Чего у роли НЕТ (и это проверяет гейт check-service-roles):
--   * INSERT/UPDATE/DELETE по audit.events — журнал для неё только чтение;
--   * доступа к identity/kyc/investments и прочим схемам данных.
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_archive') THEN
        CREATE ROLE app_archive NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
    ELSE
        ALTER ROLE app_archive NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;
    -- Владелец состоит в группе, чтобы выдавать её логин-роли (bootstrap:roles).
    EXECUTE format('GRANT app_archive TO %I', current_user);
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_archive', current_database());
END $$;

GRANT USAGE ON SCHEMA audit TO app_archive;

-- ------------------------------------------------------------------ журнал
-- Роль читает журнал целиком: политика без предикатов по пользовательскому
-- контексту — у процедуры выгрузки его нет и быть не должно.
GRANT SELECT ON audit.events TO app_archive;

CREATE POLICY events_archive_read ON audit.events FOR SELECT
    TO app_archive USING (true);

GRANT EXECUTE ON FUNCTION audit.verify_event_chain(TIMESTAMPTZ) TO app_archive;

-- ------------------------------------------------------------- реестр выгрузок
GRANT SELECT, INSERT ON audit.event_archives TO app_archive;

CREATE POLICY event_archives_archive_read ON audit.event_archives FOR SELECT
    TO app_archive USING (true);

CREATE POLICY event_archives_archive_insert ON audit.event_archives FOR INSERT
    TO app_archive WITH CHECK (true);

COMMENT ON ROLE app_archive IS
    'Выгрузка журнала событий в холодное хранилище (SEC-10): чтение журнала, '
    'append-only реестр выгрузок. Журнал изменять не может.';
