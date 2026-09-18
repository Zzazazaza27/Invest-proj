-- M084 — текущее привлечение проекта в публичной выдаче берётся из раунда.
--
-- Решение владельца 2026-09-18 (план 0.2 §0г.2 п.9, проверка перед 5.6.4):
-- при отсутствии незавершённого раунда сумма в кеше проекта
-- (lab.projects.investment_ask) НЕ считается текущим запросом — ни в
-- карточках, ни в API, ни в поиске, фильтрах и сортировках. Источник
-- текущего привлечения — раунд и его состояние (open / paused / none).
--
-- Публичная роль не имеет доступа к lab.funding_rounds (FORCE RLS, политик
-- для неё нет — раунд до этапа 5.7 внешним не виден целиком). Наружу нужно
-- ровно три поля незавершённого раунда ОПУБЛИКОВАННОГО проекта, поэтому они
-- отдаются функцией SECURITY DEFINER с проверкой листинга, а не политикой:
-- функция не раскрывает ни ответов раунда, ни раундов неопубликованных
-- проектов.
--
-- Колонка lab.projects.investment_ask остаётся как совместимый кеш (кабинет
-- v1, триггер тарифа, вход скоринга до этапа 6) и в публичной выдаче больше
-- не читается как запрос.

CREATE OR REPLACE FUNCTION lab.public_round(p_project UUID)
RETURNS TABLE (status TEXT, target NUMERIC, currency CHAR(3))
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab, public
AS $$
    SELECT r.status, r.target, r.currency
      FROM lab.funding_rounds r
      JOIN lab.projects p ON p.id = r.project_id
     WHERE r.project_id = p_project
       AND r.status IN ('open', 'paused')
       AND p.listing_status = 'listed'
       AND p.deleted_at IS NULL
     LIMIT 1
$$;
REVOKE ALL ON FUNCTION lab.public_round(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.public_round(UUID) TO app_public_read, app_backend, app_integration;
COMMENT ON FUNCTION lab.public_round(UUID) IS
    'Состояние, сумма и валюта незавершённого раунда опубликованного проекта — единственное, '
    'что о раунде видно снаружи до этапа 5.7. Для неопубликованного проекта пусто.';

-- Вью получает три колонки в конец: investment_ask остаётся для совместимости
-- и текущим запросом не является.
CREATE OR REPLACE VIEW lab.v_public_catalog WITH (security_invoker = true) AS
SELECT p.id, p.taxonomy_id, p.title, p.tagline, p.stage, p.geo_country,
       p.investment_ask, p.ask_currency, p.listed_at,
       COALESCE(r.status, 'none')::text AS raising,
       r.target   AS round_target,
       r.currency AS round_currency
  FROM lab.projects p
  LEFT JOIN LATERAL lab.public_round(p.id) r ON true
 WHERE p.listing_status = 'listed' AND p.deleted_at IS NULL;

COMMENT ON VIEW lab.v_public_catalog IS
    'Публичный тизер: allowlist колонок проекта + состояние привлечения из раунда (M084). '
    'investment_ask — совместимый кеш старой формы, в API не отдаётся как текущий запрос.';
COMMENT ON COLUMN lab.v_public_catalog.raising IS
    'open — раунд открыт; paused — привлечение приостановлено; none — сейчас не привлекает.';
