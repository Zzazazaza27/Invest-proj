-- M070 — провайдер LLM DeepSeek в списке продуктов «Подключённые API».
-- Порядок тот же, что в M069: CHECK + LlmProviderSchema + LLM_PROVIDERS +
-- ai-policy.json + PROVIDER_TITLES одним коммитом.

ALTER TABLE scoring.ai_provider_credentials
    DROP CONSTRAINT IF EXISTS ai_provider_credentials_provider_check;

ALTER TABLE scoring.ai_provider_credentials
    ADD CONSTRAINT ai_provider_credentials_provider_check
    CHECK (provider IN ('yandex_gpt','gigachat','anthropic','openai','kimi','qwen','deepseek'));
