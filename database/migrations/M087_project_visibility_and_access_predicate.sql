-- M087 — режим видимости проекта, согласие владельца, предикат аудитории (5.7.1).
--
-- План: docs/architecture/заявка-04-план-этапа-5.7-видимость.md (редакция 2),
-- §3.1–§3.4, §3.6, §3.8. Всё expand-only; ничего наружу не расширяется:
--
--   • режим проекта `lab.projects.visibility` (private | public |
--     registered_investors | selected_investors), перенос данных —
--     `listed → public` ТОЛЬКО как тизер: согласия на ответы нет (NULL),
--     материалы все → private;
--   • разрешения выбранных получателей `lab.project_access_grants` — НАБОР
--     конкретных разрешений (profile, round, materials, passport, extended),
--     не уровень; исключения `lab.project_access_exclusions` с приоритетом;
--   • предикат `lab.project_audience(project, user, permission)` отвечает,
--     с какой аудиторией зритель видит объект (private — полный доступ
--     команды и админа, platform, investors, public) или NULL;
--     `lab.can_view_project` — булева обёртка для RLS и вью (5.7.5);
--   • согласие владельца на ответы — конкретный неизменяемый снимок
--     `disclosed_version_id` и версия условий `disclosure_form_version`;
--     эффективная видимость поля `lab.effective_visibility(key, version)` =
--     строже из активной конфигурации и версии согласия;
--   • коммерческий допуск инвестора отделён от прав на данные: одна функция
--     `lab.investor_gate(user)` = роль investor И (барьер выключен ИЛИ
--     действующее членство). Флаг `billing.investor_access_requires_subscription`
--     заводится ВКЛЮЧЁННЫМ — ровно сегодняшнее поведение; выключение —
--     решение владельца о составе бесплатного доступа, не миграция;
--   • организатор: проекция сезона `lab.v_season_projects` с перечнем полей —
--     подготовка к снятию его с RLS проектов в 5.7.5 (здесь RLS не меняется);
--   • `lab.round_view` и `lab.viewer_audience` переводятся на предикат и
--     `investor_gate` — поведение при включённом барьере совпадает с M085/M086.

-- ---------------------------------------------------------------- проект
ALTER TABLE lab.projects
    ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'
        CHECK (visibility IN ('private','public','registered_investors','selected_investors')),
    ADD COLUMN IF NOT EXISTS visibility_changed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS blocked_reason TEXT
        CHECK (blocked_reason IS NULL OR length(blocked_reason) <= 500),
    ADD COLUMN IF NOT EXISTS disclosed_version_id UUID,
    ADD COLUMN IF NOT EXISTS disclosure_form_version INTEGER
        CHECK (disclosure_form_version IS NULL OR disclosure_form_version >= 0),
    ADD COLUMN IF NOT EXISTS disclosed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS disclosed_by UUID REFERENCES identity.users(id);

-- Снимок согласия обязан принадлежать тому же проекту (как основание раунда).
ALTER TABLE lab.projects
    ADD CONSTRAINT projects_disclosed_version_same_project
    FOREIGN KEY (id, disclosed_version_id) REFERENCES lab.project_versions (project_id, id);
ALTER TABLE lab.projects
    ADD CONSTRAINT projects_blocked_reason_with_time
    CHECK (blocked_reason IS NULL OR blocked_at IS NOT NULL);
-- Согласие целиком: снимок и версия условий ставятся вместе.
ALTER TABLE lab.projects
    ADD CONSTRAINT projects_disclosure_pair
    CHECK ((disclosed_version_id IS NULL) = (disclosure_form_version IS NULL));

COMMENT ON COLUMN lab.projects.visibility IS
    'Режим видимости — решение владельца (5.7): private — никому вне команды; public — тизер и public-поля '
    'любому; registered_investors — только допущенным инвесторам; selected_investors — только по grant. '
    'listing_status — следствие режима (кеш для v1 и Integration API).';
COMMENT ON COLUMN lab.projects.blocked_at IS
    'Административная блокировка: внешним ролям проект недоступен независимо от режима; команда и админ видят.';
COMMENT ON COLUMN lab.projects.disclosed_version_id IS
    'Снимок (lab.project_versions), который владелец согласился показывать наружу: ставится при подаче с '
    'предпросмотром. Public View и Investor View читают только его; NULL — ответы наружу не отдаются.';
COMMENT ON COLUMN lab.projects.disclosure_form_version IS
    'Версия конфигурации формы (условий раскрытия), которую владелец видел, соглашаясь. Эффективная видимость '
    'ответа = строже из активной конфигурации и этой версии; обновляется только явным действием владельца.';

CREATE INDEX IF NOT EXISTS projects_visibility ON lab.projects (visibility)
    WHERE deleted_at IS NULL AND visibility <> 'private';

-- Перенос: опубликованный листинг = публичный тизер. Согласия на ответы нет,
-- поэтому Public View отдаст только тизер и проекцию раунда (M085/M086) —
-- ровно то, что каталог отдаёт сегодня.
UPDATE lab.projects
   SET visibility = 'public', visibility_changed_at = COALESCE(listed_at, now())
 WHERE listing_status = 'listed' AND deleted_at IS NULL AND visibility = 'private';

-- Публичной роли колонка режима нужна для вью каталога на предикате (5.7.5);
-- выдаётся сейчас, чтобы вью можно было переключить без нового GRANT.
GRANT SELECT (visibility, blocked_at) ON lab.projects TO app_public_read;

-- ---------------------------------------------------------------- материалы
ALTER TABLE lab.project_materials
    ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'
        CHECK (visibility IN ('private','investors','public'));
COMMENT ON COLUMN lab.project_materials.visibility IS
    'Отметка владельца (5.7): private — команда; investors — допущенным инвесторам по предикату materials; '
    'public — зарезервировано для логотипа и обложки (7.2), в интерфейсе 5.7 не предлагается. '
    'Все материалы, существовавшие до M087, — private: миграция ничего не раскрывает.';

-- ---------------------------------------------------------------- grants и исключения
CREATE TABLE lab.project_access_grants (
    id                UUID PRIMARY KEY,
    project_id        UUID NOT NULL REFERENCES lab.projects(id),
    grantee_user_id   UUID REFERENCES identity.users(id),
    grantee_entity_id UUID REFERENCES kyc.business_entities(id),
    -- Набор конкретных разрешений, не уровень: {materials} даёт материалы и
    -- тизер, но не ответы анкеты. extended требует ещё KYC получателя.
    permissions       TEXT[] NOT NULL
        CHECK (permissions <@ ARRAY['profile','round','materials','passport','extended']::TEXT[]
               AND cardinality(permissions) > 0),
    granted_by        UUID NOT NULL REFERENCES identity.users(id),
    granted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at        TIMESTAMPTZ,
    reason            TEXT CHECK (reason IS NULL OR length(reason) <= 500),
    CONSTRAINT project_access_grants_one_grantee
        CHECK (num_nonnulls(grantee_user_id, grantee_entity_id) = 1)
);
CREATE INDEX project_access_grants_project_user
    ON lab.project_access_grants (project_id, grantee_user_id) WHERE revoked_at IS NULL;
CREATE INDEX project_access_grants_project_entity
    ON lab.project_access_grants (project_id, grantee_entity_id) WHERE revoked_at IS NULL;
COMMENT ON TABLE lab.project_access_grants IS
    'Разрешения выбранных получателей (режим selected_investors, 5.7 модель / 5.8 интерфейс): набор '
    'разрешений на конкретные объекты проекта. Отзыв — revoked_at, не удаление.';

CREATE TABLE lab.project_access_exclusions (
    id                 UUID PRIMARY KEY,
    project_id         UUID NOT NULL REFERENCES lab.projects(id),
    excluded_user_id   UUID REFERENCES identity.users(id),
    excluded_entity_id UUID REFERENCES kyc.business_entities(id),
    created_by         UUID NOT NULL REFERENCES identity.users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at         TIMESTAMPTZ,
    reason             TEXT CHECK (reason IS NULL OR length(reason) <= 500),
    CONSTRAINT project_access_exclusions_one_subject
        CHECK (num_nonnulls(excluded_user_id, excluded_entity_id) = 1)
);
CREATE INDEX project_access_exclusions_project_user
    ON lab.project_access_exclusions (project_id, excluded_user_id) WHERE revoked_at IS NULL;
CREATE INDEX project_access_exclusions_project_entity
    ON lab.project_access_exclusions (project_id, excluded_entity_id) WHERE revoked_at IS NULL;
COMMENT ON TABLE lab.project_access_exclusions IS
    'Исключения: пользователю или организации проект недоступен при любом режиме и любом grant. '
    'В режиме public надёжно только для входа под учётной записью — интерфейс говорит об этом явно.';

ALTER TABLE lab.project_access_grants     ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.project_access_grants     FORCE  ROW LEVEL SECURITY;
ALTER TABLE lab.project_access_exclusions ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.project_access_exclusions FORCE  ROW LEVEL SECURITY;

-- Читают и пишут команда проекта и админ; получатель видит СВОЙ grant (чтобы
-- кабинет мог объяснить, почему проект открыт). Предикат читает таблицы как
-- SECURITY DEFINER, политики ему не нужны.
CREATE POLICY project_access_grants_team ON lab.project_access_grants FOR ALL TO app_backend
    USING (lab.is_project_member(project_id, app.current_user_id()) OR app.has_role('admin'))
    WITH CHECK (lab.is_project_member(project_id, app.current_user_id()) OR app.has_role('admin'));
CREATE POLICY project_access_grants_grantee ON lab.project_access_grants FOR SELECT TO app_backend
    USING (grantee_user_id IS NOT NULL AND grantee_user_id = app.current_user_id());
CREATE POLICY project_access_exclusions_team ON lab.project_access_exclusions FOR ALL TO app_backend
    USING (lab.is_project_member(project_id, app.current_user_id()) OR app.has_role('admin'))
    WITH CHECK (lab.is_project_member(project_id, app.current_user_id()) OR app.has_role('admin'));

GRANT SELECT, INSERT, UPDATE ON lab.project_access_grants     TO app_backend;
GRANT SELECT, INSERT, UPDATE ON lab.project_access_exclusions TO app_backend;
-- DELETE не выдан: отзыв — revoked_at.

-- ---------------------------------------------------------------- барьер подписки как настройка
INSERT INTO audit.feature_flags (key, enabled, rules_jsonb)
VALUES ('billing.investor_access_requires_subscription', true,
        '{"note":"Коммерческий допуск инвестора к Investor View: включён — нужно действующее членство investor_membership (поведение до 5.7); выключен — достаточно роли investor. Права на данные (режим проекта, согласие владельца, grant, отметки материалов) проверяются до флага и им не обходятся."}')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION lab.investor_access_requires_subscription()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, audit, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT enabled FROM audit.feature_flags
          WHERE key = 'billing.investor_access_requires_subscription'),
        true);
$$;
REVOKE ALL ON FUNCTION lab.investor_access_requires_subscription() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.investor_access_requires_subscription()
    TO app_backend, app_public_read, app_integration, app_billing;
COMMENT ON FUNCTION lab.investor_access_requires_subscription() IS
    'Флаг billing.investor_access_requires_subscription; отсутствие записи — включён (fail-closed).';

-- Единственная точка коммерческого допуска инвестора. Роль берётся из сессии
-- (app.current_roles), а не из таблицы ролей: предикат отвечает за текущую
-- сессию; p_user — для членства и для анонима (NULL → false).
CREATE OR REPLACE FUNCTION lab.investor_gate(p_user UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab, app
AS $$
    SELECT p_user IS NOT NULL
       AND app.has_role('investor')
       AND (NOT lab.investor_access_requires_subscription()
            OR lab.has_active_investor_membership(p_user));
$$;
REVOKE ALL ON FUNCTION lab.investor_gate(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.investor_gate(UUID) TO app_backend, app_public_read, app_integration;
COMMENT ON FUNCTION lab.investor_gate(UUID) IS
    'Инвестор допущен: роль investor в сессии и (барьер подписки выключен или действующее членство). '
    'Все проекции и RLS 5.7 зовут только эту функцию.';

-- ---------------------------------------------------------------- предикат
-- Аудитория, с которой зритель видит объект проекта, или NULL.
-- p_permission ∈ teaser | profile | round | materials | passport | extended.
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
    v_in_season  BOOLEAN;
    v_grant      TEXT[];
BEGIN
    IF p_permission NOT IN ('teaser','profile','round','materials','passport','extended') THEN
        RETURN NULL; -- неизвестное разрешение — fail-closed
    END IF;

    SELECT p.visibility, p.deleted_at IS NOT NULL, p.blocked_at IS NOT NULL, p.season_id IS NOT NULL
      INTO v_visibility, v_deleted, v_blocked, v_in_season
      FROM lab.projects p
     WHERE p.id = p_project;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- 2. Команда и админ — полный доступ (в том числе к удалённому и
    --    заблокированному); назначенный рецензент — platform, кроме extended.
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
    -- 1. Блокировка — внешним ничего.
    IF v_blocked THEN
        RETURN NULL;
    END IF;

    -- 3. Организатор: только тизер и только проекты сезона (§3.6).
    IF app.has_role('organizer') THEN
        IF p_permission = 'teaser' AND v_in_season THEN
            RETURN 'public';
        END IF;
        RETURN NULL;
    END IF;

    -- 4. Исключение — приоритет над режимом и grant.
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

    -- 5. Закрытый проект.
    IF v_visibility = 'private' THEN
        RETURN NULL;
    END IF;

    -- 6–7. Открытые режимы: допуск инвестора — investor_gate.
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

    -- 8–9. Выбранные получатели: набор разрешений grant; допуск владельцем
    --      личный, investor_gate не требуется.
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
REVOKE ALL ON FUNCTION lab.project_audience(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.project_audience(UUID, UUID, TEXT)
    TO app_backend, app_public_read, app_integration;
COMMENT ON FUNCTION lab.project_audience(UUID, UUID, TEXT) IS
    'Предикат доступа 5.7: аудитория зрителя для объекта проекта (private — команда/админ, platform — '
    'рецензент, investors, public) или NULL. Порядок: удалён/заблокирован → команда → рецензент → '
    'организатор (тизер сезона) → исключение → режим → grant. Роли — из сессии.';

CREATE OR REPLACE FUNCTION lab.can_view_project(p_project UUID, p_user UUID, p_permission TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab
AS $$
    SELECT lab.project_audience(p_project, p_user, p_permission) IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION lab.can_view_project(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.can_view_project(UUID, UUID, TEXT)
    TO app_backend, app_public_read, app_integration;

-- ---------------------------------------------------------------- эффективная видимость
-- Строже из активной конфигурации и версии согласия; NULL согласия — private.
CREATE OR REPLACE FUNCTION lab.effective_visibility(p_key TEXT, p_consent_version INTEGER)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab
AS $$
    SELECT CASE
             WHEN p_consent_version IS NULL THEN 'private'
             ELSE lab.stricter_visibility(lab.field_visibility(p_key),
                                          lab.version_field_visibility(p_consent_version, p_key))
           END;
$$;
REVOKE ALL ON FUNCTION lab.effective_visibility(TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.effective_visibility(TEXT, INTEGER)
    TO app_backend, app_public_read, app_integration;
COMMENT ON FUNCTION lab.effective_visibility(TEXT, INTEGER) IS
    'Эффективная видимость поля: строже из активной конфигурации (политика администратора) и версии условий, '
    'на которую согласился владелец. Без согласия — private.';

-- Поля раунда: та же функция под прежним именем (M086), чтобы проекция не
-- менялась; NULL версии у раунда быть не может после open, у черновика —
-- schema_version (COALESCE в round_projection).
CREATE OR REPLACE FUNCTION lab.round_field_visibility(p_key TEXT, p_round_version INTEGER)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab
AS $$
    SELECT CASE
             WHEN p_round_version IS NULL THEN lab.field_visibility(p_key)
             ELSE lab.effective_visibility(p_key, p_round_version)
           END;
$$;

-- ---------------------------------------------------------------- аудитория сессии и проекция раунда
-- Аудитория сессии без привязки к объекту (для мест, где объект уже проверен):
-- допуск инвестора — через investor_gate (флаг барьера), не через членство напрямую.
CREATE OR REPLACE FUNCTION lab.viewer_audience()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab, app
AS $$
    SELECT CASE
             WHEN app.has_role('admin') OR app.has_role('organizer') THEN 'platform'
             WHEN lab.investor_gate(app.current_user_id()) THEN 'investors'
             ELSE 'public'
           END;
$$;

-- Проекция раунда для текущей сессии — через предикат `round`: режим проекта,
-- исключения и grant учитываются здесь же. Команда/админ (private) и
-- рецензент (platform) — полный состав, как в M085.
CREATE OR REPLACE FUNCTION lab.round_view(p_project UUID)
RETURNS TABLE (
    raising            TEXT,
    target             NUMERIC,
    currency           CHAR(3),
    funding_scope      TEXT,
    funding_scope_note TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab, app
AS $$
    WITH a AS (
        SELECT lab.project_audience(p_project, app.current_user_id(), 'round') AS audience
    )
    SELECT v.*
      FROM a
      CROSS JOIN LATERAL lab.round_projection(
          p_project,
          CASE WHEN a.audience IN ('private','platform') THEN 'platform' ELSE a.audience END,
          a.audience IN ('private','platform')) v
     WHERE a.audience IS NOT NULL;
$$;
COMMENT ON FUNCTION lab.round_view(UUID) IS
    'Проекция раунда для текущей сессии по предикату lab.project_audience(…, round): пусто, если объект '
    'недоступен; иначе поля по эффективной видимости и аудитории. Единственный путь раунда наружу.';

-- ---------------------------------------------------------------- проекция сезона для организатора
CREATE OR REPLACE VIEW lab.v_season_projects AS
SELECT p.id, p.title, p.stage, p.status, p.season_id, p.taxonomy_id, p.geo_country,
       p.listed_at, p.created_at, p.updated_at
  FROM lab.projects p
 WHERE p.season_id IS NOT NULL AND p.deleted_at IS NULL;
-- Вью без security_invoker: владелец схемы читает проекты, наружу — только
-- перечисленные поля проектов сезона. Организатор переводится на неё в 5.7.5.
GRANT SELECT ON lab.v_season_projects TO app_backend;
COMMENT ON VIEW lab.v_season_projects IS
    'Поля проектов сезона для функций организатора (5.7 §3.6): без описаний, сумм, версий и заявок.';

-- ---------------------------------------------------------------- глаголы аудита
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('lab.project.visibility_changed',
     'Владелец изменил режим видимости проекта (кто может видеть проект)',
     ARRAY['founder','admin']),
    ('lab.project.disclosure_confirmed',
     'Владелец подтвердил раскрытие: снимок и версия условий (подача с предпросмотром)',
     ARRAY['founder','admin']),
    ('lab.project.disclosure_applied',
     'Владелец применил новые условия раскрытия к профилю и/или раунду',
     ARRAY['founder','admin']),
    ('lab.project.blocked',
     'Администратор заблокировал проект для внешних ролей',
     ARRAY['admin']),
    ('lab.project.unblocked',
     'Администратор снял блокировку проекта',
     ARRAY['admin']),
    ('lab.project_material.visibility_changed',
     'Владелец изменил отметку видимости материала',
     ARRAY['founder','admin']),
    ('lab.project_access.granted',
     'Выдано разрешение выбранному получателю (набор разрешений)',
     ARRAY['founder','admin']),
    ('lab.project_access.revoked',
     'Отозвано разрешение выбранного получателя',
     ARRAY['founder','admin']),
    ('lab.project_access.excluded',
     'Пользователь или организация исключены из доступа к проекту',
     ARRAY['founder','admin']),
    ('lab.project_access.exclusion_revoked',
     'Исключение снято',
     ARRAY['founder','admin'])
ON CONFLICT (verb) DO NOTHING;
