-- =============================================================================
-- M171 — общий контекст автора действия (блок 10, задание 1).
-- docs/architecture/b10-actor-context.md
--
-- 1. Журнал: если в контексте события есть `actor` (форма версии 1), он обязан
--    совпадать со столбцами actor_id / actor_role. Расхождение — исключение: событие
--    и изменение откатываются вместе. Записи без `actor` (прежнее ядро, старые записи)
--    принимаются как раньше; цепочка и формула хеша не меняются.
-- 2. Реестр глаголов: роли, которые теперь выводятся из пройденной проверки, —
--    `anonymous` (до входа), `user` (действие над своей учётной записью), `service`
--    (сервисная учётная запись), `admin` там, где действие мог сделать администратор,
--    а журнал прежде записывал `founder`. Роли только добавляются.
-- 3. Происхождение операции для фона: lab.project_materials.upload_origin,
--    comms.mail_queue.origin (+ вариант функции постановки письма с ним).
--
-- migrate:compat-none не ставится: прежний код проверяется database/compat/M171_actor_context.mjs.
-- =============================================================================

-- ------------------------------------------------------------------ 1. журнал
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
SET search_path = pg_catalog, audit, public, pg_temp
AS $$
DECLARE
    v_id      UUID;
    v_prev    BYTEA;
    v_prev_ts TIMESTAMPTZ;
    v_hash    BYTEA;
    v_ts      TIMESTAMPTZ;
    v_actor   JSONB;
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

    -- Контекст автора (M171): столбцы и контекст не противоречат друг другу.
    IF p_context ? 'actor' THEN
        v_actor := p_context -> 'actor';
        IF jsonb_typeof(v_actor) <> 'object' OR (v_actor ->> 'v') IS DISTINCT FROM '1' THEN
            RAISE EXCEPTION 'контекст автора: неизвестная форма' USING ERRCODE = '22023';
        END IF;
        IF (v_actor ->> 'kind') IS NULL
           OR (v_actor ->> 'kind') NOT IN ('person', 'service_account', 'anonymous', 'system') THEN
            RAISE EXCEPTION 'контекст автора: неизвестный вид %', v_actor ->> 'kind'
                USING ERRCODE = '22023';
        END IF;
        IF (v_actor ->> 'userId') IS DISTINCT FROM p_actor_id::text
           OR (v_actor ->> 'role') IS DISTINCT FROM p_actor_role THEN
            RAISE EXCEPTION 'контекст автора расходится с автором события %', p_verb
                USING ERRCODE = '22023';
        END IF;
        IF ((v_actor ->> 'kind') = 'person') <> (p_actor_id IS NOT NULL) THEN
            RAISE EXCEPTION 'контекст автора: человек без учётной записи или наоборот (%)', p_verb
                USING ERRCODE = '22023';
        END IF;
        IF (v_actor ->> 'operationId') IS NULL THEN
            RAISE EXCEPTION 'контекст автора без операции (%)', p_verb USING ERRCODE = '22023';
        END IF;
    END IF;

    -- Разрешение на вставку в append-only журнал. Флаг транзакционный и сам по
    -- себе не является границей безопасности: INSERT на audit.events не выдан
    -- ни одной роли приложения, поэтому выставить флаг снаружи бесполезно.
    PERFORM set_config('app.event_emit_context', 'on', true);

    SELECT e.row_hash, e.ts INTO v_prev, v_prev_ts
      FROM audit.events e ORDER BY e.ts DESC, e.id DESC LIMIT 1;

    -- Метка времени берётся ПОСЛЕ захвата лока и принудительно строго возрастает (M001).
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

-- Роль app_auth пишет событие В ТОЙ ЖЕ транзакции, что и смена пароля / подтверждение
-- почты по ссылке (блок 10): прежде запись шла отдельной транзакцией после изменения.
GRANT EXECUTE ON FUNCTION audit.app_emit_event(TEXT, UUID, TEXT, TEXT, UUID, JSONB, TEXT)
    TO app_auth;

-- -------------------------------------------------------- 2. реестр глаголов
UPDATE audit.event_type_registry r
   SET actor_roles_allowed = ARRAY(
         SELECT DISTINCT x FROM unnest(r.actor_roles_allowed || a.add) AS x ORDER BY x)
  FROM (VALUES
    ('identity.user.registered',          ARRAY['anonymous']),
    ('identity.login.failed',             ARRAY['anonymous']),
    ('identity.password.reset_requested', ARRAY['anonymous']),
    ('identity.password.reset_completed', ARRAY['anonymous']),
    ('identity.email.verified',           ARRAY['anonymous']),
    ('identity.email.verification_sent',  ARRAY['user']),
    ('identity.password.changed',         ARRAY['user']),
    ('identity.avatar.set',               ARRAY['user']),
    ('identity.avatar.removed',           ARRAY['user']),
    ('identity.user.profile_updated',     ARRAY['user']),
    ('identity.token.revoked',            ARRAY['user']),
    ('comms.device.revoked',              ARRAY['user']),
    ('kyc.verification.submitted',        ARRAY['user']),
    ('kyc.entity.created',                ARRAY['user']),
    ('kyc.entity.member_added',           ARRAY['user']),
    ('kyc.kyb.submitted',                 ARRAY['user']),
    ('lab.project.created',               ARRAY['admin']),
    ('lab.material.added',                ARRAY['admin']),
    ('lab.listing.published',             ARRAY['admin']),
    ('integration.webhook.registered',    ARRAY['service']),
    ('integration.webhook.disabled',      ARRAY['service']),
    ('integration.token.issued',          ARRAY['service'])
  ) AS a(verb, add)
 WHERE r.verb = a.verb;

-- ------------------------------------------------ 3. происхождение для фона
ALTER TABLE lab.project_materials ADD COLUMN upload_origin JSONB;
COMMENT ON COLUMN lab.project_materials.upload_origin IS
    'Происхождение операции загрузки (M171): operationId, инициатор, запрос. Сверка пишет '
    'завершение от системы с этим инициатором; у старых строк NULL — автор не выдумывается.';
GRANT INSERT (upload_origin) ON lab.project_materials TO app_backend;
GRANT SELECT (upload_origin) ON lab.project_materials TO app_backend, app_maintenance;

ALTER TABLE comms.mail_queue ADD COLUMN origin JSONB;
COMMENT ON COLUMN comms.mail_queue.origin IS
    'Происхождение операции, поставившей письмо (M171); повторы отправки несут тот же '
    'operationId. У старых строк NULL.';

CREATE OR REPLACE FUNCTION comms.enqueue_service_mail(
    p_id          UUID,
    p_source_type TEXT,
    p_source_id   UUID,
    p_recipient   TEXT,
    p_subject     TEXT,
    p_body        TEXT,
    p_message_id  TEXT,
    p_origin      JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, comms, pg_temp
AS $$
BEGIN
    IF p_source_type NOT IN ('support.ticket.opened', 'support.message.added',
                             'identity.user.registered') THEN
        RAISE EXCEPTION 'неизвестный источник служебного письма' USING ERRCODE = '22023';
    END IF;
    INSERT INTO comms.mail_queue (id, source_type, source_id, recipient, subject, body,
                                  message_id, origin)
    VALUES (p_id, p_source_type, p_source_id, p_recipient, p_subject, p_body, p_message_id,
            p_origin)
    ON CONFLICT (source_type, source_id) DO NOTHING;
    RETURN FOUND;
END;
$$;
COMMENT ON FUNCTION comms.enqueue_service_mail(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB) IS
    'Постановка служебного письма с происхождением операции (M171). Вариант без него (M166) '
    'остаётся для прежнего ядра.';
REVOKE ALL ON FUNCTION comms.enqueue_service_mail(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION comms.enqueue_service_mail(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB)
    TO app_backend;
