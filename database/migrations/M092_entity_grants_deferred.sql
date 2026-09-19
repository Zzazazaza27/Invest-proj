-- M092 — выдача разрешений ОРГАНИЗАЦИИ отложена (решение владельца 2026-09-19).
--
-- Почему отложена: разрешение организации действует через её состав
-- (`kyc.entity_members`), а управления составом у платформы нет — участника
-- можно только добавить. Выхода, исключения участника и организационных ролей
-- сейчас не строим (командная система отложена раньше). Значит обещание
-- «доступ закрывается при выходе из организации» выполнить нечем, и держать
-- рабочим механизм, который это обещание нарушает, нельзя.
--
-- Что делает миграция:
--
--   • заводит флаг `access.entity_grants.enabled` (выключен) и функцию
--     `lab.entity_grants_enabled()` — тем же приёмом, что отложенные сезоны
--     (M088): контур отключается, а не удаляется;
--   • ЗАКРЫВАЕТ ПУТЬ ЗАПИСИ: триггер отклоняет создание и изменение записей
--     с `grantee_entity_id` / `excluded_entity_id`, пока флаг выключен. Это
--     и есть «недоступно через API»: запрет стоит в БД, а не в интерфейсе,
--     поэтому его не обойти ни новым маршрутом, ни служебной консолью;
--   • ОТЗЫВАЕТ действующие организационные выдачи: пока состава нет, они
--     давали бы доступ людям, которых никто не может вывести;
--   • в предикате организационная ветка ВЫДАЧИ работает только при
--     включённом флаге. Ветка ИСКЛЮЧЕНИЙ остаётся действующей: исключение
--     запрещает, а не разрешает, и оставлять запрет действующим безопасно
--     (fail-closed). Новые организационные исключения при этом тоже не
--     создаются — триггер запрещает.
--
-- Структуры (колонки, индексы, ветки предиката) сохранены: возврат
-- направления — включение флага после появления настоящего членства.

INSERT INTO audit.feature_flags (key, enabled, rules_jsonb)
VALUES ('access.entity_grants.enabled', false,
        '{"note":"Выдача разрешений организации отложена (2026-09-19): нет управления составом организации (приглашения, выход, исключение участника, роли). Выключен: организационные выдачи не создаются и не дают доступа. Включение — только вместе с реализацией членства (TODO, направление «Организации и участники»)."}')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION lab.entity_grants_enabled()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, audit, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT enabled FROM audit.feature_flags WHERE key = 'access.entity_grants.enabled'),
        false);
$$;
COMMENT ON FUNCTION lab.entity_grants_enabled() IS
    'Флаг access.entity_grants.enabled; отсутствие записи — выключен (fail-closed). Пока выключен, '
    'разрешения организации не создаются и не дают доступа (M092).';
GRANT EXECUTE ON FUNCTION lab.entity_grants_enabled() TO PUBLIC;

-- ------------------------------------------------------- запрет записи
CREATE OR REPLACE FUNCTION lab.deny_entity_access_rows()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, lab, audit, pg_temp
AS $$
DECLARE
    v_row    JSONB;
    v_entity TEXT;
BEGIN
    -- Поля читаются через jsonb: у выдачи колонка называется
    -- grantee_entity_id, у исключения — excluded_entity_id, и прямая ссылка
    -- на обе в одной функции не компилируется (поле есть только в своей
    -- таблице). Один триггер на две таблицы — одно место правды о запрете.
    v_row := to_jsonb(NEW);
    v_entity := COALESCE(v_row->>'grantee_entity_id', v_row->>'excluded_entity_id');
    -- Запрещается ДЕЙСТВУЮЩАЯ запись по организации. Отзыв (проставление
    -- revoked_at) разрешён всегда: иначе унаследованную запись нельзя было бы
    -- закрыть — запрет мешал бы ровно тому, ради чего он поставлен.
    IF v_entity IS NOT NULL AND v_row->>'revoked_at' IS NULL
       AND NOT lab.entity_grants_enabled() THEN
        RAISE EXCEPTION
            'доступ по организации отложен: нет управления составом организации (M092)'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;
COMMENT ON FUNCTION lab.deny_entity_access_rows() IS
    'Пока access.entity_grants.enabled выключен, строки доступа по организации не создаются и не '
    'изменяются — запрет стоит в БД, а не в интерфейсе, и потому не обходится через API (M092).';

DROP TRIGGER IF EXISTS project_access_grants_no_entity ON lab.project_access_grants;
CREATE TRIGGER project_access_grants_no_entity
    BEFORE INSERT OR UPDATE ON lab.project_access_grants
    FOR EACH ROW EXECUTE FUNCTION lab.deny_entity_access_rows();

DROP TRIGGER IF EXISTS project_access_exclusions_no_entity ON lab.project_access_exclusions;
CREATE TRIGGER project_access_exclusions_no_entity
    BEFORE INSERT OR UPDATE ON lab.project_access_exclusions
    FOR EACH ROW EXECUTE FUNCTION lab.deny_entity_access_rows();

-- ------------------------------------- отзыв действующих организационных выдач
-- На момент миграции таких записей нет ни в рабочей, ни в тестовой базе
-- (проверено), но отзыв выполняется безусловно: выдача могла появиться на
-- другом стенде, а оставленная действующей она открывала бы проект людям,
-- которых некому вывести из организации.
UPDATE lab.project_access_grants
   SET revoked_at = now()
 WHERE grantee_entity_id IS NOT NULL
   AND revoked_at IS NULL;

-- ------------------------------------------------------------- предикат
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
    v_grant      TEXT[];
BEGIN
    IF p_permission NOT IN ('teaser','profile','round','materials','passport','extended') THEN
        RETURN NULL; -- неизвестное разрешение — fail-closed
    END IF;

    SELECT p.visibility, p.deleted_at IS NOT NULL, p.blocked_at IS NOT NULL
      INTO v_visibility, v_deleted, v_blocked
      FROM lab.projects p
     WHERE p.id = p_project;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- Команда и админ — полный доступ (в том числе к удалённому и
    -- заблокированному); назначенный рецензент — platform, кроме extended.
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
    -- Блокировка — внешним ничего.
    IF v_blocked THEN
        RETURN NULL;
    END IF;

    -- Исключение — приоритет над режимом и grant. Организационная ветка
    -- остаётся действующей и при отложенных организациях: она ЗАПРЕЩАЕТ.
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

    IF v_visibility = 'private' THEN
        RETURN NULL;
    END IF;

    -- Открытые режимы: допуск инвестора — investor_gate.
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

    -- Выбранные получатели: набор разрешений grant; допуск личный.
    -- Разрешение ОРГАНИЗАЦИИ учитывается только при включённом флаге
    -- access.entity_grants.enabled (M092): пока управления составом нет,
    -- членство не может быть отозвано, и такое разрешение не действует.
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
                OR (g.grantee_entity_id IS NOT NULL
                    AND lab.entity_grants_enabled()
                    AND EXISTS (
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
COMMENT ON FUNCTION lab.project_audience(UUID, UUID, TEXT) IS
    'Предикат доступа 5.7: аудитория зрителя для объекта проекта (private — команда/админ, platform — '
    'рецензент, investors, public) или NULL. Порядок: удалён/заблокирован → команда → рецензент → '
    'исключение → режим → grant. Роль organizer прав не даёт (сезоны отложены, M088); разрешение '
    'организации не действует, пока выключен access.entity_grants.enabled (M092).';
