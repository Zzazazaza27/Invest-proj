-- =============================================================================
-- M048 — управление контентом витрины
--
-- Последняя позиция раздела «Интерфейсы» из TODO, закрываемая кодом: тексты
-- лендинга и баннеры были зашиты в `apps/web-public/src/App.tsx`, и поменять
-- их можно было только выкладкой фронтенда. Для платформы, где часть текстов —
-- публичные утверждения оператора (кому адресован продукт, что именно
-- предлагается, какие условия), это не мелочь: правка текста не должна
-- требовать релиза и не должна проходить мимо журнала.
--
-- Версионирование, а не правка на месте — тот же приём, что у тарифов
-- (`billing.subscription_plans`). Причина та же: опубликованный текст является
-- утверждением, и «что именно было написано на витрине в тот день» обязано
-- восстанавливаться. Правка на месте это стирает.
--
-- Активной считается версия, у которой `valid_from <= now()` и
-- `valid_to IS NULL OR valid_to > now()`. Частичный уникальный индекс не даёт
-- двум версиям одного блока действовать одновременно.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS content;   -- тексты и баннеры публичной витрины

GRANT USAGE ON SCHEMA content TO app_public_read, app_backend;

CREATE TABLE content.landing_blocks (
    id          UUID PRIMARY KEY,
    -- Ключ блока: по нему витрина запрашивает конкретное место на странице.
    -- Свободный текст здесь был бы приглашением к опечаткам, поэтому allowlist.
    key         TEXT NOT NULL CHECK (key IN
                ('hero_title','hero_subtitle','hero_cta','about','for_founders',
                 'for_investors','disclaimer','banner_primary','banner_secondary')),
    locale      TEXT NOT NULL DEFAULT 'ru-RU' CHECK (locale IN ('ru-RU','en-US')),
    -- Заголовок необязателен: у части блоков (дисклеймер) его нет.
    title       TEXT CHECK (title IS NULL OR length(title) BETWEEN 1 AND 300),
    body        TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
    -- Ссылка баннера. Только https и без учётных данных в адресе: этот текст
    -- попадает на публичную страницу как есть.
    link_url    TEXT CHECK (link_url IS NULL OR link_url ~ '^https://[^@\s]+$'),
    valid_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to    TIMESTAMPTZ,
    created_by  UUID NOT NULL REFERENCES identity.users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (valid_to IS NULL OR valid_to > valid_from)
);

COMMENT ON TABLE content.landing_blocks IS
    'Тексты и баннеры публичной витрины. Версионируются, а не правятся на месте: '
    'опубликованный текст — утверждение оператора, и его история обязана '
    'восстанавливаться (M048).';

-- Одновременно действующей может быть только одна версия блока в локали.
CREATE UNIQUE INDEX landing_blocks_active_uq
    ON content.landing_blocks (key, locale)
    WHERE valid_to IS NULL;

CREATE INDEX landing_blocks_lookup
    ON content.landing_blocks (locale, key, valid_from DESC);

ALTER TABLE content.landing_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.landing_blocks FORCE  ROW LEVEL SECURITY;

-- Читают все, включая анонимных: витрина публична по определению.
CREATE POLICY landing_blocks_public_read ON content.landing_blocks FOR SELECT
    TO app_public_read, app_backend USING (true);

-- Пишет только администратор. Роль приложения сама по себе права не даёт —
-- условие проверяет роль пользователя в контексте запроса.
CREATE POLICY landing_blocks_admin_write ON content.landing_blocks FOR ALL TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

GRANT SELECT ON content.landing_blocks TO app_public_read;
GRANT SELECT, INSERT, UPDATE ON content.landing_blocks TO app_backend;
