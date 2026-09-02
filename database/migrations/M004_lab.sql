-- =============================================================================
-- M004 — lab
-- Таксономия, проекты, безопасное публичное представление, основатели,
-- неизменяемые версии заявок, материалы, парсинг, антидубликаты, FTS.
-- Источник: docs/architecture/Database_Launch.md §5.
-- =============================================================================

CREATE TABLE lab.project_taxonomy (
    id        UUID PRIMARY KEY,
    parent_id UUID REFERENCES lab.project_taxonomy(id),
    slug      TEXT NOT NULL UNIQUE,
    name_ru   TEXT NOT NULL,
    name_en   TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE TABLE lab.projects (
    id                 UUID PRIMARY KEY,
    taxonomy_id        UUID REFERENCES lab.project_taxonomy(id),
    title              TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 200),
    tagline            TEXT CHECK (tagline IS NULL OR length(tagline) <= 300),
    description        TEXT CHECK (description IS NULL OR length(description) <= 20000),
    stage              TEXT NOT NULL CHECK (stage IN ('idea','mvp','early_revenue','growth')),
    geo_country        CHAR(2),
    geo_region         TEXT,

    -- Запрос инвестиций определяет тариф подписки (Architect_Launch §5.1)
    investment_ask     NUMERIC(14,2) NOT NULL CHECK (investment_ask > 0),
    ask_currency       CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (ask_currency = 'RUB'),
    required_plan_id   UUID,                                 -- FK → billing.subscription_plans в M009

    -- Листинг на платформе
    listing_status     TEXT NOT NULL DEFAULT 'not_listed' CHECK (listing_status IN
                       ('not_listed','listed','suspended_billing','unlisted')),
    listed_at          TIMESTAMPTZ,
    teaser_jsonb       JSONB NOT NULL DEFAULT '{}',

    status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                       ('draft','submitted','ai_review','expert_review','bootcamp',
                        'finalist','graduated','rejected','archived')),
                       -- 'graduated' — выпускник, готов к шву Capital; НЕ путать с listing_status
    season_id          UUID,                                 -- FK → seasons.seasons в M007
    current_version_id UUID,
    capital_ref        UUID,                                 -- → integration.external_refs после выпуска
    search_tsv         TSVECTOR,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at         TIMESTAMPTZ,
    CHECK (listing_status <> 'listed' OR listed_at IS NOT NULL)
);
CREATE INDEX projects_season_status ON lab.projects (season_id, status);
CREATE INDEX projects_catalog ON lab.projects (listing_status, taxonomy_id, listed_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX projects_ask ON lab.projects (investment_ask) WHERE listing_status = 'listed';
CREATE INDEX projects_fts ON lab.projects USING GIN (search_tsv);

COMMENT ON COLUMN lab.projects.listing_status IS
    'listed — виден в каталоге; suspended_billing — подписка просрочена (данные сохраняются); '
    'unlisted — снят владельцем или админом.';

-- Поддержка FTS: русская конфигурация, только публично безопасные поля.
CREATE OR REPLACE FUNCTION lab.projects_tsv_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, lab, public
AS $$
BEGIN
    NEW.search_tsv :=
        setweight(to_tsvector('russian', coalesce(NEW.title, '')), 'A') ||
        setweight(to_tsvector('russian', coalesce(NEW.tagline, '')), 'B') ||
        setweight(to_tsvector('russian', coalesce(NEW.description, '')), 'C');
    NEW.updated_at := now();
    RETURN NEW;
END $$;

CREATE TRIGGER projects_tsv
    BEFORE INSERT OR UPDATE OF title, tagline, description ON lab.projects
    FOR EACH ROW EXECUTE FUNCTION lab.projects_tsv_update();

-- Публичный каталог: ТОЛЬКО явный allowlist колонок.
-- Свободный teaser_jsonb наружу не отдаётся никогда.
CREATE VIEW lab.v_public_catalog WITH (security_invoker = true) AS
SELECT id, taxonomy_id, title, tagline, stage, geo_country,
       investment_ask, ask_currency, listed_at
FROM lab.projects
WHERE listing_status = 'listed' AND deleted_at IS NULL;

CREATE TABLE lab.founders_projects (
    project_id UUID NOT NULL REFERENCES lab.projects(id),
    user_id    UUID NOT NULL REFERENCES identity.users(id),
    role       TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','cofounder')),
    equity_pct NUMERIC(5,2) CHECK (equity_pct >= 0 AND equity_pct <= 100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id)
);
CREATE INDEX founders_projects_user ON lab.founders_projects (user_id);
-- Ровно один владелец на проект.
CREATE UNIQUE INDEX founders_projects_single_owner
    ON lab.founders_projects (project_id) WHERE role = 'owner';

CREATE TABLE lab.project_versions (
    id             UUID PRIMARY KEY,
    project_id     UUID NOT NULL REFERENCES lab.projects(id),
    season_id      UUID NOT NULL,                            -- FK → seasons.seasons в M007
    version_no     INTEGER NOT NULL CHECK (version_no > 0),
    snapshot_jsonb JSONB NOT NULL,                           -- неизменяемый снимок заявки
    submitted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, season_id, version_no),
    UNIQUE (project_id, id)
);
CREATE INDEX project_versions_project ON lab.project_versions (project_id, submitted_at DESC);

ALTER TABLE lab.projects
    ADD CONSTRAINT projects_current_version_fk
    FOREIGN KEY (id, current_version_id) REFERENCES lab.project_versions(project_id, id)
    DEFERRABLE INITIALLY DEFERRED;

-- Версии заявок append-only: снимок, на который ссылались AI-скоринг и эксперты,
-- переписать нельзя.
CREATE OR REPLACE FUNCTION lab.forbid_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, lab, public
AS $$
BEGIN
    RAISE EXCEPTION 'lab.project_versions is append-only' USING ERRCODE = '42501';
END $$;

CREATE TRIGGER project_versions_immutable
    BEFORE UPDATE OR DELETE ON lab.project_versions
    FOR EACH ROW EXECUTE FUNCTION lab.forbid_version_mutation();

CREATE TABLE lab.project_materials (
    id           UUID PRIMARY KEY,
    project_id   UUID NOT NULL REFERENCES lab.projects(id),
    type         TEXT NOT NULL CHECK (type IN ('deck','video','doc','product_link')),
    version      INTEGER NOT NULL DEFAULT 1,
    s3_key       TEXT,                                       -- шифрование per-object
    url          TEXT,
    parse_status TEXT NOT NULL DEFAULT 'queued' CHECK (parse_status IN
                 ('queued','running','succeeded','failed','not_required')),
    uploaded_by  UUID NOT NULL REFERENCES identity.users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, type, version),
    CHECK (version > 0),
    CHECK ((type = 'product_link' AND url IS NOT NULL AND s3_key IS NULL)
        OR (type <> 'product_link' AND s3_key IS NOT NULL AND url IS NULL)),
    -- Внешняя ссылка допускается только по https: защита от javascript:/data:/file:
    CHECK (url IS NULL OR url ~ '^https://[a-zA-Z0-9._~:/?#\[\]@!$&''()*+,;=%-]+$')
);
CREATE INDEX project_materials_project ON lab.project_materials (project_id, type);

CREATE TABLE lab.project_material_parses (
    id              UUID PRIMARY KEY,
    material_id     UUID NOT NULL REFERENCES lab.project_materials(id),
    status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
                    ('queued','running','succeeded','failed')),
    extracted_jsonb JSONB,
    model_version   TEXT,
    error_detail    TEXT,
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    CHECK (status <> 'succeeded' OR extracted_jsonb IS NOT NULL),
    CHECK (finished_at IS NULL OR started_at IS NOT NULL)
);
CREATE INDEX material_parses_material ON lab.project_material_parses (material_id, status);

CREATE TABLE lab.project_duplicates (
    id               UUID PRIMARY KEY,
    project_id       UUID NOT NULL REFERENCES lab.projects(id),
    other_project_id UUID NOT NULL REFERENCES lab.projects(id),
    method           TEXT NOT NULL CHECK (method IN ('perceptual_hash','embedding')),
    similarity_score NUMERIC(5,4) NOT NULL,
    decision         TEXT NOT NULL DEFAULT 'flagged' CHECK (decision IN
                     ('flagged','cleared','confirmed_duplicate')),
    decided_by       UUID REFERENCES identity.users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (project_id < other_project_id),
    CHECK (similarity_score >= 0 AND similarity_score <= 1),
    UNIQUE (project_id, other_project_id, method)
);

-- Отложенный FK из M002.
ALTER TABLE identity.publication_consents
    ADD CONSTRAINT publication_consents_project_fk
    FOREIGN KEY (project_id) REFERENCES lab.projects(id);

-- --------------------------------------------- предикаты доступа к проекту
CREATE OR REPLACE FUNCTION lab.is_project_member(p_project_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, lab, public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM lab.founders_projects fp
        WHERE fp.project_id = p_project_id AND fp.user_id = p_user_id
    );
$$;

-- Активная подписка инвестора. Определяется здесь как заглушка-предикат и
-- переопределяется в M009, когда появится billing.subscriptions.
CREATE OR REPLACE FUNCTION lab.has_active_investor_membership(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, lab, public
AS $$
    SELECT false;  -- переопределяется в M009
$$;

COMMENT ON FUNCTION lab.has_active_investor_membership(UUID) IS
    'Fail-closed заглушка до M009: без подписки инвестор не видит ничего сверх тизера.';

-- ------------------------------------------------------------------------ RLS
ALTER TABLE lab.projects               ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.projects               FORCE  ROW LEVEL SECURITY;
ALTER TABLE lab.founders_projects      ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.founders_projects      FORCE  ROW LEVEL SECURITY;
ALTER TABLE lab.project_versions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.project_versions       FORCE  ROW LEVEL SECURITY;
ALTER TABLE lab.project_materials      ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.project_materials      FORCE  ROW LEVEL SECURITY;
ALTER TABLE lab.project_material_parses ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.project_material_parses FORCE  ROW LEVEL SECURITY;
ALTER TABLE lab.project_duplicates     ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.project_duplicates     FORCE  ROW LEVEL SECURITY;
ALTER TABLE lab.project_taxonomy       ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.project_taxonomy       FORCE  ROW LEVEL SECURITY;

-- Владелец + admin/organizer — полностью; эксперт — назначенные (политика
-- дополняется в M007); инвестор — только листинги и только с активной подпиской.
--
-- Явный список `TO` обязателен: без него это выражение вычислялось бы и для
-- app_public_read, которому недоступны lab.founders_projects и
-- billing.subscriptions, — публичный каталог падал бы по привилегиям.
CREATE POLICY projects_select ON lab.projects FOR SELECT TO app_backend USING (
    app.has_role('admin')
    OR app.has_role('organizer')
    OR lab.is_project_member(id, app.current_user_id())
    OR (app.has_role('investor')
        AND listing_status = 'listed'
        AND deleted_at IS NULL
        AND lab.has_active_investor_membership(app.current_user_id())));

CREATE POLICY projects_update_owner ON lab.projects FOR UPDATE TO app_backend USING (
    lab.is_project_member(id, app.current_user_id()) OR app.has_role('admin'))
WITH CHECK (
    lab.is_project_member(id, app.current_user_id()) OR app.has_role('admin'));

CREATE POLICY projects_insert_service ON lab.projects FOR INSERT TO app_backend WITH CHECK (true);

-- Анонимный доступ — только allowlist тизера, через column-level GRANT.
CREATE POLICY projects_public_teaser ON lab.projects FOR SELECT TO app_public_read USING (
    listing_status = 'listed' AND deleted_at IS NULL);

-- Системные роли читают проект для денежных операций и интеграций.
CREATE POLICY projects_system_read ON lab.projects FOR SELECT
    TO app_investments, app_billing, app_integration USING (true);

-- Политика НЕ вызывает lab.is_project_member(): предикат сам читает эту
-- таблицу, и ссылка политики на собственную таблицу даёт infinite recursion.
-- Ограничение своими строками — ровно то, что предикату нужно проверить.
CREATE POLICY founders_select ON lab.founders_projects FOR SELECT TO app_backend USING (
    user_id = app.current_user_id()
    OR app.has_role('admin') OR app.has_role('organizer'));
CREATE POLICY founders_insert ON lab.founders_projects FOR INSERT TO app_backend
    WITH CHECK (true);
CREATE POLICY founders_modify ON lab.founders_projects FOR UPDATE TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));
CREATE POLICY founders_delete ON lab.founders_projects FOR DELETE TO app_backend
    USING (app.has_role('admin'));
CREATE POLICY founders_system_read ON lab.founders_projects FOR SELECT
    TO app_investments, app_billing, app_integration USING (true);

CREATE POLICY versions_select ON lab.project_versions FOR SELECT TO app_backend USING (
    lab.is_project_member(project_id, app.current_user_id())
    OR app.has_role('admin') OR app.has_role('organizer'));
CREATE POLICY versions_insert ON lab.project_versions FOR INSERT TO app_backend WITH CHECK (
    lab.is_project_member(project_id, app.current_user_id()) OR app.has_role('admin'));

CREATE POLICY materials_member ON lab.project_materials FOR ALL TO app_backend USING (
    lab.is_project_member(project_id, app.current_user_id())
    OR app.has_role('admin') OR app.has_role('organizer'))
WITH CHECK (lab.is_project_member(project_id, app.current_user_id()) OR app.has_role('admin'));

CREATE POLICY parses_member ON lab.project_material_parses FOR SELECT TO app_backend USING (
    EXISTS (SELECT 1 FROM lab.project_materials m
            WHERE m.id = project_material_parses.material_id
              AND (lab.is_project_member(m.project_id, app.current_user_id())
                   OR app.has_role('admin') OR app.has_role('organizer'))));
CREATE POLICY parses_insert ON lab.project_material_parses FOR INSERT TO app_backend
    WITH CHECK (true);
CREATE POLICY parses_update ON lab.project_material_parses FOR UPDATE TO app_backend
    USING (true) WITH CHECK (true);

-- Антидубликаты — только комплаенс: сам факт похожести на чужой проект есть
-- утечка информации о чужом проекте.
CREATE POLICY duplicates_admin ON lab.project_duplicates FOR SELECT TO app_backend USING (
    app.has_role('admin') OR app.has_role('organizer'));
CREATE POLICY duplicates_insert ON lab.project_duplicates FOR INSERT TO app_backend
    WITH CHECK (true);
CREATE POLICY duplicates_decide ON lab.project_duplicates FOR UPDATE TO app_backend
    USING (app.has_role('admin') OR app.has_role('organizer'))
    WITH CHECK (app.has_role('admin') OR app.has_role('organizer'));

CREATE POLICY taxonomy_public_read ON lab.project_taxonomy FOR SELECT
    TO app_public_read, app_backend, app_integration USING (true);
CREATE POLICY taxonomy_admin_write ON lab.project_taxonomy FOR ALL TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

-- ---------------------------------------------------------------------- права
GRANT SELECT, INSERT, UPDATE ON lab.projects TO app_backend;
GRANT SELECT, INSERT ON lab.project_versions TO app_backend;
GRANT SELECT, INSERT, UPDATE, DELETE ON lab.founders_projects, lab.project_materials TO app_backend;
GRANT SELECT, INSERT, UPDATE ON lab.project_material_parses, lab.project_duplicates TO app_backend;
GRANT SELECT, INSERT, UPDATE ON lab.project_taxonomy TO app_backend;

-- Публичная роль: НЕТ GRANT SELECT на всю таблицу, только перечисленные колонки.
--
-- listing_status и deleted_at входят в список не потому, что публичны, а
-- потому что участвуют в WHERE представления v_public_catalog. У security_invoker
-- вью права проверяются на базовую таблицу для вызывающего, и колонки фильтра
-- требуют SELECT наравне с выводимыми. Без них публичный каталог просто не
-- читается. Содержательной утечки нет: наружу отдаются только строки
-- listing_status='listed'.
GRANT SELECT (id, taxonomy_id, title, tagline, stage, geo_country,
              investment_ask, ask_currency, listed_at, listing_status, deleted_at)
    ON lab.projects TO app_public_read;
GRANT SELECT ON lab.v_public_catalog TO app_public_read;
GRANT SELECT ON lab.project_taxonomy TO app_public_read;

-- Системным ролям нужны и проект, и состав основателей: без founders_projects
-- их политики на lab.projects не смогут вычислиться.
GRANT SELECT ON lab.projects, lab.founders_projects TO app_investments, app_billing, app_integration;
GRANT EXECUTE ON FUNCTION lab.is_project_member(UUID, UUID) TO app_backend, app_investments,
    app_billing, app_integration, app_public_read;
GRANT EXECUTE ON FUNCTION lab.has_active_investor_membership(UUID) TO app_backend, app_investments,
    app_billing, app_integration, app_public_read;
