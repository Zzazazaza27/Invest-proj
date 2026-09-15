-- M076 — глагол аудита активации весов готовности (этап 3.4, план 0.2 §2.7).
--
-- Реестр fail-closed (M001): незарегистрированный verb роняет транзакцию
-- сервиса. Как и в M072/M074, глагол регистрируется отдельно от схемы M075.

INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('lab.readiness_config.activated',
     'Активирована новая версия весов готовности заявки; черновики считаются по ней, снимки не меняются',
     ARRAY['admin','system'])
ON CONFLICT (verb) DO NOTHING;
