-- M089 — проекции для Public View и Investor View (5.7.2).
--
-- План: docs/architecture/заявка-04-план-этапа-5.7-видимость.md §3.5. Три
-- SECURITY DEFINER-функции — единственный путь профиля, материалов и паспорта
-- наружу до перевода RLS на предикат (следующий шаг плана). Каждая сама
-- спрашивает предикат `lab.project_audience(project, current_user, permission)`
-- и без доступа отдаёт пусто; поля фильтруются ядром по аудитории, которую
-- функция возвращает вместе с данными. Старые пути (RLS с членством) не
-- трогаются: новые представления — надстройка, а не расширение.
--
--   • lab.disclosed_profile(project) — снимок, который владелец согласился
--     показывать (`disclosed_version_id`), конфигурация формы его версии и
--     эффективная видимость каждого вопроса = строже(активная, версия
--     согласия). Без согласия — пусто: ответы наружу не отдаются;
--   • lab.visible_materials(project) — материалы с отметкой владельца не
--     строже аудитории зрителя (investors → investors|public; public → public);
--   • lab.visible_passport(project) — явный состав паспорта: версия, уровень
--     раскрытия, IRS и оси; только по разрешению `passport`.

CREATE OR REPLACE FUNCTION lab.disclosed_profile(p_project UUID)
RETURNS TABLE (
    audience             TEXT,
    version_id           UUID,
    application_id       UUID,
    schema_version       INTEGER,
    consent_version      INTEGER,
    active_version       INTEGER,
    stage                TEXT,
    snapshot             JSONB,
    config               JSONB,
    effective_visibility JSONB,
    disclosed_at         TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab, app
AS $$
    WITH a AS (
        SELECT lab.project_audience(p_project, app.current_user_id(), 'profile') AS audience
    ),
    p AS (
        SELECT p.disclosed_version_id, p.disclosure_form_version, p.disclosed_at
          FROM lab.projects p
         WHERE p.id = p_project
    ),
    v AS (
        SELECT v.id, v.application_id, v.schema_version, v.snapshot_jsonb
          FROM p JOIN lab.project_versions v ON v.id = p.disclosed_version_id
    ),
    f AS (
        SELECT fv.config_jsonb
          FROM v JOIN lab.application_form_versions fv ON fv.version = v.schema_version
    ),
    eff AS (
        SELECT COALESCE(jsonb_object_agg(q->>'key',
                        lab.effective_visibility(q->>'key', p.disclosure_form_version)), '{}'::jsonb) AS m
          FROM f, p, jsonb_array_elements(f.config_jsonb->'questions') q
         WHERE q->>'archivedAt' IS NULL
    )
    SELECT a.audience,
           v.id,
           v.application_id,
           v.schema_version,
           p.disclosure_form_version,
           (SELECT version FROM lab.application_form_versions WHERE is_active LIMIT 1),
           v.snapshot_jsonb->'core'->>'stage',
           v.snapshot_jsonb,
           f.config_jsonb,
           eff.m,
           p.disclosed_at
      FROM a, p, v, f, eff
     WHERE a.audience IS NOT NULL
       AND p.disclosed_version_id IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION lab.disclosed_profile(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.disclosed_profile(UUID) TO app_backend, app_public_read, app_integration;
COMMENT ON FUNCTION lab.disclosed_profile(UUID) IS
    'Снимок, согласованный владельцем, с аудиторией зрителя (предикат profile) и эффективной видимостью '
    'вопросов (строже из активной конфигурации и версии согласия). Пусто без доступа или без согласия.';

CREATE OR REPLACE FUNCTION lab.visible_materials(p_project UUID)
RETURNS TABLE (
    audience   TEXT,
    id         UUID,
    type       TEXT,
    version    INTEGER,
    url        TEXT,
    visibility TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab, app
AS $$
    WITH a AS (
        SELECT lab.project_audience(p_project, app.current_user_id(), 'materials') AS audience
    )
    SELECT a.audience, m.id, m.type, m.version, m.url, m.visibility, m.created_at
      FROM a
      JOIN lab.project_materials m ON m.project_id = p_project
     WHERE a.audience IS NOT NULL
       AND m.uploaded_at IS NOT NULL
       AND (a.audience IN ('private', 'platform')
            OR lab.visible_to(m.visibility, a.audience))
     ORDER BY m.created_at DESC
     LIMIT 100;
$$;
REVOKE ALL ON FUNCTION lab.visible_materials(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.visible_materials(UUID) TO app_backend, app_public_read, app_integration;
COMMENT ON FUNCTION lab.visible_materials(UUID) IS
    'Материалы проекта для зрителя: доступ по предикату materials, состав — по отметке владельца '
    '(private только команде и админу).';

CREATE OR REPLACE FUNCTION lab.visible_passport(p_project UUID)
RETURNS TABLE (
    audience        TEXT,
    version         INTEGER,
    disclosure_tier TEXT,
    irs             NUMERIC,
    axes            JSONB,
    published_at    TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab, app, scoring
AS $$
    WITH a AS (
        SELECT lab.project_audience(p_project, app.current_user_id(), 'passport') AS audience
    ),
    p AS (
        SELECT ip.id, ip.version, ip.disclosure_tier, ip.published_at
          FROM scoring.investment_passports ip
         WHERE ip.project_id = p_project
           AND ip.superseded_at IS NULL
           AND ip.published_at IS NOT NULL
         ORDER BY ip.version DESC
         LIMIT 1
    )
    SELECT a.audience,
           p.version,
           p.disclosure_tier,
           (SELECT i.value FROM scoring.irs_scores i
             WHERE i.project_id = p_project ORDER BY i.computed_at DESC LIMIT 1),
           COALESCE((SELECT jsonb_agg(jsonb_build_object('axis', s.axis, 'value', s.value) ORDER BY s.axis)
                       FROM scoring.scores s WHERE s.passport_id = p.id), '[]'::jsonb),
           p.published_at
      FROM a, p
     WHERE a.audience IS NOT NULL
       -- Внешним — только опубликованные уровни teaser | full; dataroom — отдельный grant (M006).
       AND (a.audience IN ('private', 'platform') OR p.disclosure_tier IN ('teaser', 'full'));
$$;
REVOKE ALL ON FUNCTION lab.visible_passport(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.visible_passport(UUID) TO app_backend, app_public_read, app_integration;
COMMENT ON FUNCTION lab.visible_passport(UUID) IS
    'Явный состав паспорта для Investor View: версия, уровень раскрытия, IRS, оси; доступ по предикату passport.';

-- Основа представления: тизер + описание + аудитории по каждому разрешению +
-- проекция раунда (lab.round_view, предикат round). Пусто, если зрителю не
-- доступен даже тизер. Работает из любой роли БД: ядро собирает Public View
-- и Investor View под публичной ролью с сессией зрителя.
CREATE OR REPLACE FUNCTION lab.project_view_base(p_project UUID)
RETURNS TABLE (
    teaser_audience    TEXT,
    profile_audience   TEXT,
    round_audience     TEXT,
    materials_audience TEXT,
    passport_audience  TEXT,
    id                 UUID,
    title              TEXT,
    tagline            TEXT,
    description        TEXT,
    stage              TEXT,
    taxonomy_id        UUID,
    geo_country        TEXT,
    geo_region         TEXT,
    listed_at          TIMESTAMPTZ,
    visibility         TEXT,
    raising            TEXT,
    round_target       NUMERIC,
    round_currency     CHAR(3),
    funding_scope      TEXT,
    funding_scope_note TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab, app
AS $$
    WITH a AS (
        SELECT lab.project_audience(p_project, app.current_user_id(), 'teaser')    AS teaser_audience,
               lab.project_audience(p_project, app.current_user_id(), 'profile')   AS profile_audience,
               lab.project_audience(p_project, app.current_user_id(), 'round')     AS round_audience,
               lab.project_audience(p_project, app.current_user_id(), 'materials') AS materials_audience,
               lab.project_audience(p_project, app.current_user_id(), 'passport')  AS passport_audience
    )
    SELECT a.teaser_audience, a.profile_audience, a.round_audience, a.materials_audience,
           a.passport_audience,
           p.id, p.title, p.tagline,
           CASE WHEN a.profile_audience IS NOT NULL THEN p.description END,
           p.stage, p.taxonomy_id, p.geo_country,
           CASE WHEN a.profile_audience IS NOT NULL THEN p.geo_region END,
           p.listed_at, p.visibility,
           COALESCE(r.raising, 'undisclosed'), r.target, r.currency, r.funding_scope, r.funding_scope_note
      FROM a
      JOIN lab.projects p ON p.id = p_project
      LEFT JOIN LATERAL lab.round_view(p_project) r ON true
     WHERE a.teaser_audience IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION lab.project_view_base(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.project_view_base(UUID) TO app_backend, app_public_read, app_integration;
COMMENT ON FUNCTION lab.project_view_base(UUID) IS
    'Основа Public/Investor View: тизер, описание (по profile), аудитории по разрешениям, проекция раунда. '
    'Пусто без доступа к тизеру.';
