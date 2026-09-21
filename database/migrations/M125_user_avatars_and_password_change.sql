-- =============================================================================
-- M125 — аватар пользователя и смена пароля из кабинета (этап 6.4).
--
-- Два разных долга, закрываемых одной миграцией, потому что оба про «человек
-- распоряжается своей учётной записью», и оба требуют явного расширения прав.
--
-- 1. АВАТАР. В модели пользователя его не было вовсе: в шапке кабинетов
--    рисовалась безликая плитка. Хранение устроено так же, как у изображений
--    проекта (M119), и по тем же причинам: оригинал в приватном бакете,
--    варианты пересчитываются платформой, байты отдаёт маршрут ядра, а не
--    публичная раздача объектов. Повторять чужую таблицу — не дублирование:
--    у аватара другой владелец (человек, а не проект), другая политика
--    доступа и другой жизненный цикл.
--
-- 2. ПАРОЛЬ. M056 отобрала у `app_backend` табличный UPDATE и выдала
--    поколоночный, оставив прямую запись в комментарии: «password_hash —
--    смены пароля в API пока нет; появится — грант расширяется явным шагом,
--    а не по умолчанию». Этот шаг здесь. Ничего, кроме `password_hash`, не
--    открывается.
-- =============================================================================

-- ------------------------------------------------------------------- аватар
CREATE TABLE identity.user_avatars (
    user_id     UUID PRIMARY KEY REFERENCES identity.users(id),

    -- Оригинал как загрузил человек: из него пересчитываются размеры, если
    -- набор вариантов изменится.
    master_key  TEXT NOT NULL,
    -- {"sm": {"key": …, "width": …, "height": …}, "md": {…}} — ключи объектов
    -- принадлежат платформе и наружу не отдаются.
    variants    JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Свойства файла, определённые РАЗБОРОМ изображения, а не заголовком.
    mime        TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
    bytes       INTEGER NOT NULL CHECK (bytes > 0),
    width       INTEGER NOT NULL CHECK (width > 0),
    height      INTEGER NOT NULL CHECK (height > 0),

    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE identity.user_avatars IS
    'Аватар пользователя (M125). Байты в приватном хранилище; отдаёт маршрут ядра. '
    'Один аватар на человека: вопроса «который из трёх настоящий» быть не должно.';

ALTER TABLE identity.user_avatars ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.user_avatars FORCE  ROW LEVEL SECURITY;

/**
 * Кто видит запись об аватаре.
 *
 * Аватар — это то, что человек показывает другим: он стоит в шапке, в списке
 * участников, в карточке администратора. Прятать САМ ФАКТ его наличия от
 * других участников платформы бессмысленно — картинку всё равно видно там,
 * где видно человека. Поэтому чтение открыто любому аутентифицированному
 * запросу, но НЕ анонимному: перебирать аватары по идентификаторам снаружи
 * незачем.
 */
CREATE POLICY user_avatars_read ON identity.user_avatars FOR SELECT
    TO app_backend USING (app.current_user_id() IS NOT NULL);

/** Меняет только владелец. Администратор чужой аватар не подменяет. */
CREATE POLICY user_avatars_own_write ON identity.user_avatars FOR ALL
    TO app_backend
    USING (user_id = app.current_user_id())
    WITH CHECK (user_id = app.current_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.user_avatars TO app_backend;

-- ------------------------------------------------------- смена пароля: грант
-- Явный шаг, обещанный в M056. Только эта колонка и только app_backend.
GRANT UPDATE (password_hash) ON identity.users TO app_backend;

-- ------------------------------------------------------------ события журнала
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('identity.password.changed',
     'Пароль изменён владельцем из кабинета',
     ARRAY['admin', 'founder', 'investor', 'expert', 'organizer', 'corporate', 'showrunner']),
    ('identity.avatar.set',
     'Аватар загружен или заменён',
     ARRAY['admin', 'founder', 'investor', 'expert', 'organizer', 'corporate', 'showrunner']),
    ('identity.avatar.removed',
     'Аватар удалён',
     ARRAY['admin', 'founder', 'investor', 'expert', 'organizer', 'corporate', 'showrunner'])
ON CONFLICT (verb) DO NOTHING;
