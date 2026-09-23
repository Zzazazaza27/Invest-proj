-- M139 — источник и упоминание: две разные вещи.
--
-- ЧТО БЫЛО НЕ ТАК (замечание владельца 2026-09-23). M137 записывал
-- «источник» как пару «сущность + адрес». Импорт get-investor.ru дал 376
-- «источников», хотя источник один — сайт, а 376 — это упоминания в нём.
-- Исследование рынка (52 площадки, два пути поиска) в такую модель не
-- ложилось вовсе: площадка ценна сама по себе, ещё до того, как из неё
-- извлечена хоть одна сущность.
--
-- МОДЕЛЬ ПОСЛЕ ЭТОЙ МИГРАЦИИ.
--   intelligence.sources  — ИСТОЧНИК: сайт или страница. Свои признаки из
--                           исследовательского задания (ТЗ §17): тип, что
--                           даёт, насколько структурирован, есть ли контакты,
--                           приоритет для парсера, как найден.
--   intelligence.mentions — УПОМИНАНИЕ: сущность найдена в источнике (на
--                           такой-то странице, в такой-то роли). Одна
--                           сущность — сколько угодно источников, один
--                           источник — сколько угодно сущностей.
--
-- СУЩНОСТЬ МОЖЕТ БЫТЬ ИСТОЧНИКОМ: сайт фонда с портфелем, страница
-- мероприятия со спикерами, сайт клуба с участниками. Это
-- `represents_entity_id`. А `via_entity_id` — обратный путь поиска (ТЗ §17,
-- путь 2): источник найден, когда искали вокруг такой-то сущности.
--
-- Колонка `sources.entity_id` выводится из употребления: данные переносятся
-- в упоминания, новая запись в неё запрещена ограничением. Удаление колонки —
-- отдельная contract-миграция (TODO.md).

ALTER TABLE intelligence.sources
    ADD COLUMN name                 TEXT CHECK (name IS NULL OR length(name) <= 300),
    ADD COLUMN kind                 TEXT CHECK (kind IS NULL OR length(kind) <= 200),
    ADD COLUMN description          TEXT CHECK (description IS NULL OR length(description) <= 20000),
    ADD COLUMN obtainable           TEXT CHECK (obtainable IS NULL OR length(obtainable) <= 2000),
    ADD COLUMN structure            TEXT CHECK (structure IN ('high', 'medium', 'low')),
    ADD COLUMN public_contacts      TEXT CHECK (public_contacts IN ('yes', 'partial', 'no')),
    ADD COLUMN alive                TEXT CHECK (alive IN ('yes', 'no', 'unknown')),
    ADD COLUMN parser_priority      TEXT CHECK (parser_priority IN ('high', 'medium', 'low')),
    ADD COLUMN discovery            TEXT NOT NULL DEFAULT 'manual'
                                    CHECK (discovery IN ('direct', 'reverse', 'import', 'manual')),
    ADD COLUMN via_entity_id        UUID REFERENCES intelligence.entities(id) ON DELETE SET NULL,
    ADD COLUMN represents_entity_id UUID REFERENCES intelligence.entities(id) ON DELETE SET NULL,
    ADD COLUMN updated_at           TIMESTAMPTZ NOT NULL DEFAULT now();

COMMENT ON COLUMN intelligence.sources.discovery IS
    'Как найден: direct — прямой поиск (путь 1), reverse — от известной '
    'сущности (путь 2, см. via_entity_id), import — разборщиком, manual — руками.';
COMMENT ON COLUMN intelligence.sources.represents_entity_id IS
    'Источник — это сама сущность: сайт фонда, страница клуба или мероприятия.';
COMMENT ON COLUMN intelligence.sources.via_entity_id IS
    'Обратный поиск: источник найден при поиске вокруг этой сущности.';

CREATE TABLE intelligence.mentions (
    id              UUID PRIMARY KEY,
    entity_id       UUID NOT NULL REFERENCES intelligence.entities(id) ON DELETE CASCADE,
    source_id       UUID NOT NULL REFERENCES intelligence.sources(id) ON DELETE CASCADE,
    -- Конкретная страница внутри источника: карточка каталога, статья,
    -- список спикеров. Пусто — упомянут «где-то на сайте».
    page_url        TEXT CHECK (page_url IS NULL OR length(page_url) <= 2000),
    -- В какой роли: спикер, жюри, портфель, раздел каталога.
    context         TEXT CHECK (context IS NULL OR length(context) <= 300),
    notes           TEXT CHECK (notes IS NULL OR length(notes) <= 20000),
    found_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_checked_at TIMESTAMPTZ,
    created_by      UUID REFERENCES identity.users(id) ON DELETE SET NULL
);
COMMENT ON TABLE intelligence.mentions IS
    'Сущность найдена в источнике. Одна сущность в разных источниках — '
    'разные строки; это и есть «одни и те же сущности в разных источниках».';
CREATE UNIQUE INDEX mentions_unique
    ON intelligence.mentions (entity_id, source_id, coalesce(page_url, ''));
CREATE INDEX mentions_source ON intelligence.mentions (source_id);

ALTER TABLE intelligence.mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE intelligence.mentions FORCE  ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON intelligence.mentions TO app_backend;
CREATE POLICY mentions_admin ON intelligence.mentions FOR ALL
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

-- ------------------------------------------------------- перенос данных
-- Один источник на домен: для каждого домена, где висели прежние «источники
-- записи», заводится источник-сайт, а прежние строки становятся упоминаниями
-- с адресом страницы.
INSERT INTO intelligence.sources
    (id, source_url, source_domain, name, discovery, discovered_at, last_checked_at)
SELECT gen_random_uuid(),
       'https://' || d.domain || '/',
       d.domain,
       CASE d.domain WHEN 'get-investor.ru' THEN 'Get-Investor' ELSE d.domain END,
       CASE d.domain WHEN 'get-investor.ru' THEN 'import' ELSE 'manual' END,
       d.first_seen,
       d.last_checked
  FROM (SELECT source_domain AS domain, min(discovered_at) AS first_seen,
               max(last_checked_at) AS last_checked
          FROM intelligence.sources
         WHERE entity_id IS NOT NULL AND source_domain IS NOT NULL
         GROUP BY source_domain) d
ON CONFLICT (source_url) WHERE entity_id IS NULL DO NOTHING;

INSERT INTO intelligence.mentions
    (id, entity_id, source_id, page_url, notes, found_at, last_checked_at, created_by)
SELECT gen_random_uuid(), old.entity_id, site.id, old.source_url, old.notes,
       old.discovered_at, old.last_checked_at, old.created_by
  FROM intelligence.sources old
  JOIN intelligence.sources site
    ON site.entity_id IS NULL
   AND site.source_url = 'https://' || old.source_domain || '/'
 WHERE old.entity_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Строки без домена (адрес не разобрался) остаются источниками сами по себе:
-- отвязываются от сущности, но не теряются.
UPDATE intelligence.sources old
   SET entity_id = NULL
 WHERE old.entity_id IS NOT NULL
   AND old.source_domain IS NULL
   AND NOT EXISTS (SELECT 1 FROM intelligence.sources s
                    WHERE s.entity_id IS NULL AND s.source_url = old.source_url);

DELETE FROM intelligence.sources WHERE entity_id IS NOT NULL;

UPDATE intelligence.sources
   SET kind = 'каталог инвесторов и мер поддержки',
       description = 'Каталоги фондов, бизнес-ангелов, клубов, акселераторов, венчурных студий, '
                     'грантов, ОЭЗ и календарь мероприятий. Сам по себе агрегатор, продающий '
                     'стартапам доступ к базе.',
       obtainable = 'фонды, ангелы, клубы, акселераторы, венчурные студии, мероприятия',
       structure = 'high',
       public_contacts = 'partial',
       alive = 'yes'
 WHERE source_url = 'https://get-investor.ru/';

ALTER TABLE intelligence.sources
    ADD CONSTRAINT sources_entity_retired CHECK (entity_id IS NULL);
COMMENT ON COLUMN intelligence.sources.entity_id IS
    'Выведена из употребления M139: связь сущности с источником — '
    'intelligence.mentions. Всегда пусто; удаление — отдельной миграцией.';
