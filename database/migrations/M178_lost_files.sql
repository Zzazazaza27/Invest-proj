-- M178 — учёт утраты готового файла и сигнал эксплуатации (работа № 7 раздела 01, 3.2).
--
-- Запись файла видна и готова, а объекта в хранилище нет. Раньше ядро отвечало «не найдено»
-- (материал — молча, изображение и аватар — строкой журнала). Теперь — техническая ошибка
-- для пользователя и строка учёта, которую видит наблюдение (`/queues` → Zabbix).
--
-- Жизненный цикл строки утраты (условия Тэнка 11.11):
--  * открывается ТОЛЬКО на ключ, на который запись ссылается СЕЙЧАС: проверка под блокировкой
--    строки записи (FOR SHARE). Запоздавший результат чтения старого ключа после
--    восстановления или замены застаёт новый ключ — утрата не открывается заново («stale»);
--  * повторы объединяются: одна открытая строка на ключ, счётчик и время последнего случая;
--  * закрывается конкретный прежний ключ, строка остаётся (история):
--      restored — материал восстановлен (работа № 6, lab.restore_material_file);
--      replaced — изображение или аватар заменены (ключ варианта сменился), либо ключ
--                 материала сменился иначе;
--      removed  — запись удалена (изображение, аватар, материал) — это не «восстановлено».
--  * недоступность хранилища утратой не считается: ядро зовёт функцию только на ответ 404
--    по ключу, который запись указывает как готовый.
--
-- Права. Таблица закрыта для ролей приложения. Открыть утрату можно только функцией
-- ops.report_lost_file (EXECUTE — app_maintenance: ядро зовёт её служебной ролью, без
-- пользовательского контекста и режима просмотра). Закрывают триггеры записей и функция
-- восстановления — от имени владельца.
--
-- migrate:compat-none: прежний код новую функцию не вызывает и новых полей не читает; lab.restore_material_file и audit.queue_metrics сохраняют подпись и прежние ключи ответа, триггеры только пишут в новую таблицу.

CREATE TABLE ops.lost_files (
    id           UUID PRIMARY KEY DEFAULT public.uuid_generate_v7(),
    kind         TEXT NOT NULL CHECK (kind IN ('material', 'project_media', 'avatar')),
    -- material — материал, project_media — проект, avatar — учётная запись.
    record_id    UUID NOT NULL,
    object_key   TEXT NOT NULL CHECK (length(object_key) BETWEEN 1 AND 1024),
    first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
    hits         INTEGER NOT NULL DEFAULT 1 CHECK (hits >= 1),
    resolved_at  TIMESTAMPTZ,
    resolution   TEXT CHECK (resolution IN ('restored', 'replaced', 'removed')),
    CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);
CREATE UNIQUE INDEX lost_files_open_key ON ops.lost_files (object_key) WHERE resolved_at IS NULL;
CREATE INDEX lost_files_record ON ops.lost_files (kind, record_id);

ALTER TABLE ops.lost_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.lost_files FORCE ROW LEVEL SECURITY;
-- Пишут только функции владельца (SECURITY DEFINER): политика — владельцу таблиц, роли
-- приложения строк не видят и не пишут.
CREATE POLICY lost_files_owner ON ops.lost_files TO CURRENT_USER USING (true) WITH CHECK (true);
CREATE POLICY lost_files_read ON ops.lost_files FOR SELECT TO app_readonly USING (true);
GRANT SELECT ON ops.lost_files TO app_readonly;

COMMENT ON TABLE ops.lost_files IS
    'Утрата готового файла: запись ссылается на ключ, объекта нет (3.2, работа № 7, M178). '
    'Открытая строка — сигнал эксплуатации; закрытая — история (restored/replaced/removed).';

-- Закрыть открытые утраты указанных ключей. Внутренняя: вызывают триггеры и восстановление.
CREATE OR REPLACE FUNCTION ops.resolve_lost_files(p_keys TEXT[], p_resolution TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops, pg_temp
AS $$
DECLARE
    v_n INTEGER;
BEGIN
    IF p_keys IS NULL OR cardinality(p_keys) = 0 THEN
        RETURN 0;
    END IF;
    UPDATE ops.lost_files
       SET resolved_at = now(), resolution = p_resolution
     WHERE resolved_at IS NULL AND object_key = ANY (p_keys);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION ops.resolve_lost_files(TEXT[], TEXT) FROM PUBLIC;

-- Ключи вариантов изображения или аватара.
CREATE OR REPLACE FUNCTION ops.variant_keys(p_variants JSONB)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT coalesce(array_agg(v ->> 'key') FILTER (WHERE v ->> 'key' IS NOT NULL), '{}')
      FROM jsonb_each(coalesce(p_variants, '{}'::jsonb)) AS e(k, v)
$$;

-- Открыть утрату (или учесть повтор). Исходы:
--   opened   — новая открытая строка;
--   repeated — открытая строка этого ключа уже есть: счётчик и время;
--   stale    — запись на этот ключ больше не ссылается (восстановлена, заменена, удалена):
--              ничего не открывается.
CREATE OR REPLACE FUNCTION ops.report_lost_file(p_kind TEXT, p_record_id UUID, p_key TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops, lab, identity, pg_temp
AS $$
DECLARE
    v_current BOOLEAN;
    v_n       INTEGER;
BEGIN
    -- Ссылка проверяется под блокировкой строки записи: восстановление и замена держат
    -- FOR UPDATE, поэтому запоздавшее чтение ждёт их завершения и видит новый ключ.
    IF p_kind = 'material' THEN
        SELECT true INTO v_current FROM lab.project_materials
         WHERE id = p_record_id AND s3_key = p_key AND upload_state = 'ready'
           FOR SHARE;
    ELSIF p_kind = 'project_media' THEN
        SELECT true INTO v_current FROM lab.project_media
         WHERE project_id = p_record_id AND p_key = ANY (ops.variant_keys(variants))
           FOR SHARE;
    ELSIF p_kind = 'avatar' THEN
        SELECT true INTO v_current FROM identity.user_avatars
         WHERE user_id = p_record_id AND p_key = ANY (ops.variant_keys(variants))
           FOR SHARE;
    ELSE
        RAISE EXCEPTION 'неизвестный вид файла %', p_kind USING ERRCODE = '22023';
    END IF;
    IF v_current IS NOT TRUE THEN
        RETURN 'stale';
    END IF;

    UPDATE ops.lost_files
       SET last_seen = now(), hits = hits + 1
     WHERE object_key = p_key AND resolved_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
        RETURN 'repeated';
    END IF;
    INSERT INTO ops.lost_files (kind, record_id, object_key)
    VALUES (p_kind, p_record_id, p_key)
    ON CONFLICT (object_key) WHERE resolved_at IS NULL
    DO UPDATE SET last_seen = now(), hits = ops.lost_files.hits + 1;
    RETURN 'opened';
END $$;
REVOKE ALL ON FUNCTION ops.report_lost_file(TEXT, UUID, TEXT) FROM PUBLIC;
GRANT USAGE ON SCHEMA ops TO app_maintenance;
GRANT EXECUTE ON FUNCTION ops.report_lost_file(TEXT, UUID, TEXT) TO app_maintenance;

-- Закрытие при смене или удалении записи. Триггеры — от имени владельца (SECURITY DEFINER):
-- роли приложения в таблицу утрат не пишут.
CREATE OR REPLACE FUNCTION ops.lost_files_on_variants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM ops.resolve_lost_files(ops.variant_keys(OLD.variants), 'removed');
        RETURN OLD;
    END IF;
    PERFORM ops.resolve_lost_files(
        ARRAY(SELECT unnest(ops.variant_keys(OLD.variants))
              EXCEPT SELECT unnest(ops.variant_keys(NEW.variants))),
        'replaced');
    RETURN NEW;
END $$;

CREATE TRIGGER project_media_lost_files
    AFTER UPDATE OF variants OR DELETE ON lab.project_media
    FOR EACH ROW EXECUTE FUNCTION ops.lost_files_on_variants();
CREATE TRIGGER user_avatars_lost_files
    AFTER UPDATE OF variants OR DELETE ON identity.user_avatars
    FOR EACH ROW EXECUTE FUNCTION ops.lost_files_on_variants();

CREATE OR REPLACE FUNCTION ops.lost_files_on_material()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.s3_key IS NOT NULL THEN
            PERFORM ops.resolve_lost_files(ARRAY[OLD.s3_key], 'removed');
        END IF;
        RETURN OLD;
    END IF;
    -- Восстановление закрывает свой ключ само («restored») до смены ключа; здесь — иные смены.
    IF OLD.s3_key IS NOT NULL AND NEW.s3_key IS DISTINCT FROM OLD.s3_key THEN
        PERFORM ops.resolve_lost_files(ARRAY[OLD.s3_key], 'replaced');
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER project_materials_lost_files
    AFTER UPDATE OF s3_key OR DELETE ON lab.project_materials
    FOR EACH ROW EXECUTE FUNCTION ops.lost_files_on_material();

-- Восстановление № 6 закрывает утрату прежнего ключа как «restored» — той же транзакцией.
-- Тело M177 без изменений, кроме вызова закрытия перед сменой ключа.
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
    v_lost  INTEGER;
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

    v_lost := ops.resolve_lost_files(ARRAY[p_old_key], 'restored');
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
                                'lostFilesResolved', v_lost, 'actor', p_actor),
        p_trace_id);
    RETURN QUERY SELECT 'restored'::text, v_event;
END $$;
REVOKE ALL ON FUNCTION lab.restore_material_file(UUID, TEXT, TEXT, TEXT, BIGINT, JSONB, JSONB, TEXT)
    FROM PUBLIC;

-- Сигнал: открытые утраты в ответе служебного порта. Прежние ключи — без изменений (M176).
CREATE OR REPLACE FUNCTION audit.queue_metrics()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, audit, lab, ops, pg_temp
AS $$
    SELECT jsonb_build_object(
        'outbox', (
            SELECT jsonb_build_object(
                'pending', count(*) FILTER (WHERE attempts < 10),
                'oldestAgeSec', coalesce(extract(epoch FROM now() - min(created_at)
                    FILTER (WHERE attempts < 10))::bigint, 0),
                'exhausted', count(*) FILTER (WHERE attempts >= 10),
                'exhaustedOldestAgeSec', coalesce(extract(epoch FROM now() - min(created_at)
                    FILTER (WHERE attempts >= 10))::bigint, 0),
                'withError', count(*) FILTER (WHERE last_error IS NOT NULL))
              FROM audit.outbox_events
             WHERE published_at IS NULL),
        'uploads', (
            SELECT jsonb_build_object(
                'pending', count(*) FILTER (WHERE upload_state = 'pending'),
                'oldestPendingAgeSec', coalesce(extract(epoch FROM now() - min(created_at)
                    FILTER (WHERE upload_state = 'pending'))::bigint, 0),
                'needsAttention', count(*) FILTER (WHERE upload_state = 'needs_attention'))
              FROM lab.project_materials
             WHERE upload_state IN ('pending', 'needs_attention')),
        'files', (
            SELECT jsonb_build_object(
                'lost', count(*),
                'lostOldestAgeSec', coalesce(extract(epoch FROM now() - min(first_seen))::bigint, 0))
              FROM ops.lost_files
             WHERE resolved_at IS NULL)
    )
$$;

COMMENT ON FUNCTION audit.queue_metrics() IS
    'Размер и возраст очередей outbox и загрузок для служебного порта ядра (/queues), '
    'без идентификаторов и содержимого (блок 8, 8.3; M152). Outbox: рабочая очередь '
    '(attempts < 10) отдельно от исчерпавших попытки (M176). files.lost — открытые утраты '
    'готовых файлов (M178).';
