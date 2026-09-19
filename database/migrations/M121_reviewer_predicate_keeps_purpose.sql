-- M121 — возврат условия по цели назначения в предикат рецензента.
--
-- Исправление регрессии, внесённой M120. Переписывая
-- `experts.is_assigned_reviewer`, я взял за основу тело из M021 и потерял
-- условие `purpose = 'review'`, добавленное M099. В результате назначение на
-- СОПРОВОЖДЕНИЕ СДЕЛКИ снова открывало данные проекта — ровно то разделение,
-- ради которого M099 и писалась.
--
-- Поймано существующей проверкой БД («сопровождение сделки не даёт ни
-- рецензентских прав, ни данных проекта»), а не глазами. Правкой M120
-- не исправляется: миграция применена, а применённые вперёд не переписывают.
--
-- Заодно возвращён `pg_temp` в `search_path` вместо `public`: у SECURITY-
-- чувствительных функций схема `public` в пути не нужна, и M099 её убрала.

CREATE OR REPLACE FUNCTION experts.is_assigned_reviewer(p_project_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, experts, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM experts.expert_assignments ea
        WHERE ea.project_id = p_project_id
          AND ea.expert_id = p_user_id
          -- Цель назначения (M099): сопровождение сделки данных проекта не
          -- открывает. Это условие — вся разница между рецензентом и
          -- сопровождающим, и терять его нельзя.
          AND ea.purpose = 'review'
          -- Отказ и просрочка доступ закрывают: работа по проекту не ведётся.
          -- `completed` доступ оставляет: сдавший рецензию видит то, о чём
          -- писал, — пока администратор не прекратит доступ явно (M120).
          AND ea.status IN ('assigned', 'accepted', 'completed')
          AND ea.access_revoked_at IS NULL
    );
$$;

COMMENT ON FUNCTION experts.is_assigned_reviewer(UUID, UUID) IS
    'Есть ли у эксперта живое или выполненное назначение НА РЕЦЕНЗИЮ (M099), доступ по '
    'которому не прекращён (M120). Предикат RLS: доступ рецензента ограничен фактом '
    'назначения, а не ролью; прекращение доступа не отменяет проделанную работу.';

REVOKE ALL ON FUNCTION experts.is_assigned_reviewer(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION experts.is_assigned_reviewer(UUID, UUID) TO app_backend;
