-- =============================================================================
-- M021 — доступ назначенного рецензента к проекту
--
-- Находка живого прогона Ф8: политика `projects_select` (M004) перечисляет
-- админа, организатора, участника проекта и инвестора с активной подпиской —
-- эксперта в ней нет. В результате назначенный рецензент не видел проект,
-- который ему поручено оценить: любая операция, читающая `lab.projects` из-под
-- его контекста, возвращала «не найдено».
--
-- Это не «ослабление RLS ради удобства». Доступ выдаётся не роли `expert`
-- вообще, а конкретному эксперту на конкретный проект и только при наличии
-- назначения: нет назначения — нет и доступа, отозвали назначение отказом —
-- доступ остаётся лишь у тех, кто рецензию уже сдал (это его собственная
-- история работы).
--
-- Реализовано ОТДЕЛЬНОЙ permissive-политикой, а не правкой существующей:
-- permissive-политики складываются по ИЛИ, поэтому прежняя логика доступа
-- остаётся ровно такой, какой была, и её не нужно перечитывать заново при
-- следующем изменении.
-- =============================================================================

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
          AND ea.status IN ('assigned', 'accepted', 'completed')
    );
$$;

COMMENT ON FUNCTION experts.is_assigned_reviewer(UUID, UUID) IS
    'Есть ли у эксперта живое или выполненное назначение на проект. '
    'Предикат RLS: доступ рецензента ограничен фактом назначения, а не ролью.';

REVOKE ALL ON FUNCTION experts.is_assigned_reviewer(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION experts.is_assigned_reviewer(UUID, UUID) TO app_backend;

CREATE POLICY projects_select_reviewer ON lab.projects FOR SELECT TO app_backend USING (
    deleted_at IS NULL AND experts.is_assigned_reviewer(id, app.current_user_id()));
