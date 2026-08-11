-- =============================================================================
-- M023 — публикация событий и доставка вебхуков
--
-- Что здесь появляется:
--
--  1. KEK-домен `webhook_secrets`. Секрет подписи вебхука — ключ, которым
--     внешняя система проверяет подлинность доставки. Он не ПДн и не документ,
--     поэтому чужой домен ему не подходит: ротация ключей должна затрагивать
--     ровно свою область, а не тянуть за собой документы KYC.
--  2. Индекс очереди доставки по эндпоинту — по нему доставщик выбирает
--     работу и по нему же считается отставание.
--  3. Право доставщика помечать событие опубликованным.
-- =============================================================================

-- ------------------------------------------------------------- KEK-домен
ALTER TABLE audit.encryption_keys_registry
    DROP CONSTRAINT IF EXISTS encryption_keys_registry_domain_check;

ALTER TABLE audit.encryption_keys_registry
    ADD CONSTRAINT encryption_keys_registry_domain_check CHECK (domain IN
        ('kyc_documents','kyb_documents','passport_sensitive',
         'investment_documents','nominal_account_evidence',
         'billing_documents','search_index','webhook_secrets'));

INSERT INTO audit.encryption_keys_registry (id, domain, kms_key_id) VALUES
    (public.uuid_generate_v7(), 'webhook_secrets', 'local/webhook_secrets/v1')
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------- очередь доставки
-- Доставщик забирает работу по (status, next_retry_at) — индекс на это уже
-- есть (M010). Здесь добавляется выборка «что происходит с конкретным
-- эндпоинтом»: без неё диагностика отстающего потребителя требует полного
-- прохода по таблице доставок.
CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint
    ON integration.webhook_deliveries (endpoint_id, created_at DESC);

-- ------------------------------------------------------------------ права
-- Публикация в NATS и постановка доставок идут под ролью интеграции: она
-- владеет вебхуками. Чтобы пометить событие опубликованным, ей нужно право
-- на UPDATE самого outbox — оно уже выдано в M001, здесь фиксируется явно
-- вместе с чтением реестра типов событий.
GRANT SELECT, UPDATE ON audit.outbox_events TO app_integration;

-- ------------------------------------------------- статус доставки в отчёте
COMMENT ON TABLE integration.webhook_deliveries IS
    'Очередь доставки событий подписчикам. Статус exhausted означает, что '
    'попытки исчерпаны: событие остаётся в журнале, но доставка прекращена — '
    'бесконечные ретраи к отвалившемуся потребителю превращаются в DoS против '
    'собственной инфраструктуры.';
