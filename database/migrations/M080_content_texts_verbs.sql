-- M080 — глаголы аудита продуктовых текстов (словарь, ЧАВО; план 0.2 §2.6).
--
-- Реестр fail-closed (M001): незарегистрированный verb роняет транзакцию.
-- Как и в M049, глаголы регистрируются отдельно от схемы M079.

INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('content.text.published',
     'Опубликована новая версия текста записи (термин, ЧАВО) на языке',
     ARRAY['admin']),
    ('content.text.withdrawn',
     'Действующая версия текста закрыта без замены',
     ARRAY['admin']),
    ('content.text_entry.updated',
     'Изменены свойства записи: порядок или активность',
     ARRAY['admin'])
ON CONFLICT (verb) DO NOTHING;
