-- =============================================================================
-- M005 — investments (регулируемое ядро ОИП)
-- Инвестиционные предложения, договоры инвестирования, транши, операции
-- номинального счёта. Машина состояний и лимиты как транзакционные инварианты.
-- Источник: Database_Launch.md §6; Architect_Launch.md §4.3, §5.3, §7.
--
-- ГРАНИЦА КОНТУРОВ (ADR-005): здесь живёт инвестиционный principal. Выручка
-- платформы — исключительно в billing.*. FK «транш → платёж» не существует.
-- =============================================================================

CREATE TABLE investments.investment_offers (
    id                   UUID PRIMARY KEY,
    project_id           UUID NOT NULL REFERENCES lab.projects(id),
    issuer_entity_id     UUID NOT NULL REFERENCES kyc.business_entities(id),
    instrument_type      TEXT NOT NULL CHECK (instrument_type IN
                         ('loan','security','utility_digital_right','dfa')),
                         -- allowlist Правил платформы, а не свободный параметр клиента
    rules_version        TEXT NOT NULL,
    target_amount        NUMERIC(14,2) NOT NULL CHECK (target_amount > 0),
    min_investment       NUMERIC(14,2) NOT NULL CHECK (min_investment > 0),
    currency             CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    terms_jsonb          JSONB NOT NULL,
    document_s3_key      TEXT NOT NULL,
    document_sha256      BYTEA NOT NULL,
    document_wrapped_dek BYTEA NOT NULL,
    status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                         ('draft','compliance_review','published','paused','closed','cancelled')),
    opens_at             TIMESTAMPTZ,
    closes_at            TIMESTAMPTZ,
    created_by           UUID NOT NULL REFERENCES identity.users(id),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (target_amount >= min_investment),
    CHECK (closes_at IS NULL OR opens_at IS NULL OR closes_at > opens_at),
    CHECK (status <> 'published' OR opens_at IS NOT NULL)
);
CREATE INDEX investment_offers_catalog ON investments.investment_offers (status, opens_at, closes_at);
CREATE INDEX investment_offers_project ON investments.investment_offers (project_id);
CREATE INDEX investment_offers_issuer ON investments.investment_offers (issuer_entity_id);

CREATE TABLE investments.investment_agreements (
    id                          UUID PRIMARY KEY,
    offer_id                    UUID NOT NULL REFERENCES investments.investment_offers(id),
    investor_id                 UUID NOT NULL REFERENCES identity.users(id),
    contract_amount             NUMERIC(14,2) NOT NULL CHECK (contract_amount > 0),
    currency                    CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    fee_schedule_id             UUID NOT NULL,               -- FK → billing.fee_schedules в M009
    document_s3_key             TEXT NOT NULL,
    document_sha256             BYTEA NOT NULL,
    document_wrapped_dek        BYTEA NOT NULL,
    investor_signed_at          TIMESTAMPTZ,
    issuer_signed_at            TIMESTAMPTZ,
    investor_signature_evidence JSONB,
    issuer_signature_evidence   JSONB,
    status                      TEXT NOT NULL DEFAULT 'pending_signatures' CHECK (status IN
                                ('pending_signatures','signed','awaiting_first_tranche',
                                 'effective','completed','cancelled','defaulted')),
    idempotency_key             TEXT NOT NULL UNIQUE,
    effective_at                TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (status NOT IN ('signed','awaiting_first_tranche','effective','completed','defaulted')
           OR (investor_signed_at IS NOT NULL AND issuer_signed_at IS NOT NULL)),
    CHECK (status NOT IN ('effective','completed','defaulted') OR effective_at IS NOT NULL)
);
CREATE INDEX investment_agreements_investor ON investments.investment_agreements (investor_id, status);
CREATE INDEX investment_agreements_offer ON investments.investment_agreements (offer_id, status);

COMMENT ON COLUMN investments.investment_agreements.contract_amount IS
    'ПОЛНАЯ сумма договора. Именно она, а не размер транша, является базой '
    'вознаграждения ОИП (Architect_Launch §5.3, ADR-005).';

CREATE TABLE investments.investment_tranches (
    id                   UUID PRIMARY KEY,
    agreement_id         UUID NOT NULL REFERENCES investments.investment_agreements(id),
    tranche_no           INTEGER NOT NULL CHECK (tranche_no > 0),
    amount               NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    currency             CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    status               TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN
                         ('scheduled','received_nominal','transferred_to_issuer',
                          'confirmed','returned','failed','disputed')),
    bank_transaction_ref TEXT,
    evidence_s3_key      TEXT,
    evidence_wrapped_dek BYTEA,
    received_nominal_at  TIMESTAMPTZ,
    transferred_at       TIMESTAMPTZ,
    confirmed_at         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (agreement_id, tranche_no),
    UNIQUE (bank_transaction_ref),
    CHECK (status <> 'confirmed' OR (confirmed_at IS NOT NULL AND transferred_at IS NOT NULL)),
    CHECK ((evidence_s3_key IS NULL) = (evidence_wrapped_dek IS NULL))
);
CREATE INDEX investment_tranches_agreement ON investments.investment_tranches (agreement_id, tranche_no);

CREATE TABLE investments.nominal_account_transactions (
    id                   UUID PRIMARY KEY,
    tranche_id           UUID REFERENCES investments.investment_tranches(id),
    bank_transaction_ref TEXT NOT NULL UNIQUE,
    direction            TEXT NOT NULL CHECK (direction IN
                         ('incoming','to_issuer','return_to_investor')),
    amount               NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    currency             CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    booked_at            TIMESTAMPTZ NOT NULL,
    raw_statement_sha256 BYTEA NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX nominal_tx_tranche ON investments.nominal_account_transactions (tranche_id);
CREATE INDEX nominal_tx_booked ON investments.nominal_account_transactions (booked_at DESC);

COMMENT ON TABLE investments.nominal_account_transactions IS
    'Операции номинального счёта ОИП. Источник — банковская выписка/событие. '
    'UNIQUE(bank_transaction_ref) делает повтор вебхука безопасным.';

-- Банковские записи не переписываются: спор оформляется новой операцией.
CREATE OR REPLACE FUNCTION investments.forbid_nominal_tx_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, investments, public
AS $$
BEGIN
    RAISE EXCEPTION 'investments.nominal_account_transactions is append-only'
        USING ERRCODE = '42501';
END $$;

CREATE TRIGGER nominal_tx_immutable
    BEFORE UPDATE OR DELETE ON investments.nominal_account_transactions
    FOR EACH ROW EXECUTE FUNCTION investments.forbid_nominal_tx_mutation();

-- ------------------------------------------- допустимые переходы состояний
CREATE OR REPLACE FUNCTION investments.enforce_agreement_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, investments, public
AS $$
DECLARE
    v_allowed TEXT[];
BEGIN
    -- Денежные условия договора неизменяемы после подписания. Проверка стоит
    -- ДО раннего выхода: иначе UPDATE без смены статуса (а именно так и
    -- выглядела бы попытка тихо переписать сумму) проскакивал бы мимо.
    IF OLD.status <> 'pending_signatures' THEN
        IF NEW.contract_amount IS DISTINCT FROM OLD.contract_amount
           OR NEW.fee_schedule_id IS DISTINCT FROM OLD.fee_schedule_id
           OR NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.offer_id IS DISTINCT FROM OLD.offer_id
           OR NEW.investor_id IS DISTINCT FROM OLD.investor_id THEN
            RAISE EXCEPTION
                'contract_amount/fee_schedule_id/currency/parties are immutable after signing'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    IF NEW.status = OLD.status THEN
        NEW.updated_at := now();
        RETURN NEW;
    END IF;

    v_allowed := CASE OLD.status
        WHEN 'pending_signatures'      THEN ARRAY['signed','cancelled']
        -- 'signed' → 'effective' допустим напрямую: подтверждение первого
        -- транша может прийти сразу после подписания, и промежуточный
        -- 'awaiting_first_tranche' в этом случае не наступает.
        WHEN 'signed'                  THEN ARRAY['awaiting_first_tranche','effective','cancelled']
        WHEN 'awaiting_first_tranche'  THEN ARRAY['effective','cancelled','defaulted']
        WHEN 'effective'               THEN ARRAY['completed','defaulted']
        WHEN 'completed'               THEN ARRAY[]::TEXT[]
        WHEN 'cancelled'               THEN ARRAY[]::TEXT[]
        WHEN 'defaulted'               THEN ARRAY[]::TEXT[]
        ELSE ARRAY[]::TEXT[]
    END;
    IF NOT (NEW.status = ANY(v_allowed)) THEN
        RAISE EXCEPTION 'illegal agreement transition % -> %', OLD.status, NEW.status
            USING ERRCODE = '23514';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END $$;

CREATE TRIGGER agreements_transition
    BEFORE UPDATE ON investments.investment_agreements
    FOR EACH ROW EXECUTE FUNCTION investments.enforce_agreement_transition();

-- --------------------------- сумма договоров не превышает цель предложения
CREATE OR REPLACE FUNCTION investments.enforce_offer_capacity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, investments, public
AS $$
DECLARE
    v_offer   RECORD;
    v_taken   NUMERIC(14,2);
BEGIN
    -- Сериализация по предложению: без лока две параллельные заявки по 60%
    -- цели пройдут обе.
    PERFORM pg_advisory_xact_lock(hashtextextended('investments.offer:' || NEW.offer_id::text, 0));

    SELECT * INTO v_offer FROM investments.investment_offers WHERE id = NEW.offer_id;
    IF v_offer.status <> 'published' THEN
        RAISE EXCEPTION 'offer % is not published (status=%)', NEW.offer_id, v_offer.status
            USING ERRCODE = '23514';
    END IF;
    IF v_offer.opens_at IS NOT NULL AND now() < v_offer.opens_at THEN
        RAISE EXCEPTION 'offer % is not open yet', NEW.offer_id USING ERRCODE = '23514';
    END IF;
    IF v_offer.closes_at IS NOT NULL AND now() >= v_offer.closes_at THEN
        RAISE EXCEPTION 'offer % is closed', NEW.offer_id USING ERRCODE = '23514';
    END IF;
    IF NEW.contract_amount < v_offer.min_investment THEN
        RAISE EXCEPTION 'contract_amount % is below min_investment %',
            NEW.contract_amount, v_offer.min_investment USING ERRCODE = '23514';
    END IF;
    IF NEW.currency <> v_offer.currency THEN
        RAISE EXCEPTION 'currency mismatch: agreement % vs offer %', NEW.currency, v_offer.currency
            USING ERRCODE = '23514';
    END IF;

    SELECT coalesce(sum(contract_amount), 0) INTO v_taken
    FROM investments.investment_agreements
    WHERE offer_id = NEW.offer_id
      AND status NOT IN ('cancelled');

    IF v_taken + NEW.contract_amount > v_offer.target_amount THEN
        RAISE EXCEPTION 'offer capacity exceeded: % + % > %',
            v_taken, NEW.contract_amount, v_offer.target_amount USING ERRCODE = '23514';
    END IF;

    -- Запрет self-deal: инвестор не может быть бенефициаром/подписантом ЛПИ.
    IF kyc.is_entity_member(v_offer.issuer_entity_id, NEW.investor_id) THEN
        RAISE EXCEPTION 'self-deal is forbidden: investor is a member of the issuing entity'
            USING ERRCODE = '42501';
    END IF;
    IF lab.is_project_member(v_offer.project_id, NEW.investor_id) THEN
        RAISE EXCEPTION 'self-deal is forbidden: investor is a member of the project team'
            USING ERRCODE = '42501';
    END IF;

    -- KYC инвестора и KYB ЛПИ обязаны быть действующими на момент заключения.
    IF NOT kyc.has_valid_kyc(NEW.investor_id, 'identity') THEN
        RAISE EXCEPTION 'investor KYC is not valid' USING ERRCODE = '42501';
    END IF;
    IF NOT kyc.has_valid_kyb(v_offer.issuer_entity_id) THEN
        RAISE EXCEPTION 'issuer KYB is not valid' USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER agreements_offer_capacity
    BEFORE INSERT ON investments.investment_agreements
    FOR EACH ROW EXECUTE FUNCTION investments.enforce_offer_capacity();

-- ------------------------- сумма траншей не превышает сумму договора
CREATE OR REPLACE FUNCTION investments.enforce_tranche_total()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, investments, public
AS $$
DECLARE
    v_contract NUMERIC(14,2);
    v_sum      NUMERIC(14,2);
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('investments.agreement:' || NEW.agreement_id::text, 0));
    SELECT contract_amount INTO v_contract
    FROM investments.investment_agreements WHERE id = NEW.agreement_id;

    SELECT coalesce(sum(amount), 0) INTO v_sum
    FROM investments.investment_tranches
    WHERE agreement_id = NEW.agreement_id
      AND status NOT IN ('returned','failed')
      AND id <> NEW.id;

    IF v_sum + NEW.amount > v_contract THEN
        RAISE EXCEPTION 'tranche total exceeds contract_amount: % + % > %',
            v_sum, NEW.amount, v_contract USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER tranches_total_limit
    BEFORE INSERT OR UPDATE OF amount ON investments.investment_tranches
    FOR EACH ROW EXECUTE FUNCTION investments.enforce_tranche_total();

-- Клиентский API не может выставить 'confirmed': это делает только серверная
-- команда confirm_first_tranche()/confirm_tranche() по банковскому событию.
CREATE OR REPLACE FUNCTION investments.forbid_client_tranche_confirm()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, investments, public
AS $$
BEGIN
    IF NEW.status = 'confirmed'
       AND coalesce(current_setting('app.bank_event_context', true), '') <> 'on' THEN
        RAISE EXCEPTION
            'tranche can be confirmed only by a bank-event driven server command'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER tranches_confirm_guard
    BEFORE INSERT OR UPDATE OF status ON investments.investment_tranches
    FOR EACH ROW EXECUTE FUNCTION investments.forbid_client_tranche_confirm();

-- ------------------------------------------------------------------------ RLS
ALTER TABLE investments.investment_offers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE investments.investment_offers            FORCE  ROW LEVEL SECURITY;
ALTER TABLE investments.investment_agreements        ENABLE ROW LEVEL SECURITY;
ALTER TABLE investments.investment_agreements        FORCE  ROW LEVEL SECURITY;
ALTER TABLE investments.investment_tranches          ENABLE ROW LEVEL SECURITY;
ALTER TABLE investments.investment_tranches          FORCE  ROW LEVEL SECURITY;
ALTER TABLE investments.nominal_account_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE investments.nominal_account_transactions FORCE  ROW LEVEL SECURITY;

-- Опубликованное предложение видит инвестор с активной подпиской; черновик — ЛПИ и админ.
CREATE POLICY offers_select ON investments.investment_offers FOR SELECT TO app_backend USING (
    app.has_role('admin')
    OR app.has_role('organizer')
    OR kyc.is_entity_member(issuer_entity_id, app.current_user_id())
    OR (app.has_role('investor')
        AND status = 'published'
        AND lab.has_active_investor_membership(app.current_user_id())));

-- app_investments обслуживает банковские события и регулируемые команды —
-- пользовательского контекста у неё нет, поэтому политика широкая осознанно.
CREATE POLICY offers_service_write ON investments.investment_offers FOR ALL
    TO app_investments USING (true) WITH CHECK (true);

CREATE POLICY investment_agreements_parties ON investments.investment_agreements FOR SELECT
    TO app_backend USING (
    investor_id = app.current_user_id()
    OR EXISTS (
        SELECT 1 FROM investments.investment_offers io
        WHERE io.id = investment_agreements.offer_id
          AND kyc.is_entity_signatory(io.issuer_entity_id, app.current_user_id()))
    OR app.has_role('admin')
    OR app.has_role('organizer'));

CREATE POLICY agreements_service_write ON investments.investment_agreements FOR ALL
    TO app_investments USING (true) WITH CHECK (true);

CREATE POLICY investment_tranches_parties ON investments.investment_tranches FOR SELECT
    TO app_backend USING (
    EXISTS (SELECT 1 FROM investments.investment_agreements ia
            WHERE ia.id = investment_tranches.agreement_id
              AND (ia.investor_id = app.current_user_id()
                   OR EXISTS (SELECT 1 FROM investments.investment_offers io
                              WHERE io.id = ia.offer_id
                                AND kyc.is_entity_member(io.issuer_entity_id, app.current_user_id()))))
    OR app.has_role('admin'));

CREATE POLICY investment_service_write ON investments.investment_tranches FOR ALL
    TO app_investments USING (true) WITH CHECK (true);

-- Выписка номинального счёта — только сервис инвестконтура.
-- app_backend не получает на неё ни GRANT, ни политики.
CREATE POLICY nominal_tx_service ON investments.nominal_account_transactions FOR ALL
    TO app_investments USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------- права
GRANT SELECT, INSERT, UPDATE ON investments.investment_offers,
    investments.investment_agreements, investments.investment_tranches TO app_investments;
GRANT SELECT, INSERT ON investments.nominal_account_transactions TO app_investments;

-- app_backend читает регулируемый контур, но НЕ пишет: денежные мутации
-- проходят только через роль app_investments и серверные команды.
GRANT SELECT ON investments.investment_offers, investments.investment_agreements,
    investments.investment_tranches TO app_backend;
GRANT SELECT ON investments.investment_agreements, investments.investment_tranches TO app_billing;
GRANT SELECT ON investments.investment_offers, investments.investment_agreements TO app_integration;

-- ВНИМАНИЕ: у app_backend НЕТ политики `USING (true)` на договоры и транши.
-- Она была бы объединена по ИЛИ с политикой сторон и открыла бы любому
-- пользователю чужие сделки. Доступ идёт только через *_parties.
CREATE POLICY agreements_billing_read ON investments.investment_agreements FOR SELECT
    TO app_billing USING (true);
CREATE POLICY tranches_billing_read ON investments.investment_tranches FOR SELECT
    TO app_billing USING (true);
CREATE POLICY offers_integration_read ON investments.investment_offers FOR SELECT
    TO app_integration USING (true);
CREATE POLICY agreements_integration_read ON investments.investment_agreements FOR SELECT
    TO app_integration USING (true);
