-- =============================================================================
-- M053 — реестр выгрузок: append-функция вместо прямого INSERT
--        + range-verifier hash-chain с seed предшественника
--
-- Закрывает две находки внешнего аудита 2026-08-13.
--
-- CODE-HIGH-10 / SEC-HIGH-05: у app_archive был прямой INSERT в
-- audit.event_archives с политикой WITH CHECK (true), а скрипт выгрузки
-- определяет начало следующего диапазона через max(period_end). Кража
-- archive-кредов позволяла вставить синтаксически валидную строку с БУДУЩЕЙ
-- границей — и все последующие выгрузки молча пропускали бы события.
-- Теперь вставка возможна только через audit.append_event_archive(), которая
-- проверяет НЕПРЕРЫВНОСТЬ (period_start = текущий max(period_end)), запрещает
-- границу в будущем, сверяет заявленные count/first/last с фактическим
-- журналом и требует допустимый префикс ключа объекта. Механизм тот же, что
-- у audit.events (M001): транзакционный флаг + политика, GRANT INSERT ни у
-- кого — два замка сразу не обойти.
--
-- CODE-MED-06 / SEC-HIGH-04: verify_event_chain(p_from) выбирает ts >= p_from,
-- не имеет верхней границы и НЕ проверяет prev_hash первой выбранной строки —
-- связь первого нового события с последним заархивированным не проверялась
-- вовсе, а события новее границы влияли на результат текущей выгрузки.
-- verify_event_chain_range() получает id предшественника, сеет цепочку его
-- row_hash и проверяет диапазон (predecessor, p_to] со строгой первой связью.
-- =============================================================================

-- ------------------------------------------------------- прямой INSERT закрыт
REVOKE INSERT ON audit.event_archives FROM app_archive;
DROP POLICY IF EXISTS event_archives_archive_insert ON audit.event_archives;

-- Вставка — только изнутри append-функции (флаг транзакции, как у журнала).
CREATE POLICY event_archives_insert_via_append ON audit.event_archives FOR INSERT
    WITH CHECK (coalesce(current_setting('app.archive_append_context', true), '') = 'on');

-- ------------------------------------------------------------- append-функция
CREATE OR REPLACE FUNCTION audit.append_event_archive(
    p_period_start   TIMESTAMPTZ,
    p_period_end     TIMESTAMPTZ,
    p_object_key     TEXT,
    p_event_count    BIGINT,
    p_sha256         TEXT,
    p_first_event_id UUID,
    p_last_event_id  UUID,
    p_chain_intact   BOOLEAN
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, audit, pg_temp
AS $$
DECLARE
    v_expected_start TIMESTAMPTZ;
    v_count          BIGINT;
    v_first          UUID;
    v_last           UUID;
    v_id             UUID;
BEGIN
    -- Конкурентные выгрузки сериализуются: две «непрерывные» записи
    -- одновременно — это одна непрерывная и одна ложная.
    PERFORM pg_advisory_xact_lock(hashtextextended('audit.event_archives:append', 0));

    SELECT coalesce(max(period_end), to_timestamp(0))
      INTO v_expected_start
      FROM audit.event_archives;
    IF p_period_start IS DISTINCT FROM v_expected_start THEN
        RAISE EXCEPTION 'реестр выгрузок непрерывен: period_start обязан равняться max(period_end) = %, получено %',
            v_expected_start, p_period_start;
    END IF;
    IF p_period_end <= p_period_start THEN
        RAISE EXCEPTION 'пустой или отрицательный диапазон: (%, %]', p_period_start, p_period_end;
    END IF;
    -- Граница в будущем — ровно тот вектор отравления, ради которого функция
    -- существует: последующие выгрузки начали бы «после будущего» и пропускали
    -- бы настоящие события.
    IF p_period_end > now() THEN
        RAISE EXCEPTION 'граница выгрузки в будущем запрещена: % > now()', p_period_end;
    END IF;
    IF p_object_key NOT LIKE 'archive/audit-events/%' THEN
        RAISE EXCEPTION 'ключ объекта вне допустимого префикса archive/audit-events/: %', p_object_key;
    END IF;

    -- Заявленное сверяется с фактическим журналом, а не записывается на веру.
    SELECT count(*) INTO v_count
      FROM audit.events WHERE ts > p_period_start AND ts <= p_period_end;
    IF v_count = 0 THEN
        RAISE EXCEPTION 'в диапазоне (%, %] нет событий — пустая запись реестра запрещена',
            p_period_start, p_period_end;
    END IF;
    SELECT id INTO v_first FROM audit.events
     WHERE ts > p_period_start AND ts <= p_period_end
     ORDER BY ts ASC, id ASC LIMIT 1;
    SELECT id INTO v_last FROM audit.events
     WHERE ts > p_period_start AND ts <= p_period_end
     ORDER BY ts DESC, id DESC LIMIT 1;
    IF p_event_count IS DISTINCT FROM v_count
       OR p_first_event_id IS DISTINCT FROM v_first
       OR p_last_event_id IS DISTINCT FROM v_last THEN
        RAISE EXCEPTION 'заявленные метаданные не совпадают с журналом: count % (факт %), first % (факт %), last % (факт %)',
            p_event_count, v_count, p_first_event_id, v_first, p_last_event_id, v_last;
    END IF;

    PERFORM set_config('app.archive_append_context', 'on', true);
    INSERT INTO audit.event_archives
        (period_start, period_end, object_key, event_count, sha256,
         first_event_id, last_event_id, chain_intact)
    VALUES (p_period_start, p_period_end, p_object_key, p_event_count, p_sha256,
            p_first_event_id, p_last_event_id, p_chain_intact)
    RETURNING id INTO v_id;
    PERFORM set_config('app.archive_append_context', '', true);
    RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION audit.append_event_archive(
    TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BIGINT, TEXT, UUID, UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.append_event_archive(
    TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BIGINT, TEXT, UUID, UUID, BOOLEAN) TO app_archive;

COMMENT ON FUNCTION audit.append_event_archive(
    TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BIGINT, TEXT, UUID, UUID, BOOLEAN) IS
    'Единственный путь записи в реестр выгрузок: непрерывность диапазонов, '
    'запрет будущей границы, сверка count/first/last с журналом, префикс ключа.';

-- ------------------------------------------------------------- range-verifier
CREATE OR REPLACE FUNCTION audit.verify_event_chain_range(
    p_predecessor_id UUID,
    p_to             TIMESTAMPTZ
) RETURNS TABLE (broken_event_id UUID, broken_at TIMESTAMPTZ, reason TEXT)
LANGUAGE plpgsql
STABLE
-- public нужен ради digest() из pgcrypto (как у verify_event_chain, M045);
-- pg_temp — последним.
SET search_path = pg_catalog, audit, public, pg_temp
AS $$
DECLARE
    r        RECORD;
    v_pred   RECORD;
    v_prev   BYTEA := NULL;
    v_first  BOOLEAN := true;
    v_from_ts TIMESTAMPTZ := NULL;
    v_from_id UUID := NULL;
    v_expect BYTEA;
BEGIN
    IF p_predecessor_id IS NOT NULL THEN
        SELECT id, ts, row_hash INTO v_pred FROM audit.events WHERE id = p_predecessor_id;
        IF v_pred.id IS NULL THEN
            broken_event_id := p_predecessor_id; broken_at := NULL;
            reason := 'predecessor not found';
            RETURN NEXT;
            RETURN;
        END IF;
        v_prev := v_pred.row_hash;
        v_from_ts := v_pred.ts;
        v_from_id := v_pred.id;
        -- Первая связь проверяется СТРОГО: prev_hash первой строки диапазона
        -- обязан равняться row_hash предшественника.
        v_first := false;
    END IF;

    FOR r IN
        SELECT * FROM audit.events
        WHERE ts <= p_to
          AND (v_from_id IS NULL OR (ts, id) > (v_from_ts, v_from_id))
        ORDER BY ts ASC, id ASC
    LOOP
        IF v_first THEN
            -- Начало журнала: у генезис-строки предшественника нет.
            IF r.prev_hash IS NOT NULL THEN
                broken_event_id := r.id; broken_at := r.ts;
                reason := 'genesis prev_hash not null';
                RETURN NEXT;
            END IF;
        ELSIF r.prev_hash IS DISTINCT FROM v_prev THEN
            broken_event_id := r.id; broken_at := r.ts; reason := 'prev_hash mismatch';
            RETURN NEXT;
        END IF;
        v_expect := digest(convert_to(concat(
            encode(coalesce(r.prev_hash, '\x00'::bytea), 'hex'), '|', r.id, '|', r.ts, '|', r.verb, '|',
            coalesce(r.actor_id::text, ''), '|', coalesce(r.actor_role, ''), '|',
            coalesce(r.subject_type, ''), '|', coalesce(r.subject_id::text, ''), '|',
            coalesce(r.context_jsonb, '{}'::jsonb)::text, '|', coalesce(r.trace_id, '')
        ), 'UTF8'), 'sha256');
        IF r.row_hash IS DISTINCT FROM v_expect THEN
            broken_event_id := r.id; broken_at := r.ts; reason := 'row_hash mismatch';
            RETURN NEXT;
        END IF;
        v_prev := r.row_hash;
        v_first := false;
    END LOOP;
END $$;

REVOKE ALL ON FUNCTION audit.verify_event_chain_range(UUID, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.verify_event_chain_range(UUID, TIMESTAMPTZ) TO app_archive;

COMMENT ON FUNCTION audit.verify_event_chain_range(UUID, TIMESTAMPTZ) IS
    'Сверка hash-chain диапазона (предшественник, p_to] с seed-хешем '
    'предшественника и верхней границей. Пустой результат = диапазон цел и '
    'связан с предыдущим архивом.';
