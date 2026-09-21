-- M129 — тестовые сессии и контексты доступа (этап 6.5, уровни 1–2).
--
-- ЗАЧЕМ. Владелец проходит платформу разными ролями и каждый раз вводит чужие
-- логины; упавший прогон Мауса разобрать нельзя — его данные остаются
-- безымянным мусором. Тестовая сессия даёт и то и другое: набор участников, к
-- которым можно вернуться, и запись прогона с шагами, результатом и перечнем
-- созданного.
--
-- ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО. Изоляции тестовых записей от рабочих внутри одной
-- базы (решение владельца 2026-09-21): это вторая ось арендаторства поверх
-- схемы, которая её не предполагала, и её полноту нельзя доказать. Тестовая
-- запись здесь — обычная запись с известным происхождением, а не запись,
-- невидимая остальной системе. Потребность в проверках рядом с продом
-- закрывается отдельным контуром — `TODO.md`.
--
-- ---------------------------------------------------------------------------
-- КОНТЕКСТ ДОСТУПА — самое опасное место этой миграции.
--
-- Контекст позволяет серверу выполнять запрос ОТ ЛИЦА другого пользователя.
-- Токен участнику при этом НЕ выпускается: платформа проверяет токен
-- инициатора обычным порядком, а действующего пользователя подставляет по
-- записи контекста. Поэтому схема работает и с внешним IdP, и локально.
--
-- Условия, которые обязана выражать схема, а не код:
--   1. Контекст привязан к КОНКРЕТНОЙ административной сессии инициатора
--      (`initiator_token_id` — `jti` его токена). Другая сессия того же
--      администратора контекст не открывает: выход на одном устройстве не
--      должен оставлять живым просмотр, открытый на другом.
--   2. Цель зависит от вида. `participant` — только зарегистрированный
--      участник ТОЙ ЖЕ сессии. `readonly` — любой пользователь, но без
--      сессии и только для чтения. `guest` — цели нет вовсе.
--   3. Рабочий пользователь не может стать участником тестовой сессии:
--      участником становится только запись происхождения `test_session`.
--      Это ограничение, а не соглашение: иначе уборка сессии однажды
--      дотянется до живого человека.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS testing;
COMMENT ON SCHEMA testing IS
    'Тестовые сессии: прогоны, их участники, шаги и созданные объекты. '
    'Класс данных `run` — единственный, который уборка сессии удаляет целиком.';

-- ------------------------------------------------- происхождение «участник»
-- M127 перечислял происхождения записи; участник тестовой сессии — новое.
-- Значение ОБЯЗАНО отличаться от `render_check`: уборка следов прогонов
-- (`stand:clean-probes`) работает по своему перечню, а участники убираются
-- уборкой своей сессии. Смешать их — значит удалить участников чужого
-- разбора вместе со случайным мусором.
ALTER TABLE identity.users DROP CONSTRAINT IF EXISTS users_origin_check;
ALTER TABLE identity.users ADD CONSTRAINT users_origin_check CHECK (origin IN (
    'self_registration', 'invite', 'seed_demo', 'seed_acceptance',
    'staff_check', 'render_check', 'load_test', 'test_session', 'unknown'));

ALTER TABLE lab.projects DROP CONSTRAINT IF EXISTS projects_origin_check;
ALTER TABLE lab.projects ADD CONSTRAINT projects_origin_check CHECK (origin IN (
    'self_registration', 'invite', 'seed_demo', 'seed_acceptance',
    'staff_check', 'render_check', 'load_test', 'test_session', 'unknown'));

-- ---------------------------------------------------------------- сессии
CREATE TABLE testing.sessions (
    id            UUID PRIMARY KEY,
    title         TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
    source        TEXT NOT NULL CHECK (source IN ('manual', 'automated')),
    created_by    UUID NOT NULL REFERENCES identity.users(id),
    environment   TEXT NOT NULL CHECK (length(btrim(environment)) BETWEEN 1 AND 40),
    -- Состояние сессии и ИТОГ ПРОВЕРКИ — разные вещи, и владелец назвал это
    -- отдельно. Завершённая сессия может быть и успешной, и упавшей; сессия
    -- в работе итога ещё не имеет.
    status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'finished', 'cleaning', 'cleaned', 'clean_failed')),
    result        TEXT NOT NULL DEFAULT 'unknown'
                  CHECK (result IN ('unknown', 'passed', 'failed')),
    -- Для автоматического прогона: что именно гоняли и на какой версии кода.
    scenario_id   TEXT CHECK (scenario_id IS NULL OR length(btrim(scenario_id)) BETWEEN 1 AND 120),
    code_version  TEXT CHECK (code_version IS NULL OR length(btrim(code_version)) BETWEEN 1 AND 80),
    -- Ошибка уборки видна, а не теряется: «очищается» без объяснения — это
    -- состояние, из которого некуда двигаться.
    cleanup_error TEXT CHECK (cleanup_error IS NULL OR length(btrim(cleanup_error)) BETWEEN 1 AND 2000),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ,
    cleaned_at    TIMESTAMPTZ,
    CHECK (cleanup_error IS NULL OR status = 'clean_failed'),
    CHECK (cleaned_at IS NULL OR status = 'cleaned')
);
COMMENT ON TABLE testing.sessions IS
    'Тестовая сессия: ручной проход или автоматический прогон. Завершение НЕ '
    'равно очистке: завершённая сессия сохраняет данные и продолжается.';
CREATE INDEX sessions_status ON testing.sessions (status, last_active_at DESC);
CREATE INDEX sessions_author ON testing.sessions (created_by, created_at DESC);

-- ------------------------------------------------------------- участники
CREATE TABLE testing.session_participants (
    session_id UUID NOT NULL REFERENCES testing.sessions(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES identity.users(id),
    role       TEXT NOT NULL CHECK (role IN
               ('founder', 'investor', 'expert', 'organizer', 'corporate', 'showrunner')),
    label      TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, user_id),
    -- Один участник принадлежит одной сессии: иначе уборка одной сессии
    -- уносит участника, на котором стоит разбор другой.
    UNIQUE (user_id)
);
COMMENT ON TABLE testing.session_participants IS
    'Участники сессии. Участником может стать ТОЛЬКО запись происхождения '
    'test_session — проверяется триггером: рабочий пользователь под уборку '
    'тестовой сессии не попадает никогда.';

CREATE OR REPLACE FUNCTION testing.assert_participant_is_test_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = testing, identity, pg_temp
AS $$
DECLARE
    v_origin TEXT;
BEGIN
    SELECT origin INTO v_origin FROM identity.users WHERE id = NEW.user_id;
    IF v_origin IS DISTINCT FROM 'test_session' THEN
        RAISE EXCEPTION
            'участником тестовой сессии может быть только запись происхождения test_session (у % — %)',
            NEW.user_id, coalesce(v_origin, 'нет такой записи')
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
COMMENT ON FUNCTION testing.assert_participant_is_test_user() IS
    'Граница между рабочим пользователем и участником прогона. Проверка в '
    'триггере, а не в приложении: путей записи несколько, а граница одна.';

CREATE TRIGGER session_participants_test_user_only
    BEFORE INSERT OR UPDATE ON testing.session_participants
    FOR EACH ROW EXECUTE FUNCTION testing.assert_participant_is_test_user();

-- ----------------------------------------------------------------- шаги
CREATE TABLE testing.session_steps (
    id          UUID PRIMARY KEY,
    session_id  UUID NOT NULL REFERENCES testing.sessions(id) ON DELETE CASCADE,
    ordinal     INTEGER NOT NULL CHECK (ordinal > 0),
    name        TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
    status      TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'skipped')),
    actor       TEXT CHECK (actor IS NULL OR length(btrim(actor)) BETWEEN 1 AND 80),
    expected    TEXT CHECK (expected IS NULL OR length(expected) <= 2000),
    actual      TEXT CHECK (actual IS NULL OR length(actual) <= 2000),
    detail_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, ordinal)
);
COMMENT ON TABLE testing.session_steps IS
    'Шаги прогона с ожидаемым и фактическим результатом. Диагностика без '
    'секретов: сюда не кладутся токены, пароли и персональные данные.';

-- ------------------------------------------------------- созданные объекты
CREATE TABLE testing.session_objects (
    session_id UUID NOT NULL REFERENCES testing.sessions(id) ON DELETE CASCADE,
    table_name TEXT NOT NULL CHECK (table_name ~ '^[a-z_]+\.[a-z_]+$'),
    row_id     UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, table_name, row_id)
);
COMMENT ON TABLE testing.session_objects IS
    'Что именно создала сессия. Уборка ходит по этому перечню, а НЕ по '
    'таблице целиком: в одной таблице лежат и подготовленное содержимое, и '
    'записи прогона — например записи ЧАВО в content.text_entries.';
CREATE INDEX session_objects_table ON testing.session_objects (table_name);

-- ------------------------------------------------------ контексты доступа
CREATE TABLE testing.access_contexts (
    id                 UUID PRIMARY KEY,
    kind               TEXT NOT NULL CHECK (kind IN ('participant', 'readonly', 'guest')),
    -- Инициатор и ЕГО сессия. Ссылка на сессию — это `jti` токена: контекст
    -- живёт ровно столько, сколько живёт та административная вкладка, из
    -- которой его открыли.
    initiator_user_id  UUID NOT NULL REFERENCES identity.users(id),
    initiator_token_id UUID NOT NULL,
    -- Кого изображаем. У гостя цели нет: запросы обрабатываются как
    -- неавторизованные.
    subject_user_id    UUID REFERENCES identity.users(id),
    session_id         UUID REFERENCES testing.sessions(id) ON DELETE CASCADE,
    expires_at         TIMESTAMPTZ NOT NULL,
    revoked_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at       TIMESTAMPTZ,
    -- Вид определяет и цель, и принадлежность сессии — иначе «просмотр
    -- кабинета» однажды окажется участником уборки.
    CHECK (
        (kind = 'guest'       AND subject_user_id IS NULL) OR
        (kind = 'participant' AND subject_user_id IS NOT NULL AND session_id IS NOT NULL) OR
        (kind = 'readonly'    AND subject_user_id IS NOT NULL AND session_id IS NULL)
    ),
    -- Срок жизни ограничен сверху: «вечный» контекст — это вторая учётная
    -- запись без владельца.
    CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '12 hours')
);
COMMENT ON TABLE testing.access_contexts IS
    'Разрешение серверу выполнять запрос от лица другого пользователя. Токен '
    'участнику НЕ выпускается: проверяется токен инициатора, личность '
    'подставляет сервер. Недействительный контекст = отказ, а не возврат к '
    'личности администратора.';
CREATE INDEX access_contexts_live ON testing.access_contexts (initiator_user_id, expires_at)
    WHERE revoked_at IS NULL;
CREATE INDEX access_contexts_session ON testing.access_contexts (session_id)
    WHERE session_id IS NOT NULL;

-- Участник контекста вида `participant` обязан быть участником ИМЕННО той
-- сессии. Ограничением это не выражается (нужна проверка по другой таблице),
-- поэтому триггер: правило слишком важное, чтобы жить только в приложении.
CREATE OR REPLACE FUNCTION testing.assert_context_target()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = testing, identity, pg_temp
AS $$
BEGIN
    IF NEW.kind = 'participant' THEN
        IF NOT EXISTS (
            SELECT 1 FROM testing.session_participants p
             WHERE p.session_id = NEW.session_id AND p.user_id = NEW.subject_user_id
        ) THEN
            RAISE EXCEPTION 'пользователь % не участник сессии %', NEW.subject_user_id, NEW.session_id
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    IF NEW.kind = 'readonly' THEN
        -- Просмотр кабинета — режим диагностики РАБОЧЕГО аккаунта. Наводить
        -- его на участника тестовой сессии незачем: туда есть обычный вход
        -- через саму сессию, а разные пути к одному — это разные правила,
        -- которые однажды разойдутся.
        IF EXISTS (SELECT 1 FROM testing.session_participants p WHERE p.user_id = NEW.subject_user_id) THEN
            RAISE EXCEPTION 'для участника тестовой сессии используется её собственный контекст'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER access_contexts_target
    BEFORE INSERT ON testing.access_contexts
    FOR EACH ROW EXECUTE FUNCTION testing.assert_context_target();

-- ------------------------------------------------------------------- RLS
-- Схема служебная: читает и пишет её только основная роль приложения от
-- имени администратора. Политики всё равно ставим — deny-by-default здесь
-- такое же правило, как везде (RULES.md §4).
ALTER TABLE testing.sessions              ENABLE ROW LEVEL SECURITY;
ALTER TABLE testing.sessions              FORCE  ROW LEVEL SECURITY;
ALTER TABLE testing.session_participants  ENABLE ROW LEVEL SECURITY;
ALTER TABLE testing.session_participants  FORCE  ROW LEVEL SECURITY;
ALTER TABLE testing.session_steps         ENABLE ROW LEVEL SECURITY;
ALTER TABLE testing.session_steps         FORCE  ROW LEVEL SECURITY;
ALTER TABLE testing.session_objects       ENABLE ROW LEVEL SECURITY;
ALTER TABLE testing.session_objects       FORCE  ROW LEVEL SECURITY;
ALTER TABLE testing.access_contexts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE testing.access_contexts       FORCE  ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA testing TO app_backend;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA testing TO app_backend;

-- Администратор распоряжается тестовыми сессиями; остальным схема не видна
-- вовсе. Проверка полномочия — в приложении и в каталоге полномочий ниже,
-- политика же отвечает на вопрос «кому вообще показывать строки».
CREATE POLICY sessions_admin ON testing.sessions FOR ALL
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));
CREATE POLICY participants_admin ON testing.session_participants FOR ALL
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));
CREATE POLICY steps_admin ON testing.session_steps FOR ALL
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));
CREATE POLICY objects_admin ON testing.session_objects FOR ALL
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));
-- Контекст видит только тот, кто его открыл: чужой контекст не должен быть
-- ни читаемым, ни отзываемым со стороны.
CREATE POLICY contexts_own ON testing.access_contexts FOR ALL
    USING (app.has_role('admin') AND initiator_user_id = app.current_user_id())
    WITH CHECK (app.has_role('admin') AND initiator_user_id = app.current_user_id());

-- ------------------------------------------------------------ полномочия
-- Новый вид действия «распоряжение». В словаре M097 были просмотр, создание,
-- изменение, подтверждение, денежная корректировка и обсуждение — удаления
-- не было вовсе. Уборка тестовой сессии удаляет её данные, и называть это
-- «изменением» значило бы выдавать разрушительное право под видом мягкого.
ALTER TABLE identity.staff_capabilities DROP CONSTRAINT IF EXISTS staff_capabilities_action_check;
ALTER TABLE identity.staff_capabilities ADD CONSTRAINT staff_capabilities_action_check
    CHECK (action IN
        ('view', 'create', 'update', 'confirm', 'financial_adjust', 'discuss', 'manage'));

INSERT INTO identity.staff_capabilities
    (code, section, action, title, description, requires_assignment, sort_order) VALUES
    ('testing.sessions.manage', 'Проверка', 'manage',
     'Распоряжаться тестовыми сессиями',
     'Создавать тестовые сессии, открывать кабинеты их участников, завершать и '
     'очищать. Участники — отдельные учётные записи, заведённые сессией; '
     'рабочие аккаунты в сессию не попадают.',
     false, 10),
    ('identity.user.view_as', 'Пользователи', 'view',
     'Смотреть кабинет пользователя',
     'Открывать кабинет РАБОЧЕГО пользователя в режиме только для чтения — для '
     'разбора обращения. Изменения запрещены сервером. Начало и завершение '
     'просмотра попадают в журнал с указанием администратора и пользователя.',
     false, 20)
ON CONFLICT (code) DO NOTHING;

-- -------------------------------------------------------- события журнала
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('testing.session.created',   'Тестовая сессия создана',            ARRAY['admin']),
    ('testing.session.finished',  'Тестовая сессия завершена',          ARRAY['admin']),
    ('testing.session.resumed',   'Тестовая сессия продолжена',         ARRAY['admin']),
    ('testing.session.cleaned',   'Данные тестовой сессии убраны',      ARRAY['admin']),
    ('testing.context.opened',    'Открыт контекст доступа от чужого лица', ARRAY['admin']),
    ('testing.context.closed',    'Контекст доступа завершён',          ARRAY['admin']),
    ('identity.user.view_started','Начат просмотр кабинета пользователя', ARRAY['admin']),
    ('identity.user.view_ended',  'Просмотр кабинета пользователя завершён', ARRAY['admin'])
ON CONFLICT (verb) DO NOTHING;
