-- M074 — глаголы аудита конфигурации вопросов заявки (этап 3, план 0.2 §0в).
--
-- Реестр fail-closed (M001): незарегистрированный verb роняет транзакцию
-- сервиса. Как и в M072, глаголы регистрируются отдельно от схемы M073.
--
-- Публикует и активирует версии только администратор; `system` — для сида
-- стартовой версии и служебных прогонов.

INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('lab.application_form.draft_saved',
     'Черновик конфигурации вопросов сохранён (в контексте — число разделов и вопросов)',
     ARRAY['admin']),
    ('lab.application_form.published',
     'Опубликована новая версия конфигурации вопросов; она стала активной для новых заявок',
     ARRAY['admin','system']),
    ('lab.application_form.activated',
     'Активирована ранее опубликованная версия конфигурации вопросов (откат или возврат)',
     ARRAY['admin','system'])
ON CONFLICT (verb) DO NOTHING;
