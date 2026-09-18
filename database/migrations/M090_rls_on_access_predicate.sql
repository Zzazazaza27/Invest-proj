-- M090 — RLS и вью на предикат доступа: закрытие старых путей (5.7.5).
--
-- План: docs/architecture/заявка-04-план-этапа-5.7-видимость.md §3.7, §7.
-- До этой миграции инвестор с членством читал полную строку проекта, паспорт,
-- оценки, все IRS и все материалы опубликованных проектов напрямую через RLS
-- (M004, M006, M065) — мимо режима проекта, исключений и отметок владельца.
-- Новые представления (M089) уже собираются по предикату; здесь старые
-- политики переводятся на него же, а инвесторские ветки УДАЛЯЮТСЯ, а не
-- переопределяются: старое ядро над этой базой получит пустые выборки, не
-- утечку. Роль организатора бездействует (M088) — её ветки не трогаются.
--
--   • lab.projects: инвестору строки нет вовсе (данные — через
--     lab.project_view_base / Investor View); публичная роль и вью каталога —
--     по предикату teaser с сессией зрителя;
--   • scoring.investment_passports, scores, irs_scores: только команда и
--     админ; инвестору — lab.visible_passport. IRS больше не читается «все
--     подряд» любым инвестором;
--   • scoring.roadmaps: назначенный рецензент вместо роли expert;
--   • lab.project_materials / parses: инвестору — по предикату materials И
--     отметке владельца (M087); это и держит маршрут выдачи байтов;
--   • флаг барьера подписки (M087) не трогается: допуск инвестора решает
--     lab.investor_gate внутри предиката.

-- ---------------------------------------------------------------- проекты
DROP POLICY IF EXISTS projects_select ON lab.projects;
CREATE POLICY projects_select ON lab.projects FOR SELECT TO app_backend USING (
    app.has_role('admin')
    OR app.has_role('organizer')
    OR lab.is_project_member(id, app.current_user_id()));
COMMENT ON POLICY projects_select ON lab.projects IS
    'Строка проекта — команде и админу (организатор бездействует, M088). Инвестор читает проект '
    'только через проекции по предикату lab.project_audience (M089/M090).';

-- Публичная роль: по предикату teaser с сессией зрителя (аноним → public;
-- вошедший инвестор — по режиму и допуску; исключённый — ничего).
DROP POLICY IF EXISTS projects_public_teaser ON lab.projects;
CREATE POLICY projects_public_teaser ON lab.projects FOR SELECT TO app_public_read USING (
    lab.can_view_project(id, app.current_user_id(), 'teaser'));

-- Вью каталога: тот же предикат; колонки кеша суммы (investment_ask,
-- ask_currency) больше не отдаются — сумма только из раунда (M084/M085).
DROP VIEW IF EXISTS lab.v_public_catalog;
CREATE VIEW lab.v_public_catalog WITH (security_invoker = true) AS
SELECT p.id, p.taxonomy_id, p.title, p.tagline, p.stage, p.geo_country, p.listed_at,
       COALESCE(r.raising, 'undisclosed')::text AS raising,
       r.target   AS round_target,
       r.currency AS round_currency
  FROM lab.projects p
  LEFT JOIN LATERAL lab.round_view(p.id) r ON true
 WHERE p.deleted_at IS NULL
   AND lab.can_view_project(p.id, app.current_user_id(), 'teaser');
GRANT SELECT ON lab.v_public_catalog TO app_public_read, app_backend;
COMMENT ON VIEW lab.v_public_catalog IS
    'Каталог по предикату доступа (M090): для сессии зрителя — проекты, чей тизер ему доступен '
    '(режим, исключения, блокировка, допуск инвестора). Сумма и состояние — проекция раунда.';

-- ---------------------------------------------------------------- скоринг
DROP POLICY IF EXISTS passports_read ON scoring.investment_passports;
CREATE POLICY passports_read ON scoring.investment_passports FOR SELECT TO app_backend USING (
    app.has_role('admin')
    OR app.has_role('organizer')
    OR lab.is_project_member(project_id, app.current_user_id()));

DROP POLICY IF EXISTS scores_read ON scoring.scores;
CREATE POLICY scores_read ON scoring.scores FOR SELECT TO app_backend USING (
    app.has_role('admin')
    OR app.has_role('organizer')
    OR lab.is_project_member(project_id, app.current_user_id()));

DROP POLICY IF EXISTS irs_read ON scoring.irs_scores;
CREATE POLICY irs_read ON scoring.irs_scores FOR SELECT TO app_backend USING (
    app.has_role('admin')
    OR app.has_role('organizer')
    OR lab.is_project_member(project_id, app.current_user_id()));

DROP POLICY IF EXISTS roadmaps_owner ON scoring.roadmaps;
CREATE POLICY roadmaps_owner ON scoring.roadmaps FOR SELECT TO app_backend USING (
    app.has_role('admin')
    OR lab.is_project_member(project_id, app.current_user_id())
    OR experts.is_assigned_reviewer(project_id, app.current_user_id()));

-- ---------------------------------------------------------------- материалы
-- Инвестор (и любой допущенный получатель): по предикату materials и отметке
-- владельца. Аудитория предиката — investors; private-материал не проходит
-- lab.visible_to. Команда и админ идут своей политикой (materials_member).
DROP POLICY IF EXISTS materials_select_investor ON lab.project_materials;
CREATE POLICY materials_select_investor ON lab.project_materials FOR SELECT TO app_backend USING (
    uploaded_at IS NOT NULL
    AND lab.visible_to(visibility,
                       COALESCE(lab.project_audience(project_id, app.current_user_id(), 'materials'),
                                'none')));

DROP POLICY IF EXISTS parses_select_investor ON lab.project_material_parses;
CREATE POLICY parses_select_investor ON lab.project_material_parses FOR SELECT TO app_backend USING (
    EXISTS (SELECT 1 FROM lab.project_materials m
             WHERE m.id = project_material_parses.material_id
               AND m.uploaded_at IS NOT NULL
               AND lab.visible_to(m.visibility,
                                  COALESCE(lab.project_audience(m.project_id, app.current_user_id(), 'materials'),
                                           'none'))));

-- ---------------------------------------------------------------- избранное
-- Добавить в избранное можно только проект, чей тизер доступен зрителю
-- (раньше — только по листингу). Проверку держит и ядро (v_public_catalog с
-- сессией), и БД.
DROP POLICY IF EXISTS project_favorites_add ON lab.project_favorites;
CREATE POLICY project_favorites_add ON lab.project_favorites FOR INSERT TO app_backend WITH CHECK (
    user_id = app.current_user_id()
    AND app.has_role('investor')
    AND lab.can_view_project(project_id, app.current_user_id(), 'teaser'));
