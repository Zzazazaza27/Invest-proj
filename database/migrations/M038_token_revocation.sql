-- =============================================================================
-- M038 — реестр отозванных токенов: отзыв ОДНОЙ сессии, а не всех сразу
--
-- Остаток находки внешнего аудита (SEC-07/08). Рубеж сессий (M035) обесценивает
-- ВСЕ токены пользователя разом: он отвечает на «права изменились» и «аккаунт
-- скомпрометирован», но не на «выйти на этом устройстве». Выход при этом лишь
-- удалял cookie у клиента — сам токен оставался действительным до `exp`, и
-- скопированное значение продолжало работать час.
--
-- Механика: у токена появляется идентификатор `jti`, и отозванный
-- идентификатор попадает в этот реестр. Проверка идёт на входе, рядом с
-- проверкой рубежа.
--
-- Почему реестр ОТОЗВАННЫХ, а не реестр выданных: список выданных пришлось бы
-- писать при каждом входе и чистить при каждом истечении — запись на горячем
-- пути ради данных, которые нужны в доли процента случаев. Отозванных всегда
-- мало, и хранятся они ровно до `expires_at`: после истечения токен и так
-- недействителен, а строка о нём — мусор.
--
-- Что этот механизм НЕ делает: он не перечисляет активные сессии пользователя.
-- Для списка «где я вошёл» нужен реестр выданных токенов; он не заводится, и
-- такого функционала нет — это записано в TODO, а не выдано за сделанное.
-- =============================================================================

CREATE TABLE IF NOT EXISTS identity.revoked_tokens (
    -- Идентификатор токена. Секретом не является: он и так лежит в полезной
    -- нагрузке у держателя токена, а восстановить по нему подпись нельзя.
    jti          TEXT PRIMARY KEY CHECK (length(jti) BETWEEN 8 AND 128),
    user_id      UUID NOT NULL REFERENCES identity.users (id),
    -- Момент истечения САМОГО токена. После него запись бессмысленна и убирается.
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Кто инициировал отзыв. NULL — системный отзыв без человека.
    revoked_by   UUID REFERENCES identity.users (id),
    reason       TEXT NOT NULL CHECK (reason IN ('logout', 'admin', 'compromise'))
);

COMMENT ON TABLE identity.revoked_tokens IS
    'Отозванные токены по идентификатору jti. Запись живёт до истечения самого '
    'токена, дальше её убирает фоновая уборка (M038).';
COMMENT ON COLUMN identity.revoked_tokens.expires_at IS
    'Истечение токена: после него запись не влияет ни на что и подлежит уборке.';

-- Уборка ходит по сроку истечения, проверка на входе — по первичному ключу.
CREATE INDEX IF NOT EXISTS revoked_tokens_expires_at
    ON identity.revoked_tokens (expires_at);

ALTER TABLE identity.revoked_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.revoked_tokens FORCE ROW LEVEL SECURITY;

-- Свои отзывы видит владелец, чужие — администратор. Перечень отозванных
-- идентификаторов чужих сессий — сам по себе разведывательная информация.
CREATE POLICY revoked_tokens_select_own ON identity.revoked_tokens FOR SELECT TO app_backend
    USING (user_id = app.current_user_id() OR app.has_role('admin'));

-- Отозвать можно свой токен; администратор — чужой (компрометация аккаунта).
CREATE POLICY revoked_tokens_insert ON identity.revoked_tokens FOR INSERT TO app_backend
    WITH CHECK (user_id = app.current_user_id() OR app.has_role('admin'));

-- Проверка на входе идёт до пользовательского контекста, тем же сервисным
-- подключением, что и чтение рубежа сессий (M035).
CREATE POLICY revoked_tokens_system_read ON identity.revoked_tokens FOR SELECT
    TO app_notifications USING (true);

-- Уборка. Удалять разрешено ТОЛЬКО уже истёкшие записи: строка о действующем
-- токене — это и есть механизм отзыва, и снимать её нельзя никому.
--
-- Уборка отдана сервисной роли, а не роли приложения, по двум причинам.
-- Первая — права: пользовательской роли право удалять из реестра отзывов не
-- нужно вовсе. Вторая обнаружена прогоном: DELETE читает строку, поэтому к
-- нему применяется ещё и SELECT-политика. У роли приложения она ограничена
-- своими записями, а уборка идёт БЕЗ пользовательского контекста — и удаляла
-- ноль строк, молча, без ошибки. У сервисной роли SELECT-политика открытая,
-- поэтому уборка действительно убирает.
CREATE POLICY revoked_tokens_delete_expired ON identity.revoked_tokens FOR DELETE
    TO app_notifications USING (expires_at < now());

GRANT SELECT, INSERT ON identity.revoked_tokens TO app_backend;
GRANT SELECT, DELETE ON identity.revoked_tokens TO app_notifications;

INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('identity.token.revoked', 'Отозван отдельный токен сессии', ARRAY['founder', 'investor', 'expert', 'organizer', 'admin'])
ON CONFLICT (verb) DO NOTHING;
