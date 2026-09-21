-- =============================================================================
-- M126 — pg_temp последним в пути поиска девятнадцати функций SECURITY DEFINER.
--
-- Почему это дыра, а не придирка линтера. Тело SECURITY DEFINER исполняется с
-- правами ВЛАДЕЛЬЦА, а неквалифицированное имя внутри него ищется по
-- search_path. Если `pg_temp` в пути не указан, PostgreSQL подставляет его
-- ПЕРВЫМ — и любой пользователь, создав в своей временной схеме таблицу или
-- функцию с подходящим именем, заставляет чужой код работать со своим
-- объектом. Для предикатов видимости проекта это означает подмену самой
-- проверки доступа.
--
-- Почему ALTER, а не CREATE OR REPLACE. Меняется ТОЛЬКО настройка пути; тела
-- функций не переписываются вовсе. Это исключает целый класс ошибок переноса:
-- предикаты `lab.project_audience`, `lab.can_view_project` и остальные
-- сложные, и любая опечатка при копировании тела открыла бы данные вместо
-- того, чтобы закрыть путь поиска.
--
-- Как найдено: заданием CI «Права PUBLIC на функциях SECURITY DEFINER»
-- (`scripts/check-definer-privileges.mjs`). Раньше задание падало раньше — на
-- линтере миграций, — и до этого шага прогон не доходил ни разу.
-- =============================================================================

ALTER FUNCTION lab.can_view_project(p_project uuid, p_user uuid, p_permission text)
    SET search_path = pg_catalog, lab, pg_temp;

ALTER FUNCTION lab.disclosed_profile(p_project uuid)
    SET search_path = pg_catalog, lab, app, pg_temp;

ALTER FUNCTION lab.effective_visibility(p_key text, p_consent_version integer)
    SET search_path = pg_catalog, lab, pg_temp;

ALTER FUNCTION lab.field_visibility(p_key text)
    SET search_path = pg_catalog, lab, pg_temp;

ALTER FUNCTION lab.investor_gate(p_user uuid)
    SET search_path = pg_catalog, lab, app, pg_temp;

ALTER FUNCTION lab.own_grant_at(p_project uuid)
    SET search_path = pg_catalog, lab, app, pg_temp;

ALTER FUNCTION lab.project_access_entries(p_project uuid)
    SET search_path = pg_catalog, lab, identity, kyc, app, pg_temp;

ALTER FUNCTION lab.project_audience(p_project uuid, p_user uuid, p_permission text)
    SET search_path = pg_catalog, lab, app, experts, kyc, pg_temp;

ALTER FUNCTION lab.project_view_base(p_project uuid)
    SET search_path = pg_catalog, lab, app, pg_temp;

ALTER FUNCTION lab.public_round(p_project uuid)
    SET search_path = pg_catalog, lab, pg_temp;

ALTER FUNCTION lab.resolve_grantee(p_email_hmac bytea)
    SET search_path = pg_catalog, identity, app, pg_temp;

ALTER FUNCTION lab.round_field_visibility(p_key text, p_round_version integer)
    SET search_path = pg_catalog, lab, pg_temp;

ALTER FUNCTION lab.round_projection(p_project uuid, p_audience text, p_full boolean)
    SET search_path = pg_catalog, lab, pg_temp;

ALTER FUNCTION lab.round_view(p_project uuid)
    SET search_path = pg_catalog, lab, app, pg_temp;

ALTER FUNCTION lab.round_view_as(p_project uuid, p_audience text)
    SET search_path = pg_catalog, lab, app, pg_temp;

ALTER FUNCTION lab.version_field_visibility(p_version integer, p_key text)
    SET search_path = pg_catalog, lab, pg_temp;

ALTER FUNCTION lab.viewer_audience()
    SET search_path = pg_catalog, lab, app, pg_temp;

ALTER FUNCTION lab.visible_materials(p_project uuid)
    SET search_path = pg_catalog, lab, app, pg_temp;

ALTER FUNCTION lab.visible_passport(p_project uuid)
    SET search_path = pg_catalog, lab, app, scoring, pg_temp;
