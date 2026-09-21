-- =============================================================================
-- M123 — блокировка учётной записи: причина, автор, время. И события журнала
-- для действий администратора над человеком.
--
-- Нового статуса НЕ заводится. `identity.users.status` уже знает `suspended`,
-- и вход этот статус уже проверяет (`IdentityService.verifyPassword`). Второй
-- признак блокировки стал бы вторым местом правды, и однажды они разошлись бы.
--
-- Что действительно отсутствовало — ответ на вопросы «почему» и «кто». Журнал
-- их знает, но карточка не должна раскапывать историю, чтобы показать текущее
-- состояние: причина действующей блокировки — это свойство состояния, а не
-- архивная запись. Поэтому три колонки рядом со статусом, а история по-прежнему
-- в журнале.
--
-- Возврат из блокировки. Вернуть всех в `active` нельзя: триггер
-- `users_activation_requires_consents` (M002) не пускает в `active` без
-- акцептов актуальных версий четырёх документов, и это правильно. Поэтому
-- сервис возвращает человека в то состояние, которое ему полагается по
-- акцептам: `active` при полном наборе, иначе `pending_consents`. Функция
-- `identity.has_required_consents` для этого уже есть.
-- =============================================================================

ALTER TABLE identity.users
    ADD COLUMN IF NOT EXISTS status_reason     TEXT,
    ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS status_changed_by UUID REFERENCES identity.users(id);

COMMENT ON COLUMN identity.users.status_reason IS
    'Причина последней смены состояния администратором (M123). Не журнал, а свойство '
    'текущего состояния: карточка показывает, почему аккаунт закрыт, не читая историю.';
COMMENT ON COLUMN identity.users.status_changed_by IS
    'Кто сменил состояние. NULL — состояние сложилось само (регистрация, акцепты).';

-- Причина обязательна ровно там, где она имеет смысл: у блокировки. Для
-- остальных состояний пустая причина — норма, и требовать её значило бы
-- заставлять придумывать текст на ровном месте.
ALTER TABLE identity.users
    ADD CONSTRAINT users_suspension_reason_required
    CHECK (status <> 'suspended' OR (status_reason IS NOT NULL AND length(btrim(status_reason)) >= 3));

-- --------------------------------------------------------- события журнала
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('identity.user.suspended',
     'Администратор заблокировал учётную запись', ARRAY['admin']),
    ('identity.user.restored',
     'Администратор снял блокировку с учётной записи', ARRAY['admin']),
    ('identity.user.profile_updated',
     'Изменено обычное профильное поле пользователя', ARRAY['admin', 'founder', 'investor', 'expert', 'organizer'])
ON CONFLICT (verb) DO NOTHING;

COMMENT ON CONSTRAINT users_suspension_reason_required ON identity.users IS
    'Блокировка без причины запрещена на уровне БД (M123): причина нужна и человеку, '
    'и разбору инцидента, и сервисный слой здесь не единственная защита.';
