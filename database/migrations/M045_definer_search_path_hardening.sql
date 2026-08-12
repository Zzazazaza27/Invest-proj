-- =============================================================================
-- M045 — search_path функций SECURITY DEFINER доведён до безопасной формы
--
-- Находка внешнего аудита (SEC-14). M032 существенно сузила привилегии, но у
-- всех восьми definer-функций осталось два изъяна:
--
--  1. **`public` в пути.** Функция SECURITY DEFINER исполняется с правами
--     владельца. Если в `public` окажется объект с именем, совпадающим с тем,
--     что функция вызывает без указания схемы, вызов уйдёт в него — с правами
--     владельца. Фактически `public` нужен ровно одной функции из восьми
--     (`audit.app_emit_event` зовёт `digest` из pgcrypto); остальным семи он
--     достался «по инерции» и снят.
--  2. **`pg_temp` не последний, а чаще отсутствует вовсе.** Временная схема
--     ищется ПЕРВОЙ, если не указана явно: любой пользователь может создать в
--     ней объект и подменить им неквалифицированное имя. PostgreSQL прямо
--     рекомендует форму «доверенные схемы, затем pg_temp» — с pg_temp в конце.
--
-- Что эта миграция НЕ делает: она не переписывает тела функций на
-- схемо-квалифицированные имена. Для семи функций в этом нет нужды — после
-- снятия `public` в их пути остаются только собственные схемы и `pg_catalog`.
-- Для `audit.app_emit_event` `public` оставлен осознанно: там живёт pgcrypto.
-- Риск закрыт с другой стороны — правом создавать объекты в `public` не обладает
-- никто, кроме владельца схемы (проверено и закреплено ниже).
-- =============================================================================

-- --------------------------------------------------- 1. Безопасный search_path

ALTER FUNCTION audit.ensure_event_partitions(integer)
    SET search_path = pg_catalog, audit, pg_temp;

ALTER FUNCTION billing.confirm_first_tranche(
    uuid, text, numeric, timestamptz, bytea, uuid, text)
    SET search_path = pg_catalog, billing, investments, audit, pg_temp;

ALTER FUNCTION billing.project_deal_commission()
    SET search_path = pg_catalog, billing, integration, pg_temp;

ALTER FUNCTION identity.find_login_candidate(bytea, bytea)
    SET search_path = pg_catalog, identity, pg_temp;

ALTER FUNCTION identity.get_active_roles(uuid)
    SET search_path = pg_catalog, identity, pg_temp;

ALTER FUNCTION integration.active_publication_consent(uuid, text)
    SET search_path = pg_catalog, identity, pg_temp;

ALTER FUNCTION seasons.refresh_rating()
    SET search_path = pg_catalog, seasons, app, pg_temp;

-- Единственная функция, которой `public` нужен по делу: `digest` из pgcrypto
-- установлен именно туда. Порядок важен — `pg_temp` остаётся последним, поэтому
-- временный объект не может перехватить ни одно имя.
ALTER FUNCTION audit.app_emit_event(text, uuid, text, text, uuid, jsonb, text)
    SET search_path = pg_catalog, audit, public, pg_temp;

-- ------------------------------------------- 2. В public нельзя ничего создать

-- Подстраховка к пункту выше: пока никто, кроме владельца, не может положить
-- объект в `public`, подменить имя внутри `audit.app_emit_event` некому.
-- В PostgreSQL 15+ это поведение по умолчанию, но полагаться на умолчание
-- в правиле безопасности нельзя — оно меняется вместе с версией и настройкой.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

DO $$
DECLARE
    r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['app_backend', 'app_integration', 'app_notifications',
                             'app_analytics', 'app_maintenance']
    LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', r);
        END IF;
    END LOOP;
END $$;
