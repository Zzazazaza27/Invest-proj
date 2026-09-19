-- M119 — логотип и обложка проекта (этап 7.2).
--
-- Карточка проекта без изображения выглядит как черновик, и это бьёт по тем,
-- ради кого витрина сделана: проект теряется среди других не потому, что он
-- хуже. Поэтому логотип и обложка — часть представления, а не украшение.
--
-- Что здесь принципиально.
--
-- **Доступ к изображению — тот же предикат, что и к проекту.** Медиа
-- закрытого проекта не открывается знанием ссылки: байты отдаёт маршрут ядра
-- после проверки аудитории, а бакет остаётся приватным. Публичной раздачи
-- объектов нет и не заводится.
--
-- **Оригинал хранится, варианты вычисляются.** Владелец загружает одно
-- изображение; размеры для карточки и страницы платформа готовит сама. Иначе
-- либо витрина тянет мегабайты, либо владелец режет картинки руками.
--
-- **Кадрирование без редактора.** Вместо рамки с ручками — точка фокуса в
-- долях от ширины и высоты. Её достаточно, чтобы лицо или логотип не
-- обрезались, и она понятна без обучения.

CREATE TABLE lab.project_media (
    id          UUID PRIMARY KEY,
    project_id  UUID NOT NULL REFERENCES lab.projects(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('logo', 'cover')),

    -- Оригинал как загрузил владелец: из него пересчитываются варианты, если
    -- изменится точка фокуса или набор размеров.
    master_key  TEXT NOT NULL,
    /**
     * Готовые размеры: {"card": {"key": ..., "width": ..., "height": ...}, ...}.
     * Ключи вариантов принадлежат платформе и наружу не отдаются — снаружи
     * есть только маршрут `/media/<kind>/<size>`.
     */
    variants    JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Фактические свойства ЗАГРУЖЕННОГО файла, определённые разбором
    -- изображения, а не тем, что назвал клиент.
    mime        TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
    bytes       INTEGER NOT NULL CHECK (bytes > 0),
    width       INTEGER NOT NULL CHECK (width > 0),
    height      INTEGER NOT NULL CHECK (height > 0),

    -- Точка фокуса в долях: 0.5/0.5 — центр.
    focus_x     NUMERIC(4,3) NOT NULL DEFAULT 0.5 CHECK (focus_x >= 0 AND focus_x <= 1),
    focus_y     NUMERIC(4,3) NOT NULL DEFAULT 0.5 CHECK (focus_y >= 0 AND focus_y <= 1),

    uploaded_by UUID REFERENCES identity.users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Один логотип и одна обложка на проект: «которая из трёх настоящая» —
    -- вопрос, которого быть не должно.
    UNIQUE (project_id, kind)
);
CREATE INDEX project_media_project ON lab.project_media (project_id);

COMMENT ON TABLE lab.project_media IS
    'Логотип и обложка проекта (M119). Байты лежат в приватном хранилище; наружу отдаёт маршрут '
    'ядра после проверки аудитории проекта — знание ссылки доступа не даёт.';
COMMENT ON COLUMN lab.project_media.mime IS
    'Тип, определённый РАЗБОРОМ изображения, а не заголовком клиента (M119).';
COMMENT ON COLUMN lab.project_media.focus_x IS
    'Точка фокуса по горизонтали в долях (M119): что не должно уехать за край при кадрировании.';

-- ------------------------------------------------------------------ RLS
ALTER TABLE lab.project_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.project_media FORCE  ROW LEVEL SECURITY;

/**
 * Читает тот, кому виден сам проект.
 *
 * Разрешение `teaser` выбрано намеренно: логотип и обложка показываются в
 * карточке, то есть ровно там, где показывается тизер. Отдельной настройки
 * видимости у изображения нет — она была бы вторым местом правды о раскрытии.
 */
CREATE POLICY project_media_audience ON lab.project_media FOR SELECT
    TO app_backend, app_public_read USING (
        lab.project_audience(project_id, app.current_user_id(), 'teaser') IS NOT NULL);

/** Меняет только команда проекта (и администратор). */
CREATE POLICY project_media_team_write ON lab.project_media FOR ALL
    TO app_backend USING (
        app.has_role('admin')
        OR lab.is_project_member(project_id, app.current_user_id()))
    WITH CHECK (
        app.has_role('admin')
        OR lab.is_project_member(project_id, app.current_user_id()));

GRANT SELECT ON lab.project_media TO app_public_read;
GRANT SELECT, INSERT, UPDATE, DELETE ON lab.project_media TO app_backend;

-- --------------------------------------------------------- глаголы аудита
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('lab.project_media.set', 'Загружен логотип или обложка проекта', ARRAY['founder', 'admin']),
    ('lab.project_media.removed', 'Удалён логотип или обложка проекта', ARRAY['founder', 'admin'])
ON CONFLICT (verb) DO NOTHING;
