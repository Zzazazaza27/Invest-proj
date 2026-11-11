-- M177 — восстановление одного файла готового материала (работа № 6 раздела 01, 2.1.3).
--
-- Готовый материал неизменяем (M147, M151): ключ, размер, хеш, тип и время готовности не
-- меняет никто. Восстановление утраченного файла из проверенной копии требует ровно одного
-- исключения: ключ переключается на новый объект С ТЕМ ЖЕ содержимым. Поэтому:
--  * размер, хеш (`sha256:…`), тип, время готовности, состояние — по-прежнему неизменны:
--    восстановленный файл обязан совпасть с записью, иначе это не восстановление;
--  * ключ меняется только внутри `lab.restore_material_file` — функции владельца таблиц,
--    EXECUTE которой не выдан никому (ни PUBLIC, ни ролям приложения);
--  * триггер пропускает смену ключа, только если одновременно: транзакционная отметка
--    названа ИМЕННО этой записью И изменение выполняет владелец таблицы (функция — SECURITY
--    DEFINER владельца). Роль приложения может выставить отметку сама, но владельцем таблицы
--    она не станет — отметка одна ничего не открывает;
--  * событие `material.file_restored` пишется той же транзакцией через audit.app_emit_event
--    (hash-chain): автор — операция эксплуатации (система) с оператором, основанием и
--    ссылкой на инцидент; владельцу материала действие не приписывается.
-- Запись не создаётся, состояние, права и видимость не меняются: отсутствующая запись,
-- удалённый проект или неготовый материал — отказ.

INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('material.file_restored',
     'Файл готового материала восстановлен из проверенной копии под новым ключом '
     '(эксплуатация, работа № 6 раздела 01, M177)',
     ARRAY['system'])
ON CONFLICT (verb) DO NOTHING;

-- Прежняя проверка M151 целиком; добавлено только узкое исключение для ключа.
CREATE OR REPLACE FUNCTION lab.forbid_ready_material_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, lab, public
AS $$
DECLARE
    v_restore BOOLEAN := false;
BEGIN
    IF OLD.upload_state = 'ready'
       AND NEW.s3_key IS DISTINCT FROM OLD.s3_key
       AND NEW.s3_key IS NOT NULL
       AND current_setting('lab.file_restore', true) = OLD.id::text
       AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c
                            WHERE c.oid = TG_RELID) THEN
        v_restore := true;
    END IF;
    IF OLD.upload_state = 'ready' AND (
           NEW.upload_state IS DISTINCT FROM OLD.upload_state
        OR (NEW.s3_key IS DISTINCT FROM OLD.s3_key AND NOT v_restore)
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

-- Переключение ключа. Все условия проверяются здесь, под блокировкой строки, в одной
-- транзакции с событием журнала. Исходы:
--   restored    — ключ переключён ровно в одной записи, событие записано;
--   already     — ключ уже новый (повтор): ничего не меняется, события нет;
--   no_record / no_project / not_ready / not_file — отказ, ничего не меняется;
--   key_changed — запись изменилась с начала восстановления: связь не переключается;
--   hash_mismatch / size_mismatch — восстановленный файл не совпадает с записью.
CREATE OR REPLACE FUNCTION lab.restore_material_file(
    p_material_id UUID,
    p_old_key     TEXT,
    p_new_key     TEXT,
    p_sha256      TEXT,
    p_size        BIGINT,
    p_actor       JSONB,
    p_context     JSONB,
    p_trace_id    TEXT
) RETURNS TABLE (outcome TEXT, event_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, lab, audit, public, pg_temp
AS $$
DECLARE
    m       RECORD;
    v_n     INTEGER;
    v_event UUID;
BEGIN
    IF p_new_key IS NULL OR p_new_key = '' OR p_new_key = p_old_key THEN
        RAISE EXCEPTION 'новый ключ не задан или совпадает с прежним' USING ERRCODE = '22023';
    END IF;
    SELECT pm.id, pm.type, pm.upload_state, pm.s3_key, pm.size_bytes, pm.content_hash,
           pm.project_id, p.id AS project_exists, p.deleted_at
      INTO m
      FROM lab.project_materials pm
      LEFT JOIN lab.projects p ON p.id = pm.project_id
     WHERE pm.id = p_material_id
       FOR UPDATE OF pm;
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'no_record'::text, NULL::uuid; RETURN;
    END IF;
    IF m.project_exists IS NULL OR m.deleted_at IS NOT NULL THEN
        RETURN QUERY SELECT 'no_project'::text, NULL::uuid; RETURN;
    END IF;
    IF m.type = 'product_link' THEN
        RETURN QUERY SELECT 'not_file'::text, NULL::uuid; RETURN;
    END IF;
    IF m.upload_state <> 'ready' THEN
        RETURN QUERY SELECT 'not_ready'::text, NULL::uuid; RETURN;
    END IF;
    IF m.s3_key = p_new_key THEN
        RETURN QUERY SELECT 'already'::text, NULL::uuid; RETURN;
    END IF;
    IF m.s3_key IS DISTINCT FROM p_old_key THEN
        RETURN QUERY SELECT 'key_changed'::text, NULL::uuid; RETURN;
    END IF;
    IF m.content_hash IS DISTINCT FROM ('sha256:' || p_sha256) THEN
        RETURN QUERY SELECT 'hash_mismatch'::text, NULL::uuid; RETURN;
    END IF;
    IF m.size_bytes IS DISTINCT FROM p_size THEN
        RETURN QUERY SELECT 'size_mismatch'::text, NULL::uuid; RETURN;
    END IF;

    PERFORM set_config('lab.file_restore', p_material_id::text, true);
    UPDATE lab.project_materials
       SET s3_key = p_new_key
     WHERE id = p_material_id AND s3_key = p_old_key AND upload_state = 'ready';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    PERFORM set_config('lab.file_restore', '', true);
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'восстановление: изменено записей %, ожидалась одна', v_n
            USING ERRCODE = '40001';
    END IF;

    v_event := audit.app_emit_event(
        'material.file_restored', NULL, 'system', 'project_material', p_material_id,
        coalesce(p_context, '{}'::jsonb)
          || jsonb_build_object('projectId', m.project_id, 'oldKey', p_old_key,
                                'newKey', p_new_key, 'sha256', p_sha256, 'sizeBytes', p_size,
                                'actor', p_actor),
        p_trace_id);
    RETURN QUERY SELECT 'restored'::text, v_event;
END $$;

REVOKE ALL ON FUNCTION lab.restore_material_file(UUID, TEXT, TEXT, TEXT, BIGINT, JSONB, JSONB, TEXT)
    FROM PUBLIC;

COMMENT ON FUNCTION lab.restore_material_file(UUID, TEXT, TEXT, TEXT, BIGINT, JSONB, JSONB, TEXT) IS
    'Переключить ключ готового материала на восстановленный объект с тем же содержимым '
    '(работа № 6, M177). Только владелец таблиц: EXECUTE не выдан никому.';
