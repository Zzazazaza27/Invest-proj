-- M159 — ключи повтора изменяющих операций (блок 2, 2.6; первый пакет 08.11.2026).
--
-- Строка ключа пишется В ТОЙ ЖЕ транзакции, что и само изменение: она появляется только
-- вместе с результатом и исчезает вместе с откатом. Состояния «выполняется» в таблице нет:
-- его даёт блокировка уникального индекса, пока первая транзакция не завершилась, — вечной
-- блокировки ключа после сбоя не бывает.
--
-- Область ключа: действующее лицо + операция + ключ. Объект операции (проект, обращение)
-- входит в отпечаток и хранится отдельно: тот же ключ для другого объекта — конфликт, а не
-- чужой результат. Результат хранится ссылкой на объект; повторный ответ читается заново с
-- текущими правами.
--
-- Окно повтора — 7 дней (expires_at). Очистка не включена: просроченный ключ даёт явный
-- отказ, а не новую работу.

CREATE SCHEMA requests;

CREATE TABLE requests.idempotency_keys (
    actor_id      UUID        NOT NULL REFERENCES identity.users(id),
    operation     TEXT        NOT NULL CHECK (operation IN (
                      'lab.project.create',
                      'lab.material.link',
                      'support.ticket.open',
                      'support.message.add')),
    key           TEXT        NOT NULL CHECK (key ~ '^[A-Za-z0-9_-]{16,128}$'),
    object_id     UUID,
    request_hash  BYTEA       NOT NULL CHECK (octet_length(request_hash) = 32),
    result_id     UUID        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (actor_id, operation, key)
);

COMMENT ON TABLE requests.idempotency_keys IS
    'Ключи повтора изменяющих операций (2.6): строка появляется в транзакции изменения, '
    'результат — ссылкой, читается заново с текущими правами (M159).';

ALTER TABLE requests.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE requests.idempotency_keys FORCE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA requests TO app_backend;
GRANT SELECT, INSERT ON requests.idempotency_keys TO app_backend;

-- Только свои ключи: чужой ключ не виден и не даёт ни результата, ни признака существования.
CREATE POLICY idempotency_keys_own ON requests.idempotency_keys
    FOR SELECT TO app_backend
    USING (actor_id = app.current_user_id());

CREATE POLICY idempotency_keys_own_insert ON requests.idempotency_keys
    FOR INSERT TO app_backend
    WITH CHECK (actor_id = app.current_user_id());
