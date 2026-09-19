-- M091 — выдача разрешений выбранным получателям: разрешение адреса и список (5.8.1).
--
-- Таблицы, политики и глаголы аудита уже есть (M087): здесь только то, чего
-- не хватает интерфейсу выдачи.
--
-- Почему функции, а не запросы из ядра:
--
--   • строку ЧУЖОГО пользователя основатель читать не может и не должен
--     (`users_select`, M002: только своя строка, админ и организатор). Чтобы
--     выдать разрешение, нужно превратить известный владельцу адрес в
--     идентификатор — и ничего больше. `lab.resolve_grantee` отдаёт ровно две
--     колонки по ТОЧНОМУ слепому индексу адреса: ни поиска по подстроке, ни
--     перечисления, ни почты обратно;
--   • список выданного показывает имя получателя — тот же запрет чтения чужих
--     строк. `lab.project_access_entries` собирает выданное и исключения с
--     именами, но только для команды проекта и админа: проверка стоит внутри
--     функции, а не у вызывающего.
--
-- Уникальность действующей записи: у получателя одна действующая запись на
-- проект. Повторная выдача меняет набор разрешений, а не плодит строки, иначе
-- «отозвать» переставало бы означать «доступ закрыт».

-- ------------------------------------------------- одна действующая запись
CREATE UNIQUE INDEX project_access_grants_active_user
    ON lab.project_access_grants (project_id, grantee_user_id)
    WHERE revoked_at IS NULL AND grantee_user_id IS NOT NULL;
CREATE UNIQUE INDEX project_access_grants_active_entity
    ON lab.project_access_grants (project_id, grantee_entity_id)
    WHERE revoked_at IS NULL AND grantee_entity_id IS NOT NULL;
CREATE UNIQUE INDEX project_access_exclusions_active_user
    ON lab.project_access_exclusions (project_id, excluded_user_id)
    WHERE revoked_at IS NULL AND excluded_user_id IS NOT NULL;
CREATE UNIQUE INDEX project_access_exclusions_active_entity
    ON lab.project_access_exclusions (project_id, excluded_entity_id)
    WHERE revoked_at IS NULL AND excluded_entity_id IS NOT NULL;

-- ------------------------------------------------------- разрешение адреса
CREATE OR REPLACE FUNCTION lab.resolve_grantee(p_email_hmac BYTEA)
RETURNS TABLE (user_id UUID, display_name TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, identity, app
AS $$
    SELECT u.id, u.display_name
      FROM identity.users u
     WHERE app.current_user_id() IS NOT NULL
       AND u.email_hmac = p_email_hmac
       AND u.deleted_at IS NULL
       AND u.status = 'active';
$$;
REVOKE ALL ON FUNCTION lab.resolve_grantee(BYTEA) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.resolve_grantee(BYTEA) TO app_backend;
COMMENT ON FUNCTION lab.resolve_grantee(BYTEA) IS
    'Точное совпадение адреса (слепой индекс) → идентификатор и имя получателя. Для выдачи '
    'разрешения владельцем проекта: поиска и перечисления нет, адрес обратно не отдаётся.';

-- --------------------------------------------------------- список выданного
CREATE OR REPLACE FUNCTION lab.project_access_entries(p_project UUID)
RETURNS TABLE (
    kind         TEXT,
    entry_id     UUID,
    subject_kind TEXT,
    subject_id   UUID,
    subject_name TEXT,
    permissions  TEXT[],
    created_at   TIMESTAMPTZ,
    created_by   UUID,
    reason       TEXT,
    revoked_at   TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab, identity, kyc, app
AS $$
    SELECT * FROM (
        SELECT 'grant'::TEXT AS kind, g.id AS entry_id,
               CASE WHEN g.grantee_user_id IS NOT NULL THEN 'user' ELSE 'entity' END AS subject_kind,
               COALESCE(g.grantee_user_id, g.grantee_entity_id) AS subject_id,
               COALESCE(u.display_name, e.legal_name, '') AS subject_name,
               g.permissions, g.granted_at AS created_at, g.granted_by AS created_by,
               g.reason, g.revoked_at
          FROM lab.project_access_grants g
          LEFT JOIN identity.users u ON u.id = g.grantee_user_id
          LEFT JOIN kyc.business_entities e ON e.id = g.grantee_entity_id
         WHERE g.project_id = p_project
        UNION ALL
        SELECT 'exclusion'::TEXT, x.id,
               CASE WHEN x.excluded_user_id IS NOT NULL THEN 'user' ELSE 'entity' END,
               COALESCE(x.excluded_user_id, x.excluded_entity_id),
               COALESCE(u.display_name, e.legal_name, ''),
               NULL::TEXT[], x.created_at, x.created_by, x.reason, x.revoked_at
          FROM lab.project_access_exclusions x
          LEFT JOIN identity.users u ON u.id = x.excluded_user_id
          LEFT JOIN kyc.business_entities e ON e.id = x.excluded_entity_id
         WHERE x.project_id = p_project
    ) entries
    WHERE lab.is_project_member(p_project, app.current_user_id()) OR app.has_role('admin')
    ORDER BY revoked_at NULLS FIRST, created_at DESC;
$$;
REVOKE ALL ON FUNCTION lab.project_access_entries(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.project_access_entries(UUID) TO app_backend;
COMMENT ON FUNCTION lab.project_access_entries(UUID) IS
    'Выданные разрешения и исключения проекта с именами получателей — команде проекта и админу. '
    'Имя чужого пользователя читается только здесь и только для проекта вызывающего (5.8.1).';
