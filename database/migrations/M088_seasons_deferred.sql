-- M088 — сезоны отложены: организатор бездействует, внешние сезонные выдачи закрыты.
--
-- Решение владельца 2026-09-18: весь сезонный контур (сезоны, набор проектов,
-- организаторы и их назначения, сезонное рецензирование, рейтинги, экраны)
-- переносится в отдельное будущее направление (TODO «Сезоны»). Сейчас нужна
-- основная платформа без зависимости от сезонов и без обхода доступа через
-- роль organizer или сезонные представления. Код и таблицы сезонов НЕ
-- удаляются — они отключаются флагом и остаются для возврата.
--
-- Что делает миграция:
--   • флаг `seasons.enabled` (выключен) и `lab.seasons_enabled()`;
--   • `app.has_role('organizer')` отвечает false, пока сезоны выключены, —
--     одна точка, которая делает бездействующими ВСЕ ветки организатора в
--     RLS (проекты, версии, заявки, материалы, паспорта, KYC, биллинг,
--     аудит, экспертиза, сезоны) без переписывания сорока политик. Роль в
--     `identity.user_roles` при этом может существовать — она просто не
--     даёт прав. Ядро дополнительно вырезает роль из сессии (guards.ts);
--   • `lab.project_audience` и `lab.viewer_audience` без ветки организатора;
--     `lab.v_season_projects` (M087) удаляется — сезонная модель доступа не
--     строится;
--   • независимые услуги экспертов (назначенный рецензент,
--     `experts.is_assigned_reviewer`) не затрагиваются.
--
-- Внешние сезонные выдачи (`GET /seasons/current`, `/seasons/:id/rating`,
-- Integration `seasons/current`, подача «в сезон» `POST /projects/:id/submit`)
-- закрываются в ядре по тому же флагу; административные операции сезона
-- остаются администратору для будущего возврата.

INSERT INTO audit.feature_flags (key, enabled, rules_jsonb)
VALUES ('seasons.enabled', false,
        '{"note":"Сезонный контур отложен (2026-09-18). Выключен: роль organizer бездействует, публичные сезонные выдачи и подача в сезон закрыты; административные операции сезона доступны администратору. Включение — только вместе с возвратом направления «Сезоны» (TODO)."}')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION lab.seasons_enabled()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, audit, pg_temp
AS $$
    SELECT COALESCE((SELECT enabled FROM audit.feature_flags WHERE key = 'seasons.enabled'), false);
$$;
COMMENT ON FUNCTION lab.seasons_enabled() IS
    'Флаг seasons.enabled; отсутствие записи — выключен (fail-closed). Читается app.has_role для роли organizer.';
GRANT EXECUTE ON FUNCTION lab.seasons_enabled() TO PUBLIC;

-- Единая точка проверки роли (M000). Организатор признаётся только при
-- включённых сезонах: так ни одна политика с веткой organizer не даёт
-- доступа, пока направление отложено. Для остальных ролей выражение
-- сворачивается планировщиком в прежнюю проверку.
CREATE OR REPLACE FUNCTION app.has_role(p_role TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, app
AS $$
    SELECT p_role = ANY(app.current_roles())
       AND (p_role <> 'organizer' OR lab.seasons_enabled());
$$;
COMMENT ON FUNCTION app.has_role(TEXT) IS
    'Единая точка проверки роли в RLS. Не заменяет проверку в сервисном слое — defense in depth. '
    'Роль organizer признаётся только при включённом флаге seasons.enabled (M088).';

-- ---------------------------------------------------------------- предикат без организатора
DROP VIEW IF EXISTS lab.v_season_projects;

CREATE OR REPLACE FUNCTION lab.viewer_audience()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab, app
AS $$
    SELECT CASE
             WHEN app.has_role('admin') THEN 'platform'
             WHEN lab.investor_gate(app.current_user_id()) THEN 'investors'
             ELSE 'public'
           END;
$$;

CREATE OR REPLACE FUNCTION lab.project_audience(p_project UUID, p_user UUID, p_permission TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab, app, experts, kyc
AS $$
DECLARE
    v_visibility TEXT;
    v_deleted    BOOLEAN;
    v_blocked    BOOLEAN;
    v_grant      TEXT[];
BEGIN
    IF p_permission NOT IN ('teaser','profile','round','materials','passport','extended') THEN
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
    -- заблокированному); назначенный рецензент — platform, кроме extended.
    IF p_user IS NOT NULL AND (lab.is_project_member(p_project, p_user) OR app.has_role('admin')) THEN
        RETURN 'private';
    END IF;
    IF v_deleted THEN
        RETURN NULL;
    END IF;
    IF p_user IS NOT NULL AND p_permission <> 'extended'
       AND experts.is_assigned_reviewer(p_project, p_user) THEN
        RETURN 'platform';
    END IF;
    -- Блокировка — внешним ничего.
    IF v_blocked THEN
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

    IF v_visibility = 'private' THEN
        RETURN NULL;
    END IF;

    -- Открытые режимы: допуск инвестора — investor_gate.
    IF v_visibility = 'public' THEN
        IF p_permission IN ('teaser','profile','round') THEN
            RETURN CASE WHEN lab.investor_gate(p_user) THEN 'investors' ELSE 'public' END;
        ELSIF p_permission IN ('materials','passport') THEN
            RETURN CASE WHEN lab.investor_gate(p_user) THEN 'investors' END;
        END IF;
        RETURN NULL; -- extended: только по grant в selected_investors
    END IF;
    IF v_visibility = 'registered_investors' THEN
        IF p_permission = 'extended' THEN
            RETURN NULL;
        END IF;
        RETURN CASE WHEN lab.investor_gate(p_user) THEN 'investors' END;
    END IF;

    -- Выбранные получатели: набор разрешений grant; допуск личный.
    IF v_visibility = 'selected_investors' THEN
        IF p_user IS NULL THEN
            RETURN NULL;
        END IF;
        SELECT array_agg(DISTINCT perm) INTO v_grant
          FROM lab.project_access_grants g
          CROSS JOIN LATERAL unnest(g.permissions) AS perm
         WHERE g.project_id = p_project
           AND g.revoked_at IS NULL
           AND (g.grantee_user_id = p_user
                OR (g.grantee_entity_id IS NOT NULL AND EXISTS (
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
    END IF;

    RETURN NULL;
END;
$$;
COMMENT ON FUNCTION lab.project_audience(UUID, UUID, TEXT) IS
    'Предикат доступа 5.7: аудитория зрителя для объекта проекта (private — команда/админ, platform — '
    'рецензент, investors, public) или NULL. Порядок: удалён/заблокирован → команда → рецензент → '
    'исключение → режим → grant. Роль organizer прав не даёт (сезоны отложены, M088).';
