-- M150 — удаление сезонов, инвестиционного процесса, экспертизы и анализа ИИ (2.1-W05).
-- migrate:contract
--
-- Решение Томаса 29.10.2026: из базовой 5Э «под корень» удаляются сезоны и
-- золотые билеты, сезонная воронка статусов проекта, медиаконтур и согласия
-- на публичный контур; весь инвестиционный процесс (заявки, анкеты, политика
-- ограничений, готовность, снимки версий, раунды, сделки, биллинг кроме
-- списка стран, пакеты, услуги, комиссии); экспертиза и кабинет сотрудника с
-- назначениями на сопровождение; денежные полномочия finance.*; анализ ИИ
-- (скоринг, паспорт, IRS, дорожные карты, ключи провайдеров, разбор
-- материалов); роли organizer, showrunner и expert.
--
-- Это contract-шаг: код, который пользовался удаляемым, уже убран в том же
-- задании, а данные на обоих стендах обнулены (29.10.2026). Новой стартовой
-- схемы нет — история миграций сохраняется, это одна итоговая миграция поверх.
--
-- Сохраняется: аккаунты и вход, механизм ролей и прав (кроме удалённых
-- ролей), KYC/KYB, проекты со всем связанным (investment_ask остаётся полем
-- проекта), материалы, каталог и избранное, MI целиком, уведомления, почта,
-- поддержка, тексты, флаги, языки, инфраструктура, Integration API (сервисные
-- аккаунты, токен, вебхуки). Из биллинга — только список стран обслуживания.
--
-- Права не расширяются ни у кого:
--  * допуск инвестора по роли держался на подписке; подписок нет — допуск
--    по роли убран, а не открыт (режим «зарегистрированные инвесторы» вне
--    команды сейчас не открывает ничего);
--  * удалённые роли не дают полномочий: строки ролей удаляются, ветви
--    политик с ними — тоже; app.has_role больше не знает об organizer.
--
-- Данные, которые нельзя отобразить без потери смысла (статус воронки у
-- проекта, удалённая роль основной у пользователя, разрешение только из
-- удалённых частей), миграция не «переводит» молча, а останавливается с
-- объяснением. На обнулённых стендах таких строк нет.

-- ============================================================ 0. Предпроверка
DO $$
DECLARE
    v_count BIGINT;
BEGIN
    SELECT count(*) INTO v_count FROM lab.projects
     WHERE status NOT IN ('draft', 'rejected', 'archived')
        OR listing_status = 'suspended_billing';
    IF v_count > 0 THEN
        RAISE EXCEPTION 'M150: % проект(ов) в статусе удаляемой воронки или снятых по подписке — '
                        'решите их судьбу до миграции', v_count;
    END IF;

    SELECT count(*) INTO v_count FROM identity.users
     WHERE primary_role IN ('expert', 'organizer', 'showrunner');
    IF v_count > 0 THEN
        RAISE EXCEPTION 'M150: у % пользовател(я/ей) основная роль удаляется — '
                        'назначьте другую до миграции', v_count;
    END IF;

    SELECT count(*) INTO v_count FROM lab.project_access_grants
     WHERE NOT (permissions && ARRAY['profile', 'materials', 'extended']);
    IF v_count > 0 THEN
        RAISE EXCEPTION 'M150: % разрешени(е/й) состоят только из удаляемых частей (раунд, паспорт)',
                        v_count;
    END IF;
END $$;

-- ============================================ 1. Политики на остающихся таблицах
-- Ветви рецензента и организатора удаляются до функций, на которые они
-- опираются: иначе удаление схемы унесло бы их каскадом молча.
DROP POLICY IF EXISTS events_read_expert_assignment ON audit.events;
DROP POLICY IF EXISTS materials_select_reviewer ON lab.project_materials;
DROP POLICY IF EXISTS projects_select_reviewer ON lab.projects;
DROP POLICY IF EXISTS projects_update_organizer ON lab.projects;

-- Служебные контуры денег и сделок больше ничего не читают.
DROP POLICY IF EXISTS entities_investments_read ON kyc.business_entities;
DROP POLICY IF EXISTS entity_members_investments_read ON kyc.entity_members;
DROP POLICY IF EXISTS kyb_investments_read ON kyc.kyb_verifications;
DROP POLICY IF EXISTS kyc_investments_read ON kyc.kyc_verifications;

ALTER POLICY events_read_own ON audit.events
    USING (actor_id = app.current_user_id() OR app.has_role('admin'));
ALTER POLICY user_roles_select ON identity.user_roles
    USING (user_id = app.current_user_id() OR app.has_role('admin'));
ALTER POLICY users_select ON identity.users
    USING (id = app.current_user_id() OR app.has_role('admin'));
ALTER POLICY entities_member_select ON kyc.business_entities
    USING (owner_user_id = app.current_user_id()
           OR kyc.is_entity_member(id, app.current_user_id())
           OR app.has_role('admin'));
ALTER POLICY entity_members_select ON kyc.entity_members
    USING (user_id = app.current_user_id() OR app.has_role('admin'));
ALTER POLICY kyb_member_select ON kyc.kyb_verifications
    USING (kyc.is_entity_member(entity_id, app.current_user_id()) OR app.has_role('admin'));
ALTER POLICY kyc_own_select ON kyc.kyc_verifications
    USING (user_id = app.current_user_id() OR app.has_role('admin'));
ALTER POLICY founders_select ON lab.founders_projects
    USING (user_id = app.current_user_id() OR app.has_role('admin'));
ALTER POLICY materials_member ON lab.project_materials
    USING ((lab.is_project_member(project_id, app.current_user_id()) OR app.has_role('admin'))
           AND (uploaded_at IS NOT NULL OR uploaded_by = app.current_user_id()
                OR app.has_role('admin')))
    WITH CHECK (lab.is_project_member(project_id, app.current_user_id()) OR app.has_role('admin'));
ALTER POLICY projects_select ON lab.projects
    USING (app.has_role('admin') OR lab.is_project_member(id, app.current_user_id()));

-- Списки сервисных ролей без удаляемых контуров.
ALTER POLICY event_registry_service_read ON audit.event_type_registry
    TO app_backend, app_integration, app_notifications;
ALTER POLICY flags_service_read ON audit.feature_flags
    TO app_backend, app_integration, app_notifications;
ALTER POLICY outbox_service ON audit.outbox_events
    TO app_backend, app_integration;
ALTER POLICY user_roles_system_read ON identity.user_roles TO app_notifications;
ALTER POLICY users_system_read ON identity.users TO app_notifications;
ALTER POLICY founders_system_read ON lab.founders_projects TO app_integration;
ALTER POLICY projects_system_read ON lab.projects TO app_integration;

-- ==================================================== 2. Триггеры воронки
DROP TRIGGER IF EXISTS projects_stamp_graduated_at ON lab.projects;
DROP TRIGGER IF EXISTS projects_organizer_scope ON lab.projects;
DROP TRIGGER IF EXISTS projects_stage_order ON lab.projects;

-- =============================== 3. Проекции, собранные из раунда и паспорта
DROP VIEW lab.v_public_catalog;
DROP FUNCTION lab.project_view_base(UUID);
-- Рейтинг сезона читает season_id проекта — уходит до колонки.
DROP MATERIALIZED VIEW seasons.mv_season_rating;

-- ==================================== 4. Колонки проекта и материала
-- Внешние ключи на версии, заявки, сезоны и внешние ссылки уходят вместе с
-- колонками.
ALTER TABLE lab.projects
    DROP CONSTRAINT IF EXISTS projects_disclosure_pair,
    DROP CONSTRAINT IF EXISTS projects_disclosure_form_version_check,
    DROP COLUMN season_id,
    DROP COLUMN current_version_id,
    DROP COLUMN current_application_id,
    DROP COLUMN capital_ref,
    DROP COLUMN graduated_at,
    DROP COLUMN disclosed_version_id,
    DROP COLUMN disclosure_form_version,
    DROP COLUMN disclosed_at,
    DROP COLUMN disclosed_by;

ALTER TABLE lab.project_materials
    DROP CONSTRAINT IF EXISTS project_materials_parse_status_check,
    DROP COLUMN parse_status;

-- ======================================================= 5. Таблицы
-- Одной командой: удаляемые таблицы ссылаются друг на друга крест-накрест
-- (покупки раунда — на раунды, начисления — на договоры), и единый DROP
-- разбирает порядок сам. CASCADE не нужен: снаружи на них не ссылается
-- ничего — ссылки из остающихся таблиц сняты выше вместе с колонками.
DROP TABLE
    -- лаборатория: заявки, версии, раунды, анкеты, готовность, разбор
    lab.funding_round_basis_history, lab.funding_rounds, lab.project_material_parses,
    lab.project_duplicates, lab.project_versions, lab.investment_applications,
    lab.application_form_versions, lab.application_policies, lab.readiness_configs,
    -- личные и внешние данные удалённых процессов
    identity.publication_consents, identity.investor_profiles,
    integration.deal_commissions, integration.external_refs,
    comms.operator_notifications, audit.node_checkpoints, audit.agent_runs,
    -- биллинг — всё, кроме списка стран обслуживания
    billing.commission_adjustments, billing.commission_accruals, billing.fee_offsets,
    billing.fee_offset_rules, billing.fee_schedules, billing.payment_discrepancies,
    billing.payment_events, billing.invoices, billing.purchase_item_runs,
    billing.round_purchase_items, billing.payments, billing.round_purchases,
    billing.round_package_selections, billing.round_package_alternatives,
    billing.round_package_services, billing.round_packages, billing.round_service_offers,
    billing.round_services, billing.service_country_policies, billing.subscriptions,
    billing.plan_capability_links, billing.plan_capabilities, billing.subscription_plans,
    -- экспертиза
    experts.expert_notes, experts.expert_reviews, experts.review_consensus,
    experts.expert_conflict_declarations, experts.expert_assignments, experts.experts,
    -- сделки
    investments.tranche_returns, investments.nominal_account_transactions,
    investments.investment_tranches, investments.investment_agreements,
    investments.investment_offers,
    -- анализ ИИ
    scoring.passport_facts, scoring.passport_texts, scoring.investment_passports,
    scoring.irs_scores, scoring.roadmap_steps, scoring.roadmaps, scoring.readiness_map,
    scoring.scores, scoring.score_models, scoring.ai_provider_credentials,
    -- сезоны
    seasons.golden_tickets, seasons.seasons;

-- Схемы целиком: таблиц в них уже нет, остаются функции и типы. CASCADE
-- уносит только объекты самих схем; проверка в конце убеждается, что
-- снаружи на них ничего не ссылается.
DROP SCHEMA seasons CASCADE;
DROP SCHEMA scoring CASCADE;
DROP SCHEMA investments CASCADE;
DROP SCHEMA experts CASCADE;

-- ===================================================== 6. Функции
DROP FUNCTION IF EXISTS billing.assert_alternative_same_country();
DROP FUNCTION IF EXISTS billing.assert_commission_adjustment_fits();
DROP FUNCTION IF EXISTS billing.assert_plan_capability_linkable();
DROP FUNCTION IF EXISTS billing.assert_service_implemented();
DROP FUNCTION IF EXISTS billing.confirm_tranche(UUID, TEXT, NUMERIC, TIMESTAMPTZ, BYTEA, UUID, TEXT);
DROP FUNCTION IF EXISTS billing.deny_auto_renew();
DROP FUNCTION IF EXISTS billing.deny_fee_offsets();
DROP FUNCTION IF EXISTS billing.deny_package_validity_days();
DROP FUNCTION IF EXISTS billing.deny_plan_capability_enforcement();
DROP FUNCTION IF EXISTS billing.enforce_subscription_shape();
DROP FUNCTION IF EXISTS billing.enforce_subscription_update();
DROP FUNCTION IF EXISTS billing.fee_offsets_enabled();
DROP FUNCTION IF EXISTS billing.forbid_accrual_money_rewrite();
DROP FUNCTION IF EXISTS billing.forbid_active_plan_rewrite();
DROP FUNCTION IF EXISTS billing.forbid_active_round_package_rewrite();
DROP FUNCTION IF EXISTS billing.forbid_commission_adjustment_rewrite();
DROP FUNCTION IF EXISTS billing.forbid_discrepancy_rewrite();
DROP FUNCTION IF EXISTS billing.forbid_fee_offset_rewrite();
DROP FUNCTION IF EXISTS billing.forbid_fee_schedule_overlap();
DROP FUNCTION IF EXISTS billing.forbid_fee_schedule_rewrite();
DROP FUNCTION IF EXISTS billing.forbid_manual_accrual();
DROP FUNCTION IF EXISTS billing.forbid_payment_event_rewrite();
DROP FUNCTION IF EXISTS billing.forbid_payment_rewrite();
DROP FUNCTION IF EXISTS billing.forbid_plan_period_overlap();
DROP FUNCTION IF EXISTS billing.forbid_proposal_rewrite();
DROP FUNCTION IF EXISTS billing.forbid_purchase_item_rewrite();
DROP FUNCTION IF EXISTS billing.forbid_purchase_rewrite();
DROP FUNCTION IF EXISTS billing.forbid_round_package_overlap();
DROP FUNCTION IF EXISTS billing.forbid_service_offer_overlap();
DROP FUNCTION IF EXISTS billing.guard_item_fulfillment_source();
DROP FUNCTION IF EXISTS billing.guard_item_run_transition();
DROP FUNCTION IF EXISTS billing.guard_llm_service_implemented();
DROP FUNCTION IF EXISTS billing.guard_payment_mode();
DROP FUNCTION IF EXISTS billing.guard_payment_transition();
DROP FUNCTION IF EXISTS billing.guard_purchase_activation();
DROP FUNCTION IF EXISTS billing.investor_capabilities(UUID);
DROP FUNCTION IF EXISTS billing.project_deal_commission();
DROP FUNCTION IF EXISTS billing.round_purchase_blocker(UUID);

DROP FUNCTION IF EXISTS comms.forbid_operator_notification_rewrite();
DROP FUNCTION IF EXISTS integration.active_publication_consent(UUID, TEXT);

DROP FUNCTION IF EXISTS lab.application_form_versions_immutable();
DROP FUNCTION IF EXISTS lab.application_form_versions_touch();
DROP FUNCTION IF EXISTS lab.disclosed_profile(UUID);
DROP FUNCTION IF EXISTS lab.effective_visibility(TEXT, INTEGER);
DROP FUNCTION IF EXISTS lab.enforce_stage_order();
DROP FUNCTION IF EXISTS lab.field_visibility(TEXT);
DROP FUNCTION IF EXISTS lab.forbid_version_mutation();
DROP FUNCTION IF EXISTS lab.funding_rounds_touch();
DROP FUNCTION IF EXISTS lab.investment_applications_touch();
DROP FUNCTION IF EXISTS lab.limit_organizer_project_update();
DROP FUNCTION IF EXISTS lab.public_round(UUID);
DROP FUNCTION IF EXISTS lab.round_view_as(UUID, TEXT);
DROP FUNCTION IF EXISTS lab.round_projection(UUID, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS lab.round_view(UUID);
DROP FUNCTION IF EXISTS lab.round_field_visibility(TEXT, INTEGER);
DROP FUNCTION IF EXISTS lab.stamp_graduated_at();
DROP FUNCTION IF EXISTS lab.version_field_visibility(INTEGER, TEXT);
DROP FUNCTION IF EXISTS lab.viewer_audience();
DROP FUNCTION IF EXISTS lab.visible_passport(UUID);

-- ================================================ 7. Роли и предикат доступа
-- has_role сначала, пока seasons_enabled ещё существует для старой версии.
CREATE OR REPLACE FUNCTION app.has_role(p_role TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE PARALLEL SAFE
SET search_path = pg_catalog, app
AS $$
    SELECT p_role = ANY(app.current_roles());
$$;

DROP FUNCTION lab.seasons_enabled();

-- Предикат аудитории без рецензента, раунда, паспорта и допуска по роли.
CREATE OR REPLACE FUNCTION lab.project_audience(p_project UUID, p_user UUID, p_permission TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = pg_catalog, lab, app, kyc, pg_temp
AS $$
DECLARE
    v_visibility TEXT;
    v_deleted    BOOLEAN;
    v_blocked    BOOLEAN;
    v_grant      TEXT[];
BEGIN
    IF p_permission NOT IN ('teaser', 'profile', 'materials', 'extended') THEN
        RETURN NULL; -- неизвестное разрешение — fail-closed
    END IF;

    SELECT p.visibility, p.deleted_at IS NOT NULL, p.blocked_at IS NOT NULL
      INTO v_visibility, v_deleted, v_blocked
      FROM lab.projects p
     WHERE p.id = p_project;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- Команда и админ — полный доступ (в том числе к удалённому и
    -- заблокированному).
    IF p_user IS NOT NULL AND (lab.is_project_member(p_project, p_user) OR app.has_role('admin')) THEN
        RETURN 'private';
    END IF;
    IF v_deleted OR v_blocked THEN
        RETURN NULL;
    END IF;

    -- Исключение — приоритет над режимом и grant.
    IF p_user IS NOT NULL AND EXISTS (
        SELECT 1 FROM lab.project_access_exclusions e
         WHERE e.project_id = p_project
           AND e.revoked_at IS NULL
           AND (e.excluded_user_id = p_user
                OR (e.excluded_entity_id IS NOT NULL AND EXISTS (
                        SELECT 1 FROM kyc.entity_members m
                         WHERE m.entity_id = e.excluded_entity_id AND m.user_id = p_user)))) THEN
        RETURN NULL;
    END IF;

    -- Открытые режимы. Допуска инвестора по роли нет: он держался на
    -- подписке, а подписки удалены. Внешнему зрителю — только то, что
    -- видно всем; «зарегистрированным инвесторам» не открыто ничего.
    IF v_visibility = 'public' THEN
        RETURN CASE WHEN p_permission IN ('teaser', 'profile') THEN 'public' END;
    END IF;
    IF v_visibility <> 'selected_investors' THEN
        RETURN NULL; -- private и registered_investors
    END IF;

    -- Выбранные получатели: набор разрешений grant; допуск личный.
    -- Разрешение ОРГАНИЗАЦИИ учитывается только при включённом флаге
    -- access.entity_grants.enabled (M092).
    IF p_user IS NULL THEN
        RETURN NULL;
    END IF;
    SELECT array_agg(DISTINCT perm) INTO v_grant
      FROM lab.project_access_grants g
      CROSS JOIN LATERAL unnest(g.permissions) AS perm
     WHERE g.project_id = p_project
       AND g.revoked_at IS NULL
       AND (g.grantee_user_id = p_user
            OR (g.grantee_entity_id IS NOT NULL
                AND lab.entity_grants_enabled()
                AND EXISTS (
                    SELECT 1 FROM kyc.entity_members m
                     WHERE m.entity_id = g.grantee_entity_id AND m.user_id = p_user)));
    IF v_grant IS NULL THEN
        RETURN NULL;
    END IF;
    IF p_permission = 'teaser' THEN
        RETURN 'investors';
    END IF;
    IF p_permission = 'extended' THEN
        RETURN CASE WHEN 'extended' = ANY(v_grant) AND kyc.has_valid_kyc(p_user, 'identity')
                    THEN 'investors' END;
    END IF;
    RETURN CASE WHEN p_permission = ANY(v_grant) THEN 'investors' END;
END;
$$;

DROP FUNCTION lab.investor_gate(UUID);
DROP FUNCTION lab.has_active_investor_membership(UUID);
DROP FUNCTION lab.investor_access_requires_subscription();

-- Основа карточки: только данные самого проекта.
CREATE FUNCTION lab.project_view_base(p_project UUID)
RETURNS TABLE (
    teaser_audience TEXT, profile_audience TEXT, materials_audience TEXT,
    id UUID, title TEXT, tagline TEXT, description TEXT, stage TEXT, taxonomy_id UUID,
    geo_country TEXT, geo_region TEXT, listed_at TIMESTAMPTZ, visibility TEXT)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = pg_catalog, lab, app, pg_temp
AS $$
    WITH a AS (
        SELECT lab.project_audience(p_project, app.current_user_id(), 'teaser')    AS teaser_audience,
               lab.project_audience(p_project, app.current_user_id(), 'profile')   AS profile_audience,
               lab.project_audience(p_project, app.current_user_id(), 'materials') AS materials_audience
    )
    SELECT a.teaser_audience, a.profile_audience, a.materials_audience,
           p.id, p.title, p.tagline,
           CASE WHEN a.profile_audience IS NOT NULL THEN p.description END,
           p.stage, p.taxonomy_id, p.geo_country,
           CASE WHEN a.profile_audience IS NOT NULL THEN p.geo_region END,
           p.listed_at, p.visibility
      FROM a
      JOIN lab.projects p ON p.id = p_project
     WHERE a.teaser_audience IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION lab.project_view_base(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.project_view_base(UUID) TO app_backend, app_public_read, app_integration;

-- Публичный каталог: тизер без раунда.
CREATE VIEW lab.v_public_catalog AS
SELECT p.id, p.taxonomy_id, p.title, p.tagline, p.stage, p.geo_country, p.listed_at
  FROM lab.projects p
 WHERE p.deleted_at IS NULL
   AND lab.can_view_project(p.id, app.current_user_id(), 'teaser');
GRANT SELECT ON lab.v_public_catalog TO app_backend, app_public_read;

-- ============================================ 8. Данные удалённых процессов
-- Таблицы с FORCE ROW LEVEL SECURITY: владелец миграции правит их, на время
-- сняв принуждение, и сразу возвращает его.
ALTER TABLE identity.user_roles NO FORCE ROW LEVEL SECURITY;
DELETE FROM identity.user_roles WHERE role IN ('expert', 'organizer', 'showrunner');
ALTER TABLE identity.user_roles FORCE ROW LEVEL SECURITY;

ALTER TABLE testing.session_participants NO FORCE ROW LEVEL SECURITY;
DELETE FROM testing.session_participants WHERE role IN ('expert', 'organizer', 'showrunner');
ALTER TABLE testing.session_participants FORCE ROW LEVEL SECURITY;

ALTER TABLE lab.project_access_grants NO FORCE ROW LEVEL SECURITY;
UPDATE lab.project_access_grants
   SET permissions = array_remove(array_remove(permissions, 'round'), 'passport')
 WHERE permissions && ARRAY['round', 'passport'];
ALTER TABLE lab.project_access_grants FORCE ROW LEVEL SECURITY;

ALTER TABLE comms.notification_preferences NO FORCE ROW LEVEL SECURITY;
DELETE FROM comms.notification_preferences WHERE topic IN ('deals', 'billing', 'experts', 'seasons');
ALTER TABLE comms.notification_preferences FORCE ROW LEVEL SECURITY;

ALTER TABLE comms.notification_templates NO FORCE ROW LEVEL SECURITY;
DELETE FROM comms.notification_templates
 WHERE code ~ '^(billing|expert|investment|season|subscription)\.'
    OR code = 'project.scored';
ALTER TABLE comms.notification_templates FORCE ROW LEVEL SECURITY;

ALTER TABLE integration.service_accounts NO FORCE ROW LEVEL SECURITY;
UPDATE integration.service_accounts
   SET scopes = ARRAY(SELECT s FROM unnest(scopes) AS s WHERE s = 'webhooks:manage')
 WHERE NOT scopes <@ ARRAY['webhooks:manage'];
-- Клиент, у которого не осталось ни одного права, приостанавливается: пустой
-- набор схема не допускает, а выдавать вместо него что-то другое нельзя.
UPDATE integration.service_accounts
   SET scopes = ARRAY['webhooks:manage'], status = 'suspended'
 WHERE cardinality(scopes) = 0;
ALTER TABLE integration.service_accounts FORCE ROW LEVEL SECURITY;

ALTER TABLE identity.staff_capability_grants NO FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.staff_capabilities NO FORCE ROW LEVEL SECURITY;
DELETE FROM identity.staff_capability_grants WHERE capability LIKE 'finance.%';
DELETE FROM identity.staff_capabilities WHERE code LIKE 'finance.%';
ALTER TABLE identity.staff_capabilities FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.staff_capability_grants FORCE ROW LEVEL SECURITY;

ALTER TABLE audit.feature_flags NO FORCE ROW LEVEL SECURITY;
DELETE FROM audit.feature_flags
 WHERE key ~ '^(ai|billing|investments)\.'
    OR key IN ('capital.integration.enabled', 'lab.ui.application_v2',
               'seasons.enabled', 'show.publication.enabled');
ALTER TABLE audit.feature_flags FORCE ROW LEVEL SECURITY;

ALTER TABLE audit.encryption_keys_registry NO FORCE ROW LEVEL SECURITY;
DELETE FROM audit.encryption_keys_registry
 WHERE domain IN ('investment_documents', 'nominal_account_evidence', 'billing_documents');
ALTER TABLE audit.encryption_keys_registry FORCE ROW LEVEL SECURITY;

-- Реестр глаголов журнала: удаляются глаголы удалённых процессов, на которые
-- не ссылается ни одно событие (журнал неизменяем — записанное остаётся).
ALTER TABLE audit.event_type_registry NO FORCE ROW LEVEL SECURITY;
DELETE FROM audit.event_type_registry r
 WHERE (r.verb ~ '^(investment|investments|experts|lab\.(application|funding_round|expert|season|golden_ticket|subscription))\.'
        OR (r.verb ~ '^billing\.' AND r.verb <> 'billing.service_country.updated')
        OR r.verb IN ('admin.ai_provider_credential.revoked', 'admin.ai_provider_credential.set',
                      'admin.listing.moderated', 'admin.scoring_review.decided',
                      'comms.operator_notification.recorded', 'integration.listing.created',
                      'lab.application_form.activated', 'lab.application_form.draft_saved',
                      'lab.application_form.published', 'lab.application_policy.activated',
                      'lab.consensus.decided', 'lab.consent.publication_granted',
                      'lab.consent.publication_revoked', 'lab.irs.recalculated',
                      'lab.payment.succeeded', 'lab.project.disclosure_applied',
                      'lab.project.disclosure_confirmed', 'lab.project.graduated',
                      'lab.project.scored', 'lab.project.stage_changed',
                      'lab.project.status_changed', 'lab.project.submitted',
                      'lab.rating.published', 'lab.readiness_config.activated'))
   AND NOT EXISTS (SELECT 1 FROM audit.events e WHERE e.verb = r.verb);
UPDATE audit.event_type_registry
   SET actor_roles_allowed = ARRAY(
           SELECT x FROM unnest(actor_roles_allowed) AS x
            WHERE x NOT IN ('expert', 'organizer', 'showrunner'))
 WHERE actor_roles_allowed && ARRAY['expert', 'organizer', 'showrunner'];
ALTER TABLE audit.event_type_registry FORCE ROW LEVEL SECURITY;

-- ================================================ 9. Ограничения значений
ALTER TABLE identity.user_roles DROP CONSTRAINT user_roles_role_check,
    ADD CONSTRAINT user_roles_role_check
        CHECK (role IN ('founder', 'investor', 'corporate', 'admin'));
ALTER TABLE identity.users DROP CONSTRAINT users_primary_role_check,
    ADD CONSTRAINT users_primary_role_check
        CHECK (primary_role IN ('founder', 'investor', 'corporate', 'admin'));
ALTER TABLE testing.session_participants DROP CONSTRAINT session_participants_role_check,
    ADD CONSTRAINT session_participants_role_check
        CHECK (role IN ('founder', 'investor', 'corporate'));
ALTER TABLE lab.projects DROP CONSTRAINT projects_status_check,
    ADD CONSTRAINT projects_status_check CHECK (status IN ('draft', 'rejected', 'archived'));
ALTER TABLE lab.projects DROP CONSTRAINT projects_listing_status_check,
    ADD CONSTRAINT projects_listing_status_check
        CHECK (listing_status IN ('not_listed', 'listed', 'unlisted'));
ALTER TABLE lab.project_access_grants DROP CONSTRAINT project_access_grants_permissions_check,
    ADD CONSTRAINT project_access_grants_permissions_check
        CHECK (permissions <@ ARRAY['profile', 'materials', 'extended'] AND cardinality(permissions) > 0);
ALTER TABLE comms.notification_preferences DROP CONSTRAINT notification_preferences_topic_check,
    ADD CONSTRAINT notification_preferences_topic_check
        CHECK (topic IN ('all', 'projects', 'messages', 'security', 'marketing'));
ALTER TABLE comms.notification_preferences DROP CONSTRAINT notification_preferences_check,
    ADD CONSTRAINT notification_preferences_check CHECK (topic <> 'security' OR enabled = true);
ALTER TABLE integration.service_accounts DROP CONSTRAINT service_accounts_scopes_check,
    ADD CONSTRAINT service_accounts_scopes_check CHECK (scopes <@ ARRAY['webhooks:manage']);
ALTER TABLE identity.staff_capabilities DROP CONSTRAINT staff_capabilities_action_check,
    ADD CONSTRAINT staff_capabilities_action_check
        CHECK (action IN ('view', 'create', 'update', 'confirm', 'manage'));
ALTER TABLE content.text_entries DROP CONSTRAINT text_entries_namespace_check,
    ADD CONSTRAINT text_entries_namespace_check CHECK (namespace IN ('glossary', 'faq', 'ui'));
ALTER TABLE audit.encryption_keys_registry DROP CONSTRAINT encryption_keys_registry_domain_check,
    ADD CONSTRAINT encryption_keys_registry_domain_check
        CHECK (domain IN ('kyc_documents', 'kyb_documents', 'passport_sensitive',
                          'search_index', 'webhook_secrets'));

-- ============================== 10. Служебные контуры денег и сделок
-- Групповые роли app_billing и app_investments создаёт M000 на уровне
-- кластера; здесь у них отзываются все права в этой базе. Сами роли
-- удаляются вне миграции (они общие для баз кластера).
REVOKE ALL ON ALL TABLES IN SCHEMA audit, identity, kyc, lab, billing, comms, integration, content
    FROM app_billing, app_investments;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA audit, identity, kyc, lab, billing, comms, integration, content
    FROM app_billing, app_investments;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app, audit, identity, kyc, lab, billing, comms, integration, content
    FROM app_billing, app_investments;
REVOKE ALL ON SCHEMA app, audit, identity, kyc, lab, billing, comms, integration, content
    FROM app_billing, app_investments;

-- ================================================ 11. Проверка результата
DO $$
DECLARE
    v_list TEXT;
BEGIN
    -- Ни одна оставшаяся функция не ссылается на удалённое. plpgsql-тела
    -- зависимостей не регистрируют, поэтому проверка — по тексту.
    SELECT string_agg(n.nspname || '.' || p.proname, ', ')
      INTO v_list
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('app', 'audit', 'identity', 'kyc', 'lab', 'billing', 'comms',
                         'integration', 'content', 'testing', 'intelligence')
       AND p.prokind IN ('f', 'p')
       AND p.prosrc ~* '(experts|seasons|scoring|investments)\.|billing\.(?!service_countries)|investment_applications|funding_round|project_versions|publication_consents|investor_gate|seasons_enabled|is_assigned_|organizer|showrunner|parse_status';
    IF v_list IS NOT NULL THEN
        RAISE EXCEPTION 'M150: функции ссылаются на удалённое: %', v_list;
    END IF;

    SELECT string_agg(schemaname || '.' || tablename || ' :: ' || policyname, ', ')
      INTO v_list
      FROM pg_policies
     WHERE (coalesce(qual, '') || coalesce(with_check, ''))
           ~* 'organizer|showrunner|expert|has_capability\(''finance|investor_gate|seasons_enabled'
        OR roles::text ~ 'app_billing|app_investments';
    IF v_list IS NOT NULL THEN
        RAISE EXCEPTION 'M150: политики ссылаются на удалённое: %', v_list;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_namespace
                WHERE nspname IN ('experts', 'seasons', 'scoring', 'investments')) THEN
        RAISE EXCEPTION 'M150: удалённая схема осталась';
    END IF;
END $$;
