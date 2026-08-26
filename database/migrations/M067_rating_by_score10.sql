-- M067 — рейтинг сезона сортируется по баллу 1–10, IRS — тай-брейкер.
--
-- Потолки применяются к баллу, а не к IRS (promt_aiscoring.md, раздел 5):
-- проект с IRS 70 и потолком 5 стоял бы в рейтинге выше проекта с IRS 60 и
-- баллом 7. Сортировка по публикуемому баллу с IRS как тай-брейкером
-- восстанавливает монотонность. Балл берётся из действующего паспорта — это
-- score10Published, то есть значение ПОСЛЕ решения человека по потолкам
-- (ADR-008 §4); проект без паспорта получает 0 и уходит в конец.
--
-- Материализованное представление пересоздаётся: ALTER для него недоступен.
-- Функция seasons.refresh_rating() ссылается на имя и правки не требует.

DROP MATERIALIZED VIEW seasons.mv_season_rating;

CREATE MATERIALIZED VIEW seasons.mv_season_rating AS
SELECT p.season_id,
       p.id AS project_id,
       p.title,
       i.value AS irs,
       i.computed_at,
       COALESCE((pp.jsonb_data->>'score10Published')::int, 0) AS score10,
       row_number() OVER (
           PARTITION BY p.season_id
           ORDER BY COALESCE((pp.jsonb_data->>'score10Published')::int, 0) DESC,
                    i.value DESC,
                    p.id
       ) AS rank
FROM lab.projects p
JOIN LATERAL (
    SELECT value, computed_at FROM scoring.irs_scores s
    WHERE s.project_id = p.id ORDER BY computed_at DESC LIMIT 1
) i ON true
LEFT JOIN scoring.investment_passports pp
       ON pp.project_id = p.id AND pp.superseded_at IS NULL
WHERE p.status IN ('expert_review','bootcamp','finalist','graduated')
  AND p.deleted_at IS NULL;

CREATE UNIQUE INDEX mv_season_rating_uq ON seasons.mv_season_rating (season_id, project_id);

GRANT SELECT ON seasons.mv_season_rating TO app_backend, app_public_read, app_integration;

COMMENT ON MATERIALIZED VIEW seasons.mv_season_rating IS
    'Рейтинг сезона: по публикуемому баллу 1–10 (после решения человека по потолкам), '
    'тай-брейкер — IRS. Пересчёт — seasons.refresh_rating().';
