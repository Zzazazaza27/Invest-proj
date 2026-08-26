-- M069 — провайдеры LLM Kimi (Moonshot AI) и Qwen (Alibaba Cloud) в списке
-- продуктов «Подключённые API».
--
-- Список провайдеров закрытый (CHECK): панель, контракт и политика шлюза
-- перечисляют те же имена. Новый провайдер — миграция + LlmProviderSchema +
-- LLM_PROVIDERS + ai-policy.json + PROVIDER_TITLES в панели, одним коммитом.
-- Адрес провайдера здесь по-прежнему не хранится — он в политике шлюза.

ALTER TABLE scoring.ai_provider_credentials
    DROP CONSTRAINT IF EXISTS ai_provider_credentials_provider_check;

ALTER TABLE scoring.ai_provider_credentials
    ADD CONSTRAINT ai_provider_credentials_provider_check
    CHECK (provider IN ('yandex_gpt','gigachat','anthropic','openai','kimi','qwen'));
