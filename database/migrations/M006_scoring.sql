-- =============================================================================
-- M006 — scoring
-- Модели, инвестиционные паспорта (HNSW/GIN), факты с источниками, оценки по
-- 9 осям, IRS, карта готовности, роадмапы.
-- Источник: docs/architecture/Database_Launch.md §7.
--
-- Принцип «AI ускоряет, человек решает»: всё здесь — рекомендательное.
-- Ни одна запись не является основанием для денежной операции.
-- =============================================================================

CREATE TABLE scoring.score_models (
    id                 UUID PRIMARY KEY,
    name               TEXT NOT NULL CHECK (name IN ('ai_score','irs','match_ranker')),
    version            TEXT NOT NULL,
    params_jsonb       JSONB NOT NULL,
    eval_metrics_jsonb JSONB,
    is_active          BOOLEAN NOT NULL DEFAULT false,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (name, version)
);
CREATE UNIQUE INDEX score_models_one_active ON scoring.score_models (name) WHERE is_active;

COMMENT ON COLUMN scoring.score_models.eval_metrics_jsonb IS
    'Результат прогона на эталонном наборе. Смена активной модели без замера '
    'до/после запрещена — measure or it did not happen (RULES.md §4).';

CREATE TABLE scoring.investment_passports (
    id              UUID PRIMARY KEY,
    project_id      UUID NOT NULL REFERENCES lab.projects(id),
    version         INTEGER NOT NULL CHECK (version > 0),
    jsonb_data      JSONB NOT NULL,
    embedding       VECTOR(1536),
    disclosure_tier TEXT NOT NULL DEFAULT 'teaser' CHECK (disclosure_tier IN
                    ('teaser','full','dataroom')),
    sources         JSONB NOT NULL DEFAULT '[]',
    model_id        UUID REFERENCES scoring.score_models(id),
    published_at    TIMESTAMPTZ,
    superseded_at   TIMESTAMPTZ,
    UNIQUE (project_id, version),
    CHECK (superseded_at IS NULL OR published_at IS NOT NULL)
);
CREATE INDEX passports_embedding_hnsw ON scoring.investment_passports
    USING hnsw (embedding vector_cosine_ops);
CREATE INDEX passports_jsonb ON scoring.investment_passports USING GIN (jsonb_data);
CREATE UNIQUE INDEX passports_one_current
    ON scoring.investment_passports (project_id) WHERE superseded_at IS NULL;

CREATE TABLE scoring.passport_facts (
    id                UUID PRIMARY KEY,
    passport_id       UUID NOT NULL REFERENCES scoring.investment_passports(id),
    category          TEXT NOT NULL CHECK (category IN
                      ('team','tech','market','competitors','legal','finance','traction','ip')),
    key               TEXT NOT NULL,
    value_jsonb       JSONB NOT NULL,                        -- finance/legal: per-field DEK
    value_wrapped_dek BYTEA,
    source_type       TEXT NOT NULL,
    source_ref        TEXT NOT NULL,
    confidence        NUMERIC(3,2) CHECK (confidence >= 0 AND confidence <= 1),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX passport_facts_lookup ON scoring.passport_facts (passport_id, category);

COMMENT ON TABLE scoring.passport_facts IS
    'Единственный допустимый источник ответов AI Mentor. Ответ без источника из '
    'этой таблицы не выдаётся (Architect_Launch §4.5).';

CREATE TABLE scoring.scores (
    id              UUID PRIMARY KEY,
    project_id      UUID NOT NULL REFERENCES lab.projects(id),
    passport_id     UUID REFERENCES scoring.investment_passports(id),
    axis            TEXT NOT NULL CHECK (axis IN
                    ('market','demand','competitive_edge','uniqueness','profitability',
                     'presentation_quality','scalability','investment_readiness','product_readiness')),
    value           NUMERIC(5,2) NOT NULL CHECK (value >= 0 AND value <= 100),
    confidence_low  NUMERIC(5,2) NOT NULL,
    confidence_high NUMERIC(5,2) NOT NULL,
    explanation     TEXT NOT NULL,
    sources         JSONB NOT NULL DEFAULT '[]',
    model_id        UUID REFERENCES scoring.score_models(id),
    computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (confidence_low >= 0 AND confidence_high <= 100),
    CHECK (confidence_low <= value AND value <= confidence_high)
);
CREATE INDEX scores_project ON scoring.scores (project_id, computed_at DESC);
CREATE INDEX scores_axis ON scoring.scores (project_id, axis, computed_at DESC);

CREATE TABLE scoring.irs_scores (
    id             UUID PRIMARY KEY,
    project_id     UUID NOT NULL REFERENCES lab.projects(id),
    value          NUMERIC(5,2) NOT NULL CHECK (value >= 0 AND value <= 100),
    previous_value NUMERIC(5,2),
    delta          NUMERIC(5,2),
    model_id       UUID REFERENCES scoring.score_models(id),
    computed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((previous_value IS NULL AND delta IS NULL)
        OR (previous_value IS NOT NULL AND delta = value - previous_value))
);
CREATE INDEX irs_project ON scoring.irs_scores (project_id, computed_at DESC);

-- IRS — сигнал честности: переписать историю нельзя.
CREATE OR REPLACE FUNCTION scoring.forbid_irs_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, scoring, public
AS $$
BEGIN
    RAISE EXCEPTION 'scoring.irs_scores is append-only: rating is not for sale'
        USING ERRCODE = '42501';
END $$;

CREATE TRIGGER irs_immutable
    BEFORE UPDATE OR DELETE ON scoring.irs_scores
    FOR EACH ROW EXECUTE FUNCTION scoring.forbid_irs_mutation();

CREATE TABLE scoring.readiness_map (
    project_id      UUID NOT NULL REFERENCES lab.projects(id),
    dimension       TEXT NOT NULL CHECK (dimension IN
                    ('problem','solution','product','tech','team','market','competition',
                     'business_model','unit_economics','legal','finance','pitch','data_room')),
    level           TEXT NOT NULL CHECK (level IN ('low','medium','high')),
    recommendations JSONB NOT NULL DEFAULT '[]',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, dimension)
);

CREATE TABLE scoring.roadmaps (
    id           UUID PRIMARY KEY,
    project_id   UUID NOT NULL REFERENCES lab.projects(id),
    generated_by TEXT NOT NULL CHECK (generated_by IN ('ai','expert')),
    author_id    UUID REFERENCES identity.users(id),
    is_active    BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (generated_by <> 'expert' OR author_id IS NOT NULL)
);
CREATE UNIQUE INDEX roadmaps_one_active ON scoring.roadmaps (project_id) WHERE is_active;

CREATE TABLE scoring.roadmap_steps (
    id           UUID PRIMARY KEY,
    roadmap_id   UUID NOT NULL REFERENCES scoring.roadmaps(id),
    title        TEXT NOT NULL,
    description  TEXT,
    dimension    TEXT,
    status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                 ('pending','in_progress','completed','skipped')),
    priority     INTEGER NOT NULL DEFAULT 0,
    order_index  INTEGER NOT NULL,
    completed_at TIMESTAMPTZ,
    CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);
CREATE INDEX roadmap_steps_roadmap ON scoring.roadmap_steps (roadmap_id, order_index);

-- ------------------------------------------------------------------------ RLS
ALTER TABLE scoring.score_models         ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoring.score_models         FORCE  ROW LEVEL SECURITY;
ALTER TABLE scoring.investment_passports ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoring.investment_passports FORCE  ROW LEVEL SECURITY;
ALTER TABLE scoring.passport_facts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoring.passport_facts       FORCE  ROW LEVEL SECURITY;
ALTER TABLE scoring.scores               ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoring.scores               FORCE  ROW LEVEL SECURITY;
ALTER TABLE scoring.irs_scores           ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoring.irs_scores           FORCE  ROW LEVEL SECURITY;
ALTER TABLE scoring.readiness_map        ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoring.readiness_map        FORCE  ROW LEVEL SECURITY;
ALTER TABLE scoring.roadmaps             ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoring.roadmaps             FORCE  ROW LEVEL SECURITY;
ALTER TABLE scoring.roadmap_steps        ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoring.roadmap_steps        FORCE  ROW LEVEL SECURITY;

-- Владелец проекта; инвестор с активной подпиской — teaser/full активного
-- листинга. Tier 'dataroom' этой политикой НЕ покрывается: он выдаётся только
-- отдельным regulated grant.
CREATE POLICY passports_read ON scoring.investment_passports FOR SELECT TO app_backend USING (
    app.has_role('admin')
    OR app.has_role('organizer')
    OR lab.is_project_member(project_id, app.current_user_id())
    OR (app.has_role('investor')
        AND disclosure_tier IN ('teaser','full')
        AND lab.has_active_investor_membership(app.current_user_id())
        AND EXISTS (SELECT 1 FROM lab.projects p
                    WHERE p.id = investment_passports.project_id
                      AND p.listing_status = 'listed'
                      AND p.deleted_at IS NULL)));

CREATE POLICY passports_service_write_insert ON scoring.investment_passports FOR INSERT
    TO app_backend WITH CHECK (true);
CREATE POLICY passports_service_write_update ON scoring.investment_passports FOR UPDATE
    TO app_backend USING (true) WITH CHECK (true);

CREATE POLICY facts_read ON scoring.passport_facts FOR SELECT TO app_backend USING (
    EXISTS (SELECT 1 FROM scoring.investment_passports p
            WHERE p.id = passport_facts.passport_id
              AND (app.has_role('admin')
                   OR lab.is_project_member(p.project_id, app.current_user_id()))));
CREATE POLICY facts_service_write_insert ON scoring.passport_facts FOR INSERT
    TO app_backend WITH CHECK (true);
CREATE POLICY facts_service_write_update ON scoring.passport_facts FOR UPDATE
    TO app_backend USING (true) WITH CHECK (true);

CREATE POLICY scores_read ON scoring.scores FOR SELECT TO app_backend USING (
    app.has_role('admin')
    OR app.has_role('organizer')
    OR lab.is_project_member(project_id, app.current_user_id())
    OR (app.has_role('investor')
        AND lab.has_active_investor_membership(app.current_user_id())
        AND EXISTS (SELECT 1 FROM lab.projects p
                    WHERE p.id = scores.project_id AND p.listing_status = 'listed')));
CREATE POLICY scores_service_write_insert ON scoring.scores FOR INSERT
    TO app_backend WITH CHECK (true);
CREATE POLICY scores_service_write_update ON scoring.scores FOR UPDATE
    TO app_backend USING (true) WITH CHECK (true);

CREATE POLICY irs_read ON scoring.irs_scores FOR SELECT TO app_backend USING (
    app.has_role('admin')
    OR app.has_role('organizer')
    OR lab.is_project_member(project_id, app.current_user_id())
    OR (app.has_role('investor')
        AND lab.has_active_investor_membership(app.current_user_id())));
CREATE POLICY irs_service_write ON scoring.irs_scores FOR INSERT
    TO app_backend WITH CHECK (true);

CREATE POLICY readiness_owner ON scoring.readiness_map FOR SELECT TO app_backend USING (
    app.has_role('admin')
    OR lab.is_project_member(project_id, app.current_user_id()));
CREATE POLICY readiness_service_write_insert ON scoring.readiness_map FOR INSERT
    TO app_backend WITH CHECK (true);
CREATE POLICY readiness_service_write_update ON scoring.readiness_map FOR UPDATE
    TO app_backend USING (true) WITH CHECK (true);

CREATE POLICY roadmaps_owner ON scoring.roadmaps FOR SELECT TO app_backend USING (
    app.has_role('admin')
    OR app.has_role('expert')
    OR lab.is_project_member(project_id, app.current_user_id()));
CREATE POLICY roadmaps_service_write_insert ON scoring.roadmaps FOR INSERT
    TO app_backend WITH CHECK (true);
CREATE POLICY roadmaps_service_write_update ON scoring.roadmaps FOR UPDATE
    TO app_backend USING (true) WITH CHECK (true);

CREATE POLICY roadmap_steps_owner ON scoring.roadmap_steps FOR ALL TO app_backend USING (
    EXISTS (SELECT 1 FROM scoring.roadmaps r
            WHERE r.id = roadmap_steps.roadmap_id
              AND (app.has_role('admin')
                   OR lab.is_project_member(r.project_id, app.current_user_id()))))
WITH CHECK (
    EXISTS (SELECT 1 FROM scoring.roadmaps r
            WHERE r.id = roadmap_steps.roadmap_id
              AND (app.has_role('admin')
                   OR lab.is_project_member(r.project_id, app.current_user_id()))));

CREATE POLICY score_models_read ON scoring.score_models FOR SELECT
    TO app_backend, app_public_read, app_integration USING (true);
CREATE POLICY score_models_admin_write ON scoring.score_models FOR ALL TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

-- ---------------------------------------------------------------------- права
GRANT SELECT, INSERT, UPDATE ON scoring.score_models, scoring.investment_passports,
    scoring.passport_facts, scoring.scores, scoring.readiness_map,
    scoring.roadmaps, scoring.roadmap_steps TO app_backend;
GRANT SELECT, INSERT ON scoring.irs_scores TO app_backend;
GRANT SELECT ON scoring.investment_passports, scoring.irs_scores, scoring.scores TO app_integration;

CREATE POLICY passports_integration_read ON scoring.investment_passports FOR SELECT
    TO app_integration USING (disclosure_tier IN ('teaser','full'));
CREATE POLICY irs_integration_read ON scoring.irs_scores FOR SELECT
    TO app_integration USING (true);
CREATE POLICY scores_integration_read ON scoring.scores FOR SELECT
    TO app_integration USING (true);
