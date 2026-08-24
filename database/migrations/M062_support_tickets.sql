-- =============================================================================
-- M062 — обращения в поддержку и сообщения об ошибках
--
-- Две задачи закрываются ОДНОЙ сущностью, и это решение, а не экономия:
--
--  1. Тестировщик нажимает служебную комбинацию клавиш, описывает проблему —
--     и к сообщению сам собой прикладывается технический контекст (адрес
--     страницы, браузер, роль, trace_id).
--  2. Пользователь пишет в поддержку и ведёт переписку внутри обращения.
--
-- Различает их поле `kind`. Отдельная таблица «баг-репортов» рядом с таблицей
-- «обращений» означала бы два списка, два статуса, два места, куда смотреть
-- сотруднику, и два письма на один служебный ящик — при полностью совпадающем
-- жизненном цикле: пришло → взяли в работу → ответили → закрыли.
--
-- Почему в схеме `comms`, а не в новой схеме `support`: это переписка с
-- пользователем, то есть ровно предмет `comms`. Новая схема потребовала бы
-- своих GRANT'ов, своей записи в манифесте покрытия RLS и своего места в
-- границах сервисных ролей — при нулевой разнице в смысле.
--
-- Чего здесь НЕТ намеренно:
--
--  * колонки `updated_at` у обращения. Её пришлось бы обновлять при каждом
--    сообщении пользователя — то есть выдать пользователю право UPDATE на
--    строку обращения, где живут `status` и `assigned_to`. Ровно этим путём
--    человек переводит собственное обращение в «закрыто» или назначает его на
--    себя. Момент последней активности вычисляется из сообщений (MAX
--    created_at), и права на запись для этого не нужно ни одного.
--  * ON DELETE CASCADE ради удобства уборки. Обращение не удаляется: закрытое
--    обращение — это след, а не мусор.
-- =============================================================================

-- ------------------------------------------------------------------ обращения
CREATE TABLE comms.support_tickets (
    id            UUID PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES identity.users(id),
    -- support    — обращение в поддержку (задача «Поддержка пользователей»);
    -- bug_report — сообщение об ошибке из служебной формы тестировщика.
    kind          TEXT NOT NULL CHECK (kind IN ('support','bug_report')),
    subject       TEXT NOT NULL CHECK (length(subject) BETWEEN 3 AND 200),
    status        TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','in_progress','closed')),
    -- Технический контекст баг-репорта. Наполняет его СЕРВЕР по строгому
    -- разрешённому списку полей: тело запроса сюда целиком не переливается,
    -- иначе первая же версия клиента с «прислать всё на всякий случай»
    -- положила бы в таблицу заголовок Cookie.
    context_jsonb JSONB NOT NULL DEFAULT '{}',
    assigned_to   UUID REFERENCES identity.users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at     TIMESTAMPTZ,
    -- Закрытие без момента закрытия — это «закрыто когда-то»: по такой строке
    -- нельзя ни посчитать срок ответа, ни отличить вчерашнее от прошлогоднего.
    CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

CREATE INDEX support_tickets_user ON comms.support_tickets (user_id, created_at DESC);
-- Очередь сотрудника: открытые обращения, старые сверху — отвечают по порядку.
CREATE INDEX support_tickets_queue ON comms.support_tickets (status, created_at)
    WHERE status <> 'closed';

COMMENT ON TABLE comms.support_tickets IS
    'Обращения в поддержку и сообщения об ошибках. Различает kind. Момент последней '
    'активности НЕ хранится: он вычисляется из comms.support_messages, чтобы автору '
    'обращения не требовалось право UPDATE на строку со статусом и назначением.';
COMMENT ON COLUMN comms.support_tickets.context_jsonb IS
    'Технический контекст, собранный сервером по разрешённому списку полей. Паролей, '
    'токенов и cookie здесь нет и быть не может: клиент их не присылает, а сервер не '
    'переносит в эту колонку ничего сверх списка.';

-- ------------------------------------------------------------------ переписка
CREATE TABLE comms.support_messages (
    id          UUID PRIMARY KEY,
    ticket_id   UUID NOT NULL REFERENCES comms.support_tickets(id),
    author_id   UUID NOT NULL REFERENCES identity.users(id),
    -- Кто написал, с точки зрения обращения. Не роль в системе: у сотрудника
    -- может быть и роль основателя, но в чужом обращении он выступает
    -- сотрудником, и человек по ту сторону должен видеть именно это.
    author_kind TEXT NOT NULL CHECK (author_kind IN ('user','staff')),
    body        TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX support_messages_thread ON comms.support_messages (ticket_id, created_at);

COMMENT ON TABLE comms.support_messages IS
    'Асинхронный диалог внутри обращения. Не realtime-чат: WebSocket-контура у '
    'платформы нет, и заводить его ради MVP поддержки означало бы новый сетевой '
    'периметр под задачу, которую закрывает обычный обмен сообщениями.';

-- ---------------------------------------------------------------------- RLS
ALTER TABLE comms.support_tickets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.support_tickets  FORCE  ROW LEVEL SECURITY;
ALTER TABLE comms.support_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.support_messages FORCE  ROW LEVEL SECURITY;

-- Своё обращение видит автор, чужие — только сотрудник поддержки (admin).
-- Ни organizer, ни compliance сюда не попадают: обращение содержит свободный
-- текст пользователя, то есть потенциально что угодно о нём самом.
CREATE POLICY support_tickets_select ON comms.support_tickets FOR SELECT
    TO app_backend USING (
        user_id = app.current_user_id()
        OR app.has_role('admin'));

-- Создаёт обращение только автор и только от своего имени, и только в
-- начальном состоянии. Без этих двух условий в WITH CHECK человек заводит
-- обращение сразу закрытым (обойдя очередь) или назначенным на сотрудника.
CREATE POLICY support_tickets_open ON comms.support_tickets FOR INSERT
    TO app_backend WITH CHECK (
        user_id = app.current_user_id()
        AND status = 'new'
        AND closed_at IS NULL
        AND assigned_to IS NULL);

-- Менять статус и назначение может только сотрудник. WITH CHECK повторяет
-- USING: иначе тем же UPDATE строку можно было бы переписать на другого
-- владельца.
CREATE POLICY support_tickets_staff ON comms.support_tickets FOR UPDATE
    TO app_backend
    USING (app.has_role('admin'))
    WITH CHECK (app.has_role('admin'));

-- Сообщения видны ровно тем, кому видно само обращение. Условие повторяет
-- политику обращения не «на всякий случай»: без него переписка читалась бы по
-- ticket_id в обход политики родительской строки.
CREATE POLICY support_messages_select ON comms.support_messages FOR SELECT
    TO app_backend USING (
        EXISTS (SELECT 1 FROM comms.support_tickets t
                 WHERE t.id = ticket_id
                   AND (t.user_id = app.current_user_id() OR app.has_role('admin'))));

-- Пользователь пишет только в своё и только не закрытое обращение, и только
-- от своего имени как пользователь. Подмена author_kind на 'staff' дала бы
-- человеку возможность нарисовать в собственной переписке ответ поддержки.
CREATE POLICY support_messages_user ON comms.support_messages FOR INSERT
    TO app_backend WITH CHECK (
        author_id = app.current_user_id()
        AND author_kind = 'user'
        AND EXISTS (SELECT 1 FROM comms.support_tickets t
                     WHERE t.id = ticket_id
                       AND t.user_id = app.current_user_id()
                       AND t.status <> 'closed'));

CREATE POLICY support_messages_staff ON comms.support_messages FOR INSERT
    TO app_backend WITH CHECK (
        app.has_role('admin')
        AND author_id = app.current_user_id()
        AND author_kind = 'staff');

-- ---------------------------------------------------------------------- права
-- DELETE не выдаётся ни на одну из двух таблиц: обращение закрывают, а не
-- стирают. UPDATE на сообщениях тоже нет — отредактированная задним числом
-- переписка перестаёт быть переписью.
GRANT SELECT, INSERT, UPDATE ON comms.support_tickets  TO app_backend;
GRANT SELECT, INSERT         ON comms.support_messages TO app_backend;
