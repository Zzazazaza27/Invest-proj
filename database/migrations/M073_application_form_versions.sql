-- M073 — конфигурация вопросов инвестиционной заявки: версии в БД.
--
-- Решение владельца 2026-09-15 (план 0.2 §0в): состав вопросов, их порядок,
-- тексты, переводы и обязательность по стадиям — данные, а не схема в коде.
-- Документ конфигурации (форма — ApplicationFormConfigSchema в
-- packages/contracts) хранится строками-версиями:
--
--   draft      — единственный редактируемый черновик админки (version IS NULL);
--   published  — неизменяемая версия с номером; ровно одна из них активна.
--
-- «Опубликовать» = черновик получает следующий номер, становится published и
-- активной; прежняя активная гаснет. Откат = повторная активация прежней
-- опубликованной версии. Заявка при создании получает активную версию в
-- schema_version и живёт на ней до подачи — активация другой версии её не
-- трогает (§0в п.6). Ничего не удаляется: история версий — история анкеты.
--
-- Веса готовности здесь НЕ живут: у них своя версия и активация
-- (lab.readiness_configs, план 0.2 §2.7) — правка текста или откат анкеты
-- не должны менять формулу.
--
-- JSONB — внутренняя реализация: администратор работает с таблицей стадий и
-- карточкой вопроса, сервер принимает документ только через схему и проверки
-- публикации (системные ключи на месте, тип опубликованного ключа не
-- меняется, опубликованный ключ не исчезает — только архивируется).

CREATE TABLE lab.application_form_versions (
    id               UUID PRIMARY KEY,
    version          INTEGER UNIQUE CHECK (version IS NULL OR version > 0),
    status           TEXT NOT NULL CHECK (status IN ('draft','published')),
    is_active        BOOLEAN NOT NULL DEFAULT false,
    config_jsonb     JSONB NOT NULL,
    based_on_version INTEGER,
    reason           TEXT CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 3 AND 500),
    created_by       UUID REFERENCES identity.users(id),         -- NULL у сида
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_by     UUID REFERENCES identity.users(id),
    published_at     TIMESTAMPTZ,
    activated_at     TIMESTAMPTZ,
    -- Опубликованная версия пронумерована, датирована и обоснована.
    CONSTRAINT application_form_versions_published_complete
        CHECK (status <> 'published' OR (version IS NOT NULL AND published_at IS NOT NULL AND reason IS NOT NULL)),
    -- Черновик без номера и никогда не активен.
    CONSTRAINT application_form_versions_draft_unnumbered
        CHECK (status <> 'draft' OR (version IS NULL AND is_active = false AND published_at IS NULL))
);

-- Черновик один, активная одна — держит БД, а не код.
CREATE UNIQUE INDEX application_form_versions_one_draft
    ON lab.application_form_versions (status) WHERE status = 'draft';
CREATE UNIQUE INDEX application_form_versions_one_active
    ON lab.application_form_versions (is_active) WHERE is_active;

COMMENT ON TABLE lab.application_form_versions IS
    'Версии конфигурации вопросов заявки (план 0.2 §0в). config_jsonb — '
    'ApplicationFormConfigSchema из packages/contracts. Один черновик, одна '
    'активная опубликованная; заявка живёт на версии, с которой создана.';
COMMENT ON COLUMN lab.application_form_versions.version IS
    'Номер присваивается при публикации; у черновика NULL. Совпадает со '
    'schema_version заявок и снимков, созданных на этой версии.';
COMMENT ON COLUMN lab.application_form_versions.based_on_version IS
    'Из какой опубликованной версии сделан черновик — для истории и диффа.';
COMMENT ON COLUMN lab.application_form_versions.reason IS
    'Основание публикации или последней активации (откат — тоже активация).';

CREATE OR REPLACE FUNCTION lab.application_form_versions_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, lab, public
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

CREATE TRIGGER application_form_versions_touch
    BEFORE UPDATE ON lab.application_form_versions
    FOR EACH ROW EXECUTE FUNCTION lab.application_form_versions_touch();

-- Опубликованный документ неизменяем: правится только черновик, у
-- опубликованной версии меняется лишь флаг активности и его дата.
CREATE OR REPLACE FUNCTION lab.application_form_versions_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, lab, public
AS $$
BEGIN
    IF OLD.status = 'published' AND (
        NEW.config_jsonb IS DISTINCT FROM OLD.config_jsonb
        OR NEW.version IS DISTINCT FROM OLD.version
        OR NEW.status IS DISTINCT FROM OLD.status
        OR NEW.published_at IS DISTINCT FROM OLD.published_at
        OR NEW.published_by IS DISTINCT FROM OLD.published_by
    ) THEN
        RAISE EXCEPTION 'published application form version is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER application_form_versions_immutable
    BEFORE UPDATE ON lab.application_form_versions
    FOR EACH ROW EXECUTE FUNCTION lab.application_form_versions_immutable();

ALTER TABLE lab.application_form_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.application_form_versions FORCE  ROW LEVEL SECURITY;

-- Опубликованные версии читает любой вошедший: основателю нужна форма его
-- заявки, в том числе старой версии. Черновик — только администратору.
CREATE POLICY application_form_versions_read ON lab.application_form_versions FOR SELECT
    TO app_backend USING (status = 'published' OR app.has_role('admin'));
CREATE POLICY application_form_versions_admin_insert ON lab.application_form_versions FOR INSERT
    TO app_backend WITH CHECK (app.has_role('admin'));
CREATE POLICY application_form_versions_admin_update ON lab.application_form_versions FOR UPDATE
    TO app_backend USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));
-- DELETE не выдан: версии не удаляются, вопросы архивируются внутри документа.

GRANT SELECT, INSERT, UPDATE ON lab.application_form_versions TO app_backend;

-- Стартовая конфигурация (версия 1 из банка вопросов) сюда НЕ вписана:
-- документ на сотню вопросов с текстами живёт в коде контрактов
-- (application-form.v1.ts) и публикуется идемпотентным скриптом
-- scripts/seed-application-form.mjs, если опубликованных версий ещё нет.
-- До сида заявки создаются с schema_version = 0 — старая форма из девяти
-- полей, как до этапа 3.
