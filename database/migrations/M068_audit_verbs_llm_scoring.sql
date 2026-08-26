-- M068 — регистрация глаголов аудита Ф68 (ключи провайдера, решения по потолкам).
--
-- Реестр событий fail-closed (M001): незарегистрированный verb роняет
-- audit.app_emit_event с 42501, а вместе с ней — всю транзакцию сервиса.
-- Именно так упал PUT /v1/admin/ai/credentials на стенде: ядро писало
-- событие, о котором база не знала. Тесты ядра аудит подменяют, поэтому
-- расхождение поймал только живой вызов; с этой миграции сверка глаголов кода
-- и реестра — отдельный тест БД (invariants.test.ts).
--
-- Роли: только администратор и система. Ключ провайдера и решение по потолку
-- — административные действия; founder/investor/expert их не совершают.

INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('admin.ai_provider_credential.set',
     'Ключ провайдера LLM задан или заменён (в журнале — отпечаток, не ключ)',
     ARRAY['admin','system']),
    ('admin.ai_provider_credential.revoked',
     'Ключ провайдера LLM отозван',
     ARRAY['admin','system']),
    ('admin.scoring_review.decided',
     'Решение администратора по потолкам балла или комплаенс-флагам паспорта',
     ARRAY['admin','system'])
ON CONFLICT (verb) DO NOTHING;
