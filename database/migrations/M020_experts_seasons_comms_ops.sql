-- =============================================================================
-- M020 — операционный слой экспертизы, сезонного рейтинга и уведомлений
--
-- Ф8 добавляет прикладной контур поверх схем M007/M008. Здесь ровно то, что
-- нельзя сделать из приложения:
--
--  1. Реестр verb'ов. Событие с незарегистрированным verb не пишется вовсе
--     (M001, fail-closed), поэтому назначение эксперта, декларация конфликта и
--     золотой билет обязаны попасть в реестр ДО первой попытки их записать.
--  2. Обновление материализованного представления рейтинга. `REFRESH
--     MATERIALIZED VIEW` требует прав ВЛАДЕЛЬЦА представления, а роль
--     приложения владельцем не является и быть им не должна. Расширять её
--     права нельзя — значит, нужна узкая SECURITY DEFINER-функция с
--     собственной проверкой роли внутри.
--  3. Шаблоны уведомлений фазы. Текст, который увидит пользователь, — это
--     данные, а не код: он живёт в БД версионируемой строкой.
-- =============================================================================

-- ------------------------------------------------------ реестр типов событий
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('lab.expert.assigned',           'Проект назначен эксперту на рецензию',  ARRAY['admin','organizer']),
    ('lab.expert.assignment_closed',  'Эксперт принял, отклонил или завершил назначение', ARRAY['expert','admin','organizer']),
    ('lab.expert.conflict_declared',  'Эксперт заявил конфликт интересов',     ARRAY['expert','admin']),
    ('lab.expert.conflict_resolved',  'Комплаенс разрешил конфликт интересов', ARRAY['admin','organizer']),
    ('lab.golden_ticket.granted',     'Выдан золотой билет сезона',            ARRAY['admin','organizer'])
ON CONFLICT (verb) DO NOTHING;

-- --------------------------------------------------- обновление рейтинга сезона
-- Почему функция, а не прямой REFRESH из приложения: владельцем представления
-- является роль миграций, и передавать это владение роли, обслуживающей
-- запросы пользователей, — значит отдать ей право переписать определение
-- рейтинга. Функция делает ровно одну операцию и проверяет роль вызывающего
-- сама: SECURITY DEFINER без внутренней проверки был бы дырой, а не решением.
--
-- CONCURRENTLY обязателен: обычный REFRESH берёт ACCESS EXCLUSIVE и на время
-- пересчёта публичный рейтинг перестал бы читаться. Уникальный индекс
-- mv_season_rating_uq (M007) — необходимое для этого условие, он уже есть.
CREATE OR REPLACE FUNCTION seasons.refresh_rating()
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, seasons, app, public
AS $$
BEGIN
    IF NOT (app.has_role('admin') OR app.has_role('organizer')) THEN
        RAISE EXCEPTION 'rating refresh requires admin or organizer role'
            USING ERRCODE = '42501';
    END IF;

    -- Один пересчёт за раз. Параллельные вызовы не ломают представление, но
    -- впустую держат соединения на одной и той же работе.
    PERFORM pg_advisory_xact_lock(hashtextextended('seasons.refresh_rating', 0));

    REFRESH MATERIALIZED VIEW CONCURRENTLY seasons.mv_season_rating;
    RETURN clock_timestamp();
END $$;

COMMENT ON FUNCTION seasons.refresh_rating() IS
    'Пересчёт материализованного рейтинга сезонов. SECURITY DEFINER из-за '
    'владения представлением; роль вызывающего проверяется внутри функции.';

REVOKE ALL ON FUNCTION seasons.refresh_rating() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seasons.refresh_rating() TO app_backend;

-- ------------------------------------------------------ шаблоны уведомлений
-- Канальная политика прежняя (docs/architecture/Database_Launch.md §10): сервисные уведомления
-- идут push → telegram → email. ПДн в шаблоны не попадают: подставляются
-- название проекта и номер сезона, но не имена и не контакты.
INSERT INTO comms.notification_templates
    (id, code, channel, locale, version, title_template, body_template, fallback_chain, is_critical) VALUES
    (public.uuid_generate_v7(),'expert.assignment.created','push','ru-RU',1,
     'Новая заявка на рецензию','Проект «{{project_title}}» ждёт вашей оценки до {{due_at}}.',
     ARRAY['telegram','email'], false),
    (public.uuid_generate_v7(),'expert.assignment.created','email','ru-RU',1,
     'Новая заявка на рецензию',
     'Проект «{{project_title}}» назначен вам на рецензию. Срок — {{due_at}}. '
     'Если есть конфликт интересов, заявите его до начала работы.',
     ARRAY[]::TEXT[], false),

    (public.uuid_generate_v7(),'expert.consensus.decided','push','ru-RU',1,
     'Решение по проекту','По проекту «{{project_title}}» принято решение: {{decision}}.',
     ARRAY['telegram','email'], false),

    (public.uuid_generate_v7(),'season.rating.published','push','ru-RU',1,
     'Рейтинг сезона обновлён','Рейтинг сезона {{season_number}} пересчитан.',
     ARRAY['telegram'], false),

    (public.uuid_generate_v7(),'season.golden_ticket.granted','push','ru-RU',1,
     'Золотой билет','Проект «{{project_title}}» получил золотой билет сезона.',
     ARRAY['telegram','email'], false),
    (public.uuid_generate_v7(),'season.golden_ticket.granted','email','ru-RU',1,
     'Золотой билет сезона',
     'Проект «{{project_title}}» получил золотой билет и проходит в следующий этап сезона.',
     ARRAY[]::TEXT[], false)
ON CONFLICT (code, channel, locale, version) DO NOTHING;
