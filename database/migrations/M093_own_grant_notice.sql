-- M093 — получателю видно, что доступ открыл владелец проекта (5.8.3).
--
-- Investor View собирается под ролью `app_public_read`, а строку своей выдачи
-- получатель читает политикой `project_access_grants_grantee` (M087) — та
-- написана для `app_backend`. Заводить ради одной даты вторую политику на
-- публичную роль значит расширять её права шире, чем нужно.
--
-- Поэтому узкая функция: она отвечает ТОЛЬКО про вызывающего (пользователь
-- берётся из сессии, а не из аргумента — иначе по паре идентификаторов можно
-- было бы опрашивать чужие выдачи) и отдаёт ТОЛЬКО дату. Причина выдачи —
-- внутренняя пометка владельца: получателю она не показывается, поэтому и не
-- возвращается отсюда.

CREATE OR REPLACE FUNCTION lab.own_grant_at(p_project UUID)
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab, app
AS $$
    SELECT g.granted_at
      FROM lab.project_access_grants g
     WHERE g.project_id = p_project
       AND g.revoked_at IS NULL
       AND app.current_user_id() IS NOT NULL
       AND g.grantee_user_id = app.current_user_id()
     LIMIT 1;
$$;
REVOKE ALL ON FUNCTION lab.own_grant_at(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.own_grant_at(UUID) TO app_backend, app_public_read;
COMMENT ON FUNCTION lab.own_grant_at(UUID) IS
    'Дата действующей выдачи разрешения ТЕКУЩЕМУ пользователю на проект, или NULL. Только дата: '
    'причина выдачи — внутренняя пометка владельца и получателю не раскрывается (5.8.3).';
