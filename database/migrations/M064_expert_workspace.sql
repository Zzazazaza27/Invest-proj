-- =============================================================================
-- M064 — рабочая зона эксперта: заметки, пересмотр рецензии, история
--
-- ТЗ требовало сначала разобрать существующий workflow и включиться в него, а
-- не строить рядом второй. Разбор дал следующее.
--
-- ЧТО УЖЕ БЫЛО (M007, M025):
--   * роль `expert` и таблица `experts.experts`;
--   * назначение на проект от организатора со сроком
--     (`expert_assignments`: assigned → accepted/declined → completed/expired);
--   * доступ эксперта к материалам назначенного проекта;
--   * рецензия по рубрике из шести критериев с рекомендацией
--     (`expert_reviews.recommendation`: pass / fail / needs_review);
--   * блокировка назначения при незакрытом конфликте интересов (триггер);
--   * консенсус организатора (`review_consensus.final_decision`);
--   * движение проекта по воронке `lab.projects.status`
--     (draft → submitted → ai_review → expert_review → bootcamp → finalist →
--     graduated, выход в rejected/archived с любого этапа), с запретом
--     перепрыгивать и откатываться (`lab.enforce_stage_order`);
--   * КАЖДОЕ действие эксперта уже пишется в журнал `audit.events` —
--     хеш-сцепленный и неизменяемый.
--
-- Отсюда прямое следствие: НОВЫХ СТАТУСОВ НЕ ВВОДИТСЯ. ТЗ прямо запрещает
-- добавлять `pending_review/in_review/approved/needs_revision/rejected`, если
-- в проекте уже действует другая статусная модель. Она действует, и она
-- богаче: состояние рассмотрения = статус назначения + рекомендация рецензии +
-- решение консенсуса.
--
-- ЧЕГО НЕ ХВАТАЛО — и что закрывает эта миграция:
--
--  1. ВНУТРЕННИЙ КОММЕНТАРИЙ ПО ХОДУ. Заключение эксперта есть, но только
--     одно и только в момент подачи рецензии. Записать «запросил
--     допматериалы, жду» было негде, а такие записи и составляют ход
--     рассмотрения.
--
--  2. ПЕРЕСМОТР РЕЗУЛЬТАТА. Рецензия подавалась ровно один раз и после этого
--     была неизменяемой. ТЗ требует «возможность изменить результат
--     рассмотрения В ПРЕДЕЛАХ РАЗРЕШЁННОГО workflow» — то есть пока решение
--     не принято. После консенсуса менять рецензию нельзя: это переписывание
--     основания уже принятого решения.
--
--  3. ЧТЕНИЕ ИСТОРИИ. Журнал `audit.events` отдаёт эксперту только СОБСТВЕННЫЕ
--     записи (`events_read_own`), поэтому в истории своего же назначения он не
--     видел ни момента назначения, ни того, кто его назначил.
-- =============================================================================

-- ------------------------------------------------ внутренние заметки эксперта
--
-- Append-only по смыслу: заметка — след хода рассмотрения, а не черновик.
-- Отредактированная задним числом заметка не является записью о том, что
-- думал эксперт тогда. Поэтому ни UPDATE, ни DELETE не выдаются.
--
-- Заметка привязана к НАЗНАЧЕНИЮ, а не к проекту: у разных экспертов по
-- одному проекту разные ходы рассмотрения, и смешивать их в один список —
-- значит показать эксперту рассуждения коллеги до консенсуса.
CREATE TABLE experts.expert_notes (
    id            UUID PRIMARY KEY,
    assignment_id UUID NOT NULL REFERENCES experts.expert_assignments(id),
    author_id     UUID NOT NULL REFERENCES identity.users(id),
    body          TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX expert_notes_assignment ON experts.expert_notes (assignment_id, created_at);

COMMENT ON TABLE experts.expert_notes IS
    'Внутренние заметки эксперта по ходу рассмотрения. Append-only: правка задним '
    'числом перестаёт быть записью о том, что эксперт думал тогда. Автору проекта '
    'не видны — это внутренняя кухня совета, как и рубричные оценки.';

ALTER TABLE experts.expert_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE experts.expert_notes FORCE  ROW LEVEL SECURITY;

-- Свои заметки видит автор; все — админ и организатор, которым принимать
-- решение. Автор проекта здесь отсутствует намеренно.
CREATE POLICY expert_notes_read ON experts.expert_notes FOR SELECT TO app_backend USING (
    author_id = app.current_user_id()
    OR app.has_role('admin')
    OR app.has_role('organizer'));

-- Писать может только эксперт, только от своего имени и только по СВОЕМУ
-- назначению. Условие про назначение не декоративное: без него эксперт
-- оставляет заметку в чужом рассмотрении.
CREATE POLICY expert_notes_write ON experts.expert_notes FOR INSERT TO app_backend
    WITH CHECK (
        author_id = app.current_user_id()
        AND EXISTS (SELECT 1 FROM experts.expert_assignments ea
                     WHERE ea.id = assignment_id
                       AND ea.expert_id = app.current_user_id()));

GRANT SELECT, INSERT ON experts.expert_notes TO app_backend;

-- ------------------------------------- пересмотр рецензии до решения по проекту
--
-- Право UPDATE на рецензию у эксперта было и раньше (политика
-- `reviews_expert_own` — FOR ALL), но ничто не мешало переписать её ПОСЛЕ
-- того, как организатор принял решение на её основании. Граница ставится в
-- БД, а не в коде маршрута: обойти её прямым доступом тогда невозможно.
--
-- Заодно запрещается перенос рецензии на другое назначение: смена
-- `assignment_id` превратила бы рецензию одного проекта в рецензию другого.
CREATE OR REPLACE FUNCTION experts.enforce_review_revision_window()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, experts, public
AS $$
DECLARE
    v_project UUID;
BEGIN
    IF NEW.assignment_id IS DISTINCT FROM OLD.assignment_id THEN
        RAISE EXCEPTION 'review cannot be moved to another assignment'
            USING ERRCODE = '42501';
    END IF;

    SELECT ea.project_id INTO v_project
      FROM experts.expert_assignments ea
     WHERE ea.id = NEW.assignment_id;

    IF EXISTS (SELECT 1 FROM experts.review_consensus rc WHERE rc.project_id = v_project) THEN
        RAISE EXCEPTION 'review is final: consensus already decided for project %', v_project
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER expert_reviews_revision_window
    BEFORE UPDATE ON experts.expert_reviews
    FOR EACH ROW EXECUTE FUNCTION experts.enforce_review_revision_window();

COMMENT ON FUNCTION experts.enforce_review_revision_window() IS
    'Рецензию можно пересмотреть, пока по проекту не принято решение консенсуса. '
    'После — она основание принятого решения, и переписывать её нельзя.';

-- --------------------------------------------- история собственного назначения
--
-- `events_read_own` (M001) отдаёт эксперту только те записи журнала, где он
-- сам — действующее лицо. В истории СВОЕГО назначения он из-за этого не видел
-- ни момента назначения, ни того, кто его назначил.
--
-- Политика ниже расширяет чтение ровно на предмет собственного назначения и
-- ни на что больше: субъект события обязан быть назначением, а назначение —
-- принадлежать читающему. Payload таких событий содержит идентификатор
-- проекта, статус назначения и рекомендацию — всё это эксперт и так знает.
CREATE POLICY events_read_expert_assignment ON audit.events FOR SELECT USING (
    subject_type = 'expert_assignment'
    AND EXISTS (SELECT 1 FROM experts.expert_assignments ea
                 WHERE ea.id = audit.events.subject_id
                   AND ea.expert_id = app.current_user_id()));

-- --------------------------------------------- решение по рассмотренному проекту
--
-- `consensus_read` (M007) пускает участника проекта, админа и организатора —
-- но не эксперта, который этот проект и рецензировал. Из-за этого кабинет
-- эксперта не мог показать, ЧЕМ закончилось рассмотрение, и, что хуже, не мог
-- честно ответить на вопрос «можно ли ещё пересмотреть рецензию»: строка
-- решения ему не видна, и любой расчёт по ней молча давал бы «можно».
--
-- Открывается ровно решение по проекту, на который эксперт назначен. Ни
-- рецензии коллег, ни состав рецензентов эта политика не раскрывает.
CREATE POLICY consensus_read_assigned_expert ON experts.review_consensus FOR SELECT
    TO app_backend USING (
        EXISTS (SELECT 1 FROM experts.expert_assignments ea
                 WHERE ea.project_id = review_consensus.project_id
                   AND ea.expert_id = app.current_user_id()));

-- ------------------------------------------------------- новые глаголы журнала
--
-- Пересмотр рецензии и внутренняя заметка — такие же действия эксперта, как
-- подача рецензии, и обязаны попадать в тот же журнал. Реестр глаголов —
-- allowlist: незарегистрированный verb `app_emit_event` не пропустит, и
-- действие осталось бы без следа.
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('lab.expert.review_revised', 'Эксперт пересмотрел свою рецензию до решения консенсуса',
     ARRAY['expert','system']),
    ('lab.expert.note_added',     'Эксперт оставил внутреннюю заметку по ходу рассмотрения',
     ARRAY['expert','system'])
ON CONFLICT (verb) DO NOTHING;
