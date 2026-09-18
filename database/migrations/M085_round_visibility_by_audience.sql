-- M085 — раскрытие полей раунда по настройке видимости и аудитории зрителя.
--
-- Решение владельца 2026-09-18 (уточнение к 5.6.4): сумма раунда и связанные
-- поля раскрываются через ОБЩИЙ механизм видимости вопросов формы, а не
-- отдельным правилом «сумма всегда публична». Настройка — видимость вопроса
-- в активной опубликованной конфигурации (`lab.application_form_versions`,
-- редактор «Вопросы заявки» в админке); аудитория зрителя — из сессии.
--
-- Две связанные группы:
--   • «текущий запрос» = состояние привлечения + сумма + валюта — видимость
--     вопроса `investment_ask`. Закрыта для аудитории → состояние
--     `undisclosed`, сумма и валюта NULL: зритель не узнаёт даже того, идёт
--     ли привлечение;
--   • «предмет финансирования» = funding_scope (+ пояснение по видимости
--     `funding_scope_note`, и только вместе с предметом).
-- Остальные поля раунда наружу не отдаются: у них нет вопроса формы, а значит
-- и настройки раскрытия (fail-closed).
--
-- Два независимых условия итогового доступа, оба обязательны:
--   1) доступ к объекту: проект опубликован и не удалён (аноним, интеграция),
--      инвестор — с действующим членством (как в projects_select), член
--      команды / админ / назначенный рецензент — всегда; раунд — только
--      незавершённый (open | paused);
--   2) настройка поля: видимость вопроса не строже аудитории зрителя
--      (`lab.visible_to`). Разрешённая аудитория поля НЕ расширяет доступ к
--      закрытому объекту: условие 1 проверяется первым.
--
-- Стартовое значение — `investors` для investment_ask, funding_scope и
-- funding_scope_note (скрипт `migrate-form-round-visibility.mjs` публикует
-- версию конфигурации; генератор v1 ставит то же). Это конфигурация, а не
-- правило в коде: администратор может открыть группу публично, опубликовав
-- версию с visibility = public. Отсутствие вопроса в активной конфигурации —
-- `private` (fail-closed).

-- ---------------------------------------------------------------- правило
CREATE OR REPLACE FUNCTION lab.visible_to(p_visibility TEXT, p_audience TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT CASE p_visibility
             WHEN 'public'    THEN 0
             WHEN 'investors' THEN 1
             WHEN 'platform'  THEN 2
             WHEN 'private'   THEN 3
             ELSE 99
           END
        <= CASE p_audience
             WHEN 'public'    THEN 0
             WHEN 'investors' THEN 1
             WHEN 'platform'  THEN 2
             WHEN 'private'   THEN 3
             ELSE -1
           END;
$$;
COMMENT ON FUNCTION lab.visible_to(TEXT, TEXT) IS
    'Одно правило раскрытия: поле видно аудитории, если его видимость не строже уровня аудитории. '
    'Неизвестная видимость или аудитория — false (fail-closed). Зеркало visibleTo() в @unicorn/contracts.';
GRANT EXECUTE ON FUNCTION lab.visible_to(TEXT, TEXT) TO PUBLIC;

-- Видимость вопроса из АКТИВНОЙ опубликованной конфигурации — платформенная
-- настройка, действует на все раунды сразу (не по версии раунда).
CREATE OR REPLACE FUNCTION lab.field_visibility(p_key TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab
AS $$
    SELECT COALESCE(
        (SELECT q->>'visibility'
           FROM lab.application_form_versions v,
                jsonb_array_elements(v.config_jsonb->'questions') q
          WHERE v.is_active
            AND q->>'key' = p_key
            AND q->>'archivedAt' IS NULL
          LIMIT 1),
        'private');
$$;
COMMENT ON FUNCTION lab.field_visibility(TEXT) IS
    'Видимость вопроса по ключу из активной конфигурации формы; нет вопроса — private (fail-closed).';
REVOKE ALL ON FUNCTION lab.field_visibility(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.field_visibility(TEXT) TO app_public_read, app_backend, app_integration;

-- Аудитория зрителя по сессии. Владелец / админ / рецензент — не аудитория, а
-- доступ к объекту; для них проекция возвращает всё (см. round_projection).
CREATE OR REPLACE FUNCTION lab.viewer_audience()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab, app
AS $$
    SELECT CASE
             WHEN app.has_role('admin') OR app.has_role('organizer') THEN 'platform'
             WHEN app.has_role('investor')
                  AND app.current_user_id() IS NOT NULL
                  AND lab.has_active_investor_membership(app.current_user_id()) THEN 'investors'
             ELSE 'public'
           END;
$$;
COMMENT ON FUNCTION lab.viewer_audience() IS
    'Аудитория текущей сессии: platform (админ, организатор), investors (инвестор с действующим членством), '
    'иначе public. Пустая сессия (роль app_public_read, интеграция) — public.';
REVOKE ALL ON FUNCTION lab.viewer_audience() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.viewer_audience() TO app_public_read, app_backend, app_integration;

-- ---------------------------------------------------------------- проекция
-- Внутренняя: не выдаётся ролям приложения; вход только через round_view /
-- round_view_as, которые решают, чья это аудитория.
CREATE OR REPLACE FUNCTION lab.round_projection(p_project UUID, p_audience TEXT, p_full BOOLEAN)
RETURNS TABLE (
    raising            TEXT,
    target             NUMERIC,
    currency           CHAR(3),
    funding_scope      TEXT,
    funding_scope_note TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab
AS $$
    WITH r AS (
        SELECT r.status, r.target, r.currency, r.funding_scope, r.funding_scope_note
          FROM lab.funding_rounds r
         WHERE r.project_id = p_project
           AND r.status IN ('open', 'paused')
         LIMIT 1
    ),
    vis AS (
        SELECT p_full OR lab.visible_to(lab.field_visibility('investment_ask'), p_audience)      AS ask_ok,
               p_full OR lab.visible_to(lab.field_visibility('funding_scope'), p_audience)       AS scope_ok,
               p_full OR lab.visible_to(lab.field_visibility('funding_scope_note'), p_audience)  AS note_ok
    )
    SELECT CASE WHEN NOT vis.ask_ok THEN 'undisclosed' ELSE COALESCE(r.status, 'none') END,
           CASE WHEN vis.ask_ok THEN r.target END,
           CASE WHEN vis.ask_ok THEN r.currency END,
           CASE WHEN vis.scope_ok THEN r.funding_scope END,
           CASE WHEN vis.scope_ok AND vis.note_ok THEN r.funding_scope_note END
      FROM vis
      LEFT JOIN r ON true;
$$;
REVOKE ALL ON FUNCTION lab.round_projection(UUID, TEXT, BOOLEAN) FROM PUBLIC;
COMMENT ON FUNCTION lab.round_projection(UUID, TEXT, BOOLEAN) IS
    'Внутренняя проекция незавершённого раунда по аудитории; p_full — зритель имеет полный доступ к объекту. '
    'Всегда возвращает одну строку: без раунда — none / undisclosed.';

-- Проекция для ТЕКУЩЕЙ сессии: доступ к объекту + аудитория из сессии.
CREATE OR REPLACE FUNCTION lab.round_view(p_project UUID)
RETURNS TABLE (
    raising            TEXT,
    target             NUMERIC,
    currency           CHAR(3),
    funding_scope      TEXT,
    funding_scope_note TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab, app, experts
AS $$
    WITH p AS (
        SELECT p.id,
               (p.listing_status = 'listed' AND p.deleted_at IS NULL) AS listed,
               (app.current_user_id() IS NOT NULL
                AND (lab.is_project_member(p.id, app.current_user_id())
                     OR app.has_role('admin')
                     OR experts.is_assigned_reviewer(p.id, app.current_user_id()))) AS full_access
          FROM lab.projects p
         WHERE p.id = p_project
    )
    SELECT v.*
      FROM p
      CROSS JOIN LATERAL lab.round_projection(p.id, lab.viewer_audience(), p.full_access) v
     WHERE p.full_access
        OR (p.listed AND (lab.viewer_audience() <> 'investors'
                          OR lab.has_active_investor_membership(app.current_user_id())));
$$;
REVOKE ALL ON FUNCTION lab.round_view(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.round_view(UUID) TO app_public_read, app_backend, app_integration;
COMMENT ON FUNCTION lab.round_view(UUID) IS
    'Проекция раунда для текущей сессии: пусто, если проект недоступен зрителю; иначе поля по настройке '
    'видимости и аудитории (member/admin/reviewer — всё). Единственный путь раунда наружу.';

-- Проекция для ВЫБРАННОЙ аудитории — предпросмотр владельцу: «так увидит
-- аноним / инвестор». Только членам команды и админу; доступ к объекту не
-- проверяется на листинг, потому что это предпросмотр, а не выдача.
CREATE OR REPLACE FUNCTION lab.round_view_as(p_project UUID, p_audience TEXT)
RETURNS TABLE (
    raising            TEXT,
    target             NUMERIC,
    currency           CHAR(3),
    funding_scope      TEXT,
    funding_scope_note TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab, app
AS $$
    SELECT v.*
      FROM lab.round_projection(p_project, p_audience, false) v
     WHERE p_audience IN ('public', 'investors')
       AND app.current_user_id() IS NOT NULL
       AND (lab.is_project_member(p_project, app.current_user_id()) OR app.has_role('admin'));
$$;
REVOKE ALL ON FUNCTION lab.round_view_as(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.round_view_as(UUID, TEXT) TO app_backend;
COMMENT ON FUNCTION lab.round_view_as(UUID, TEXT) IS
    'Предпросмотр проекции раунда для аудитории public | investors — членам команды и админу.';

-- Совместимость: прежняя функция M084 отдаёт ту же проекцию по сессии
-- (для публичной роли — аудитория public), чтобы старые запросы не раскрыли
-- больше нового правила. Новый код читает lab.round_view.
CREATE OR REPLACE FUNCTION lab.public_round(p_project UUID)
RETURNS TABLE (status TEXT, target NUMERIC, currency CHAR(3))
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab
AS $$
    SELECT v.raising, v.target, v.currency
      FROM lab.round_view(p_project) v
     WHERE v.raising IN ('open', 'paused');
$$;
COMMENT ON FUNCTION lab.public_round(UUID) IS
    'Совместимость (M084): незавершённый раунд по правилу видимости M085; предпочитайте lab.round_view.';

-- Вью тизера: состояние может быть undisclosed; сумма и валюта тогда NULL.
CREATE OR REPLACE VIEW lab.v_public_catalog WITH (security_invoker = true) AS
SELECT p.id, p.taxonomy_id, p.title, p.tagline, p.stage, p.geo_country,
       p.investment_ask, p.ask_currency, p.listed_at,
       COALESCE(r.raising, 'undisclosed')::text AS raising,
       r.target   AS round_target,
       r.currency AS round_currency
  FROM lab.projects p
  LEFT JOIN LATERAL lab.round_view(p.id) r ON true
 WHERE p.listing_status = 'listed' AND p.deleted_at IS NULL;

COMMENT ON COLUMN lab.v_public_catalog.raising IS
    'open — раунд открыт; paused — приостановлено; none — не привлекает; undisclosed — группа «текущий '
    'запрос» закрыта для аудитории сессии (M085).';
