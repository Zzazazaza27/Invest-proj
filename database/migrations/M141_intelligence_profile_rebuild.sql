-- M141 — перестройка Market Intelligence под профильную базу рынка.
--
-- Постановка — docs/product/market-intelligence/ТЗ-перестройка.md. Коротко,
-- что было не так и что меняется:
--
-- 1. ИСТОЧНИК БЫВАЕТ ПРОФИЛЬНЫМ ИЛИ НЕТ (ТЗ §2, §9, §10). Акселератор,
--    фонд, клуб, Demo Day, профильный каталог — площадка инвестиционного
--    рынка, и присутствие на ней говорит о весе сущности. Газета, блог,
--    новостной портал — нет: 50 публикаций СМИ не должны превращаться в 50
--    профильных упоминаний. Пока источник не разобран, признак пуст — это
--    честнее, чем записать «нет» по умолчанию.
--
-- 2. УПОМИНАНИЕ СТАНОВИТСЯ ФАКТОМ (ТЗ §7, §8): когда, где, в какой роли,
--    что произошло, какая организация, какое событие — и СТАТУС ПРОВЕРКИ.
--    Подтверждён только факт, у которого открыта конкретная страница и
--    сущность на ней действительно есть. «Поисковик показал имя рядом с
--    доменом» — кандидат, в показатели он не идёт.
--
-- 3. ЧЕЛОВЕК — ЭТО PERSON (ТЗ §5). «Инвестор», «спикер», «партнёр» — роли в
--    фактах, а не типы. Тип `investor` упраздняется.
--
-- 4. ДУБЛИ ОБЪЕДИНЯЮТСЯ (ТЗ §15, шаг 3), и ключ импорта объединённой записи
--    не должен воскресить её при следующем импорте — поэтому ключи внешних
--    источников переезжают в отдельную таблицу, где у одной сущности их
--    может быть несколько.

-- ================================================================ сущности

ALTER TABLE intelligence.entities DROP CONSTRAINT entities_type_check;
UPDATE intelligence.entities SET type = 'person' WHERE type = 'investor';
UPDATE intelligence.entities SET type = 'venture_studio'
 WHERE attributes->>'catalog' = 'venture-studios';
UPDATE intelligence.entities SET type = 'program'
 WHERE attributes->>'catalog' = 'grants-and-subsidies';
ALTER TABLE intelligence.entities ADD CONSTRAINT entities_type_check CHECK (type IN (
    'person', 'organization', 'fund', 'investor_club', 'accelerator', 'venture_studio',
    'bootcamp', 'event', 'platform', 'media', 'corporation', 'program', 'project', 'other'));

/**
 * Имя для сравнения дублей: без регистра, кавычек, «ё» и родовых слов в
 * начале. «Синдикат» и «Венчурный клуб "Синдикат"» дают одно и то же.
 */
CREATE OR REPLACE FUNCTION intelligence.norm_name(p_name TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT btrim(regexp_replace(
             regexp_replace(
               regexp_replace(replace(lower(p_name), 'ё', 'е'), '["«»„“”''`]', ' ', 'g'),
               '^\s*(венчурный клуб|инвестиционный клуб|клуб инвесторов|клуб|венчурный фонд|инвестиционный фонд|фонд|сообщество инвесторов|сообщество|акселератор)\s+',
               ''),
             '\s+', ' ', 'g'))
$$;
COMMENT ON FUNCTION intelligence.norm_name(TEXT) IS
    'Нормализованное имя для поиска дублей: регистр, кавычки, ё, родовое слово в начале.';

CREATE INDEX entities_norm_name ON intelligence.entities (intelligence.norm_name(name), type);

-- Ключи внешних источников: у объединённой сущности их несколько.
CREATE TABLE intelligence.external_ids (
    import_source TEXT NOT NULL CHECK (length(import_source) BETWEEN 1 AND 80),
    external_id   TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
    entity_id     UUID NOT NULL REFERENCES intelligence.entities(id) ON DELETE CASCADE,
    external_url  TEXT CHECK (external_url IS NULL OR length(external_url) <= 2000),
    PRIMARY KEY (import_source, external_id)
);
COMMENT ON TABLE intelligence.external_ids IS
    'Под каким номером сущность известна внешнему источнику. После объединения '
    'дублей у сущности несколько ключей — повторный импорт находит её по любому.';
CREATE INDEX external_ids_entity ON intelligence.external_ids (entity_id);
INSERT INTO intelligence.external_ids (import_source, external_id, entity_id, external_url)
SELECT import_source, external_id, id, external_url
  FROM intelligence.entities
 WHERE import_source IS NOT NULL;

ALTER TABLE intelligence.external_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE intelligence.external_ids FORCE  ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON intelligence.external_ids TO app_backend;
CREATE POLICY external_ids_admin ON intelligence.external_ids FOR ALL
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

-- ================================================================ источники

ALTER TABLE intelligence.sources
    ADD COLUMN is_profile            BOOLEAN,
    ADD COLUMN source_type           TEXT CHECK (source_type IN (
        -- профильные площадки (ТЗ §2.1)
        'fund', 'investor_club', 'accelerator', 'venture_studio', 'incubator', 'bootcamp',
        'demo_day', 'pitch_session', 'conference', 'competition', 'investment_platform',
        'crowdinvesting', 'investor_catalog', 'startup_catalog', 'community',
        'corporate_program', 'bank_program', 'university_program', 'gov_program',
        'market_portal', 'aggregator', 'event_calendar',
        -- непрофильные (ТЗ §2.2)
        'media', 'news', 'blog', 'telegram', 'general', 'speaker_agency', 'education',
        -- собственный сайт сущности (ТЗ §12)
        'own_site', 'other')),
    ADD COLUMN has_events            BOOLEAN,
    ADD COLUMN has_participant_lists BOOLEAN,
    ADD COLUMN parseable             TEXT CHECK (parseable IN ('yes', 'partial', 'no')),
    ADD COLUMN review_status         TEXT NOT NULL DEFAULT 'unchecked'
                                     CHECK (review_status IN ('unchecked', 'checked', 'unreachable'));

COMMENT ON COLUMN intelligence.sources.is_profile IS
    'Профильная площадка инвестиционного рынка (ТЗ §2). NULL — источник ещё не '
    'разобран; в карту профильных площадок и в вес сущностей идёт только true.';
COMMENT ON COLUMN intelligence.sources.review_status IS
    'unchecked — не открывали; checked — открыт и классифицирован; '
    'unreachable — не открылся (сайт мёртв или закрыт).';

-- get-investor.ru разобран при первом импорте: профильный агрегатор.
UPDATE intelligence.sources
   SET is_profile = true, source_type = 'aggregator', has_events = true,
       has_participant_lists = true, parseable = 'yes', review_status = 'checked'
 WHERE source_url = 'https://get-investor.ru/';

-- Собственный сайт сущности — не профильная площадка (ТЗ §12).
UPDATE intelligence.sources
   SET source_type = 'own_site', is_profile = false
 WHERE represents_entity_id IS NOT NULL AND source_type IS NULL;

-- ================================================================== факты

ALTER TABLE intelligence.mentions RENAME COLUMN context TO role;
ALTER TABLE intelligence.mentions RENAME COLUMN summary TO action;
ALTER TABLE intelligence.mentions
    ADD COLUMN organization_id UUID REFERENCES intelligence.entities(id) ON DELETE SET NULL,
    ADD COLUMN event_id        UUID REFERENCES intelligence.entities(id) ON DELETE SET NULL,
    ADD COLUMN verification    TEXT NOT NULL DEFAULT 'candidate'
                               CHECK (verification IN ('verified', 'candidate', 'rejected')),
    ADD COLUMN verified_at     TIMESTAMPTZ,
    ADD COLUMN evidence        TEXT CHECK (evidence IS NULL OR length(evidence) <= 2000),
    ADD CONSTRAINT mentions_verified_has_page
        CHECK (verification <> 'verified' OR page_url IS NOT NULL);

COMMENT ON TABLE intelligence.mentions IS
    'ФАКТ о сущности: когда, где (страница), в какой роли, что произошло, с какой '
    'организацией и событием. В показатели идёт только verified — страница '
    'открыта, сущность на ней есть.';
COMMENT ON COLUMN intelligence.mentions.evidence IS
    'Дословная цитата со страницы, подтверждающая факт: по ней факт проверяется, '
    'не открывая страницу заново.';

-- Одна страница может дать несколько фактов об одной сущности: спикер и
-- жюри на одном Demo Day, партнёр двух фондов в одной биографии.
DROP INDEX intelligence.mentions_unique;
CREATE UNIQUE INDEX mentions_unique ON intelligence.mentions (
    entity_id, source_id, coalesce(page_url, ''), coalesce(role, ''),
    coalesce(organization_id::text, ''));
CREATE INDEX mentions_organization ON intelligence.mentions (organization_id);

-- Карточки get-investor.ru открыты импортом, и сущность на своей карточке
-- есть по построению — это подтверждённые факты. Всё прочее из первого
-- прохода — кандидаты: обратный поиск сохранял домены из выдачи, не
-- открывая страниц (разбор 2026-09-23, «как-я-понял-задачу.md» §4).
UPDATE intelligence.mentions m
   SET verification = 'verified',
       verified_at = coalesce(m.last_checked_at, m.found_at),
       role = CASE m.role
                WHEN 'Бизнес-ангелы' THEN 'бизнес-ангел (в каталоге)'
                WHEN 'Инвестиционные фонды' THEN 'фонд в каталоге'
                WHEN 'Клубы инвесторов' THEN 'клуб в каталоге'
                WHEN 'Акселераторы' THEN 'акселератор в каталоге'
                WHEN 'Венчурные студии' THEN 'венчурная студия в каталоге'
                WHEN 'Календарь мероприятий' THEN 'мероприятие в календаре'
                ELSE coalesce(m.role, 'в каталоге')
              END
  FROM intelligence.sources s
 WHERE s.id = m.source_id AND s.source_url = 'https://get-investor.ru/'
   AND m.page_url IS NOT NULL;
