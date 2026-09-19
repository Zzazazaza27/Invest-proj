-- M099 — назначение получает НАЗНАЧЕНИЕ: рецензия или сопровождение сделки.
--
-- Противоречие, которое здесь закрывается. В M097–M098 областью работы для
-- денежных действий было взято существующее назначение эксперта на проект.
-- Но это же назначение даёт рецензенту уровень `platform` в предикате
-- доступа (M087) и открывает материалы, анкету и раунд (M025, M071, M081,
-- M085). Получалось, что назначить человека на сопровождение сделки нельзя,
-- не открыв ему заодно весь проект как рецензенту.
--
-- Минимальное различие: у назначения появляется ЦЕЛЬ. Универсального
-- конструктора областей здесь нет — только две реализованные цели, каждая со
-- своим смыслом:
--
--   `review`       — экспертная оценка проекта. Существующие назначения
--                    получают именно её, поэтому права действующих
--                    рецензентов не меняются ни на йоту;
--   `deal_support` — сопровождение сделки. Даёт ТОЛЬКО область работы для
--                    денежных действий (и только вместе с отдельно выданным
--                    финансовым полномочием). Ни анкеты, ни внутренних
--                    оценок, ни материалов, ни `platform`-полей.
--
-- Способ сделать это одной правкой: `experts.is_assigned_reviewer` — общая
-- точка, через которую рецензентский доступ входит во ВСЕ политики и в
-- предикат. Сузив её до цели `review`, мы закрываем платформенный доступ для
-- сопровождающих везде сразу, ничего больше не переписывая.

ALTER TABLE experts.expert_assignments
    ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'review';

ALTER TABLE experts.expert_assignments
    DROP CONSTRAINT IF EXISTS expert_assignments_purpose_check;
ALTER TABLE experts.expert_assignments
    ADD CONSTRAINT expert_assignments_purpose_check
    CHECK (purpose IN ('review', 'deal_support'));

COMMENT ON COLUMN experts.expert_assignments.purpose IS
    'Цель назначения (M099): review — экспертная оценка проекта (даёт платформенный доступ к '
    'данным проекта); deal_support — сопровождение сделки (доступа к данным проекта НЕ даёт, '
    'только область работы для денежных действий вместе с финансовым полномочием).';

-- Один активный ассайнмент НА ЦЕЛЬ: человек может и рецензировать проект, и
-- сопровождать сделку по нему — это разные работы, а не дубликат.
DROP INDEX IF EXISTS experts.assignments_active_uq;
CREATE UNIQUE INDEX assignments_active_uq
    ON experts.expert_assignments (project_id, expert_id, purpose)
    WHERE status IN ('assigned', 'accepted');

-- Рецензентский доступ — только цель `review`. Одна правка закрывает
-- платформенные пути (M025 материалы, M056, M071 анкеты, M081 раунды,
-- M085 видимость раунда, M087 предикат) для сопровождающих сделку.
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
          AND ea.purpose = 'review'
          -- Отказ и просрочка доступ закрывают: работа по проекту не ведётся.
          AND ea.status IN ('assigned', 'accepted', 'completed')
    );
$$;
COMMENT ON FUNCTION experts.is_assigned_reviewer(UUID, UUID) IS
    'Назначен ли пользователь РЕЦЕНЗЕНТОМ проекта (M021, сужено M099 до цели review). Через эту '
    'функцию рецензентский доступ входит во все политики и в предикат аудитории; сопровождение '
    'сделки её не проходит.';

/**
 * Сопровождает ли пользователь сделки этого проекта.
 *
 * Отдельная функция, а не флаг в прежней: смысл другой, и путать их нельзя.
 * Сама по себе она доступа к данным проекта не даёт — только отвечает на
 * вопрос «это его сделка?» для денежных действий.
 */
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
    );
$$;
COMMENT ON FUNCTION experts.is_assigned_deal_supporter(UUID, UUID) IS
    'Сопровождает ли пользователь сделки проекта (M099). Доступа к анкете, оценкам и материалам '
    'не даёт: отвечает только за область денежных действий.';

GRANT EXECUTE ON FUNCTION experts.is_assigned_deal_supporter(UUID, UUID)
    TO app_backend, app_billing;

-- Рецензия пишется только по назначению на рецензию: сопровождающий сделку
-- эксперт не становится оценщиком проекта оттого, что у него есть строка
-- назначения.
CREATE OR REPLACE FUNCTION experts.assert_review_assignment_purpose()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, experts, pg_temp
AS $$
DECLARE
    v_purpose TEXT;
BEGIN
    SELECT purpose INTO v_purpose
      FROM experts.expert_assignments WHERE id = NEW.assignment_id;
    IF v_purpose IS DISTINCT FROM 'review' THEN
        RAISE EXCEPTION
            'рецензию можно подать только по назначению на экспертную оценку (цель %)',
            COALESCE(v_purpose, 'нет назначения')
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER expert_reviews_purpose
    BEFORE INSERT ON experts.expert_reviews
    FOR EACH ROW EXECUTE FUNCTION experts.assert_review_assignment_purpose();

-- ------------------------------------- область денежных действий (M097–M098)
-- Финансовые действия опираются теперь на сопровождение сделки, а не на
-- рецензентское назначение.
CREATE OR REPLACE FUNCTION investments.staff_may_view_deal(p_agreement_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, investments, experts, app, pg_temp
AS $$
    SELECT investments.staff_has_finance_capability()
       AND EXISTS (
            SELECT 1
              FROM investments.investment_agreements a
              JOIN investments.investment_offers o ON o.id = a.offer_id
             WHERE a.id = p_agreement_id
               AND experts.is_assigned_deal_supporter(o.project_id, app.current_user_id())
        );
$$;

DROP POLICY IF EXISTS staff_scope_offers ON investments.investment_offers;
CREATE POLICY staff_scope_offers ON investments.investment_offers FOR SELECT
    TO app_backend USING (
        investments.staff_has_finance_capability()
        AND experts.is_assigned_deal_supporter(project_id, app.current_user_id()));

DROP POLICY IF EXISTS staff_scope_agreements ON investments.investment_agreements;
CREATE POLICY staff_scope_agreements ON investments.investment_agreements FOR SELECT
    TO app_backend USING (
        investments.staff_has_finance_capability()
        AND EXISTS (
            SELECT 1 FROM investments.investment_offers o
             WHERE o.id = investment_agreements.offer_id
               AND experts.is_assigned_deal_supporter(o.project_id, app.current_user_id())));

-- Запись возврата: та же замена основания области работы (M097).
DROP POLICY IF EXISTS tranche_returns_read ON investments.tranche_returns;
CREATE POLICY tranche_returns_read ON investments.tranche_returns FOR SELECT
    TO app_backend USING (
        app.has_role('admin')
        OR EXISTS (
            SELECT 1
              FROM investments.investment_tranches t
              JOIN investments.investment_agreements a ON a.id = t.agreement_id
              JOIN investments.investment_offers o ON o.id = a.offer_id
             WHERE t.id = tranche_returns.tranche_id
               AND (a.investor_id = app.current_user_id()
                    OR lab.is_project_member(o.project_id, app.current_user_id())
                    OR (app.has_capability('finance.tranche_return.record')
                        AND experts.is_assigned_deal_supporter(o.project_id,
                                                               app.current_user_id())))
        ));

DROP POLICY IF EXISTS tranche_returns_write ON investments.tranche_returns;
CREATE POLICY tranche_returns_write ON investments.tranche_returns FOR INSERT
    TO app_backend WITH CHECK (
        app.has_capability('finance.tranche_return.record')
        AND (app.has_role('admin')
             OR EXISTS (
                 SELECT 1
                   FROM investments.investment_tranches t
                   JOIN investments.investment_agreements a ON a.id = t.agreement_id
                   JOIN investments.investment_offers o ON o.id = a.offer_id
                  WHERE t.id = tranche_returns.tranche_id
                    AND experts.is_assigned_deal_supporter(o.project_id, app.current_user_id())))
    );

-- --------------------------------------------------------- глагол аудита
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('experts.deal_support.assigned',
     'Сотрудник назначен на сопровождение сделок проекта',
     ARRAY['admin'])
ON CONFLICT (verb) DO NOTHING;
