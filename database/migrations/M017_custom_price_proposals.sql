-- =============================================================================
-- M017 — предложения индивидуальной цены (4-eyes)
--
-- Почему отдельная таблица, а не поля в подписке.
--
-- `billing.subscriptions` содержит CHECK: индивидуальная цена допустима только
-- вместе с ОБЕИМИ подписями — назначившего и утвердившего, причём разными.
-- Это правильное ограничение: подписка не должна существовать в состоянии
-- «цена уже стоит, но её никто не утвердил». Но двухшаговое согласование
-- требует где-то хранить промежуточный шаг, и класть его в ту же строку —
-- значит ослабить инвариант ради процесса.
--
-- Поэтому предложение живёт отдельно: пока оно не утверждено, цена подписки не
-- меняется вовсе. Утверждение переносит цену в подписку одной транзакцией,
-- сразу с обеими подписями.
-- =============================================================================

CREATE TABLE billing.custom_price_proposals (
    id              UUID PRIMARY KEY,
    subscription_id UUID NOT NULL REFERENCES billing.subscriptions(id),
    price           NUMERIC(14,2) NOT NULL CHECK (price > 0),
    currency        CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    reason          TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
    proposed_by     UUID NOT NULL REFERENCES identity.users(id),
    proposed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_by     UUID REFERENCES identity.users(id),
    approved_at     TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                    ('pending','approved','rejected','superseded')),
    -- Четыре глаза: утвердить может только другой человек.
    CHECK (approved_by IS NULL OR approved_by <> proposed_by),
    CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
    CHECK (status <> 'approved' OR approved_by IS NOT NULL)
);

-- Одно ожидающее предложение на подписку: два параллельных предложения сделали
-- бы неопределённым, какое из них утверждается.
CREATE UNIQUE INDEX custom_price_one_pending
    ON billing.custom_price_proposals (subscription_id) WHERE status = 'pending';
CREATE INDEX custom_price_subscription
    ON billing.custom_price_proposals (subscription_id, proposed_at DESC);

COMMENT ON TABLE billing.custom_price_proposals IS
    'Двухшаговое согласование индивидуальной цены. Пока предложение не утверждено '
    'вторым администратором, цена подписки не меняется.';

-- Денежные поля предложения неизменяемы: новая цена — новое предложение.
CREATE OR REPLACE FUNCTION billing.forbid_proposal_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, public
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'предложения индивидуальной цены не удаляются'
            USING ERRCODE = '42501';
    END IF;
    IF NEW.price IS DISTINCT FROM OLD.price
       OR NEW.subscription_id IS DISTINCT FROM OLD.subscription_id
       OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by
       OR NEW.reason IS DISTINCT FROM OLD.reason THEN
        RAISE EXCEPTION 'условия предложения неизменяемы; создайте новое предложение'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER custom_price_proposals_immutable
    BEFORE UPDATE OR DELETE ON billing.custom_price_proposals
    FOR EACH ROW EXECUTE FUNCTION billing.forbid_proposal_rewrite();

-- ------------------------------------------------------------------------ RLS
ALTER TABLE billing.custom_price_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.custom_price_proposals FORCE  ROW LEVEL SECURITY;

-- Индивидуальные цены — коммерческая тайна платформы и предмет злоупотреблений:
-- видит их только администратор, владелец подписки — нет.
CREATE POLICY custom_price_admin_read ON billing.custom_price_proposals
    FOR SELECT TO app_backend USING (app.has_role('admin'));
CREATE POLICY custom_price_admin_insert ON billing.custom_price_proposals
    FOR INSERT TO app_backend WITH CHECK (app.has_role('admin'));
CREATE POLICY custom_price_admin_update ON billing.custom_price_proposals
    FOR UPDATE TO app_backend USING (app.has_role('admin'))
    WITH CHECK (app.has_role('admin'));
CREATE POLICY custom_price_billing_read ON billing.custom_price_proposals
    FOR SELECT TO app_billing USING (true);

GRANT SELECT, INSERT, UPDATE ON billing.custom_price_proposals TO app_backend;
GRANT SELECT ON billing.custom_price_proposals TO app_billing;

INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('billing.custom_price.rejected', 'Предложение индивидуальной цены отклонено',
     ARRAY['admin','system'])
ON CONFLICT (verb) DO NOTHING;
