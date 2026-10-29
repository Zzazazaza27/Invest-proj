-- M147 — учёт и завершение загрузок материалов проекта (5Э MVP, работа 2.1-W03).
--
-- Требования: блок 1 (1.3.2–1.3.4), 3.3 «Учёт загрузок», 2.1.2 «Сохранение
-- файла вместе с записью о нём». План согласован Томасом и Тэнком 29.10.2026.
--
-- Что меняется в смысле полей:
--  * `s3_key` — ключ ГОТОВОГО файла: окончательная копия, недоступная форме
--    браузера. Код, читающий материалы, не меняется.
--  * `upload_key` — временный ключ подписанной формы. Пока материал не готов,
--    `s3_key` пуст, а файл лежит по `upload_key`.
--  * `upload_state` — ожидает загрузки / готово / отклонено / требует
--    вмешательства. «Отклонено» — проверенное несоответствие формату или
--    размеру: автоматических повторов нет, другой файл — новая загрузка
--    (предложение к фиксации в 2.1.2).
--  * аренда `lease_id` / `lease_until` — общий модуль `background/lease.ts`
--    (W01): новый id на каждый захват (в 3.3 названы `locked_*`; имена —
--    предложение к фиксации).
--
-- РЕЖИМ ОТКАТА. Миграция при возврате прежнего кода остаётся, и защита
-- держится в БД, а не в коде:
--  * прежнее создание (s3_key без upload_key) отвергается проверкой таблицы;
--  * прежнее подтверждение (uploaded_at без «готово») — тоже;
--  * прежнее удаление по возрасту — у роли обслуживания нет DELETE;
--  * готовые материалы читаются как прежде, незавершённые записи и объекты
--    сохраняются, после возврата новой версии их завершает сверка.

-- --- 1. Поля загрузки --------------------------------------------------------

ALTER TABLE lab.project_materials
    ADD COLUMN upload_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (upload_state IN ('pending', 'ready', 'rejected', 'needs_attention')),
    ADD COLUMN upload_state_reason TEXT CHECK (length(upload_state_reason) <= 500),
    ADD COLUMN upload_state_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN upload_key TEXT,
    ADD COLUMN upload_expires_at TIMESTAMPTZ,
    ADD COLUMN upload_content_type TEXT,
    ADD COLUMN upload_max_bytes BIGINT CHECK (upload_max_bytes IS NULL OR upload_max_bytes > 0),
    ADD COLUMN object_received_at TIMESTAMPTZ,
    ADD COLUMN not_received_at TIMESTAMPTZ,
    ADD COLUMN content_type TEXT,
    ADD COLUMN lease_id UUID,
    ADD COLUMN lease_until TIMESTAMPTZ,
    ADD COLUMN next_check_at TIMESTAMPTZ,
    ADD COLUMN check_failures INTEGER NOT NULL DEFAULT 0 CHECK (check_failures >= 0),
    ADD COLUMN unknown_since TIMESTAMPTZ,
    ADD COLUMN last_error TEXT CHECK (length(last_error) <= 500);

COMMENT ON COLUMN lab.project_materials.s3_key IS
    'Ключ ГОТОВОГО файла (окончательная копия). Пуст, пока материал не готов (M147).';
COMMENT ON COLUMN lab.project_materials.upload_key IS
    'Временный ключ подписанной формы. Готовый файл по нему не читается (M147).';
COMMENT ON COLUMN lab.project_materials.upload_state IS
    'pending — ожидает загрузки; ready — готово; rejected — проверенное несоответствие '
    'формату или размеру; needs_attention — требует вмешательства эксплуатации.';
COMMENT ON COLUMN lab.project_materials.object_received_at IS
    'Когда хранилище впервые подтвердило наличие объекта по upload_key.';
COMMENT ON COLUMN lab.project_materials.not_received_at IS
    'Отметка «к сроку не получен»: срок формы прошёл, объекта нет. Не окончательная неудача.';
COMMENT ON COLUMN lab.project_materials.unknown_since IS
    'Начало непрерывного неизвестного результата (таймаут, недоступность хранилища).';

-- --- 2. Существующие записи --------------------------------------------------

-- Прежняя проверка требовала s3_key у любого файла; заменяется ниже.
ALTER TABLE lab.project_materials DROP CONSTRAINT project_materials_check;

UPDATE lab.project_materials
   SET upload_state = 'ready', upload_state_changed_at = uploaded_at
 WHERE uploaded_at IS NOT NULL;

-- Неподтверждённые: прежний ключ был ключом формы — он становится временным.
UPDATE lab.project_materials
   SET upload_key = s3_key, s3_key = NULL, next_check_at = now()
 WHERE uploaded_at IS NULL AND type <> 'product_link';

-- --- 3. Проверки таблицы ------------------------------------------------------

ALTER TABLE lab.project_materials
    ADD CONSTRAINT project_materials_link_or_file CHECK (
        (type = 'product_link' AND url IS NOT NULL AND s3_key IS NULL AND upload_key IS NULL)
        OR (type <> 'product_link' AND url IS NULL)),
    -- «Готово» тогда и только тогда, когда проставлено время готовности: прежнее
    -- подтверждение (uploaded_at без смены состояния) отвергается.
    ADD CONSTRAINT project_materials_ready_iff_uploaded CHECK (
        (upload_state = 'ready') = (uploaded_at IS NOT NULL)),
    -- Файл: готовый — по окончательному ключу; неготовый — только по временному.
    -- Прежнее создание (s3_key без upload_key) отвергается.
    ADD CONSTRAINT project_materials_file_keys CHECK (
        type = 'product_link'
        OR (upload_state = 'ready' AND s3_key IS NOT NULL)
        OR (upload_state <> 'ready' AND s3_key IS NULL AND upload_key IS NOT NULL)),
    ADD CONSTRAINT project_materials_lease_pair CHECK (
        (lease_id IS NULL) = (lease_until IS NULL));

-- Ссылка на продукт готова сразу: состояние ставится тем же триггером, что и
-- время готовности (M040), — и для прежнего кода тоже.
CREATE OR REPLACE FUNCTION lab.mark_product_link_uploaded()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, lab, public
AS $$
BEGIN
    IF NEW.type = 'product_link' AND NEW.uploaded_at IS NULL THEN
        NEW.uploaded_at := coalesce(NEW.created_at, now());
    END IF;
    IF NEW.type = 'product_link' THEN
        NEW.upload_state := 'ready';
    END IF;
    RETURN NEW;
END $$;

-- Неизменность готового файла: окончательный ключ, размер, хеш, тип и время
-- готовности после «готово» не меняются никем. Новый файл — новая версия.
CREATE OR REPLACE FUNCTION lab.forbid_ready_material_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, lab, public
AS $$
BEGIN
    IF OLD.upload_state = 'ready' AND (
           NEW.upload_state IS DISTINCT FROM OLD.upload_state
        OR NEW.s3_key IS DISTINCT FROM OLD.s3_key
        OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
        OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
        OR NEW.content_type IS DISTINCT FROM OLD.content_type
        OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at) THEN
        RAISE EXCEPTION 'ready material is immutable: %', OLD.id USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER project_materials_ready_immutable
    BEFORE UPDATE ON lab.project_materials
    FOR EACH ROW EXECUTE FUNCTION lab.forbid_ready_material_rewrite();

-- Отбор незавершённых загрузок сверкой.
CREATE INDEX project_materials_upload_due
    ON lab.project_materials (next_check_at)
    WHERE upload_state = 'pending' AND type <> 'product_link';

-- --- 4. Попытки завершения ---------------------------------------------------

CREATE TABLE lab.material_upload_attempts (
    id          UUID PRIMARY KEY,
    material_id UUID NOT NULL REFERENCES lab.project_materials(id),
    final_key   TEXT NOT NULL UNIQUE,
    lease_id    UUID NOT NULL,
    state       TEXT NOT NULL DEFAULT 'copying'
        CHECK (state IN ('copying', 'copied', 'published', 'failed', 'abandoned')),
    error       TEXT CHECK (length(error) <= 500),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE lab.material_upload_attempts IS
    'Попытки завершения загрузки: окончательный ключ записывается ДО CopyObject, '
    'чтобы после сбоя найти и копии, не ставшие итоговым файлом (3.3).';

CREATE INDEX material_upload_attempts_material ON lab.material_upload_attempts (material_id);

-- Опубликована не более чем одна попытка на материал.
CREATE UNIQUE INDEX material_upload_attempts_one_published
    ON lab.material_upload_attempts (material_id) WHERE state = 'published';

ALTER TABLE lab.material_upload_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.material_upload_attempts FORCE ROW LEVEL SECURITY;

-- --- 5. Права роли обслуживания ---------------------------------------------
--
-- Завершение в обоих путях (браузер и сверка) выполняется под app_maintenance;
-- доступ пользователя браузерный путь проверяет раньше, своим контекстом.

DROP POLICY materials_maintenance_delete ON lab.project_materials;
DROP POLICY materials_maintenance_read ON lab.project_materials;
REVOKE DELETE ON lab.project_materials FROM app_maintenance;
REVOKE SELECT ON lab.project_materials FROM app_maintenance;

GRANT SELECT (id, project_id, type, version, uploaded_by, created_at,
              upload_state, upload_state_reason, upload_state_changed_at,
              upload_key, upload_expires_at, upload_content_type, upload_max_bytes,
              object_received_at, not_received_at,
              s3_key, size_bytes, content_hash, content_type, uploaded_at,
              lease_id, lease_until, next_check_at, check_failures, unknown_since, last_error)
    ON lab.project_materials TO app_maintenance;

GRANT UPDATE (upload_state, upload_state_reason, upload_state_changed_at,
              object_received_at, not_received_at,
              s3_key, size_bytes, content_hash, content_type, uploaded_at,
              lease_id, lease_until, next_check_at, check_failures, unknown_since, last_error)
    ON lab.project_materials TO app_maintenance;

CREATE POLICY materials_maintenance_select ON lab.project_materials
    FOR SELECT TO app_maintenance
    USING (type <> 'product_link');

-- Исходная строка — только «ожидает»; результат — любое из согласованных
-- состояний. Готовые сведения защищает триггер неизменности выше.
CREATE POLICY materials_maintenance_complete ON lab.project_materials
    FOR UPDATE TO app_maintenance
    USING (upload_state = 'pending' AND type <> 'product_link')
    WITH CHECK (upload_state IN ('pending', 'ready', 'rejected', 'needs_attention')
                AND type <> 'product_link');

GRANT SELECT, INSERT ON lab.material_upload_attempts TO app_maintenance;
GRANT UPDATE (state, error, updated_at) ON lab.material_upload_attempts TO app_maintenance;

CREATE POLICY upload_attempts_maintenance ON lab.material_upload_attempts
    FOR ALL TO app_maintenance
    USING (true) WITH CHECK (true);

-- Администратор видит попытки для разбора; изменять их не может.
GRANT SELECT ON lab.material_upload_attempts TO app_backend;
CREATE POLICY upload_attempts_admin_read ON lab.material_upload_attempts
    FOR SELECT TO app_backend
    USING (app.has_role('admin'));

-- Журнал действий: событие публикации пишется в той же транзакции.
GRANT USAGE ON SCHEMA audit TO app_maintenance;
GRANT EXECUTE ON FUNCTION audit.app_emit_event(TEXT, UUID, TEXT, TEXT, UUID, JSONB, TEXT)
    TO app_maintenance;
