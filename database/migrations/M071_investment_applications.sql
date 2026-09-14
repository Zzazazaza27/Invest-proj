-- =============================================================================
-- M071 — инвестиционная заявка как отдельная сущность
--
-- Основание: docs/architecture/заявка-02-технический-план.md §0а, §2.2–§2.4,
-- §2.8, §2.9.2, §2.16. Этап 2, коммит 2.1.
--
-- До этой миграции заявка = проект: девять полей в lab.projects, один запрос
-- суммы на проект, снимок при подаче копирует поля проекта. Теперь заявка —
-- своя строка с типизированными core-полями и ответами по стабильным ключам;
-- у проекта может быть несколько заявок. Снимок остаётся в
-- lab.project_versions: таблица получает ссылку на заявку, версии схемы и
-- конфигурации готовности и процент, а season_id перестаёт быть обязательным
-- (сезон — второй этап продукта, §2.14).
--
-- Проект НЕ источник истины по истории заявок. Его колонки stage,
-- investment_ask, required_plan_id остаются как производный кеш, который
-- сервис пересчитывает из открытых заявок (§2.4) — так каталог, фильтры,
-- интеграционный API и триггер биллинга не замечают разделения.
--
-- Платёжный барьер. По решению владельца в первой очереди основатель создаёт
-- и подаёт заявки бесплатно, а тариф не условие листинга (§0а). Тарифная
-- инфраструктура не удаляется: барьер выключается флагом
-- billing.listing_requires_subscription, который читает существующий
-- триггер листинга и сервис публикации. Флаг заводится выключенным, потому
-- что продуктовое правило — «бесплатно»; тесты барьера включают его явно в
-- своей транзакции. Доступ инвестора от флага не зависит: он держится на
-- lab.has_active_investor_membership и listing_status = 'listed' (§2.9.3).
--
-- Ограничения основателя — политика lab.application_policies: сколько
-- заявок, какая сумма, против дробления запроса. Значения — настройка
-- админки, стартовые из примера плана (§2.8); тариф в них не участвует.
--
-- Всё expand-only. Единственный contract-шаг — снятие NOT NULL с
-- project_versions.season_id: у существующих версий значение остаётся,
-- NULL получают только новые версии без сезона. Читателей, требующих
-- NOT NULL, нет (заявка-01 §1.3).
-- =============================================================================

-- Backfill ниже идёт под FORCE RLS от владельца схем: владелец состоит в
-- app_backend (M000), и политики `TO app_backend` на него действуют. Контекст
-- администратора даёт политикам пройти честно, без их отключения.
SET LOCAL app.current_roles = 'admin';

-- ------------------------------------------------------------------ заявка
CREATE TABLE lab.investment_applications (
    id                 UUID PRIMARY KEY,
    project_id         UUID NOT NULL REFERENCES lab.projects(id),
    status             TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','submitted','archived')),
    title              TEXT CHECK (title IS NULL OR length(btrim(title)) BETWEEN 1 AND 120),
    -- Core-поля: участвуют в проекции, готовности и входе скоринга.
    stage              TEXT NOT NULL CHECK (stage IN ('idea','mvp','early_revenue','growth')),
    business_type      TEXT CHECK (business_type IS NULL OR business_type IN
                       ('saas','marketplace','consumer','enterprise',
                        'hardware_deeptech','regulated_biotech','other')),
    funding_scope      TEXT NOT NULL DEFAULT 'project' CHECK (funding_scope IN ('project','direction')),
    funding_scope_note TEXT CHECK (funding_scope_note IS NULL OR length(funding_scope_note) <= 200),
    -- Черновик свободен: сумма и уточнение направления могут быть пустыми,
    -- пока заявка не подана. Обязательность — условие подачи, не создания.
    investment_ask     NUMERIC(14,2) CHECK (investment_ask IS NULL OR investment_ask > 0),
    ask_currency       CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (ask_currency = 'RUB'),
    schema_version     INTEGER NOT NULL CHECK (schema_version >= 0),
    answers_jsonb      JSONB NOT NULL DEFAULT '{}',
    evidence_jsonb     JSONB NOT NULL DEFAULT '{}',
    current_version_id UUID,                                 -- FK ниже, DEFERRABLE
    created_by         UUID REFERENCES identity.users(id),   -- NULL только у перенесённых
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    submitted_at       TIMESTAMPTZ,
    archived_at        TIMESTAMPTZ,
    CONSTRAINT applications_submitted_has_ask
        CHECK (status <> 'submitted' OR investment_ask IS NOT NULL),
    CONSTRAINT applications_submitted_has_scope_note
        CHECK (status <> 'submitted' OR funding_scope = 'project' OR funding_scope_note IS NOT NULL),
    CONSTRAINT applications_submitted_has_time
        CHECK (status <> 'submitted' OR submitted_at IS NOT NULL),
    CONSTRAINT applications_archived_has_time
        CHECK (status <> 'archived' OR archived_at IS NOT NULL)
);

CREATE INDEX investment_applications_project_status
    ON lab.investment_applications (project_id, status);
CREATE INDEX investment_applications_project_updated
    ON lab.investment_applications (project_id, updated_at DESC);

COMMENT ON TABLE lab.investment_applications IS
    'Инвестиционная заявка: состояние проекта и конкретный запрос в момент подачи. '
    'У проекта может быть несколько заявок. Черновик свободен — обязательность полей '
    'проверяется при подаче (условные CHECK — последний рубеж). Снимки — в '
    'lab.project_versions по application_id.';
COMMENT ON COLUMN lab.investment_applications.answers_jsonb IS
    'Ответы по стабильным ключам вопросов схемы schema_version; форма проверяется '
    'Zod-схемой, выведенной из схемы вопросов в packages/contracts.';
COMMENT ON COLUMN lab.investment_applications.evidence_jsonb IS
    'Привязки подтверждений к ключам вопросов: {key: [materialId, ...]}.';

CREATE OR REPLACE FUNCTION lab.investment_applications_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, lab, public
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

CREATE TRIGGER investment_applications_touch
    BEFORE UPDATE ON lab.investment_applications
    FOR EACH ROW EXECUTE FUNCTION lab.investment_applications_touch();

-- ------------------------------------------------- проект: текущая заявка
ALTER TABLE lab.projects ADD COLUMN current_application_id UUID;
ALTER TABLE lab.projects
    ADD CONSTRAINT projects_current_application_fk
    FOREIGN KEY (current_application_id) REFERENCES lab.investment_applications(id)
    DEFERRABLE INITIALLY DEFERRED;

COMMENT ON COLUMN lab.projects.current_application_id IS
    'Последняя поданная открытая заявка. Колонки stage, investment_ask, required_plan_id '
    'проекта — производный кеш из открытых заявок (пересчитывает сервис); источник '
    'истины по истории — lab.investment_applications и lab.project_versions.';

-- ------------------------------------------------- версии: ссылка на заявку
ALTER TABLE lab.project_versions ADD COLUMN application_id UUID
    REFERENCES lab.investment_applications(id);
ALTER TABLE lab.project_versions ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 0
    CHECK (schema_version >= 0);
ALTER TABLE lab.project_versions ADD COLUMN readiness_config_version INTEGER;
ALTER TABLE lab.project_versions ADD COLUMN completeness_pct SMALLINT
    CHECK (completeness_pct IS NULL OR completeness_pct BETWEEN 0 AND 100);
-- Сезон больше не условие подачи (§2.14). Существующий UNIQUE
-- (project_id, season_id, version_no) продолжает держать сезонный путь; для
-- версий без сезона нумерацию держит индекс ниже.
ALTER TABLE lab.project_versions ALTER COLUMN season_id DROP NOT NULL;
CREATE UNIQUE INDEX project_versions_application_no
    ON lab.project_versions (application_id, version_no)
    WHERE application_id IS NOT NULL;

COMMENT ON COLUMN lab.project_versions.schema_version IS
    '0 — снимок старой формы из девяти полей проекта; 1+ — версия схемы вопросов.';
COMMENT ON COLUMN lab.project_versions.completeness_pct IS
    'Готовность заявки, которую видел основатель в момент подачи. NULL — снимок '
    'создан до расчёта готовности.';

ALTER TABLE lab.investment_applications
    ADD CONSTRAINT applications_current_version_fk
    FOREIGN KEY (current_version_id) REFERENCES lab.project_versions(id)
    DEFERRABLE INITIALLY DEFERRED;

-- ------------------------------------------ политика ограничений основателя
CREATE TABLE lab.application_policies (
    id           UUID PRIMARY KEY,
    version      INTEGER NOT NULL UNIQUE CHECK (version > 0),
    config_jsonb JSONB NOT NULL,
    is_active    BOOLEAN NOT NULL DEFAULT false,
    created_by   UUID REFERENCES identity.users(id),         -- NULL у сида
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason       TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500)
);
CREATE UNIQUE INDEX application_policies_one_active
    ON lab.application_policies (is_active) WHERE is_active;

COMMENT ON TABLE lab.application_policies IS
    'Ограничения основателя: сколько заявок, какая сумма, потолок суммы открытых '
    'заявок против дробления. Форма config_jsonb — ApplicationPolicySchema в '
    'packages/contracts. Одна активная версия; активация — новая строка с '
    'основанием. Тариф в ограничениях не участвует (план 0.2 §0а).';

-- Стартовые значения — из примера плана (§2.8). Это настройка: заказчик
-- меняет её в админке новой версией, релиз не нужен.
INSERT INTO lab.application_policies (id, version, config_jsonb, is_active, reason) VALUES
    (public.uuid_generate_v7(), 1,
     '{"maxApplicationsPerProject": 3, "maxApplicationsPerAccount": null,
       "count": {"draft": true, "submitted": true, "archived": false},
       "maxAskPerApplication": "5000000.00", "maxOpenAskTotalPerProject": null}',
     true, 'Стартовые значения первой очереди (план 0.2 §2.8)');

-- ---------------------------------------------- платёжный барьер как флаг
INSERT INTO audit.feature_flags (key, enabled, rules_jsonb)
VALUES ('billing.listing_requires_subscription', false,
        '{"note":"Барьер основателя: подписка на тариф по сумме как условие листинга. Выключен по решению владельца 2026-09-14; доступ инвестора от флага не зависит."}')
ON CONFLICT (key) DO NOTHING;

-- Читается триггером листинга и сервисом публикации. SECURITY DEFINER: триггер
-- выполняется от роли запроса, а флаги — таблица журнала с собственными
-- политиками; предикат должен отвечать одинаково любой роли.
CREATE OR REPLACE FUNCTION lab.listing_requires_subscription()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, audit, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT enabled FROM audit.feature_flags WHERE key = 'billing.listing_requires_subscription'),
        false);
$$;
REVOKE ALL ON FUNCTION lab.listing_requires_subscription() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.listing_requires_subscription() TO app_backend, app_billing;

-- Тело триггера из M009 сохранено байт в байт ниже раннего выхода: при
-- выключенном барьере проверка не выполняется, при включённом — прежняя.
CREATE OR REPLACE FUNCTION lab.enforce_listing_requires_subscription()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, lab, billing, public
AS $$
BEGIN
    IF NOT lab.listing_requires_subscription() THEN
        RETURN NEW;
    END IF;
    -- Проверять только переход в 'listed' недостаточно: тогда основатель мог бы
    -- опубликовать проект на дешёвом тарифе и потом поднять investment_ask,
    -- оставаясь в каталоге. Проверяем при ЛЮБОМ изменении ask/плана у
    -- опубликованного проекта.
    IF NEW.listing_status = 'listed'
       AND (TG_OP = 'INSERT'
            OR OLD.listing_status IS DISTINCT FROM 'listed'
            OR OLD.investment_ask IS DISTINCT FROM NEW.investment_ask
            OR OLD.required_plan_id IS DISTINCT FROM NEW.required_plan_id) THEN
        -- Тариф обязан соответствовать текущему запросу инвестиций.
        IF NEW.required_plan_id IS DISTINCT FROM billing.resolve_founder_plan(NEW.investment_ask) THEN
            RAISE EXCEPTION
                'required_plan_id does not match investment_ask %: upgrade needed before listing',
                NEW.investment_ask USING ERRCODE = '23514';
        END IF;
        IF NOT lab.can_list_project(NEW.id) THEN
            RAISE EXCEPTION 'listing requires an active subscription of the resolved plan'
                USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END $$;

-- ------------------------------------------------------------------ RLS
ALTER TABLE lab.investment_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.investment_applications FORCE  ROW LEVEL SECURITY;
ALTER TABLE lab.application_policies    ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.application_policies    FORCE  ROW LEVEL SECURITY;

-- Заявку читают члены проекта, администратор, организатор и назначенный
-- рецензент (M021). Инвестора здесь нет: ему отдаётся снимок через проект.
CREATE POLICY applications_select ON lab.investment_applications FOR SELECT TO app_backend USING (
    lab.is_project_member(project_id, app.current_user_id())
    OR app.has_role('admin') OR app.has_role('organizer')
    OR experts.is_assigned_reviewer(project_id, app.current_user_id()));
CREATE POLICY applications_insert ON lab.investment_applications FOR INSERT TO app_backend WITH CHECK (
    lab.is_project_member(project_id, app.current_user_id()) OR app.has_role('admin'));
CREATE POLICY applications_update ON lab.investment_applications FOR UPDATE TO app_backend USING (
    lab.is_project_member(project_id, app.current_user_id()) OR app.has_role('admin'))
WITH CHECK (
    lab.is_project_member(project_id, app.current_user_id()) OR app.has_role('admin'));
-- DELETE не выдан: заявка архивируется, а не удаляется.

-- Политику ограничений читает любой вошедший (основатель видит остаток до
-- создания), меняет только администратор.
CREATE POLICY application_policies_read ON lab.application_policies FOR SELECT
    TO app_backend USING (true);
CREATE POLICY application_policies_admin_write ON lab.application_policies FOR INSERT
    TO app_backend WITH CHECK (app.has_role('admin'));
CREATE POLICY application_policies_admin_update ON lab.application_policies FOR UPDATE
    TO app_backend USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

GRANT SELECT, INSERT, UPDATE ON lab.investment_applications TO app_backend;
GRANT SELECT, INSERT, UPDATE ON lab.application_policies TO app_backend;

-- ----------------------------------------------------------- перенос данных
-- У каждого проекта появляется ровно одна заявка из его полей: схема 0 (старая
-- форма из девяти полей), описание — в answers под ключом description. Проекты
-- с поданной версией получают заявку в статусе submitted, остальные — draft.
-- Мягко удалённые проекты переносятся тоже: у их версий обязана быть заявка.
INSERT INTO lab.investment_applications
    (id, project_id, status, stage, investment_ask, ask_currency, schema_version,
     answers_jsonb, current_version_id, created_by, created_at, updated_at, submitted_at)
SELECT public.uuid_generate_v7(),
       p.id,
       CASE WHEN p.current_version_id IS NOT NULL THEN 'submitted' ELSE 'draft' END,
       p.stage,
       p.investment_ask,
       p.ask_currency,
       0,
       CASE WHEN p.description IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('description', p.description) END,
       p.current_version_id,
       (SELECT fp.user_id FROM lab.founders_projects fp
         WHERE fp.project_id = p.id ORDER BY (fp.role = 'owner') DESC, fp.created_at LIMIT 1),
       p.created_at,
       p.updated_at,
       (SELECT v.submitted_at FROM lab.project_versions v WHERE v.id = p.current_version_id)
  FROM lab.projects p
 WHERE NOT EXISTS (SELECT 1 FROM lab.investment_applications a WHERE a.project_id = p.id);

UPDATE lab.projects p
   SET current_application_id = a.id
  FROM lab.investment_applications a
 WHERE a.project_id = p.id AND p.current_application_id IS NULL;

-- Версии append-only (M004): для однократного backfill ссылки на заявку
-- триггер и принудительный RLS снимаются и тут же возвращаются. Изменяется
-- одна новая колонка; снимки и остальные поля не трогаются.
ALTER TABLE lab.project_versions DISABLE TRIGGER project_versions_immutable;
ALTER TABLE lab.project_versions NO FORCE ROW LEVEL SECURITY;
UPDATE lab.project_versions v
   SET application_id = a.id
  FROM lab.investment_applications a
 WHERE a.project_id = v.project_id AND v.application_id IS NULL;
ALTER TABLE lab.project_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE lab.project_versions ENABLE TRIGGER project_versions_immutable;

-- Инварианты переноса: заявок ровно столько же, сколько проектов; ни одной
-- версии без заявки; у каждого проекта проставлена текущая заявка.
DO $$
DECLARE
    v_projects   BIGINT;
    v_apps       BIGINT;
    v_orphans    BIGINT;
    v_no_current BIGINT;
BEGIN
    SELECT count(*) INTO v_projects FROM lab.projects;
    SELECT count(*) INTO v_apps FROM lab.investment_applications;
    SELECT count(*) INTO v_orphans FROM lab.project_versions WHERE application_id IS NULL;
    SELECT count(*) INTO v_no_current FROM lab.projects WHERE current_application_id IS NULL;
    IF v_projects <> v_apps THEN
        RAISE EXCEPTION 'M071: проектов %, заявок % — перенос неполный', v_projects, v_apps;
    END IF;
    IF v_orphans > 0 THEN
        RAISE EXCEPTION 'M071: версий без заявки: %', v_orphans;
    END IF;
    IF v_no_current > 0 THEN
        RAISE EXCEPTION 'M071: проектов без текущей заявки: %', v_no_current;
    END IF;
END $$;
