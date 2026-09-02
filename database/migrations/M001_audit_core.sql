-- =============================================================================
-- M001 — audit-core
-- Реестр типов событий, append-only журнал с hash-chain и партициями,
-- app_emit_event(), transactional outbox, дедуп консьюмеров.
-- Идёт ДО доменных команд: любая доменная мутация обязана уметь писать событие.
-- Источник: docs/architecture/Database_Launch.md §12, §16.
-- =============================================================================

-- ------------------------------------------------------- реестр типов событий
CREATE TABLE audit.event_type_registry (
    verb                TEXT PRIMARY KEY,
    description         TEXT,
    actor_roles_allowed TEXT[] NOT NULL,
    schema_version      INTEGER NOT NULL DEFAULT 1,
    CHECK (cardinality(actor_roles_allowed) > 0)
);
COMMENT ON TABLE audit.event_type_registry IS
    'Событие с незарегистрированным verb или недопустимой ролью актора не пишется — fail-closed.';

-- --------------------------------------------------------- append-only журнал
CREATE TABLE audit.events (
    id              UUID NOT NULL,
    ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
    verb            TEXT NOT NULL REFERENCES audit.event_type_registry(verb),
    actor_id        UUID,
    actor_role      TEXT,
    subject_type    TEXT,
    subject_id      UUID,
    context_jsonb   JSONB NOT NULL DEFAULT '{}',
    trace_id        TEXT,
    prev_hash       BYTEA,
    row_hash        BYTEA,
    PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

-- Индекс под чтение «последнего звена цепи» в app_emit_event().
CREATE INDEX events_chain_tail ON audit.events (ts DESC, id DESC);
CREATE INDEX events_actor ON audit.events (actor_id, ts DESC);
CREATE INDEX events_subject ON audit.events (subject_type, subject_id, ts DESC);
CREATE INDEX events_verb ON audit.events (verb, ts DESC);

-- ---------------------------------------- обслуживание партиций (нативный путь)
CREATE OR REPLACE FUNCTION audit.ensure_event_partitions(p_months_ahead INTEGER DEFAULT 2)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, audit, public
AS $$
DECLARE
    v_month  DATE := date_trunc('month', now())::date;
    v_i      INTEGER;
    v_from   DATE;
    v_to     DATE;
    v_name   TEXT;
    v_created INTEGER := 0;
BEGIN
    IF p_months_ahead < 0 OR p_months_ahead > 24 THEN
        RAISE EXCEPTION 'p_months_ahead вне допустимого диапазона 0..24: %', p_months_ahead;
    END IF;
    -- Предыдущий месяц тоже создаём: события могут приходить с небольшим сдвигом.
    --
    -- Проверка «уже есть» идёт НЕ по имени: pg_partman называет свои партиции
    -- по-своему (events_p20260701), и проверка по имени приводит к попытке
    -- создать перекрывающийся диапазон. Полагаемся на сам PostgreSQL: он
    -- отвергает и дубликат имени (42P07), и перекрытие диапазона (42P17).
    FOR v_i IN -1 .. p_months_ahead LOOP
        v_from := (v_month + (v_i || ' month')::interval)::date;
        v_to   := (v_from + interval '1 month')::date;
        v_name := 'events_' || to_char(v_from, 'YYYY_MM');
        BEGIN
            EXECUTE format(
                'CREATE TABLE audit.%I PARTITION OF audit.events FOR VALUES FROM (%L) TO (%L)',
                v_name, v_from, v_to);
            v_created := v_created + 1;
        EXCEPTION
            WHEN duplicate_table THEN
                NULL;                       -- партиция с таким именем уже есть
            WHEN invalid_object_definition THEN
                NULL;                       -- диапазон уже покрыт другой партицией
        END;
    END LOOP;
    RETURN v_created;
END $$;

COMMENT ON FUNCTION audit.ensure_event_partitions(INTEGER) IS
    'Идемпотентное создание месячных партиций. Вызывается миграцией и плановой задачей.';

-- Выбор пути обслуживания: pg_partman, если он установлен, иначе нативный (ADR-004).
DO $$
DECLARE v_created INTEGER;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_partman') THEN
        PERFORM partman.create_parent(
            p_parent_table := 'audit.events',
            p_control      := 'ts',
            p_interval     := '1 month',
            p_type         := 'range'
        );
        RAISE NOTICE 'M001: партиции audit.events обслуживает pg_partman';
    ELSE
        v_created := audit.ensure_event_partitions(2);
        RAISE NOTICE 'M001: партиции audit.events обслуживаются нативно, создано %', v_created;
    END IF;
END $$;

-- Страховка независимо от выбранного пути: текущий и следующий месяц обязаны быть.
SELECT audit.ensure_event_partitions(1);

-- ------------------------------------------------------------ запрет мутаций
CREATE OR REPLACE FUNCTION audit.forbid_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, audit, public
AS $$
BEGIN
    RAISE EXCEPTION 'audit.events is append-only';
END $$;

CREATE TRIGGER events_no_update
    BEFORE UPDATE OR DELETE ON audit.events
    FOR EACH ROW EXECUTE FUNCTION audit.forbid_event_mutation();

-- ------------------------------------------------------------ эмиссия события
-- SECURITY DEFINER: роли приложения не имеют INSERT на audit.events напрямую,
-- единственный путь записи — эта функция.
CREATE OR REPLACE FUNCTION audit.app_emit_event(
    p_verb          TEXT,
    p_actor_id      UUID,
    p_actor_role    TEXT,
    p_subject_type  TEXT,
    p_subject_id    UUID,
    p_context       JSONB,
    p_trace_id      TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, audit, public
AS $$
DECLARE
    v_id      UUID;
    v_prev    BYTEA;
    v_prev_ts TIMESTAMPTZ;
    v_hash    BYTEA;
    v_ts      TIMESTAMPTZ;
BEGIN
    -- Одна последовательность hash-chain: исключает ветвление при конкурентных INSERT.
    PERFORM pg_advisory_xact_lock(hashtext('audit.events.hash_chain'));

    IF NOT EXISTS (
        SELECT 1 FROM audit.event_type_registry r
        WHERE r.verb = p_verb
          AND p_actor_role = ANY(r.actor_roles_allowed)
    ) THEN
        RAISE EXCEPTION 'actor role % is not allowed for %', p_actor_role, p_verb
            USING ERRCODE = '42501';
    END IF;

    -- Разрешение на вставку в append-only журнал. Флаг транзакционный и сам по
    -- себе не является границей безопасности: INSERT на audit.events не выдан
    -- ни одной роли приложения, поэтому выставить флаг снаружи бесполезно.
    PERFORM set_config('app.event_emit_context', 'on', true);

    SELECT e.row_hash, e.ts INTO v_prev, v_prev_ts
      FROM audit.events e ORDER BY e.ts DESC, e.id DESC LIMIT 1;

    -- Метка времени берётся ПОСЛЕ захвата лока и принудительно строго
    -- возрастает. Если брать её раньше (в DECLARE), транзакция, дождавшаяся
    -- лока, вставит событие с более ранним ts, чем уже записанное: порядок по
    -- ts перестанет совпадать с порядком цепочки, и сверка увидит разрыв там,
    -- где подделки не было.
    v_ts := clock_timestamp();
    IF v_prev_ts IS NOT NULL AND v_ts <= v_prev_ts THEN
        v_ts := v_prev_ts + interval '1 microsecond';
    END IF;

    v_id := public.uuid_generate_v7();
    v_hash := digest(convert_to(concat(
        encode(coalesce(v_prev, '\x00'::bytea), 'hex'), '|', v_id, '|', v_ts, '|', p_verb, '|',
        coalesce(p_actor_id::text, ''), '|', coalesce(p_actor_role, ''), '|',
        coalesce(p_subject_type, ''), '|', coalesce(p_subject_id::text, ''), '|',
        coalesce(p_context, '{}'::jsonb)::text, '|', coalesce(p_trace_id, '')
    ), 'UTF8'), 'sha256');

    INSERT INTO audit.events (id, ts, verb, actor_id, actor_role, subject_type,
                              subject_id, context_jsonb, trace_id, prev_hash, row_hash)
    VALUES (v_id, v_ts, p_verb, p_actor_id, p_actor_role, p_subject_type,
            p_subject_id, coalesce(p_context, '{}'::jsonb), p_trace_id, v_prev, v_hash);

    RETURN v_id;
END $$;

-- ----------------------------------------------- проверка целостности цепочки
CREATE OR REPLACE FUNCTION audit.verify_event_chain(p_from TIMESTAMPTZ DEFAULT NULL)
RETURNS TABLE (broken_event_id UUID, broken_at TIMESTAMPTZ, reason TEXT)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, audit, public
AS $$
DECLARE
    r        RECORD;
    v_prev   BYTEA := NULL;
    v_first  BOOLEAN := true;
    v_expect BYTEA;
BEGIN
    FOR r IN
        SELECT * FROM audit.events
        WHERE p_from IS NULL OR ts >= p_from
        ORDER BY ts ASC, id ASC
    LOOP
        IF NOT v_first AND r.prev_hash IS DISTINCT FROM v_prev THEN
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

COMMENT ON FUNCTION audit.verify_event_chain(TIMESTAMPTZ) IS
    'Сверка hash-chain. Пустой результат = цепочка цела. Публичные счётчики честны только при целой цепочке.';

-- --------------------------------------------------------- transactional outbox
CREATE TABLE audit.outbox_events (
    id                UUID PRIMARY KEY,
    aggregate_type    TEXT NOT NULL,
    aggregate_id      UUID NOT NULL,
    event_type        TEXT NOT NULL,
    payload_jsonb     JSONB NOT NULL,
    nats_subject      TEXT NOT NULL,
    schema_version    INTEGER NOT NULL DEFAULT 1,
    aggregate_version BIGINT NOT NULL,
    message_key       TEXT NOT NULL,
    attempts          INTEGER NOT NULL DEFAULT 0,
    next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_at         TIMESTAMPTZ,
    last_error        TEXT,
    published_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (aggregate_type, aggregate_id, aggregate_version, event_type),
    CHECK (attempts >= 0)
);
CREATE INDEX outbox_unpublished ON audit.outbox_events (next_attempt_at, created_at)
    WHERE published_at IS NULL;
CREATE INDEX outbox_dlq ON audit.outbox_events (attempts DESC)
    WHERE published_at IS NULL AND attempts >= 10;

COMMENT ON TABLE audit.outbox_events IS
    'Доменная мутация и её событие коммитятся одной транзакцией. Publisher забирает '
    'строки FOR UPDATE SKIP LOCKED и публикует id как Nats-Msg-Id (дедуп на стороне JetStream).';

-- --------------------------------------------------- идемпотентность консьюмеров
CREATE TABLE audit.consumed_events (
    consumer    TEXT NOT NULL,
    event_id    UUID NOT NULL,
    consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer, event_id)
);

-- ------------------------------------------------------------------ RLS и права
ALTER TABLE audit.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.events FORCE ROW LEVEL SECURITY;
-- Реестр verb'ов не содержит ПДн, но определяет, какая роль какое событие
-- вправе эмитить. Оставлять его без RLS — оставлять дырку в fail-closed
-- контуре журнала, поэтому включаем наравне с остальными.
ALTER TABLE audit.event_type_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.event_type_registry FORCE ROW LEVEL SECURITY;
ALTER TABLE audit.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.outbox_events FORCE ROW LEVEL SECURITY;
ALTER TABLE audit.consumed_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.consumed_events FORCE ROW LEVEL SECURITY;

-- Чтение журнала: свои события; admin/organizer — все.
CREATE POLICY events_read_own ON audit.events FOR SELECT USING (
    actor_id = app.current_user_id()
    OR app.has_role('admin')
    OR app.has_role('organizer'));

-- Единственный путь записи — app_emit_event(). Политика пропускает вставку
-- только внутри её транзакционного контекста; GRANT на INSERT при этом не
-- выдан никому, так что двух замков сразу обойти нельзя.
CREATE POLICY events_insert_via_emit ON audit.events FOR INSERT WITH CHECK (
    coalesce(current_setting('app.event_emit_context', true), '') = 'on');

GRANT SELECT ON audit.events TO app_backend, app_investments, app_billing, app_integration, app_readonly;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON audit.events
    FROM app_backend, app_investments, app_billing, app_integration, app_readonly, app_notifications, app_public_read;

CREATE POLICY event_registry_read ON audit.event_type_registry FOR SELECT USING (true);
CREATE POLICY event_registry_admin_write ON audit.event_type_registry FOR ALL
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));
CREATE POLICY event_registry_service_read ON audit.event_type_registry FOR SELECT
    TO app_backend, app_investments, app_billing, app_integration, app_notifications USING (true);

GRANT SELECT ON audit.event_type_registry TO app_backend, app_investments, app_billing, app_integration;

-- Outbox: пишут доменные роли, читает и помечает опубликованным publisher (app_backend).
CREATE POLICY outbox_service ON audit.outbox_events FOR ALL
    TO app_backend, app_investments, app_billing, app_integration
    USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON audit.outbox_events
    TO app_backend, app_investments, app_billing, app_integration;

CREATE POLICY consumed_service ON audit.consumed_events FOR ALL
    TO app_backend, app_integration
    USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON audit.consumed_events TO app_backend, app_integration;

GRANT EXECUTE ON FUNCTION audit.app_emit_event(TEXT, UUID, TEXT, TEXT, UUID, JSONB, TEXT)
    TO app_backend, app_investments, app_billing, app_integration, app_notifications;
GRANT EXECUTE ON FUNCTION audit.ensure_event_partitions(INTEGER) TO app_backend;
GRANT EXECUTE ON FUNCTION audit.verify_event_chain(TIMESTAMPTZ) TO app_backend, app_readonly;
