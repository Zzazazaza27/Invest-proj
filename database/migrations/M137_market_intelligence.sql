-- M137 — Market Intelligence: сущности рынка и их источники (MVP).
--
-- ЗАЧЕМ. Владельцу нужно начать копить сведения об инвестиционном рынке —
-- фонды, ангелы, клубы, акселераторы, мероприятия — там же, где живёт
-- платформа, а не в разрозненных заметках. Постановка —
-- docs/product/market-intelligence/ТЗ-MVP.md.
--
-- НАМЕРЕННО ПРОСТО. Две таблицы и никакой модели связей: «сначала собираем
-- реальные данные, потом по ним уточняем модель» (ТЗ §14). То, что источник
-- даёт сверх минимальных полей (регион, раунды, отрасли, телефон), лежит в
-- `attributes` как есть — чтобы не терять данные и не проектировать схему
-- под догадку.
--
-- КЛАСС ДАННЫХ — `content`: владелец наполняет раздел руками, и сброс стенда
-- не должен уносить накопленное (database/src/data-classes.ts).
--
-- ДОСТУП — только администратор, как у тестовых сессий (M129).

CREATE SCHEMA IF NOT EXISTS intelligence;
COMMENT ON SCHEMA intelligence IS
    'Market Intelligence: сведения об участниках инвестиционного рынка и '
    'источники, где они найдены. Внутренний раздел админки.';

CREATE TABLE intelligence.entities (
    id                UUID PRIMARY KEY,
    type              TEXT NOT NULL CHECK (type IN (
                          'person', 'investor', 'organization', 'fund', 'investor_club',
                          'accelerator', 'bootcamp', 'event', 'media', 'corporation', 'other')),
    name              TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 300),
    organization_name TEXT CHECK (organization_name IS NULL OR length(organization_name) <= 300),
    description       TEXT CHECK (description IS NULL OR length(description) <= 20000),
    website_url       TEXT CHECK (website_url IS NULL OR length(website_url) <= 2000),
    email             TEXT CHECK (email IS NULL OR length(email) <= 320),
    telegram          TEXT CHECK (telegram IS NULL OR length(telegram) <= 300),
    linkedin          TEXT CHECK (linkedin IS NULL OR length(linkedin) <= 2000),
    status            TEXT NOT NULL DEFAULT 'raw'
                      CHECK (status IN ('raw', 'reviewed', 'interesting', 'contacted', 'archived')),
    notes             TEXT CHECK (notes IS NULL OR length(notes) <= 20000),
    -- Всё, что источник дал сверх полей выше. Не модель, а склад: по нему
    -- потом решается, какие признаки заслуживают своих колонок.
    attributes        JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Происхождение импортированной записи (ТЗ §10). У ручной — пусто.
    import_source     TEXT CHECK (import_source IS NULL OR length(import_source) <= 80),
    external_url      TEXT CHECK (external_url IS NULL OR length(external_url) <= 2000),
    external_id       TEXT CHECK (external_id IS NULL OR length(external_id) <= 200),
    imported_at       TIMESTAMPTZ,
    created_by        UUID REFERENCES identity.users(id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((import_source IS NULL) = (external_id IS NULL))
);
COMMENT ON TABLE intelligence.entities IS
    'Участник рынка: человек, фонд, клуб, акселератор, мероприятие. Дубли не '
    'объединяются автоматически — экран только предупреждает (ТЗ §11).';
COMMENT ON COLUMN intelligence.entities.attributes IS
    'Сведения источника сверх основных полей, как они есть: характеристики '
    'каталога, телефон, полный текст карточки. Догадки сюда не пишутся.';

-- Повторный импорт узнаёт запись по её номеру в источнике, а не по имени:
-- имя в каталоге могут поправить, номер остаётся.
CREATE UNIQUE INDEX entities_external
    ON intelligence.entities (import_source, external_id)
    WHERE import_source IS NOT NULL;
CREATE INDEX entities_type_status ON intelligence.entities (type, status);
CREATE INDEX entities_updated ON intelligence.entities (updated_at DESC);
-- Подозрение на дубль (ТЗ §11): одинаковые имя и организация.
CREATE INDEX entities_name_org
    ON intelligence.entities (lower(name), lower(coalesce(organization_name, '')));

CREATE TABLE intelligence.sources (
    id              UUID PRIMARY KEY,
    -- Пусто — источник сохранён сам по себе («Импорт URL»), к сущности ещё
    -- не привязан. Это законное состояние: страница найдена, разбор впереди.
    entity_id       UUID REFERENCES intelligence.entities(id) ON DELETE CASCADE,
    source_url      TEXT NOT NULL CHECK (length(btrim(source_url)) BETWEEN 1 AND 2000),
    source_domain   TEXT CHECK (source_domain IS NULL OR length(source_domain) <= 300),
    source_title    TEXT CHECK (source_title IS NULL OR length(source_title) <= 1000),
    discovered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_checked_at TIMESTAMPTZ,
    notes           TEXT CHECK (notes IS NULL OR length(notes) <= 20000),
    created_by      UUID REFERENCES identity.users(id)
);
COMMENT ON TABLE intelligence.sources IS
    'Где сущность найдена. У одной сущности источников сколько угодно; '
    'источник без сущности — сохранённая страница, ещё не разобранная.';

CREATE UNIQUE INDEX sources_entity_url
    ON intelligence.sources (entity_id, source_url) WHERE entity_id IS NOT NULL;
CREATE UNIQUE INDEX sources_loose_url
    ON intelligence.sources (source_url) WHERE entity_id IS NULL;
CREATE INDEX sources_domain ON intelligence.sources (source_domain);

ALTER TABLE intelligence.entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE intelligence.entities FORCE  ROW LEVEL SECURITY;
ALTER TABLE intelligence.sources  ENABLE ROW LEVEL SECURITY;
ALTER TABLE intelligence.sources  FORCE  ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA intelligence TO app_backend;
GRANT SELECT, INSERT, UPDATE, DELETE ON intelligence.entities, intelligence.sources TO app_backend;

CREATE POLICY entities_admin ON intelligence.entities FOR ALL
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));
CREATE POLICY sources_admin ON intelligence.sources FOR ALL
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));
