-- M164 — ключи повтора для новых операций (блок 2, 2.6; пакет 7 раздела 01, 09.11.2026).
--
-- M159 не правится (forward-only): здесь расширяется её перечень операций.
--
--   * integration.service_account.create / .rotate — секрет показывается ОДИН раз. Запись
--     ключа, как и в M159, хранит ссылку на результат (идентификатор аккаунта), а не ответ:
--     открытого секрета нет ни здесь, ни в журнале, ни в маршруте состояния. Повтор тем же
--     ключом возвращает аккаунт без секрета и с явной пометкой «секрет уже выдан»;
--   * lab.media.finalize — подтверждение загрузки логотипа или обложки; объект операции —
--     проект, в отпечаток входит вид медиа и идентификатор загрузки.
--
-- Права и политики таблицы — прежние (M159): ключ виден и записывается только своему
-- действующему лицу.

ALTER TABLE requests.idempotency_keys DROP CONSTRAINT idempotency_keys_operation_check;
ALTER TABLE requests.idempotency_keys
    ADD CONSTRAINT idempotency_keys_operation_check CHECK (operation IN (
        'lab.project.create',
        'lab.material.link',
        'support.ticket.open',
        'support.message.add',
        'integration.service_account.create',
        'integration.service_account.rotate',
        'lab.media.finalize'));
