-- M162 — группа функций «Почта» (блок 4, 4.11; пакет 4 раздела 01, 08.11.2026).
--
-- 1. Наблюдения и ручные ограничения принимают группу `mail`.
--
-- 2. Отметки отправки писем со ссылкой (`comms.mail_dispatches`): смена пароля и
--    подтверждение адреса. SMTP не входит в транзакцию БД, поэтому начало внешней отправки
--    фиксируется ДО неё — в одной транзакции с выдачей ссылки. Исход пишется отдельно.
--    Отправка, оставшаяся «начатой» после срока `started_until` (процесс упал), считается
--    неизвестной: повтор тем же ключом письмо заново не отправляет.
--    Ни ссылки, ни адреса, ни получателя в записи нет. У анонимной операции («Забыли
--    пароль») нет и пользователя: запись одинакова для существующего и отсутствующего адреса
--    до исхода, и ключ ничего не раскрывает о наличии аккаунта.
--
-- 3. Очередь служебных писем (`comms.mail_queue`): копия обращения и уведомление о
--    регистрации ставятся в одной транзакции с исходным событием; уникальность по событию
--    не даёт повтору запроса создать вторую задачу. `unknown_count` — число неизвестных
--    исходов; повтор после неизвестного исхода — не больше одного, предел хранится здесь и
--    не начинается заново после перезапуска или нового захвата аренды.

-- ---------------------------------------------------------------- 1. группа «Почта»
ALTER TABLE availability.observations DROP CONSTRAINT observations_group_id_check;
ALTER TABLE availability.observations
    ADD CONSTRAINT observations_group_id_check CHECK (group_id IN ('files', 'mail'));
ALTER TABLE availability.restrictions DROP CONSTRAINT restrictions_group_id_check;
ALTER TABLE availability.restrictions
    ADD CONSTRAINT restrictions_group_id_check CHECK (group_id IN ('files', 'mail'));

-- ------------------------------------------------------- 2. отметки писем со ссылкой
CREATE TABLE comms.mail_dispatches (
    id             UUID        PRIMARY KEY,
    purpose        TEXT        NOT NULL CHECK (purpose IN ('password_reset', 'email_verify')),
    scope          TEXT        NOT NULL CHECK (scope IN ('anonymous', 'user')),
    -- Только у операции вошедшего пользователя; у анонимной — NULL всегда.
    actor_id       UUID        REFERENCES identity.users(id),
    key_hash       BYTEA       NOT NULL CHECK (octet_length(key_hash) = 32),
    request_hash   BYTEA       NOT NULL CHECK (octet_length(request_hash) = 32),
    -- started — внешняя отправка начата; accepted — принято релеем (250 после DATA), это не
    -- доставка адресату; not_sent — точно не ушло; unknown — исход не выяснен; skipped —
    -- письма не было (адреса нет или превышен счётчик), наружу неотличимо от остальных.
    state          TEXT        NOT NULL CHECK (state IN
                       ('started', 'accepted', 'not_sent', 'unknown', 'skipped')),
    started_until  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at    TIMESTAMPTZ,
    expires_at     TIMESTAMPTZ NOT NULL,
    CHECK ((scope = 'anonymous') = (actor_id IS NULL)),
    CHECK ((state = 'started') = (started_until IS NOT NULL))
);

CREATE UNIQUE INDEX mail_dispatches_key ON comms.mail_dispatches
    (purpose, scope, coalesce(actor_id, '00000000-0000-0000-0000-000000000000'::uuid), key_hash);

COMMENT ON TABLE comms.mail_dispatches IS
    'Начало и исход отправки писем со ссылкой (4.11, M162): без ссылки, адреса и получателя.';

ALTER TABLE comms.mail_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.mail_dispatches FORCE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA comms TO app_auth;
GRANT SELECT, INSERT, UPDATE ON comms.mail_dispatches TO app_auth, app_backend;

-- Анонимные — только роли проверки входа; свои — только своему пользователю.
CREATE POLICY mail_dispatches_anonymous ON comms.mail_dispatches
    FOR ALL TO app_auth
    USING (scope = 'anonymous') WITH CHECK (scope = 'anonymous' AND actor_id IS NULL);
CREATE POLICY mail_dispatches_own ON comms.mail_dispatches
    FOR ALL TO app_backend
    USING (scope = 'user' AND actor_id = app.current_user_id())
    WITH CHECK (scope = 'user' AND actor_id = app.current_user_id());

-- -------------------------------------------------------- 3. очередь служебных писем
CREATE TABLE comms.mail_queue (
    id              UUID        PRIMARY KEY,
    source_type     TEXT        NOT NULL CHECK (source_type IN
                        ('support.ticket.opened', 'support.message.added',
                         'identity.user.registered')),
    source_id       UUID        NOT NULL,
    recipient       TEXT        NOT NULL CHECK (length(recipient) BETWEEN 3 AND 254),
    subject         TEXT        NOT NULL CHECK (length(subject) BETWEEN 1 AND 300),
    -- Тело очищается после «принято релеем»: копия уже у адресата, хранить её незачем.
    body            TEXT        NOT NULL,
    -- Постоянный на все попытки: повтор после неизвестного исхода — с прежним Message-ID.
    -- Устранения дублей это не гарантирует.
    message_id      TEXT        NOT NULL UNIQUE,
    state           TEXT        NOT NULL DEFAULT 'pending' CHECK (state IN
                        ('pending', 'sending', 'accepted', 'failed', 'unknown')),
    attempts        INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    unknown_count   INTEGER     NOT NULL DEFAULT 0 CHECK (unknown_count BETWEEN 0 AND 2),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_stage      TEXT,
    last_code       INTEGER,
    lease_id        UUID,
    lease_until     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    accepted_at     TIMESTAMPTZ,
    UNIQUE (source_type, source_id)
);

CREATE INDEX mail_queue_due ON comms.mail_queue (next_attempt_at)
    WHERE state IN ('pending', 'sending');

COMMENT ON TABLE comms.mail_queue IS
    'Очередь служебных писем (4.11, M162): одна задача на исходное событие, один повтор после '
    'неизвестного исхода.';
COMMENT ON COLUMN comms.mail_queue.unknown_count IS
    'Неизвестные исходы (обрыв после DATA, падение во время отправки). 1 — допустим один '
    'повтор с прежним Message-ID; 2 — окончательно «неизвестно».';

ALTER TABLE comms.mail_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.mail_queue FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON comms.mail_queue TO app_backend;
GRANT USAGE ON SCHEMA comms TO app_readonly;
GRANT SELECT ON comms.mail_queue TO app_readonly;

-- Как у outbox: пишут транзакции событий и отправщик ядра; людям через API не отдаётся.
CREATE POLICY mail_queue_core ON comms.mail_queue
    FOR ALL TO app_backend USING (true) WITH CHECK (true);
CREATE POLICY mail_queue_read ON comms.mail_queue
    FOR SELECT TO app_readonly USING (true);
