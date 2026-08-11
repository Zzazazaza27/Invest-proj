-- =============================================================================
-- M028 — проекция вознаграждения для Integration API
--
-- Задача: внешняя система (Capital) должна видеть по сделке не только объём, но
-- и вознаграждение платформы. Прямой путь — дать `app_integration` право читать
-- `billing.commission_accruals` — закрыт намеренно: роли разделены ровно для
-- того, чтобы денежный контур не читался интеграционным. Расширить права ради
-- одного поля значит отменить границу, ради которой роли и заводились.
--
-- Поэтому вводится проекция: узкая таблица с тем и только тем, что интеграции
-- положено видеть. Наполняет её БИЛЛИНГ — в той же транзакции, где возникает
-- начисление, поэтому проекция не может «отстать» от источника или разойтись
-- с ним. Читает — только `app_integration` и только SELECT.
--
-- Чего в проекции НЕТ и не будет: сторон сделки, реквизитов, статуса оплаты
-- счёта. Вознаграждение — это факт о сделке; кто и когда его заплатил —
-- внутреннее дело биллинга.
-- =============================================================================

CREATE TABLE integration.deal_commissions (
    agreement_id        UUID PRIMARY KEY REFERENCES investments.investment_agreements(id),
    accrual_id          UUID NOT NULL UNIQUE REFERENCES billing.commission_accruals(id),
    base_amount         NUMERIC(14,2) NOT NULL CHECK (base_amount > 0),
    currency            CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    investor_fee_amount NUMERIC(14,2) NOT NULL CHECK (investor_fee_amount >= 0),
    issuer_fee_amount   NUMERIC(14,2) NOT NULL CHECK (issuer_fee_amount >= 0),
    total_fee_amount    NUMERIC(14,2) GENERATED ALWAYS AS
                        (investor_fee_amount + issuer_fee_amount) STORED,
    accrued_at          TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE integration.deal_commissions IS
    'Проекция вознаграждения по сделке для Integration API. Пишется триггером '
    'биллинга в транзакции начисления; интеграционная роль имеет только SELECT.';

CREATE INDEX deal_commissions_accrued ON integration.deal_commissions (accrued_at DESC);

-- Проекция наполняется триггером, а не вызовом из приложения: начисление
-- создаётся внутри `billing.confirm_first_tranche`, и любой будущий второй путь
-- создания начисления получит проекцию автоматически. Вызов из приложения такой
-- гарантии не даёт — его можно забыть.
--
-- SECURITY DEFINER: роль, создающая начисление (`app_billing`), прав на схему
-- `integration` не имеет и иметь не должна. Функция не принимает аргументов
-- извне — она работает только с NEW, поэтому расширить её действие подстановкой
-- нельзя.
CREATE OR REPLACE FUNCTION billing.project_deal_commission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, billing, integration, public
AS $$
BEGIN
    INSERT INTO integration.deal_commissions
        (agreement_id, accrual_id, base_amount, currency,
         investor_fee_amount, issuer_fee_amount, accrued_at)
    VALUES (NEW.agreement_id, NEW.id, NEW.base_amount, NEW.currency,
            NEW.investor_fee_amount, NEW.issuer_fee_amount, NEW.accrued_at)
    ON CONFLICT (agreement_id) DO NOTHING;
    RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION billing.project_deal_commission() FROM PUBLIC;

CREATE TRIGGER accruals_project_commission
    AFTER INSERT ON billing.commission_accruals
    FOR EACH ROW EXECUTE FUNCTION billing.project_deal_commission();

-- Уже созданные начисления попадают в проекцию тем же правилом: иначе сделки,
-- прошедшие до этой миграции, навсегда остались бы без вознаграждения в выдаче.
INSERT INTO integration.deal_commissions
    (agreement_id, accrual_id, base_amount, currency,
     investor_fee_amount, issuer_fee_amount, accrued_at)
SELECT agreement_id, id, base_amount, currency,
       investor_fee_amount, issuer_fee_amount, accrued_at
  FROM billing.commission_accruals
ON CONFLICT (agreement_id) DO NOTHING;

-- ------------------------------------------------------------------------ RLS
ALTER TABLE integration.deal_commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.deal_commissions FORCE  ROW LEVEL SECURITY;

-- Читает интеграция; пишет — только определитель функции. Политики на INSERT
-- нет ни у одной роли приложения: единственный законный путь записи — триггер.
CREATE POLICY deal_commissions_read ON integration.deal_commissions FOR SELECT
    TO app_integration USING (true);
CREATE POLICY deal_commissions_admin_read ON integration.deal_commissions FOR SELECT
    TO app_backend USING (app.has_role('admin'));

GRANT SELECT ON integration.deal_commissions TO app_integration, app_backend;
