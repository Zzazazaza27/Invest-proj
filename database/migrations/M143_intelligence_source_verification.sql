-- M143 — проверенность и достоверность площадки отдельно от её профильности.
--
-- Решение владельца 2026-09-23 разделяет четыре вещи: сама сущность;
-- подтверждённость факта (mentions.verification); профильность источника
-- (sources.is_profile); пригодность площадки для карты рынка. До этой
-- миграции последние две не различались, и источник, который не удалось
-- открыть, уже считался профильной площадкой, если так решили по описанию.
--
--  * verification — проверена ли сама площадка: `verified` — открыта и
--    классифицирована; `candidate` — не открыта или не открылась; `rejected`
--    — открыта, но площадкой не является (мёртвый домен, не то, чем
--    назвалась).
--  * reliability — годится ли площадка для построения карты рынка:
--    `doubtful` хранит сведения и факты, но веса сущностям не добавляет.
--    Сомнительность площадки НЕ делает сомнительными ни сущность, ни её
--    факты с других источников.
--
-- Вес (unique_profile_sources_count) считается только по площадкам
-- is_profile AND verification = 'verified' AND reliability <> 'doubtful'.
ALTER TABLE intelligence.sources
    ADD COLUMN verification TEXT NOT NULL DEFAULT 'candidate'
        CHECK (verification IN ('candidate', 'verified', 'rejected')),
    ADD COLUMN reliability  TEXT NOT NULL DEFAULT 'unassessed'
        CHECK (reliability IN ('unassessed', 'reliable', 'doubtful'));

COMMENT ON COLUMN intelligence.sources.verification IS
    'Проверена ли площадка: verified — открыта и классифицирована; candidate — '
    'не открыта или не открылась; rejected — площадкой не является.';
COMMENT ON COLUMN intelligence.sources.reliability IS
    'Пригодность для карты рынка. doubtful — сведения хранятся, в вес сущностей '
    'не идут. Не влияет на подтверждённость фактов и на саму сущность.';

-- Открыт и разобран — подтверждён; не открылся или не открывали — кандидат.
UPDATE intelligence.sources SET verification = 'verified' WHERE review_status = 'checked';

-- RusInvestProject (разбор 2026-09-23, пачка 2): в карточках известные
-- инвесторы с неправдоподобными суммами. Не удаляется — исключается из веса
-- до проверки качества (решение владельца 2026-09-23).
UPDATE intelligence.sources
   SET reliability = 'doubtful',
       notes = concat_ws(E'\n', notes,
         'Сомнительная площадка (2026-09-23): известные имена с неправдоподобными '
         'суммами; в вес сущностей не идёт до проверки качества.')
 WHERE source_domain = 'rusinvestproject.ru';
