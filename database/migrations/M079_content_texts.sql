-- M079 — продуктовые тексты в БД: языки, записи, версии (план 0.2 §2.6, этап 5.3).
--
-- Словарь терминов и ЧАВО правит владелец продукта в админке без релиза
-- (постановка §11.6, §12.1). Тексты вопросов анкеты здесь НЕ живут — они
-- часть документа конфигурации (M073); сюда попадают записи без структуры:
-- термин с коротким и полным описанием, вопрос ЧАВО с ответом.
--
-- Три таблицы по образцу content.landing_blocks (M048): язык — строка, а не
-- колонка; запись — стабильный ключ и порядок; текст — версия с
-- valid_from/valid_to и основанием, одна действующая на (запись, язык, поле).
-- Публикация = закрыть действующую версию и вставить новую одной транзакцией;
-- история хранится. Пустой действующей версии не бывает: отсутствие перевода
-- — это отсутствие строки, и выдача честно отдаёт fallback и список missing.

CREATE TABLE content.languages (
    code       TEXT PRIMARY KEY CHECK (code ~ '^[a-z]{2}-[A-Z]{2}$'),
    name       TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
    is_active  BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0
);
COMMENT ON TABLE content.languages IS
    'Языки продуктовых текстов. Новый язык — строка здесь и переводы в text_versions; '
    'структура таблиц не меняется (постановка §12.3).';

INSERT INTO content.languages (code, name, is_active, sort_order) VALUES
    ('ru-RU', 'Русский', true, 10),
    ('en-US', 'English', false, 20)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE content.text_entries (
    id         UUID PRIMARY KEY,
    namespace  TEXT NOT NULL CHECK (namespace IN ('glossary','faq','ui','application')),
    key        TEXT NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,63}$'),
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active  BOOLEAN NOT NULL DEFAULT true,
    created_by UUID REFERENCES identity.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (namespace, key)
);
COMMENT ON TABLE content.text_entries IS
    'Языконезависимые записи продуктовых текстов: термин словаря, вопрос ЧАВО. '
    'Ключ стабилен; порядок и активность — свойства записи, не перевода.';

CREATE TABLE content.text_versions (
    id         UUID PRIMARY KEY,
    entry_id   UUID NOT NULL REFERENCES content.text_entries(id),
    locale     TEXT NOT NULL REFERENCES content.languages(code),
    field      TEXT NOT NULL CHECK (field ~ '^[a-z][a-z0-9_]{0,40}$'),
    body       TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
    version    INTEGER NOT NULL CHECK (version > 0),
    valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to   TIMESTAMPTZ,
    created_by UUID REFERENCES identity.users(id),
    reason     TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
    CHECK (valid_to IS NULL OR valid_to > valid_from),
    UNIQUE (entry_id, locale, field, version)
);
COMMENT ON TABLE content.text_versions IS
    'Версии текста поля записи на языке. Одна действующая (valid_to IS NULL) на '
    '(запись, язык, поле); история хранится, правка — новая версия с основанием.';

CREATE UNIQUE INDEX text_versions_active_uq
    ON content.text_versions (entry_id, locale, field)
    WHERE valid_to IS NULL;
CREATE INDEX text_versions_lookup
    ON content.text_versions (entry_id, locale, valid_from DESC);

CREATE OR REPLACE FUNCTION content.text_entries_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, content, public
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;
CREATE TRIGGER text_entries_touch
    BEFORE UPDATE ON content.text_entries
    FOR EACH ROW EXECUTE FUNCTION content.text_entries_touch();

ALTER TABLE content.languages     ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.languages     FORCE  ROW LEVEL SECURITY;
ALTER TABLE content.text_entries  ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.text_entries  FORCE  ROW LEVEL SECURITY;
ALTER TABLE content.text_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.text_versions FORCE  ROW LEVEL SECURITY;

-- Читают все, включая анонимных: словарь и ЧАВО публичны. Пишет администратор.
CREATE POLICY languages_public_read ON content.languages FOR SELECT
    TO app_public_read, app_backend USING (true);
CREATE POLICY languages_admin_write ON content.languages FOR ALL TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

CREATE POLICY text_entries_public_read ON content.text_entries FOR SELECT
    TO app_public_read, app_backend USING (true);
CREATE POLICY text_entries_admin_write ON content.text_entries FOR ALL TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

CREATE POLICY text_versions_public_read ON content.text_versions FOR SELECT
    TO app_public_read, app_backend USING (true);
CREATE POLICY text_versions_admin_write ON content.text_versions FOR ALL TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

GRANT SELECT ON content.languages, content.text_entries, content.text_versions TO app_public_read;
GRANT SELECT, INSERT, UPDATE ON content.languages, content.text_entries, content.text_versions TO app_backend;
-- DELETE не выдан: запись выключается (is_active), версия закрывается (valid_to).
