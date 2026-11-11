-- M180 — протокол запрета очистки служебных копий (работа № 8, замечание Тэнка 12.11).
--
-- В M179 запрет был просто строкой: команда могла подтвердить запрет, пока уже начатый проход
-- очистки продолжал удалять выбранные копии. Теперь общий протокол на одной блокировке
-- (advisory, ключ `lab.upload_cleanup`):
--  * взятие материала очисткой (`lab.upload_cleanup_claim`) сначала берёт её РАЗДЕЛЯЕМО до
--    конца своей транзакции — той, внутри которой идут удаления и отметка, — и только ПОСЛЕ
--    этого читает запреты;
--  * постановка запрета (`ops.cleanup_hold_set`) вставляет строку и в той же транзакции берёт
--    блокировку ИСКЛЮЧИТЕЛЬНО: ждёт завершения всех начатых очисток. Подтверждение (фиксация)
--    приходит только после этого, а любое взятие после него видит запрет.
--  * не дождалась за отведённое время — транзакция откатывается, запрета нет, команда прямо
--    говорит «не установлен: идёт очистка» (подтверждения без гарантии не бывает).
--
-- migrate:compat-none: прежний код новые функции не вызывает; claim сохраняет подпись и ответ, добавлена только блокировка перед чтением запретов.

CREATE OR REPLACE FUNCTION ops.cleanup_hold_set(
    p_scope    TEXT,
    p_target   UUID,
    p_reason   TEXT,
    p_incident TEXT,
    p_by       TEXT,
    p_wait     INTERVAL DEFAULT interval '60 seconds'
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops, pg_temp
AS $$
DECLARE
    v_id UUID;
BEGIN
    INSERT INTO ops.cleanup_holds (scope, target_id, reason, incident, created_by)
    VALUES (p_scope, p_target, p_reason, NULLIF(p_incident, ''), p_by)
    RETURNING id INTO v_id;
    PERFORM set_config('lock_timeout', (extract(epoch FROM p_wait) * 1000)::bigint::text, true);
    -- Ждать начатые очистки; таймаут — ошибка 55P03, транзакция (и строка запрета) откатывается.
    PERFORM pg_advisory_xact_lock(hashtext('lab.upload_cleanup'));
    PERFORM set_config('lock_timeout', '0', true);
    RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION ops.cleanup_hold_set(TEXT, UUID, TEXT, TEXT, TEXT, INTERVAL) FROM PUBLIC;
COMMENT ON FUNCTION ops.cleanup_hold_set(TEXT, UUID, TEXT, TEXT, TEXT, INTERVAL) IS
    'Поставить запрет очистки служебных копий с гарантией: возвращается только после завершения '
    'начатых очисток (M180). Только владелец таблиц.';

-- claim: блокировка протокола до чтения запретов. Остальное — как в M179.
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
    -- Протокол запрета: раздельно, до конца транзакции вызывающего (удаления и отметка — в ней).
    -- Идёт постановка запрета — ждать её, затем читать запреты уже с ней.
    PERFORM pg_advisory_xact_lock_shared(hashtext('lab.upload_cleanup'));
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
