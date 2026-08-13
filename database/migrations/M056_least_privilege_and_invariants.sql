-- =============================================================================
-- M056 — least privilege по identity.users и доуточнение инвариантов
--        (MEDIUM/LOW внешнего аудита №2)
--
-- 1. Три сервисные роли читали `identity.users` ЦЕЛИКОМ — включая
--    `password_hash` (Argon2id → офлайн-перебор при компрометации роли),
--    шифртексты контактов, обёрнутый DEK и blind-индексы. Паттерн
--    поколоночного GRANT отработан в M046 для `app_auth`, но на старшие роли
--    не распространён. Фактически им нужны только идентификатор, отображаемое
--    имя, роль, статус и локаль (проверено grep'ом по коду: обращений к
--    users под этими ролями нет вовсе, гранты выданы «на будущее»).
--
-- 2. `users_update_self` + GRANT UPDATE на всю таблицу позволяли пользователю
--    менять `primary_role`, `deleted_at`, `sessions_valid_from`, а также
--    `email_hmac`/`phone_hmac` — то есть ломать blind-индексы и уникальность
--    контактов. Поколоночный GRANT UPDATE закрывает это правами, а не
--    аккуратностью кода.
--
-- 3. SELECT-политики материалов не фильтровали `uploaded_at IS NULL`:
--    утверждение «неподтверждённый материал наружу не выдаётся» держалось
--    только на коде приложения (M037). Вторая линия — в RLS.
--
-- 4. `has_required_consents` возвращала true для локали, где шаблонов НЕТ
--    (NOT EXISTS по пустому множеству): аккаунт активировался без единого
--    акцепта. Теперь наличие всех четырёх обязательных видов — условие.
--
-- 5. `has_valid_kyc` считала валидной верификацию с незакрытым санкционным
--    review (`sanctions_status='review'`). Для регулируемого контура это
--    комплаенс-риск; блокируем — «в процессе проверки» не равно «чисто».
--
-- 6. Ёмкость оффера контролировалась только при вставке договора: UPDATE
--    `target_amount` ниже уже набранной суммы ничем не сдерживался.
--
-- 7. `app_integration` читала ВСЕ `service_accounts`, включая
--    `client_secret_hash` чужих аккаунтов — офлайн-оракул при компрометации
--    роли. Проверка секрета выносится в SECURITY DEFINER-функцию,
--    возвращающую только вердикт.
-- =============================================================================

-- ------------------------------------- 1. поколоночное чтение identity.users
REVOKE SELECT ON identity.users FROM app_investments, app_billing, app_notifications;
GRANT SELECT (id, display_name, primary_role, status, locale)
    ON identity.users TO app_investments, app_billing, app_notifications;

-- ------------------------------------ 2. поколоночная правка identity.users
-- Что оставлено app_backend и почему: `status` и `updated_at` — активация
-- аккаунта после акцептов; `sessions_valid_from` — сдвиг рубежа сессий при
-- изменении прав; профильные поля — редактирование самим пользователем.
-- Чего НЕТ: primary_role (эскалация), deleted_at (самоудаление в обход
-- процедуры), контакты и их blind-индексы (поломка уникальности и поиска),
-- password_hash (смены пароля в API пока нет; появится — грант расширяется
-- явным шагом, а не по умолчанию).
REVOKE UPDATE ON identity.users FROM app_backend;
GRANT UPDATE (display_name, locale, currency_pref, mfa_enabled, status,
              updated_at, sessions_valid_from)
    ON identity.users TO app_backend;

-- --------------------------- 3. неподтверждённые материалы не видны наружу
DROP POLICY materials_member ON lab.project_materials;
CREATE POLICY materials_member ON lab.project_materials FOR ALL TO app_backend
    USING (
        (lab.is_project_member(project_id, app.current_user_id())
         OR app.has_role('admin') OR app.has_role('organizer'))
        -- Незавершённый билет загрузки — не материал. Уборка и подтверждение
        -- ходят своими путями (app_maintenance и UPDATE по id), поэтому
        -- фильтр не мешает жизненному циклу: он закрывает ЧТЕНИЕ.
        AND (uploaded_at IS NOT NULL OR app.has_role('admin')))
    WITH CHECK (lab.is_project_member(project_id, app.current_user_id())
                OR app.has_role('admin'));

DROP POLICY materials_select_reviewer ON lab.project_materials;
CREATE POLICY materials_select_reviewer ON lab.project_materials FOR SELECT TO app_backend
    USING (experts.is_assigned_reviewer(project_id, app.current_user_id())
           AND uploaded_at IS NOT NULL);

-- --------------------------------- 4. согласия: пустая локаль ≠ «всё принято»
CREATE OR REPLACE FUNCTION identity.has_required_consents(p_user_id UUID, p_locale TEXT DEFAULT 'ru-RU')
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, identity, public
AS $$
    SELECT
        -- Все четыре обязательных вида должны СУЩЕСТВОВАТЬ в этой локали:
        -- без этого условия локаль без шаблонов давала «нечего акцептовать»
        -- и аккаунт активировался без единого согласия.
        (SELECT count(DISTINCT t.kind) FROM identity.consent_templates t
          WHERE t.superseded_at IS NULL AND t.locale = p_locale
            AND t.kind IN ('platform_rules','tos','pdn','commission_terms')) = 4
        AND NOT EXISTS (
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

-- --------------------------------------- 5. санкционный review блокирует KYC
CREATE OR REPLACE FUNCTION kyc.has_valid_kyc(p_user_id UUID, p_kind TEXT DEFAULT 'identity')
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, kyc, public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM kyc.kyc_verifications v
        WHERE v.user_id = p_user_id
          AND v.kind = p_kind
          AND v.status = 'approved'
          AND (v.expires_at IS NULL OR v.expires_at > now())
          AND coalesce(v.risk_level, 'low') <> 'prohibited'
          -- 'review' — незакрытая санкционная проверка. Раньше проходила как
          -- валидная: блокировался только явный 'match'. Для регулируемого
          -- контура «ещё проверяем» не равно «чисто».
          AND v.sanctions_status NOT IN ('match', 'review')
    );
$$;

-- --------------------------------- 6. ёмкость оффера защищена и при UPDATE
CREATE OR REPLACE FUNCTION investments.enforce_offer_target_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, investments, pg_temp
AS $$
DECLARE
    v_taken NUMERIC(14,2);
BEGIN
    IF NEW.target_amount >= OLD.target_amount THEN
        RETURN NEW;
    END IF;
    SELECT coalesce(sum(a.contract_amount), 0) INTO v_taken
      FROM investments.investment_agreements a
     WHERE a.offer_id = NEW.id
       AND a.status <> 'canceled';
    IF NEW.target_amount < v_taken THEN
        RAISE EXCEPTION 'цель оффера ниже уже набранной суммы: % < %',
            NEW.target_amount, v_taken USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS offer_target_guard ON investments.investment_offers;
CREATE TRIGGER offer_target_guard
    BEFORE UPDATE OF target_amount ON investments.investment_offers
    FOR EACH ROW EXECUTE FUNCTION investments.enforce_offer_target_change();

-- ------------------------- 7. хеш секрета сервисного аккаунта — не перечислим
-- Сравнение Argon2id выполняется в приложении (соль внутри хеша, в SQL это
-- сравнение невозможно), поэтому хеш всё равно нужен вызывающему. Разница —
-- в объёме: раньше `app_integration` могла прочитать ВСЕ строки и получить
-- офлайн-оракул по чужим секретам; теперь узкая функция отдаёт материал
-- ровно по одному запрошенному `client_id`. Тот же паттерн, что закрыл
-- перечисление пользователей при входе (`identity.find_login_candidate`, M012).
CREATE OR REPLACE FUNCTION integration.find_token_candidate(p_client_id TEXT)
RETURNS TABLE (
    id                    UUID,
    client_id             TEXT,
    client_secret_hash    TEXT,
    mtls_cert_fingerprint TEXT,
    scopes                TEXT[],
    token_epoch           INTEGER
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, integration, pg_temp
AS $$
    SELECT sa.id, sa.client_id, sa.client_secret_hash, sa.mtls_cert_fingerprint,
           sa.scopes, sa.token_epoch
      FROM integration.service_accounts sa
     WHERE sa.client_id = p_client_id
       AND sa.status = 'active';
$$;

REVOKE ALL ON FUNCTION integration.find_token_candidate(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration.find_token_candidate(TEXT) TO app_integration;

COMMENT ON FUNCTION integration.find_token_candidate(TEXT) IS
    'Материал для проверки секрета РОВНО по одному client_id (M056): роль '
    'интеграции больше не может перечислить чужие client_secret_hash.';

-- Поколоночный GRANT: хеш и отпечаток сертификата роль читает только через
-- функцию выше, обычные операции (эпоха, скоупы, статус) — напрямую.
REVOKE SELECT ON integration.service_accounts FROM app_integration;
GRANT SELECT (id, client_id, name, scopes, status, token_epoch, created_at, rotated_at)
    ON integration.service_accounts TO app_integration;
