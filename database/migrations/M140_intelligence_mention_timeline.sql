-- M140 — упоминание как строка хроники сущности.
--
-- ЗАЧЕМ (владелец 2026-09-23). У сущности должен быть профиль: где
-- упоминается, что делала, когда. По нему быстро понятно, кто это, и можно
-- написать адресное письмо, а не общее. Дальше этот профиль будут наполнять
-- ежедневный разбор интернета и проход за прошлые годы.
--
-- `found_at` — когда НАШЛИ мы. Для хроники нужна дата самого события
-- (выступил на форуме, вложился в раунд, дал интервью) — это `happened_on`.
-- Дата бывает известна до месяца или года, поэтому хранится день и
-- точность, а не выдуманный «1 января».
ALTER TABLE intelligence.mentions
    ADD COLUMN happened_on        DATE,
    ADD COLUMN happened_precision TEXT CHECK (happened_precision IN ('day', 'month', 'year')),
    ADD COLUMN summary            TEXT CHECK (summary IS NULL OR length(summary) <= 4000),
    ADD CONSTRAINT mentions_happened_precision
        CHECK ((happened_on IS NULL) = (happened_precision IS NULL));

COMMENT ON COLUMN intelligence.mentions.happened_on IS
    'Когда произошло событие упоминания (не когда мы его нашли). Точность — happened_precision.';
COMMENT ON COLUMN intelligence.mentions.summary IS
    'Что сущность делала в этом упоминании: одна-две фразы для профиля.';

CREATE INDEX mentions_timeline ON intelligence.mentions (entity_id, happened_on DESC NULLS LAST);
