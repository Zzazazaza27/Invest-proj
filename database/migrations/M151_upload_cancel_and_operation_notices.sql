-- M151 — отмена загрузки и отметки показа итога операции (5Э MVP, работа 2.1-W04).
--
-- Требования: блок 1 1.5 «Длительные пользовательские операции», 2.1.2, 3.3.
-- План — редакция 2, согласована Томасом и Тэнком 30.10.2026.
--
-- 1. Отмена загрузки — СОСТОЯНИЕ «отменено», а не удаление. Файл мог уже
--    поступить, копироваться или прийти позже; запись нужна для учёта
--    временного объекта и попыток. Записи и объекты сохраняются (2.1.2).
--    Переход только из «ожидает». Из «отменено» выхода нет — поздний файл
--    не публикуется: сверка и завершение работают только с «ожидает», а
--    отмена снимает аренду, и публикация под прежней арендой не проходит.
--    Резерв квоты освобождается сам: квота считает «готово» и «ожидает» (M149).
-- 2. Имя файла формы — чтобы сообщить, КАКОЙ файл не загружен.
-- 3. `comms.operation_notices` — отметка «итог операции показан пользователю»:
--    одна на пару «операция — пользователь», независимо от устройства (1.5).
--    Пишет только сам пользователь; принадлежность операции и доступ к ней
--    ядро проверяет в той же вставке (INSERT … SELECT под RLS материалов).

-- --- 1. Состояние «отменено» -------------------------------------------------

ALTER TABLE lab.project_materials DROP CONSTRAINT project_materials_upload_state_check;

ALTER TABLE lab.project_materials
    ADD CONSTRAINT project_materials_upload_state_check CHECK (
        upload_state IN ('pending', 'ready', 'rejected', 'needs_attention', 'cancelled')),
    ADD COLUMN cancelled_at TIMESTAMPTZ,
    ADD COLUMN cancelled_by UUID REFERENCES identity.users(id),
    ADD COLUMN upload_file_name TEXT CHECK (length(upload_file_name) <= 255);

ALTER TABLE lab.project_materials
    ADD CONSTRAINT project_materials_cancelled_iff_marked CHECK (
        (upload_state = 'cancelled') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL));

COMMENT ON COLUMN lab.project_materials.upload_state IS
    'pending — ожидает загрузки; ready — готово; rejected — проверенное несоответствие '
    'формату или размеру; needs_attention — требует вмешательства эксплуатации; '
    'cancelled — отменено автором (M151), запись и объекты сохраняются.';
COMMENT ON COLUMN lab.project_materials.upload_file_name IS
    'Имя файла, заявленное при выдаче формы: для сообщений пользователю (M151).';

-- Неизменность: готовый файл (M147) и отменённая загрузка. Из «отменено» нет
-- перехода ни у кого — иначе поздний файл мог бы стать материалом.
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
    IF OLD.upload_state = 'cancelled' AND (
           NEW.upload_state IS DISTINCT FROM OLD.upload_state
        OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
        OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by
        OR NEW.s3_key IS NOT NULL
        OR NEW.uploaded_at IS NOT NULL) THEN
        RAISE EXCEPTION 'cancelled upload is final: %', OLD.id USING ERRCODE = '23514';
    END IF;
    -- В «отменено» — только из «ожидает».
    IF NEW.upload_state = 'cancelled' AND OLD.upload_state NOT IN ('pending', 'cancelled') THEN
        RAISE EXCEPTION 'only pending upload can be cancelled: %', OLD.id USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

-- Отменяет автор под своим контекстом (app_backend, политика materials_member
-- показывает незавершённую загрузку только её автору и администратору).
GRANT UPDATE (cancelled_at, cancelled_by) ON lab.project_materials TO app_backend;
GRANT INSERT (upload_file_name) ON lab.project_materials TO app_backend;
GRANT SELECT (cancelled_at, cancelled_by, upload_file_name) ON lab.project_materials
    TO app_maintenance;

INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('lab.material.upload_cancelled', 'Загрузка материала отменена автором',
     ARRAY['founder', 'admin'])
ON CONFLICT (verb) DO NOTHING;

-- --- 2. Отметки показа итога -------------------------------------------------

CREATE TABLE comms.operation_notices (
    operation_kind TEXT NOT NULL CHECK (operation_kind IN ('material_upload')),
    operation_id   UUID NOT NULL,
    user_id        UUID NOT NULL REFERENCES identity.users(id),
    shown_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (operation_kind, operation_id, user_id)
);

COMMENT ON TABLE comms.operation_notices IS
    'Итог длительной операции показан пользователю (блок 1, 1.5): после отметки '
    'всплывающее сообщение не повторяется ни на этом, ни на другом устройстве. '
    'Состояние и результат операции остаются в её функции (M151).';

ALTER TABLE comms.operation_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.operation_notices FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON comms.operation_notices TO app_backend;

CREATE POLICY operation_notices_own ON comms.operation_notices
    FOR SELECT TO app_backend
    USING (user_id = app.current_user_id());

CREATE POLICY operation_notices_own_insert ON comms.operation_notices
    FOR INSERT TO app_backend
    WITH CHECK (user_id = app.current_user_id());
