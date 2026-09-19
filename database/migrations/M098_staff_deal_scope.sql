-- M098 — служебный доступ сотрудника к СВОЕЙ сделке (продолжение M097).
--
-- Сотруднику, который вправе фиксировать возврат или корректировать
-- вознаграждение, нужно видеть сделку, по которой он это делает. Без этого
-- полномочие бессмысленно: действие есть, а объекта не видно.
--
-- Доступ выдаётся УЗКО и по явному основанию, а не роли:
--
--   • нужно хотя бы одно ФИНАНСОВОЕ полномочие (роль `expert` сама по себе
--     не подходит) И
--   • назначение на проект этой сделки (`experts.is_assigned_reviewer`).
--
-- Снятие любого из двух закрывает доступ при следующем запросе. Ни аудитория
-- `platform`, ни дата-рум проекта этим не открываются: видно ровно сделку —
-- предложение, договор, транши и начисления.
CREATE OR REPLACE FUNCTION investments.staff_has_finance_capability()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, app, pg_temp
AS $$
    SELECT app.has_capability('finance.tranche_return.record')
        OR app.has_capability('finance.commission.reduce')
        OR app.has_capability('finance.commission.refund_paid')
        OR app.has_capability('finance.return.discuss');
$$;
COMMENT ON FUNCTION investments.staff_has_finance_capability() IS
    'Есть ли у сотрудника хоть одно финансовое полномочие (M098). Половина основания служебного '
    'доступа; вторая половина — назначение на проект сделки.';
GRANT EXECUTE ON FUNCTION investments.staff_has_finance_capability() TO app_backend, app_billing;

/**
 * Служебный доступ к сделке по её договору.
 *
 * ВАЖНО: функция не обращается к таблице, на которой стоит её же политика —
 * иначе проверка политики вызывала бы саму себя и запрос уходил в рекурсию.
 * Поэтому политика на договорах пользуется собственной колонкой строки, а
 * здесь разрешён только путь «транш/начисление → договор → предложение».
 */
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
               AND experts.is_assigned_reviewer(o.project_id, app.current_user_id())
        );
$$;
COMMENT ON FUNCTION investments.staff_may_view_deal(UUID) IS
    'Служебный доступ сотрудника к конкретной сделке (M098): финансовое полномочие И назначение '
    'на проект этой сделки. Роль сама по себе доступа не даёт; снятие любого из двух закрывает.';
GRANT EXECUTE ON FUNCTION investments.staff_may_view_deal(UUID) TO app_backend, app_billing;

-- Политики добавляют ОДНУ ветку; прежние условия остаются как были.
--
-- Предложение и договор проверяются по собственным колонкам строки: подзапрос
-- к той же таблице внутри её политики — это рекурсия, а не проверка.
DROP POLICY IF EXISTS staff_scope_offers ON investments.investment_offers;
CREATE POLICY staff_scope_offers ON investments.investment_offers FOR SELECT
    TO app_backend USING (
        investments.staff_has_finance_capability()
        AND experts.is_assigned_reviewer(project_id, app.current_user_id()));

DROP POLICY IF EXISTS staff_scope_agreements ON investments.investment_agreements;
CREATE POLICY staff_scope_agreements ON investments.investment_agreements FOR SELECT
    TO app_backend USING (
        investments.staff_has_finance_capability()
        AND EXISTS (
            SELECT 1 FROM investments.investment_offers o
             WHERE o.id = investment_agreements.offer_id
               AND experts.is_assigned_reviewer(o.project_id, app.current_user_id())));

DROP POLICY IF EXISTS staff_scope_tranches ON investments.investment_tranches;
CREATE POLICY staff_scope_tranches ON investments.investment_tranches FOR SELECT
    TO app_backend USING (investments.staff_may_view_deal(agreement_id));

DROP POLICY IF EXISTS staff_scope_accruals ON billing.commission_accruals;
CREATE POLICY staff_scope_accruals ON billing.commission_accruals FOR SELECT
    TO app_backend USING (investments.staff_may_view_deal(agreement_id));

DROP FUNCTION IF EXISTS investments.staff_may_view_offer(UUID);
