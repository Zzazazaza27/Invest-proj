-- =============================================================================
-- M025 — материалы рецензенту, погашение золотого билета, этапы сезона
--
-- Закрывает три позиции техдолга, у которых общий корень: доступ и переходы
-- описаны в модели, но не выражены в правилах БД.
--
--  1. Рецензент видел карточку проекта (M021), но не его версии и материалы —
--     то есть ровно то, что он и должен читать, чтобы написать рецензию.
--     Принцип тот же, что в M021: доступ даётся не роли `expert` вообще, а
--     конкретному эксперту по факту назначения, и отдельной permissive-политикой.
--
--  2. Золотой билет не погашался: колонка `used_at` существовала, но
--     UPDATE-политики у таблицы не было — проставить её было невозможно в
--     принципе. Погашение односторонне: снять отметку нельзя даже админу,
--     иначе билет становится многоразовым в обход лимита на выдающего.
--
--  3. Буткемп и финал были статусами без механики. Переход проекта по этапам
--     сезона — фактическое решение о судьбе заявки, поэтому право на него
--     ограничено организатором и админом, а сам набор допустимых переходов
--     проверяется в приложении (`PROJECT_TRANSITIONS`) и здесь не дублируется:
--     два источника правды о переходах разошлись бы при первом же изменении.
-- =============================================================================

-- ------------------------------------------------------ реестр типов событий
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('lab.project.stage_changed',   'Проект переведён на другой этап сезона', ARRAY['admin','organizer']),
    ('lab.golden_ticket.redeemed',  'Золотой билет погашен при переводе проекта', ARRAY['admin','organizer'])
ON CONFLICT (verb) DO NOTHING;

-- --------------------------------------------- материалы и версии рецензенту
-- Функция-предикат уже есть (M021); ей нужно лишь новое применение.
-- Материалы читаются, но не изменяются: рецензент — читатель чужой заявки.
CREATE POLICY versions_select_reviewer ON lab.project_versions FOR SELECT TO app_backend USING (
    experts.is_assigned_reviewer(project_id, app.current_user_id()));

CREATE POLICY materials_select_reviewer ON lab.project_materials FOR SELECT TO app_backend USING (
    experts.is_assigned_reviewer(project_id, app.current_user_id()));

-- Результат разбора материала — производная того же материала: закрывать его
-- от того, кому открыт сам материал, бессмысленно, а открывать шире — утечка.
CREATE POLICY parses_select_reviewer ON lab.project_material_parses FOR SELECT TO app_backend USING (
    EXISTS (SELECT 1 FROM lab.project_materials m
            WHERE m.id = project_material_parses.material_id
              AND experts.is_assigned_reviewer(m.project_id, app.current_user_id())));

-- ------------------------------------------------- погашение золотого билета
CREATE POLICY golden_tickets_redeem ON seasons.golden_tickets FOR UPDATE TO app_backend
    USING (app.has_role('admin') OR app.has_role('organizer'))
    WITH CHECK (app.has_role('admin') OR app.has_role('organizer'));

-- Погашение необратимо и одноразово. Без этого триггера UPDATE-политика
-- позволяла бы обнулить `used_at` и использовать билет повторно — лимит «два
-- билета на организатора за сезон» перестал бы что-либо значить.
CREATE OR REPLACE FUNCTION seasons.forbid_ticket_unredeem()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, seasons, public
AS $$
BEGIN
    IF OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at THEN
        RAISE EXCEPTION 'golden ticket is already redeemed' USING ERRCODE = '42501';
    END IF;
    -- Прочие поля билета — факт выдачи, он неизменен.
    IF NEW.project_id <> OLD.project_id OR NEW.season_id <> OLD.season_id
       OR NEW.granted_by <> OLD.granted_by OR NEW.reason <> OLD.reason THEN
        RAISE EXCEPTION 'golden ticket grant is immutable' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER golden_tickets_redeem_once
    BEFORE UPDATE ON seasons.golden_tickets
    FOR EACH ROW EXECUTE FUNCTION seasons.forbid_ticket_unredeem();

-- ------------------------------------------------------- переходы по этапам
-- Владелец проекта редактирует заявку (projects_update_owner, M004), но этап
-- сезона ему неподвластен: иначе основатель объявлял бы себя финалистом.
-- Организатору же нужно менять этап у ЧУЖОГО проекта, а членом команды он не
-- является — существующая политика его не покрывает.
CREATE POLICY projects_update_organizer ON lab.projects FOR UPDATE TO app_backend
    USING (app.has_role('organizer')) WITH CHECK (app.has_role('organizer'));

-- Политика даёт организатору доступ к СТРОКЕ целиком — RLS не умеет ограничивать
-- набор колонок, а column-level GRANT здесь бесполезен: и основатель, и
-- организатор ходят под одной и той же ролью БД `app_backend`, различаясь лишь
-- прикладной ролью в GUC. Поэтому границу держит триггер: тот, кто дотянулся до
-- чужой строки именно как организатор, меняет только этап.
CREATE OR REPLACE FUNCTION lab.limit_organizer_project_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, lab, app, public
AS $$
BEGIN
    -- Админ и участники проекта сюда не попадают: у них своя, более широкая
    -- политика, и ограничивать их этим правилом не требуется.
    IF app.has_role('admin') OR lab.is_project_member(OLD.id, app.current_user_id()) THEN
        RETURN NEW;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        -- Разрешён ровно один сценарий: смена этапа. Все прочие поля обязаны
        -- совпасть со старой строкой, кроме служебной отметки времени.
        -- Сравнение через to_jsonb, а не перечислением колонок: перечисление
        -- пришлось бы дополнять при каждой новой колонке, и забытая колонка молча
        -- открывала бы дыру.
        IF (to_jsonb(NEW) - 'status' - 'updated_at')
           IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_at') THEN
            RAISE EXCEPTION 'organizer may change project stage only'
                USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'organizer may change project stage only' USING ERRCODE = '42501';
END $$;

CREATE TRIGGER projects_organizer_scope
    BEFORE UPDATE ON lab.projects
    FOR EACH ROW EXECUTE FUNCTION lab.limit_organizer_project_update();

-- Смена этапа не должна проходить мимо журнала. Гарантия здесь механическая:
-- допустимость самого перехода проверяет приложение, а БД следит за тем, что
-- статус не «перепрыгивает» в выпускники из черновика при любой ошибке кода.
CREATE OR REPLACE FUNCTION lab.enforce_stage_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, lab, public
AS $$
DECLARE
    -- Порядок этапов воронки. `rejected`/`archived` вне порядка: в них можно
    -- попасть с любого этапа, это выход из воронки, а не движение по ней.
    v_order CONSTANT TEXT[] := ARRAY['draft','submitted','ai_review','expert_review',
                                     'bootcamp','finalist','graduated'];
    v_from INTEGER;
    v_to   INTEGER;
BEGIN
    IF NEW.status = OLD.status THEN RETURN NEW; END IF;
    IF NEW.status IN ('rejected','archived') OR OLD.status IN ('rejected','archived') THEN
        RETURN NEW;
    END IF;
    v_from := array_position(v_order, OLD.status);
    v_to   := array_position(v_order, NEW.status);
    IF v_from IS NULL OR v_to IS NULL THEN RETURN NEW; END IF;
    IF v_to > v_from + 1 THEN
        RAISE EXCEPTION 'stage cannot skip: % -> %', OLD.status, NEW.status
            USING ERRCODE = '23514';
    END IF;
    IF v_to < v_from THEN
        RAISE EXCEPTION 'stage cannot move backwards: % -> %', OLD.status, NEW.status
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER projects_stage_order
    BEFORE UPDATE OF status ON lab.projects
    FOR EACH ROW EXECUTE FUNCTION lab.enforce_stage_order();

-- Выборка проектов сезона по этапу — основной запрос отбора в буткемп и финал.
CREATE INDEX IF NOT EXISTS projects_season_status
    ON lab.projects (season_id, status) WHERE deleted_at IS NULL;

COMMENT ON FUNCTION lab.enforce_stage_order() IS
    'Этап проекта движется вперёд ровно на один шаг. Выход в rejected/archived '
    'разрешён с любого этапа: это не движение по воронке.';
