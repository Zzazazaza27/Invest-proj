-- M146 — обзор площадки в профиле источника.
--
-- Решение владельца 2026-09-25: результаты исследования площадок видны прямо
-- в профиле площадки (карточка источника в Market Intelligence), а не только
-- в исследовательских файлах. Своё поле, а не `description` и `notes`:
-- краткое описание из разбора и заметки человека остаются нетронутыми.
--
--  * platform_review    — обзор площадки (безопасный Markdown): назначение и
--    аудитория, возможности и услуги, ограничения, условия, источники с датой.
--    Внутренние выводы исследования сюда не пишутся.
--  * platform_review_at — когда обзор последний раз записан; ставит ядро.
--
-- Доступ — как у всей таблицы: только администратор (RLS M137).

ALTER TABLE intelligence.sources
    ADD COLUMN platform_review    TEXT
        CHECK (platform_review IS NULL OR length(platform_review) <= 20000),
    ADD COLUMN platform_review_at TIMESTAMPTZ;

COMMENT ON COLUMN intelligence.sources.platform_review IS
    'Обзор площадки из исследования (Markdown): назначение, возможности, ограничения, '
    'условия, источники с датой проверки. Не заменяет description и notes.';
COMMENT ON COLUMN intelligence.sources.platform_review_at IS
    'Когда обзор площадки записан последний раз.';
