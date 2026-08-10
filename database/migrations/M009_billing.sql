-- =============================================================================
-- M009 — billing
-- Версионируемые тарифы и fee schedule, подписки, начисления вознаграждения
-- ОИП, инвойсы, платежи. Атомарная команда confirm_first_tranche().
-- Источник: Database_Launch.md §11; Architect_Launch.md §5; ADR-005.
--
-- ГРАНИЦА КОНТУРОВ: здесь только выручка платформы. Инвестиционный principal
-- живёт в investments.* и в billing.payments не попадает никогда.
-- =============================================================================

-- ------------------------------------------------- версионируемые тарифы
CREATE TABLE billing.subscription_plans (
    id                 UUID PRIMARY KEY,
    code               TEXT NOT NULL CHECK (code IN
                       ('founder_t1','founder_t2','founder_t3','founder_t4','founder_t5',
                        'investor_membership')),
    version            INTEGER NOT NULL CHECK (version > 0),
    audience           TEXT NOT NULL CHECK (audience IN ('founder','investor')),
    name               TEXT NOT NULL,
    ask_limit          NUMERIC(14,2) CHECK (ask_limit IS NULL OR ask_limit > 0),
    individual_pricing BOOLEAN NOT NULL DEFAULT false,
    price              NUMERIC(14,2) CHECK (price IS NULL OR price >= 0),
    currency           CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    billing_period     TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_period IN ('monthly','yearly')),
    features_jsonb     JSONB NOT NULL DEFAULT '{}',
    valid_from         TIMESTAMPTZ NOT NULL,
    valid_to           TIMESTAMPTZ,
    published_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (individual_pricing OR price IS NOT NULL),
    CHECK (valid_to IS NULL OR valid_to > valid_from),
    UNIQUE (code, version)
);
CREATE INDEX subscription_plans_lookup ON billing.subscription_plans (audience, valid_from, valid_to);

CREATE TABLE billing.fee_schedules (
    id               UUID PRIMARY KEY,
    code             TEXT NOT NULL,
    version          INTEGER NOT NULL CHECK (version > 0),
    investor_fee_pct NUMERIC(5,2) NOT NULL CHECK (investor_fee_pct >= 0 AND investor_fee_pct <= 100),
    issuer_fee_pct   NUMERIC(5,2) NOT NULL CHECK (issuer_fee_pct >= 0 AND issuer_fee_pct <= 100),
    rules_version    TEXT NOT NULL,
    valid_from       TIMESTAMPTZ NOT NULL,
    valid_to         TIMESTAMPTZ,
    published_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (valid_to IS NULL OR valid_to > valid_from),
    UNIQUE (code, version)
);

COMMENT ON TABLE billing.fee_schedules IS
    'Неизменяемые версии условий вознаграждения ОИП. Проценты снапшотятся в '
    'начисление: изменение тарифа задним числом невозможно (ADR-005).';

-- Периоды действия версий одного code не пересекаются: иначе резолвер тарифа
-- становится недетерминированным, а цена — предметом спора.
CREATE OR REPLACE FUNCTION billing.forbid_plan_period_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, public
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('billing.plan:' || NEW.code, 0));
    IF EXISTS (
        SELECT 1 FROM billing.subscription_plans p
        WHERE p.code = NEW.code
          AND p.id <> NEW.id
          AND tstzrange(p.valid_from, p.valid_to, '[)')
              && tstzrange(NEW.valid_from, NEW.valid_to, '[)')
    ) THEN
        RAISE EXCEPTION 'subscription_plans: overlapping validity periods for code %', NEW.code
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER subscription_plans_no_overlap
    AFTER INSERT OR UPDATE ON billing.subscription_plans
    DEFERRABLE INITIALLY IMMEDIATE
    FOR EACH ROW EXECUTE FUNCTION billing.forbid_plan_period_overlap();

CREATE OR REPLACE FUNCTION billing.forbid_fee_schedule_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, public
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('billing.fee:' || NEW.code, 0));
    IF EXISTS (
        SELECT 1 FROM billing.fee_schedules f
        WHERE f.code = NEW.code
          AND f.id <> NEW.id
          AND tstzrange(f.valid_from, f.valid_to, '[)')
              && tstzrange(NEW.valid_from, NEW.valid_to, '[)')
    ) THEN
        RAISE EXCEPTION 'fee_schedules: overlapping validity periods for code %', NEW.code
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER fee_schedules_no_overlap
    AFTER INSERT OR UPDATE ON billing.fee_schedules
    DEFERRABLE INITIALLY IMMEDIATE
    FOR EACH ROW EXECUTE FUNCTION billing.forbid_fee_schedule_overlap();

-- Денежные условия версии неизменяемы: новая цена = новая версия.
CREATE OR REPLACE FUNCTION billing.forbid_fee_schedule_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, public
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'fee_schedules cannot be deleted' USING ERRCODE = '42501';
    END IF;
    IF NEW.investor_fee_pct IS DISTINCT FROM OLD.investor_fee_pct
       OR NEW.issuer_fee_pct IS DISTINCT FROM OLD.issuer_fee_pct
       OR NEW.rules_version IS DISTINCT FROM OLD.rules_version
       OR NEW.valid_from IS DISTINCT FROM OLD.valid_from THEN
        RAISE EXCEPTION 'fee schedule terms are immutable; publish a new version instead'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER fee_schedules_immutable
    BEFORE UPDATE OR DELETE ON billing.fee_schedules
    FOR EACH ROW EXECUTE FUNCTION billing.forbid_fee_schedule_rewrite();

-- Резолвер тарифа основателя по запросу инвестиций. Вызывается сервером при
-- публикации и при каждом изменении investment_ask.
CREATE OR REPLACE FUNCTION billing.resolve_founder_plan(p_ask NUMERIC, p_at TIMESTAMPTZ DEFAULT now())
RETURNS UUID
LANGUAGE sql
STABLE
SET search_path = pg_catalog, billing, public
AS $$
    SELECT id FROM billing.subscription_plans
    WHERE audience = 'founder'
      AND valid_from <= p_at AND (valid_to IS NULL OR valid_to > p_at)
      AND (ask_limit IS NULL OR p_ask <= ask_limit)
    ORDER BY ask_limit NULLS LAST, version DESC
    LIMIT 1;
$$;

-- Отложенные FK.
ALTER TABLE lab.projects
    ADD CONSTRAINT projects_required_plan_fk
    FOREIGN KEY (required_plan_id) REFERENCES billing.subscription_plans(id);
ALTER TABLE investments.investment_agreements
    ADD CONSTRAINT investment_agreements_fee_schedule_fk
    FOREIGN KEY (fee_schedule_id) REFERENCES billing.fee_schedules(id);

-- ------------------------------------------------------------------ подписки
CREATE TABLE billing.subscriptions (
    id                       UUID PRIMARY KEY,
    user_id                  UUID NOT NULL REFERENCES identity.users(id),
    plan_id                  UUID NOT NULL REFERENCES billing.subscription_plans(id),
    project_id               UUID REFERENCES lab.projects(id),
                             -- founder: подписка на КОНКРЕТНЫЙ проект (обязателен)
                             -- investor: NULL (подписка на аккаунт)
    price_snapshot           NUMERIC(14,2) NOT NULL CHECK (price_snapshot >= 0),
    currency_snapshot        CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (currency_snapshot = 'RUB'),
    terms_version            TEXT NOT NULL,
    custom_price             NUMERIC(14,2) CHECK (custom_price IS NULL OR custom_price > 0),
    custom_price_set_by      UUID REFERENCES identity.users(id),
    custom_price_approved_by UUID REFERENCES identity.users(id),
    status                   TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN
                             ('pending_payment','active','past_due','canceled','expired')),
    current_period_end       TIMESTAMPTZ,
    grace_until              TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    canceled_at              TIMESTAMPTZ,
    -- 4-eyes: назначивший индивидуальную цену не может сам её утвердить
    CHECK (custom_price IS NULL OR
          (custom_price_set_by IS NOT NULL AND custom_price_approved_by IS NOT NULL
           AND custom_price_set_by <> custom_price_approved_by)),
    CHECK (status <> 'canceled' OR canceled_at IS NOT NULL)
);
CREATE INDEX subscriptions_user ON billing.subscriptions (user_id, status);
CREATE INDEX subscriptions_project ON billing.subscriptions (project_id) WHERE status = 'active';
CREATE UNIQUE INDEX subscriptions_one_active_per_project
    ON billing.subscriptions (project_id) WHERE status IN ('pending_payment','active','past_due');
CREATE UNIQUE INDEX subscriptions_one_investor_active
    ON billing.subscriptions (user_id)
    WHERE status IN ('pending_payment','active','past_due') AND project_id IS NULL;

-- founder-план ↔ project_id NOT NULL; investor-план ↔ project_id IS NULL.
CREATE OR REPLACE FUNCTION billing.enforce_subscription_shape()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, public
AS $$
DECLARE
    v_plan RECORD;
BEGIN
    SELECT * INTO v_plan FROM billing.subscription_plans WHERE id = NEW.plan_id;
    IF v_plan.audience = 'founder' AND NEW.project_id IS NULL THEN
        RAISE EXCEPTION 'founder subscription requires project_id' USING ERRCODE = '23514';
    END IF;
    IF v_plan.audience = 'investor' AND NEW.project_id IS NOT NULL THEN
        RAISE EXCEPTION 'investor subscription must not reference a project' USING ERRCODE = '23514';
    END IF;
    -- Снапшот цены обязан соответствовать плану либо утверждённой индивидуальной цене.
    IF NEW.custom_price IS NOT NULL THEN
        IF NEW.price_snapshot <> NEW.custom_price THEN
            RAISE EXCEPTION 'price_snapshot must equal approved custom_price' USING ERRCODE = '23514';
        END IF;
    ELSIF v_plan.individual_pricing THEN
        RAISE EXCEPTION 'plan % requires an approved custom_price (4-eyes)', v_plan.code
            USING ERRCODE = '23514';
    ELSIF NEW.price_snapshot <> v_plan.price THEN
        RAISE EXCEPTION 'price_snapshot % does not match plan price %',
            NEW.price_snapshot, v_plan.price USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

-- IMMEDIATE: у проверки формы подписки нет зависимости от порядка вставок,
-- а отложенная ошибка всплывала бы только на COMMIT — далеко от вызвавшего её
-- запроса, что усложняет и отладку, и тесты.
CREATE CONSTRAINT TRIGGER subscriptions_shape
    AFTER INSERT OR UPDATE ON billing.subscriptions
    DEFERRABLE INITIALLY IMMEDIATE
    FOR EACH ROW EXECUTE FUNCTION billing.enforce_subscription_shape();

-- Теперь, когда подписки существуют, предикат доступа инвестора становится
-- настоящим (в M004 он был fail-closed заглушкой).
CREATE OR REPLACE FUNCTION lab.has_active_investor_membership(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, lab, billing, public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM billing.subscriptions s
        JOIN billing.subscription_plans sp ON sp.id = s.plan_id
        WHERE s.user_id = p_user_id
          AND s.project_id IS NULL
          AND sp.audience = 'investor'
          AND s.status = 'active'
    );
$$;

-- Листинг публикуется только при активной подписке нужного уровня у владельца.
CREATE OR REPLACE FUNCTION lab.can_list_project(p_project_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, lab, billing, public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM lab.projects p
        JOIN lab.founders_projects fp ON fp.project_id = p.id AND fp.role = 'owner'
        JOIN billing.subscriptions s ON s.project_id = p.id AND s.user_id = fp.user_id
        WHERE p.id = p_project_id
          AND s.status = 'active'
          AND p.required_plan_id IS NOT NULL
          AND s.plan_id = p.required_plan_id
    );
$$;

CREATE OR REPLACE FUNCTION lab.enforce_listing_requires_subscription()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, lab, billing, public
AS $$
BEGIN
    -- Проверять только переход в 'listed' недостаточно: тогда основатель мог бы
    -- опубликовать проект на дешёвом тарифе и потом поднять investment_ask,
    -- оставаясь в каталоге. Проверяем при ЛЮБОМ изменении ask/плана у
    -- опубликованного проекта.
    IF NEW.listing_status = 'listed'
       AND (TG_OP = 'INSERT'
            OR OLD.listing_status IS DISTINCT FROM 'listed'
            OR OLD.investment_ask IS DISTINCT FROM NEW.investment_ask
            OR OLD.required_plan_id IS DISTINCT FROM NEW.required_plan_id) THEN
        -- Тариф обязан соответствовать текущему запросу инвестиций.
        IF NEW.required_plan_id IS DISTINCT FROM billing.resolve_founder_plan(NEW.investment_ask) THEN
            RAISE EXCEPTION
                'required_plan_id does not match investment_ask %: upgrade needed before listing',
                NEW.investment_ask USING ERRCODE = '23514';
        END IF;
        IF NOT lab.can_list_project(NEW.id) THEN
            RAISE EXCEPTION 'listing requires an active subscription of the resolved plan'
                USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER projects_listing_requires_subscription
    AFTER INSERT OR UPDATE OF listing_status, required_plan_id, investment_ask ON lab.projects
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION lab.enforce_listing_requires_subscription();

-- ------------------------------------------- начисление вознаграждения ОИП
CREATE TABLE billing.commission_accruals (
    id                  UUID PRIMARY KEY,
    agreement_id        UUID NOT NULL UNIQUE REFERENCES investments.investment_agreements(id),
    trigger_tranche_id  UUID NOT NULL UNIQUE REFERENCES investments.investment_tranches(id),
    fee_schedule_id     UUID NOT NULL REFERENCES billing.fee_schedules(id),
    base_amount         NUMERIC(14,2) NOT NULL CHECK (base_amount > 0),
    currency            CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    investor_fee_pct    NUMERIC(5,2) NOT NULL CHECK (investor_fee_pct >= 0 AND investor_fee_pct <= 100),
    issuer_fee_pct      NUMERIC(5,2) NOT NULL CHECK (issuer_fee_pct >= 0 AND issuer_fee_pct <= 100),
    investor_fee_amount NUMERIC(14,2) GENERATED ALWAYS AS
                        (round(base_amount * investor_fee_pct / 100, 2)) STORED,
    issuer_fee_amount   NUMERIC(14,2) GENERATED ALWAYS AS
                        (round(base_amount * issuer_fee_pct / 100, 2)) STORED,
    status              TEXT NOT NULL DEFAULT 'accrued' CHECK (status IN
                        ('accrued','invoiced','partially_paid','paid','disputed','adjusted')),
    accrued_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE billing.commission_accruals IS
    'UNIQUE(agreement_id) делает повторное начисление физически невозможным. '
    'base_amount — ПОЛНАЯ сумма договора, а не размер транша (ADR-005).';

-- Денежные поля начисления не переписываются: корректировка — компенсирующая
-- запись, а не UPDATE истории.
CREATE OR REPLACE FUNCTION billing.forbid_accrual_money_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, public
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'commission accruals cannot be deleted' USING ERRCODE = '42501';
    END IF;
    IF NEW.base_amount IS DISTINCT FROM OLD.base_amount
       OR NEW.investor_fee_pct IS DISTINCT FROM OLD.investor_fee_pct
       OR NEW.issuer_fee_pct IS DISTINCT FROM OLD.issuer_fee_pct
       OR NEW.fee_schedule_id IS DISTINCT FROM OLD.fee_schedule_id
       OR NEW.agreement_id IS DISTINCT FROM OLD.agreement_id
       OR NEW.trigger_tranche_id IS DISTINCT FROM OLD.trigger_tranche_id
       OR NEW.currency IS DISTINCT FROM OLD.currency THEN
        RAISE EXCEPTION 'accrual money fields are immutable; use a compensating entry'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER accruals_money_immutable
    BEFORE UPDATE OR DELETE ON billing.commission_accruals
    FOR EACH ROW EXECUTE FUNCTION billing.forbid_accrual_money_rewrite();

-- Начисление создаётся ТОЛЬКО серверной командой confirm_first_tranche().
CREATE OR REPLACE FUNCTION billing.forbid_manual_accrual()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, public
AS $$
BEGIN
    IF coalesce(current_setting('app.accrual_context', true), '') <> 'confirm_first_tranche' THEN
        RAISE EXCEPTION
            'commission accrual can be created only by billing.confirm_first_tranche()'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER accruals_insert_guard
    BEFORE INSERT ON billing.commission_accruals
    FOR EACH ROW EXECUTE FUNCTION billing.forbid_manual_accrual();

-- --------------------------------------------------------- инвойсы и платежи
CREATE TABLE billing.invoices (
    id                  UUID PRIMARY KEY,
    subscription_id     UUID REFERENCES billing.subscriptions(id),
    accrual_id          UUID REFERENCES billing.commission_accruals(id),
    payer_role          TEXT NOT NULL CHECK (payer_role IN ('account','investor','issuer')),
    payer_user_id       UUID REFERENCES identity.users(id),
    payer_entity_id     UUID REFERENCES kyc.business_entities(id),
    number              TEXT NOT NULL UNIQUE,
    amount_due          NUMERIC(14,2) NOT NULL CHECK (amount_due > 0),
    currency            CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    tax_jsonb           JSONB NOT NULL DEFAULT '{}',
    requisites_snapshot JSONB NOT NULL,
    status              TEXT NOT NULL DEFAULT 'issued' CHECK (status IN
                        ('issued','partially_paid','paid','overdue','void','adjusted')),
    pdf_s3_key          TEXT NOT NULL,
    pdf_wrapped_dek     BYTEA NOT NULL,
    issued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    due_at              TIMESTAMPTZ NOT NULL,
    CHECK (num_nonnulls(subscription_id, accrual_id) = 1),
    CHECK (num_nonnulls(payer_user_id, payer_entity_id) = 1),
    CHECK (due_at >= issued_at),
    UNIQUE (accrual_id, payer_role)
);
CREATE INDEX invoices_payer ON billing.invoices (payer_user_id, status);
CREATE INDEX invoices_overdue ON billing.invoices (due_at) WHERE status IN ('issued','partially_paid');

CREATE TABLE billing.payments (
    id              UUID PRIMARY KEY,
    invoice_id      UUID NOT NULL REFERENCES billing.invoices(id),
    user_id         UUID REFERENCES identity.users(id),
    amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    refunded_amount NUMERIC(14,2) NOT NULL DEFAULT 0
                    CHECK (refunded_amount >= 0 AND refunded_amount <= amount),
    currency        CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    provider        TEXT NOT NULL,
    provider_ref    TEXT,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                    ('pending','authorized','succeeded','failed','partially_refunded','refunded','chargeback')),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_hash    BYTEA NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_ref)
);
CREATE INDEX payments_invoice ON billing.payments (invoice_id, status);

COMMENT ON TABLE billing.payments IS
    'Только платежи в пользу платформы: подписки и вознаграждение ОИП. '
    'Инвестиционные транши сюда не попадают и не имеют FK на эту таблицу.';

-- =============================================================================
-- КЛЮЧЕВАЯ КОМАНДА: подтверждение первого транша.
--
-- Триггер начисления составной и неделимый (Architect_Launch §5.3):
--   (1) договор подписан обеими сторонами И
--   (2) первый транш подтверждён банковским событием номинального счёта.
-- База — ПОЛНАЯ сумма договора. Начисление создаётся ровно один раз.
-- Повтор с тем же bank reference возвращает прежний результат, а не дубликат.
-- =============================================================================
CREATE OR REPLACE FUNCTION billing.confirm_first_tranche(
    p_agreement_id         UUID,
    p_bank_transaction_ref TEXT,
    p_amount               NUMERIC,
    p_booked_at            TIMESTAMPTZ,
    p_statement_sha256     BYTEA,
    p_actor_id             UUID DEFAULT NULL,
    p_trace_id             TEXT DEFAULT NULL
) RETURNS TABLE (tranche_id UUID, accrual_id UUID, already_processed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, billing, investments, audit, public
AS $$
DECLARE
    v_agreement   investments.investment_agreements%ROWTYPE;
    v_tranche     investments.investment_tranches%ROWTYPE;
    v_fee         billing.fee_schedules%ROWTYPE;
    v_accrual_id  UUID;
    v_now         TIMESTAMPTZ := now();
    v_existing    RECORD;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'tranche amount must be positive' USING ERRCODE = '23514';
    END IF;

    -- Идемпотентность: повторная доставка того же банковского события.
    SELECT t.id AS tranche_id, a.id AS accrual_id
      INTO v_existing
      FROM investments.investment_tranches t
      LEFT JOIN billing.commission_accruals a ON a.trigger_tranche_id = t.id
     WHERE t.bank_transaction_ref = p_bank_transaction_ref;
    IF FOUND THEN
        tranche_id := v_existing.tranche_id;
        accrual_id := v_existing.accrual_id;
        already_processed := true;
        RETURN NEXT;
        RETURN;
    END IF;

    -- Блокировка договора: два параллельных вебхука не создадут два начисления.
    SELECT * INTO v_agreement
      FROM investments.investment_agreements
     WHERE id = p_agreement_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'agreement % not found', p_agreement_id USING ERRCODE = 'P0002';
    END IF;

    IF v_agreement.investor_signed_at IS NULL OR v_agreement.issuer_signed_at IS NULL THEN
        RAISE EXCEPTION 'agreement % is not signed by both parties', p_agreement_id
            USING ERRCODE = '42501';
    END IF;
    IF v_agreement.status NOT IN ('signed','awaiting_first_tranche') THEN
        RAISE EXCEPTION 'agreement % is in status % and cannot accept the first tranche',
            p_agreement_id, v_agreement.status USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM billing.commission_accruals WHERE agreement_id = p_agreement_id) THEN
        RAISE EXCEPTION 'agreement % already has a commission accrual', p_agreement_id
            USING ERRCODE = '23505';
    END IF;

    SELECT * INTO v_fee FROM billing.fee_schedules WHERE id = v_agreement.fee_schedule_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'fee schedule % not found', v_agreement.fee_schedule_id USING ERRCODE = 'P0002';
    END IF;

    -- Контекст, разрешающий подтверждение транша и создание начисления.
    -- Вне этой функции оба действия запрещены триггерами.
    PERFORM set_config('app.bank_event_context', 'on', true);
    PERFORM set_config('app.accrual_context', 'confirm_first_tranche', true);

    -- Порядок вставок: сначала транш, затем операция номинального счёта со
    -- ссылкой на него. Обратный порядок потребовал бы UPDATE выписки, а она
    -- append-only — банковский факт не переписывается даже собственным кодом.
    INSERT INTO investments.investment_tranches
        (id, agreement_id, tranche_no, amount, currency, status,
         bank_transaction_ref, received_nominal_at, transferred_at, confirmed_at)
    VALUES (public.uuid_generate_v7(), p_agreement_id, 1, p_amount, v_agreement.currency,
            'confirmed', p_bank_transaction_ref, p_booked_at, v_now, v_now)
    RETURNING * INTO v_tranche;

    INSERT INTO investments.nominal_account_transactions
        (id, tranche_id, bank_transaction_ref, direction, amount, currency,
         booked_at, raw_statement_sha256)
    VALUES (public.uuid_generate_v7(), v_tranche.id, p_bank_transaction_ref, 'incoming',
            p_amount, v_agreement.currency, p_booked_at, p_statement_sha256);

    -- Договор вступает в силу.
    UPDATE investments.investment_agreements
       SET status = 'effective', effective_at = v_now, updated_at = v_now
     WHERE id = p_agreement_id;

    -- Единственное начисление. База — ПОЛНАЯ сумма договора.
    v_accrual_id := public.uuid_generate_v7();
    INSERT INTO billing.commission_accruals
        (id, agreement_id, trigger_tranche_id, fee_schedule_id, base_amount, currency,
         investor_fee_pct, issuer_fee_pct, status, accrued_at)
    VALUES (v_accrual_id, p_agreement_id, v_tranche.id, v_fee.id,
            v_agreement.contract_amount, v_agreement.currency,
            v_fee.investor_fee_pct, v_fee.issuer_fee_pct, 'accrued', v_now);

    -- Журнал и outbox — в той же транзакции.
    PERFORM audit.app_emit_event('investment.first_tranche.confirmed', p_actor_id, 'system',
        'investment_agreement', p_agreement_id,
        jsonb_build_object('tranche_id', v_tranche.id, 'amount', p_amount), p_trace_id);
    PERFORM audit.app_emit_event('investment.agreement.effective', p_actor_id, 'system',
        'investment_agreement', p_agreement_id,
        jsonb_build_object('effective_at', v_now), p_trace_id);
    PERFORM audit.app_emit_event('billing.commission.accrued', p_actor_id, 'system',
        'commission_accrual', v_accrual_id,
        jsonb_build_object('agreement_id', p_agreement_id,
                           'base_amount', v_agreement.contract_amount,
                           'investor_fee_pct', v_fee.investor_fee_pct,
                           'issuer_fee_pct', v_fee.issuer_fee_pct), p_trace_id);

    INSERT INTO audit.outbox_events
        (id, aggregate_type, aggregate_id, event_type, payload_jsonb, nats_subject,
         aggregate_version, message_key)
    VALUES
        (public.uuid_generate_v7(), 'investment_agreement', p_agreement_id,
         'investment.first_tranche.confirmed',
         jsonb_build_object('agreement_id', p_agreement_id, 'tranche_id', v_tranche.id,
                            'amount', p_amount, 'booked_at', p_booked_at),
         'investment.first_tranche.confirmed', 1, p_agreement_id::text),
        (public.uuid_generate_v7(), 'investment_agreement', p_agreement_id,
         'investment.agreement.effective',
         jsonb_build_object('agreement_id', p_agreement_id, 'effective_at', v_now),
         'investment.agreement.effective', 2, p_agreement_id::text),
        (public.uuid_generate_v7(), 'commission_accrual', v_accrual_id,
         'billing.commission.accrued',
         jsonb_build_object('accrual_id', v_accrual_id, 'agreement_id', p_agreement_id,
                            'base_amount', v_agreement.contract_amount),
         'billing.commission.accrued', 1, v_accrual_id::text);

    tranche_id := v_tranche.id;
    accrual_id := v_accrual_id;
    already_processed := false;
    RETURN NEXT;
END $$;

COMMENT ON FUNCTION billing.confirm_first_tranche IS
    'Атомарно: операция номинального счёта → транш №1 confirmed → договор effective → '
    'единственное начисление 10%%/5%% от полной суммы договора → журнал и outbox. '
    'Повтор с тем же bank_transaction_ref возвращает прежний результат (ADR-005).';

-- ------------------------------------------------------------------------ RLS
ALTER TABLE billing.subscription_plans    ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.subscription_plans    FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing.fee_schedules         ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.fee_schedules         FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing.subscriptions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.subscriptions         FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing.commission_accruals   ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.commission_accruals   FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing.invoices              ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.invoices              FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing.payments              ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.payments              FORCE  ROW LEVEL SECURITY;

-- Тарифы и условия вознаграждения публичны: принцип радикальной прозрачности.
CREATE POLICY plans_public_read ON billing.subscription_plans FOR SELECT
    TO app_public_read, app_backend, app_billing, app_investments, app_integration USING (true);
CREATE POLICY plans_admin_write ON billing.subscription_plans FOR ALL TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));
CREATE POLICY fees_public_read ON billing.fee_schedules FOR SELECT
    TO app_public_read, app_backend, app_billing, app_investments, app_integration USING (true);
CREATE POLICY fees_admin_write ON billing.fee_schedules FOR ALL TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

CREATE POLICY subscriptions_own ON billing.subscriptions FOR SELECT TO app_backend USING (
    user_id = app.current_user_id() OR app.has_role('admin') OR app.has_role('organizer'));
CREATE POLICY subscriptions_money ON billing.subscriptions FOR ALL
    TO app_billing USING (true) WITH CHECK (true);
CREATE POLICY subscriptions_create ON billing.subscriptions FOR INSERT
    TO app_backend WITH CHECK (user_id = app.current_user_id() OR app.has_role('admin'));
CREATE POLICY subscriptions_cancel ON billing.subscriptions FOR UPDATE
    TO app_backend USING (user_id = app.current_user_id() OR app.has_role('admin'))
    WITH CHECK (user_id = app.current_user_id() OR app.has_role('admin'));

CREATE POLICY accruals_party ON billing.commission_accruals FOR SELECT TO app_backend USING (
    app.has_role('admin')
    OR EXISTS (SELECT 1 FROM investments.investment_agreements ia
               WHERE ia.id = commission_accruals.agreement_id
                 AND ia.investor_id = app.current_user_id())
    OR EXISTS (SELECT 1 FROM investments.investment_agreements ia
               JOIN investments.investment_offers io ON io.id = ia.offer_id
               WHERE ia.id = commission_accruals.agreement_id
                 AND kyc.is_entity_signatory(io.issuer_entity_id, app.current_user_id())));
CREATE POLICY accruals_service ON billing.commission_accruals FOR ALL
    TO app_billing USING (true) WITH CHECK (true);

CREATE POLICY invoices_party ON billing.invoices FOR SELECT TO app_backend USING (
    payer_user_id = app.current_user_id()
    OR (payer_entity_id IS NOT NULL
        AND kyc.is_entity_member(payer_entity_id, app.current_user_id()))
    OR app.has_role('admin'));
CREATE POLICY invoices_service ON billing.invoices FOR ALL
    TO app_billing USING (true) WITH CHECK (true);

CREATE POLICY payments_own ON billing.payments FOR SELECT TO app_backend USING (
    user_id = app.current_user_id() OR app.has_role('admin'));
CREATE POLICY billing_service_write ON billing.payments FOR ALL
    TO app_billing USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------- права
GRANT SELECT ON billing.subscription_plans, billing.fee_schedules
    TO app_backend, app_public_read, app_investments, app_billing, app_integration;
GRANT INSERT, UPDATE ON billing.subscription_plans, billing.fee_schedules TO app_backend;
GRANT SELECT, INSERT, UPDATE ON billing.subscriptions TO app_backend, app_billing;
GRANT SELECT, INSERT, UPDATE ON billing.commission_accruals, billing.invoices,
    billing.payments TO app_billing;

-- app_backend НЕ получает прямого доступа к деньгам: только чтение начислений
-- и инвойсов для отображения пользователю.
GRANT SELECT ON billing.commission_accruals, billing.invoices, billing.payments TO app_backend;
-- Политик вида "TO app_backend USING (true)" на деньгах НЕТ: они объединились бы
-- по ИЛИ с политиками сторон и открыли бы чужие начисления, счета и платежи.
-- Чтение идёт только через accruals_party / invoices_party / payments_own.

GRANT EXECUTE ON FUNCTION billing.resolve_founder_plan(NUMERIC, TIMESTAMPTZ)
    TO app_backend, app_billing, app_public_read;
GRANT EXECUTE ON FUNCTION lab.can_list_project(UUID) TO app_backend, app_billing;
-- Подтверждение транша доступно ТОЛЬКО роли инвестконтура: она вызывается из
-- обработчика банковского события, не из клиентского API.
GRANT EXECUTE ON FUNCTION billing.confirm_first_tranche(UUID, TEXT, NUMERIC, TIMESTAMPTZ, BYTEA, UUID, TEXT)
    TO app_investments;
