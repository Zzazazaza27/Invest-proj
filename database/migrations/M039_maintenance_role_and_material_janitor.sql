-- =============================================================================
-- M039 — роль планового обслуживания и уборка брошенных материалов
--
-- Две связанные вещи.
--
-- 1. **Роль `app_maintenance`.** Уборка — это не доставка уведомлений и не
--    работа пользовательского API. В M038 реестр отзывов убирала роль
--    `app_notifications` просто потому, что у неё оказалась подходящая
--    SELECT-политика; это работало, но роль означала не то, что делала. Здесь
--    заводится отдельная роль планового обслуживания, и права уборки переходят
--    к ней (ADR-006: у каждого контура своя роль и свои права).
--
-- 2. **Уборка брошенных материалов (остаток SEC-14).** Билет на загрузку мог
--    быть выдан и не использован: строка материала есть, объекта в хранилище
--    нет — или он есть, но подтверждения не было. Наружу такой материал уже не
--    выдаётся (M037), но и не убирается: и строка, и объект остаются навсегда.
--
-- Защитная рамка вынесена в саму политику, а не оставлена коду: удалять
-- разрешено ТОЛЬКО неподтверждённые записи и ТОЛЬКО старше часа. Час — не
-- произвольное число: предельный срок жизни подписанной формы загрузки
-- ограничен `S3_PRESIGN_TTL_SECONDS` максимумом в 3600 секунд, то есть через
-- час билет заведомо непригоден и «загрузка ещё идёт» невозможна.
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_maintenance') THEN
        CREATE ROLE app_maintenance NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
    ELSE
        ALTER ROLE app_maintenance NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;
    -- Владелец схем состоит во всех сервисных группах: иначе SECURITY DEFINER
    -- упирался бы в собственные политики `TO app_*` (см. M000).
    EXECUTE format('GRANT app_maintenance TO %I', current_user);
END $$;

DO $$
BEGIN
    -- Тестовая база называется иначе; грант на неё выдаётся тем же прогоном,
    -- поэтому имя берётся из текущего подключения, а не зашивается.
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_maintenance', current_database());
END $$;

GRANT USAGE ON SCHEMA app TO app_maintenance;
GRANT EXECUTE ON FUNCTION app.current_user_id(), app.current_roles(), app.has_role(TEXT)
    TO app_maintenance;
GRANT USAGE ON SCHEMA identity, lab TO app_maintenance;

-- ---------------------------------------------------------------- реестр отзывов
-- Права уборки переезжают с роли доставки уведомлений на роль обслуживания.
-- Чтение реестра на входе остаётся за `app_notifications`: его выполняет guard
-- на каждом запросе, и это не обслуживание.
DROP POLICY IF EXISTS revoked_tokens_delete_expired ON identity.revoked_tokens;
REVOKE DELETE ON identity.revoked_tokens FROM app_notifications;

-- DELETE читает строку, поэтому роли нужна и SELECT-политика: без неё уборка
-- удаляет ноль строк молча (проверено прогоном в Ф12).
CREATE POLICY revoked_tokens_maintenance_read ON identity.revoked_tokens FOR SELECT
    TO app_maintenance USING (true);
CREATE POLICY revoked_tokens_maintenance_delete ON identity.revoked_tokens FOR DELETE
    TO app_maintenance USING (expires_at < now());

GRANT SELECT, DELETE ON identity.revoked_tokens TO app_maintenance;

-- ------------------------------------------------------- брошенные материалы
-- Видно ровно то, что подлежит уборке: подтверждённые материалы роли
-- обслуживания не показываются вовсе.
CREATE POLICY materials_maintenance_read ON lab.project_materials FOR SELECT
    TO app_maintenance USING (
        uploaded_at IS NULL
        AND type <> 'product_link'
        AND created_at < now() - interval '1 hour');

CREATE POLICY materials_maintenance_delete ON lab.project_materials FOR DELETE
    TO app_maintenance USING (
        uploaded_at IS NULL
        AND type <> 'product_link'
        AND created_at < now() - interval '1 hour');

GRANT SELECT, DELETE ON lab.project_materials TO app_maintenance;

COMMENT ON POLICY materials_maintenance_read ON lab.project_materials IS
    'Роль обслуживания видит только брошенные билеты на загрузку: подтверждённый '
    'материал ей не виден, и удалить его она не может (M039).';

-- Доступа к схеме `audit` роль обслуживания НЕ получает намеренно. Уборка
-- брошенного билета — не доменный факт: событие писать не о чем, а лишний
-- GRANT на журнал стоил бы дороже той наблюдаемости, которую даёт счётчик в
-- логе обслуживания.
