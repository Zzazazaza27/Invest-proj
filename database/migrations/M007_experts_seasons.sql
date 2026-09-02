-- =============================================================================
-- M007 — experts + seasons
-- Экспертный совет (назначения, конфликты, рецензии, консенсус) и сезонный
-- метроном с золотыми билетами и рейтингом.
-- Источник: docs/architecture/Database_Launch.md §8, §9.
-- =============================================================================

-- --------------------------------------------------------------- эксперты
CREATE TABLE experts.experts (
    user_id           UUID PRIMARY KEY REFERENCES identity.users(id),
    expertise_tags    TEXT[] NOT NULL DEFAULT '{}',
    bio               TEXT,
    capacity_per_week INTEGER NOT NULL DEFAULT 5 CHECK (capacity_per_week > 0),
    is_public         BOOLEAN NOT NULL DEFAULT false,
    rating            NUMERIC(4,2) CHECK (rating IS NULL OR (rating >= 0 AND rating <= 10)),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE experts.expert_assignments (
    id              UUID PRIMARY KEY,
    project_id      UUID NOT NULL REFERENCES lab.projects(id),
    expert_id       UUID NOT NULL REFERENCES experts.experts(user_id),
    season_id       UUID,                                    -- FK ниже
    assigned_reason TEXT NOT NULL CHECK (assigned_reason IN
                    ('auto_taxonomy','manual','third_reviewer')),
    status          TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN
                    ('assigned','accepted','declined','completed','expired')),
    due_at          TIMESTAMPTZ NOT NULL,
    assigned_by     UUID REFERENCES identity.users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX assignments_expert ON experts.expert_assignments (expert_id, status);
CREATE INDEX assignments_project ON experts.expert_assignments (project_id);
-- Один активный ассайнмент эксперта на проект.
CREATE UNIQUE INDEX assignments_active_uq ON experts.expert_assignments (project_id, expert_id)
    WHERE status IN ('assigned','accepted');

CREATE TABLE experts.expert_reviews (
    id                  UUID PRIMARY KEY,
    assignment_id       UUID NOT NULL UNIQUE REFERENCES experts.expert_assignments(id),
    rubric_scores_jsonb JSONB NOT NULL
        CHECK (rubric_scores_jsonb ?& ARRAY['team','product','strategy','legal','finmodel','scalability']),
    comment             TEXT,
    recommendation      TEXT NOT NULL CHECK (recommendation IN ('pass','fail','needs_review')),
    submitted_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE experts.expert_conflict_declarations (
    id          UUID PRIMARY KEY,
    expert_id   UUID NOT NULL REFERENCES experts.experts(user_id),
    project_id  UUID NOT NULL REFERENCES lab.projects(id),
    description TEXT NOT NULL,
    resolution  TEXT CHECK (resolution IN ('recused','approved_with_disclosure')),
    resolved_by UUID REFERENCES identity.users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((resolution IS NULL) = (resolved_by IS NULL))
);
CREATE INDEX conflicts_project ON experts.expert_conflict_declarations (project_id);

-- Заявленный и не разрешённый конфликт блокирует назначение: сначала решение
-- комплаенса, потом работа эксперта.
CREATE OR REPLACE FUNCTION experts.enforce_no_open_conflict()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, experts, public
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM experts.expert_conflict_declarations c
        WHERE c.expert_id = NEW.expert_id
          AND c.project_id = NEW.project_id
          AND (c.resolution IS NULL OR c.resolution = 'recused')
    ) THEN
        RAISE EXCEPTION 'expert % has an unresolved or recused conflict on project %',
            NEW.expert_id, NEW.project_id USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER assignments_conflict_guard
    BEFORE INSERT OR UPDATE OF expert_id, project_id ON experts.expert_assignments
    FOR EACH ROW EXECUTE FUNCTION experts.enforce_no_open_conflict();

CREATE TABLE experts.review_consensus (
    id                UUID PRIMARY KEY,
    project_id        UUID NOT NULL REFERENCES lab.projects(id),
    season_id         UUID,
    discrepancy_score NUMERIC(5,2),
    third_reviewer_id UUID REFERENCES experts.experts(user_id),
    final_decision    TEXT NOT NULL CHECK (final_decision IN ('pass','fail','needs_review')),
    decided_by        UUID NOT NULL REFERENCES identity.users(id),
    decided_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX consensus_project ON experts.review_consensus (project_id, decided_at DESC);

COMMENT ON COLUMN experts.review_consensus.decided_by IS
    'Human gate: финальное решение фиксирует человек, а не модель '
    '(docs/architecture/Architect.md §3.6 «AI ускоряет, человек решает»).';

-- ---------------------------------------------------------------- сезоны
CREATE TABLE seasons.seasons (
    id                      UUID PRIMARY KEY,
    number                  INTEGER NOT NULL UNIQUE,
    title                   TEXT,
    starts_at               TIMESTAMPTZ NOT NULL,
    ends_at                 TIMESTAMPTZ NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                            ('draft','applications_open','review','bootcamp','final','closed')),
    investor_cap            INTEGER CHECK (investor_cap IS NULL OR investor_cap > 0),
    new_member_cap_per_year INTEGER CHECK (new_member_cap_per_year IS NULL OR new_member_cap_per_year > 0),
    funnel_config_jsonb     JSONB NOT NULL DEFAULT '{}',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at)
);

-- Отложенные FK из M004 и выше.
ALTER TABLE lab.projects
    ADD CONSTRAINT projects_season_fk FOREIGN KEY (season_id) REFERENCES seasons.seasons(id);
ALTER TABLE lab.project_versions
    ADD CONSTRAINT versions_season_fk FOREIGN KEY (season_id) REFERENCES seasons.seasons(id);
ALTER TABLE experts.expert_assignments
    ADD CONSTRAINT assignments_season_fk FOREIGN KEY (season_id) REFERENCES seasons.seasons(id);
ALTER TABLE experts.review_consensus
    ADD CONSTRAINT consensus_season_fk FOREIGN KEY (season_id) REFERENCES seasons.seasons(id);

CREATE TABLE seasons.golden_tickets (
    id         UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES lab.projects(id),
    season_id  UUID NOT NULL REFERENCES seasons.seasons(id),
    granted_by UUID NOT NULL REFERENCES identity.users(id),
    reason     TEXT NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, season_id)
);

CREATE OR REPLACE FUNCTION seasons.enforce_golden_ticket_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, seasons, public
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended(NEW.granted_by::text || ':' || NEW.season_id::text, 0));
    IF (SELECT count(*) FROM seasons.golden_tickets
        WHERE granted_by = NEW.granted_by AND season_id = NEW.season_id) >= 2 THEN
        RAISE EXCEPTION 'golden ticket limit reached for this season' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER golden_tickets_limit
    BEFORE INSERT ON seasons.golden_tickets
    FOR EACH ROW EXECUTE FUNCTION seasons.enforce_golden_ticket_limit();

-- Рейтинг сезона. Материализованное представление обновляется CONCURRENTLY
-- после каждого пересчёта IRS.
CREATE MATERIALIZED VIEW seasons.mv_season_rating AS
SELECT p.season_id,
       p.id AS project_id,
       p.title,
       i.value AS irs,
       i.computed_at,
       row_number() OVER (PARTITION BY p.season_id ORDER BY i.value DESC, p.id) AS rank
FROM lab.projects p
JOIN LATERAL (
    SELECT value, computed_at FROM scoring.irs_scores s
    WHERE s.project_id = p.id ORDER BY computed_at DESC LIMIT 1
) i ON true
WHERE p.status IN ('expert_review','bootcamp','finalist','graduated')
  AND p.deleted_at IS NULL;
CREATE UNIQUE INDEX mv_season_rating_uq ON seasons.mv_season_rating (season_id, project_id);

-- ------------------------------------------------------------------------ RLS
ALTER TABLE experts.experts                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE experts.experts                       FORCE  ROW LEVEL SECURITY;
ALTER TABLE experts.expert_assignments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE experts.expert_assignments            FORCE  ROW LEVEL SECURITY;
ALTER TABLE experts.expert_reviews                ENABLE ROW LEVEL SECURITY;
ALTER TABLE experts.expert_reviews                FORCE  ROW LEVEL SECURITY;
ALTER TABLE experts.expert_conflict_declarations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE experts.expert_conflict_declarations  FORCE  ROW LEVEL SECURITY;
ALTER TABLE experts.review_consensus              ENABLE ROW LEVEL SECURITY;
ALTER TABLE experts.review_consensus              FORCE  ROW LEVEL SECURITY;
ALTER TABLE seasons.seasons                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE seasons.seasons                       FORCE  ROW LEVEL SECURITY;
ALTER TABLE seasons.golden_tickets                ENABLE ROW LEVEL SECURITY;
ALTER TABLE seasons.golden_tickets                FORCE  ROW LEVEL SECURITY;

CREATE POLICY experts_self_or_public ON experts.experts FOR SELECT TO app_backend USING (
    is_public OR user_id = app.current_user_id() OR app.has_role('admin') OR app.has_role('organizer'));
CREATE POLICY experts_self_update ON experts.experts FOR UPDATE TO app_backend USING (
    user_id = app.current_user_id() OR app.has_role('admin'))
WITH CHECK (user_id = app.current_user_id() OR app.has_role('admin'));
CREATE POLICY experts_insert ON experts.experts FOR INSERT TO app_backend WITH CHECK (true);

CREATE POLICY assignments_own ON experts.expert_assignments FOR SELECT TO app_backend USING (
    expert_id = app.current_user_id()
    OR lab.is_project_member(project_id, app.current_user_id())
    OR app.has_role('admin') OR app.has_role('organizer'));
CREATE POLICY assignments_insert ON experts.expert_assignments FOR INSERT TO app_backend
    WITH CHECK (app.has_role('admin') OR app.has_role('organizer'));
CREATE POLICY assignments_update ON experts.expert_assignments FOR UPDATE TO app_backend
    USING (expert_id = app.current_user_id() OR app.has_role('admin') OR app.has_role('organizer'))
    WITH CHECK (expert_id = app.current_user_id() OR app.has_role('admin') OR app.has_role('organizer'));

-- Эксперт видит и пишет только свою рецензию по своему назначению.
CREATE POLICY reviews_expert_own ON experts.expert_reviews FOR ALL TO app_backend USING (
    EXISTS (SELECT 1 FROM experts.expert_assignments ea
            WHERE ea.id = expert_reviews.assignment_id
              AND ea.expert_id = app.current_user_id())
    OR app.has_role('admin') OR app.has_role('organizer'))
WITH CHECK (
    EXISTS (SELECT 1 FROM experts.expert_assignments ea
            WHERE ea.id = expert_reviews.assignment_id
              AND ea.expert_id = app.current_user_id())
    OR app.has_role('admin'));

CREATE POLICY conflicts_own ON experts.expert_conflict_declarations FOR SELECT TO app_backend USING (
    expert_id = app.current_user_id() OR app.has_role('admin') OR app.has_role('organizer'));
CREATE POLICY conflicts_insert_self ON experts.expert_conflict_declarations FOR INSERT
    TO app_backend WITH CHECK (expert_id = app.current_user_id() OR app.has_role('admin'));
CREATE POLICY conflicts_resolve_admin ON experts.expert_conflict_declarations FOR UPDATE
    TO app_backend USING (app.has_role('admin') OR app.has_role('organizer'))
    WITH CHECK (app.has_role('admin') OR app.has_role('organizer'));

CREATE POLICY consensus_read ON experts.review_consensus FOR SELECT TO app_backend USING (
    lab.is_project_member(project_id, app.current_user_id())
    OR app.has_role('admin') OR app.has_role('organizer'));
CREATE POLICY consensus_write_admin ON experts.review_consensus FOR INSERT
    TO app_backend WITH CHECK (app.has_role('admin') OR app.has_role('organizer'));

-- Сезон — публичная информация (метроном платформы).
CREATE POLICY seasons_public_read ON seasons.seasons FOR SELECT
    TO app_public_read, app_backend, app_integration, app_notifications USING (true);
CREATE POLICY seasons_admin_write ON seasons.seasons FOR ALL TO app_backend
    USING (app.has_role('admin') OR app.has_role('organizer'))
    WITH CHECK (app.has_role('admin') OR app.has_role('organizer'));

CREATE POLICY golden_tickets_read ON seasons.golden_tickets FOR SELECT TO app_backend USING (
    lab.is_project_member(project_id, app.current_user_id())
    OR app.has_role('admin') OR app.has_role('organizer'));
CREATE POLICY golden_tickets_write ON seasons.golden_tickets FOR INSERT
    TO app_backend WITH CHECK (app.has_role('admin') OR app.has_role('organizer'));

-- ---------------------------------------------------------------------- права
GRANT SELECT, INSERT, UPDATE ON experts.experts, experts.expert_assignments,
    experts.expert_reviews, experts.expert_conflict_declarations,
    experts.review_consensus TO app_backend;
GRANT SELECT, INSERT, UPDATE ON seasons.seasons, seasons.golden_tickets TO app_backend;
GRANT SELECT ON seasons.mv_season_rating TO app_backend, app_public_read, app_integration;
GRANT SELECT ON seasons.seasons TO app_public_read, app_integration;

