-- M179 — очистка служебных копий завершённых загрузок (работа № 8 раздела 01, 3.3).
--
-- Удаляются ТОЛЬКО служебные копии готового материала не раньше срока (≥ 7 дней) после
-- перехода в «готово»: временный исходник (`upload_key`) и копии попыток, не выбранные итогом
-- (`failed`, `abandoned`, неопубликованная `copied`). Не удаляются никогда: файл материала,
-- копия опубликованной попытки (даже если ключ материала потом сменило восстановление № 6),
-- брошенные/отменённые/отклонённые загрузки, изображения и аватары, резервные копии.
--
-- Окно между проверкой и удалением (условие Тэнка 12.11). Ядро удаляет объект ВНУТРИ
-- транзакции, в которой `lab.upload_cleanup_claim` взяла блокировку строки материала
-- (FOR UPDATE NOWAIT) и проверила условия; отметка `lab.upload_cleanup_done` — той же
-- транзакцией. Все операции, которые могли бы оживить ключ, работают под той же блокировкой
-- или не могут его переиспользовать:
--  * завершение загрузки берёт только «ожидает»; готовый материал в «ожидает» не возвращается
--    (триггер неизменности M147/M151);
--  * ключ попытки содержит её UUID и уникален (`final_key UNIQUE`) — повторно не выдаётся;
--  * временный исходник принадлежит одной записи; форма браузера по нему истекла (проверка),
--    новой формы готовый материал не получает;
--  * восстановление № 6 и учёт утраты № 7 блокируют ту же строку; новый ключ восстановления
--    случаен;
--  * изображения, аватары и контрольные объекты лежат под своими префиксами; ссылка на ключ
--    кандидата из любой записи всё равно проверяется под блокировкой.
--
-- Запрет для расследования (условие Тэнка 12.11): `ops.cleanup_holds` — явная служебная
-- отметка на материал, проект или всю среду, без ITSM. Открытая утрата № 7 и закрытые ворота
-- восстановления тоже запрещают. Любая неопределённость — отложить, не удалять.
--
-- migrate:compat-none: прежний код новые колонки и функции не использует; audit.queue_metrics сохраняет подпись и прежние ключи ответа.

ALTER TABLE lab.project_materials
    ADD COLUMN upload_copy_cleaned_at TIMESTAMPTZ,
    ADD COLUMN upload_copy_cleanup_error TEXT CHECK (length(upload_copy_cleanup_error) <= 500);
ALTER TABLE lab.material_upload_attempts
    ADD COLUMN cleaned_at TIMESTAMPTZ,
    ADD COLUMN cleanup_error TEXT CHECK (length(cleanup_error) <= 500);

COMMENT ON COLUMN lab.project_materials.upload_copy_cleaned_at IS
    'Временный исходник готового материала удалён очисткой служебных копий (3.3, M179).';
COMMENT ON COLUMN lab.material_upload_attempts.cleaned_at IS
    'Копия невыбранной попытки удалена очисткой служебных копий (3.3, M179).';

CREATE TABLE ops.cleanup_holds (
    id          UUID PRIMARY KEY DEFAULT public.uuid_generate_v7(),
    scope       TEXT NOT NULL CHECK (scope IN ('all', 'project', 'material')),
    target_id   UUID,
    reason      TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
    incident    TEXT CHECK (length(incident) <= 200),
    created_by  TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at TIMESTAMPTZ,
    released_by TEXT CHECK (length(released_by) <= 100),
    CHECK ((scope = 'all') = (target_id IS NULL)),
    CHECK ((released_at IS NULL) = (released_by IS NULL))
);
CREATE INDEX cleanup_holds_open ON ops.cleanup_holds (scope, target_id) WHERE released_at IS NULL;
ALTER TABLE ops.cleanup_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.cleanup_holds FORCE ROW LEVEL SECURITY;
-- Ставит и снимает эксплуатация от имени владельца (scripts/file-restore.mjs cleanup-hold).
CREATE POLICY cleanup_holds_owner ON ops.cleanup_holds TO CURRENT_USER USING (true) WITH CHECK (true);
CREATE POLICY cleanup_holds_read ON ops.cleanup_holds FOR SELECT TO app_readonly USING (true);
GRANT SELECT ON ops.cleanup_holds TO app_readonly;
COMMENT ON TABLE ops.cleanup_holds IS
    'Запрет очистки служебных копий для расследования: материал, проект или вся среда (3.3, M179). '
    'Открытая строка — удаление откладывается.';

-- Материалы, у которых может быть что чистить. Окончательная проверка — в claim.
CREATE OR REPLACE FUNCTION lab.upload_cleanup_candidates(p_after INTERVAL, p_limit INTEGER)
RETURNS SETOF UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab, pg_temp
AS $$
BEGIN
    IF p_after < interval '7 days' THEN
        RAISE EXCEPTION 'срок очистки меньше 7 дней: %', p_after USING ERRCODE = '22023';
    END IF;
    RETURN QUERY
    SELECT m.id FROM lab.project_materials m
     WHERE m.upload_state = 'ready' AND m.type <> 'product_link' AND m.s3_key IS NOT NULL
       AND m.upload_state_changed_at <= now() - p_after
       AND ((m.upload_key IS NOT NULL AND m.upload_copy_cleaned_at IS NULL)
            OR EXISTS (SELECT 1 FROM lab.material_upload_attempts a
                        WHERE a.material_id = m.id AND a.cleaned_at IS NULL
                          AND a.state IN ('failed', 'abandoned', 'copied')))
     ORDER BY m.upload_state_changed_at
     LIMIT p_limit;
END $$;

-- Ключ используется какой-либо записью (кроме служебной роли кандидата у своего материала).
CREATE OR REPLACE FUNCTION lab.storage_key_referenced(p_key TEXT, p_material UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab, identity, audit, ops, pg_temp
AS $$
    SELECT EXISTS (SELECT 1 FROM lab.project_materials WHERE s3_key = p_key)
        OR EXISTS (SELECT 1 FROM lab.project_materials WHERE upload_key = p_key AND id <> p_material)
        OR EXISTS (SELECT 1 FROM lab.material_upload_attempts
                    WHERE final_key = p_key AND state = 'published')
        OR EXISTS (SELECT 1 FROM lab.project_media
                    WHERE master_key = p_key OR p_key = ANY (ops.variant_keys(variants)))
        OR EXISTS (SELECT 1 FROM identity.user_avatars
                    WHERE master_key = p_key OR p_key = ANY (ops.variant_keys(variants)))
        OR EXISTS (SELECT 1 FROM audit.control_objects WHERE s3_key = p_key)
$$;

-- Взять материал для очистки: блокировка строки до конца транзакции вызывающего, проверка
-- условий. Строки результата:
--   defer_reason IS NOT NULL — отложить весь материал (ключей нет);
--   иначе — разрешённые к удалению ключи: target 'upload' (ref = материал) или 'attempt'.
CREATE OR REPLACE FUNCTION lab.upload_cleanup_claim(p_material UUID, p_after INTERVAL)
RETURNS TABLE (target TEXT, ref UUID, object_key TEXT, defer_reason TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, lab, ops, pg_temp
AS $$
DECLARE
    m RECORD;
BEGIN
    IF p_after < interval '7 days' THEN
        RAISE EXCEPTION 'срок очистки меньше 7 дней: %', p_after USING ERRCODE = '22023';
    END IF;
    BEGIN
        SELECT * INTO m FROM lab.project_materials WHERE id = p_material FOR UPDATE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
        RETURN QUERY SELECT NULL::text, p_material, NULL::text, 'запись занята'::text; RETURN;
    END;
    IF NOT FOUND THEN
        RETURN QUERY SELECT NULL::text, p_material, NULL::text, 'записи нет'::text; RETURN;
    END IF;
    IF ops.restore_gate_state() <> 'open' THEN
        RETURN QUERY SELECT NULL::text, p_material, NULL::text, 'ворота восстановления закрыты'::text;
        RETURN;
    END IF;
    IF m.upload_state <> 'ready' OR m.s3_key IS NULL OR m.type = 'product_link' THEN
        RETURN QUERY SELECT NULL::text, p_material, NULL::text, 'материал не готов'::text; RETURN;
    END IF;
    IF m.upload_state_changed_at > now() - p_after THEN
        RETURN QUERY SELECT NULL::text, p_material, NULL::text, 'срок не прошёл'::text; RETURN;
    END IF;
    IF m.lease_until IS NOT NULL AND m.lease_until >= now() THEN
        RETURN QUERY SELECT NULL::text, p_material, NULL::text, 'аренда записи действует'::text;
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM lab.material_upload_attempts
                WHERE material_id = p_material AND state = 'copying') THEN
        RETURN QUERY SELECT NULL::text, p_material, NULL::text,
            'активная попытка: результат копирования неизвестен'::text;
        RETURN;
    END IF;
    IF m.upload_expires_at IS NOT NULL AND m.upload_expires_at >= now() THEN
        RETURN QUERY SELECT NULL::text, p_material, NULL::text,
            'разрешение передачи не истекло'::text;
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM ops.lost_files
                WHERE kind = 'material' AND record_id = p_material AND resolved_at IS NULL) THEN
        RETURN QUERY SELECT NULL::text, p_material, NULL::text, 'открыта утрата файла'::text;
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM ops.cleanup_holds h
                WHERE h.released_at IS NULL
                  AND (h.scope = 'all'
                       OR (h.scope = 'project' AND h.target_id = m.project_id)
                       OR (h.scope = 'material' AND h.target_id = p_material))) THEN
        RETURN QUERY SELECT NULL::text, p_material, NULL::text, 'запрет очистки'::text; RETURN;
    END IF;

    IF m.upload_key IS NOT NULL AND m.upload_copy_cleaned_at IS NULL
       AND NOT lab.storage_key_referenced(m.upload_key, p_material) THEN
        RETURN QUERY SELECT 'upload'::text, p_material, m.upload_key, NULL::text;
    END IF;
    RETURN QUERY
    SELECT 'attempt'::text, a.id, a.final_key, NULL::text
      FROM lab.material_upload_attempts a
     WHERE a.material_id = p_material AND a.cleaned_at IS NULL
       AND a.state IN ('failed', 'abandoned', 'copied')
       AND NOT lab.storage_key_referenced(a.final_key, p_material)
     ORDER BY a.created_at;
END $$;

-- Отметить итог удаления; строка материала должна быть заблокирована этой же транзакцией
-- (claim). p_results: [{"target":"upload"|"attempt","ref":uuid,"ok":bool,"error":text}].
CREATE OR REPLACE FUNCTION lab.upload_cleanup_done(p_material UUID, p_results JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, lab, pg_temp
AS $$
DECLARE
    r   JSONB;
    v_n INTEGER := 0;
BEGIN
    -- Та же транзакция, что claim: повторная блокировка своей строки мгновенна, чужой — отказ.
    PERFORM 1 FROM lab.project_materials WHERE id = p_material FOR UPDATE NOWAIT;
    FOR r IN SELECT * FROM jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) LOOP
        IF r ->> 'target' = 'upload' THEN
            UPDATE lab.project_materials
               SET upload_copy_cleaned_at = CASE WHEN (r ->> 'ok')::boolean THEN now() END,
                   upload_copy_cleanup_error = CASE WHEN (r ->> 'ok')::boolean THEN NULL
                                                    ELSE left(r ->> 'error', 500) END
             WHERE id = p_material AND upload_copy_cleaned_at IS NULL;
        ELSIF r ->> 'target' = 'attempt' THEN
            UPDATE lab.material_upload_attempts
               SET cleaned_at = CASE WHEN (r ->> 'ok')::boolean THEN now() END,
                   cleanup_error = CASE WHEN (r ->> 'ok')::boolean THEN NULL
                                        ELSE left(r ->> 'error', 500) END,
                   updated_at = now()
             WHERE id = (r ->> 'ref')::uuid AND material_id = p_material AND cleaned_at IS NULL
               AND state IN ('failed', 'abandoned', 'copied');
        END IF;
        IF (r ->> 'ok')::boolean THEN v_n := v_n + 1; END IF;
    END LOOP;
    RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION lab.upload_cleanup_candidates(INTERVAL, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION lab.storage_key_referenced(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION lab.upload_cleanup_claim(UUID, INTERVAL) FROM PUBLIC;
REVOKE ALL ON FUNCTION lab.upload_cleanup_done(UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.upload_cleanup_candidates(INTERVAL, INTEGER) TO app_maintenance;
GRANT EXECUTE ON FUNCTION lab.upload_cleanup_claim(UUID, INTERVAL) TO app_maintenance;
GRANT EXECUTE ON FUNCTION lab.upload_cleanup_done(UUID, JSONB) TO app_maintenance;

-- Путь поиска функции восстановления (M177/M178) — без public: функции public ей не нужны,
-- а SECURITY DEFINER с public в пути — лишняя поверхность (scripts/check-definer-privileges.mjs).
ALTER FUNCTION lab.restore_material_file(UUID, TEXT, TEXT, TEXT, BIGINT, JSONB, JSONB, TEXT)
    SET search_path = pg_catalog, lab, audit, ops, pg_temp;

-- Сигнал: ошибки очистки и действующие запреты. Прежние ключи — без изменений (M178).
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
             WHERE upload_state IN ('pending', 'needs_attention'))
          || jsonb_build_object(
                'cleanupFailed',
                (SELECT count(*) FROM lab.project_materials
                  WHERE upload_copy_cleanup_error IS NOT NULL AND upload_copy_cleaned_at IS NULL)
              + (SELECT count(*) FROM lab.material_upload_attempts
                  WHERE cleanup_error IS NOT NULL AND cleaned_at IS NULL),
                'cleanupHolds',
                (SELECT count(*) FROM ops.cleanup_holds WHERE released_at IS NULL)),
        'files', (
            SELECT jsonb_build_object(
                'lost', count(*),
                'lostOldestAgeSec', coalesce(extract(epoch FROM now() - min(first_seen))::bigint, 0))
              FROM ops.lost_files
             WHERE resolved_at IS NULL)
    )
$$;
