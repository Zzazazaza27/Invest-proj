-- =============================================================================
-- M026 — тексты уведомлений об этапах сезона
--
-- Отдельная миграция от M025 намеренно: M025 описывает правила доступа и
-- переходов, а здесь — данные, которые видит пользователь. Их дальше правит
-- админский API (`/admin/notification-templates`), а не миграция; миграция
-- задаёт лишь начальный набор, чтобы первый же перевод проекта не упёрся в
-- отсутствующий шаблон.
--
-- Конфигурация воронки сезона (квоты и расписание этапов) живёт в уже
-- существующей `seasons.seasons.funnel_config_jsonb` — новых колонок не нужно,
-- форму проверяет контракт `SeasonFunnelConfigSchema`.
-- =============================================================================

-- Настройка воронки — отдельное событие, а не разновидность смены этапа:
-- у них разный агрегат (сезон против проекта) и разный смысл в журнале.
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('lab.season.funnel_configured', 'Заданы квоты и расписание этапов сезона', ARRAY['admin','organizer'])
ON CONFLICT (verb) DO NOTHING;

INSERT INTO comms.notification_templates
    (id, code, channel, locale, version, title_template, body_template, fallback_chain, is_critical) VALUES
    (public.uuid_generate_v7(),'season.stage.advanced','push','ru-RU',1,
     'Проект прошёл дальше',
     'Проект «{{project_title}}» переведён на этап «{{stage_title}}» сезона {{season_number}}.',
     ARRAY['telegram','email'], false),
    (public.uuid_generate_v7(),'season.stage.advanced','email','ru-RU',1,
     'Новый этап сезона',
     'Проект «{{project_title}}» переведён на этап «{{stage_title}}» сезона {{season_number}}. '
     'Подробности и следующие шаги — в кабинете основателя.',
     ARRAY[]::TEXT[], false),

    (public.uuid_generate_v7(),'season.stage.rejected','push','ru-RU',1,
     'Решение по заявке',
     'Заявка проекта «{{project_title}}» не проходит дальше в сезоне {{season_number}}.',
     ARRAY['telegram','email'], false),
    (public.uuid_generate_v7(),'season.stage.rejected','email','ru-RU',1,
     'Решение по заявке сезона',
     'Заявка проекта «{{project_title}}» не проходит дальше в сезоне {{season_number}}. '
     'Заявку можно доработать и подать в следующем сезоне.',
     ARRAY[]::TEXT[], false)
ON CONFLICT (code, channel, locale, version) DO NOTHING;
