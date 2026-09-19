-- M120 — прекращение доступа отдельно от завершённой работы.
--
-- Разбор замечания владельца 2026-09-20. В `expert_assignments` один столбец
-- `status` отвечал сразу на два разных вопроса:
--
--   1. что стало с РАБОТОЙ — назначен, принял, отказался, выполнил, просрочено;
--   2. открыт ли ДОСТУП к закрытым данным проекта.
--
-- Пока они совпадали, выходило противоречие. Предикат `is_assigned_reviewer`
-- (M021) считает доступ открытым и при `completed` — сознательно: рецензент,
-- сдавший работу, должен видеть то, о чём писал. Но тогда единственным
-- способом закрыть ему доступ оставалось переписать `status`, то есть сделать
-- вид, что работы не было. Приложение это запрещало («рецензия уже подана —
-- назначение снять нельзя»), и получалось, что после сдачи рецензии
-- администратор не может прекратить доступ вообще ничем.
--
-- Здесь это разводится минимально: РАБОТА остаётся в `status` и не
-- переписывается, а ПРЕКРАЩЕНИЕ ДОСТУПА становится отдельным фактом со своим
-- временем, автором и основанием. Рецензия, её авторство и история назначения
-- не трогаются ни при каком исходе.
--
-- Почему не «удалить назначение». Удаление стёрло бы основание, по которому
-- рецензия была написана: рецензия без назначения — документ без полномочия
-- автора. История обязана оставаться читаемой задним числом.
--
-- Почему прекращение необратимо. «Вернуть доступ» — это не откат записи о
-- прекращении, а НОВОЕ решение: заводится новое назначение, с новым временем и
-- основанием. Обратное означало бы, что запись о прекращении можно стереть, и
-- тогда она ничего не доказывает.
--
-- Кто может прекратить. Политика обновления (M007) допускает к строке и самого
-- эксперта. Для этого поля это безопасно в одну сторону: закрыть себе доступ
-- он вправе, а СНЯТЬ отметку не может — запрещено триггером ниже. Поэтому
-- отметка не обходится тем, на кого она выписана, даже если он как-то изменит
-- `status`.

ALTER TABLE experts.expert_assignments
    ADD COLUMN access_revoked_at    TIMESTAMPTZ,
    ADD COLUMN access_revoked_by    UUID REFERENCES identity.users(id),
    ADD COLUMN access_revoke_reason TEXT,
    -- Прекращение без основания не бывает: запись должна объяснять себя.
    ADD CONSTRAINT assignments_revoke_reason_present
        CHECK ((access_revoked_at IS NULL) = (access_revoke_reason IS NULL));

COMMENT ON COLUMN experts.expert_assignments.access_revoked_at IS
    'Момент прекращения доступа по этому назначению. Работа (status) при этом '
    'не переписывается: сданная рецензия остаётся сданной.';
COMMENT ON COLUMN experts.expert_assignments.access_revoke_reason IS
    'Основание прекращения доступа. Обязательно — это решение человека.';

CREATE INDEX assignments_access_live
    ON experts.expert_assignments (project_id, expert_id, purpose)
    WHERE access_revoked_at IS NULL;

-- Отметку о прекращении нельзя ни снять, ни передвинуть задним числом.
CREATE OR REPLACE FUNCTION experts.guard_access_revocation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, experts, pg_temp
AS $$
BEGIN
    IF OLD.access_revoked_at IS NOT NULL
       AND NEW.access_revoked_at IS DISTINCT FROM OLD.access_revoked_at THEN
        RAISE EXCEPTION
            'доступ по назначению уже прекращён: вернуть его можно только новым назначением'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER assignments_access_revocation_guard
    BEFORE UPDATE ON experts.expert_assignments
    FOR EACH ROW EXECUTE FUNCTION experts.guard_access_revocation();

-- -----------------------------------------------------------------------------
-- Предикаты доступа: прекращение закрывает доступ при ЛЮБОМ состоянии работы.
--
-- Состав `status` не меняется — он по-прежнему отвечает за работу. Добавлено
-- одно условие: живой считается только та строка, по которой доступ не
-- прекращён.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION experts.is_assigned_reviewer(p_project_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, experts, public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM experts.expert_assignments ea
        WHERE ea.project_id = p_project_id
          AND ea.expert_id = p_user_id
          -- Отказ и просрочка доступ закрывают: работа по проекту не ведётся.
          -- `completed` доступ оставляет: сдавший рецензию видит то, о чём
          -- писал, — пока администратор не прекратит доступ явно.
          AND ea.status IN ('assigned', 'accepted', 'completed')
          AND ea.access_revoked_at IS NULL
    );
$$;

COMMENT ON FUNCTION experts.is_assigned_reviewer(UUID, UUID) IS
    'Есть ли у эксперта живое или выполненное назначение на проект, доступ по которому '
    'не прекращён (M120). Предикат RLS: доступ рецензента ограничен фактом назначения, '
    'а не ролью; прекращение доступа не отменяет проделанную работу.';

CREATE OR REPLACE FUNCTION experts.is_assigned_deal_supporter(p_project_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, experts, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM experts.expert_assignments ea
        WHERE ea.project_id = p_project_id
          AND ea.expert_id = p_user_id
          AND ea.purpose = 'deal_support'
          AND ea.status IN ('assigned', 'accepted', 'completed')
          AND ea.access_revoked_at IS NULL
    );
$$;

COMMENT ON FUNCTION experts.is_assigned_deal_supporter(UUID, UUID) IS
    'Сопровождает ли пользователь сделки проекта (M099, M120). Доступа к анкете, оценкам '
    'и материалам не даёт: отвечает только за область денежных действий. Прекращённый '
    'доступ (access_revoked_at) закрывает область при любом состоянии работы.';

GRANT EXECUTE ON FUNCTION experts.is_assigned_deal_supporter(UUID, UUID)
    TO app_backend, app_billing;

-- -----------------------------------------------------------------------------
-- Рецензия не исчезает вместе с доступом.
--
-- Это уже так по устройству: `expert_reviews` живёт своей строкой со ссылкой
-- на назначение и на автора, и ничто в этой миграции их не трогает. Запрет
-- удаления ставится явно, чтобы «прекратить доступ» никогда не превратилось в
-- «стереть работу» — ни через приложение, ни прямым запросом из-под роли
-- приложения.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION experts.forbid_review_deletion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, experts, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION
        'рецензию нельзя удалить: это выполненная работа с указанным автором'
        USING ERRCODE = '42501';
END $$;

CREATE TRIGGER expert_reviews_no_delete
    BEFORE DELETE ON experts.expert_reviews
    FOR EACH ROW EXECUTE FUNCTION experts.forbid_review_deletion();
