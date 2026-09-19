-- M096 — вознаграждение платформы: общая ставка с долями сторон и начисление
-- с КАЖДОГО подтверждённого транша (5.9.3).
--
-- Решения владельца 2026-09-18 (план 0.2 §0г.2 п.5) и уточнение 2026-09-19:
--
--   • ставка одна и считается от ОДНОЙ базы; между сторонами она
--     РАСПРЕДЕЛЯЕТСЯ в процентных пунктах. Два независимых процента (10 % с
--     инвестора и 5 % с привлекающего по M009) арифметически давали тот же
--     итог, но скрывали главное: договорённость — про общую ставку, а не про
--     две отдельные. Теперь `total_pct` хранится явно, а доли обязаны в неё
--     складываться — иначе «сколько всего берёт платформа» становится
--     предметом вычисления, а не записи;
--
--   • вознаграждение начисляется с каждого ПОДТВЕРЖДЁННОГО транша, а не
--     разово со всей суммы договора при первом транше. Прежняя модель брала
--     деньги за то, что ещё не произошло: договор на 10 млн с одним
--     поступлением в 1 млн давал начисление на все 10 млн.
--
-- Что НЕ решено и поэтому не реализовано: ступенчатые ставки, возврат уже
-- начисленного при возврате транша, перенос между раундами, правило зачёта
-- оплаченных услуг. Конкретные значения ставок тоже не утверждены — сюда
-- перенесены действующие (15 % = 10 % + 5 %) как ДАННЫЕ, а не как решение.

-- ============================================================ условия ставки
-- Общая ставка — отдельная колонка, а не сумма двух: договорённость должна
-- читаться, а не выводиться. Доли остаются в тех же колонках, что и раньше —
-- меняется их смысл: это процентные пункты ОДНОЙ базы, а не независимые
-- проценты. Переименование ничего бы не прибавило, а сломало бы ссылки.
ALTER TABLE billing.fee_schedules
    ADD COLUMN IF NOT EXISTS total_pct NUMERIC(5,2);

UPDATE billing.fee_schedules
   SET total_pct = investor_fee_pct + issuer_fee_pct
 WHERE total_pct IS NULL;

ALTER TABLE billing.fee_schedules
    ALTER COLUMN total_pct SET NOT NULL;

ALTER TABLE billing.fee_schedules
    DROP CONSTRAINT IF EXISTS fee_schedules_shares_sum;
ALTER TABLE billing.fee_schedules
    ADD CONSTRAINT fee_schedules_shares_sum
    CHECK (investor_fee_pct + issuer_fee_pct = total_pct
           AND total_pct >= 0 AND total_pct <= 100);

-- Основание версии: почему условия такие. У перенесённых строк его не было.
ALTER TABLE billing.fee_schedules
    ADD COLUMN IF NOT EXISTS reason TEXT;
UPDATE billing.fee_schedules
   SET reason = 'Перенос M096: условия из стартового сида, значения владельцем не утверждены'
 WHERE reason IS NULL;
ALTER TABLE billing.fee_schedules
    ALTER COLUMN reason SET NOT NULL;
ALTER TABLE billing.fee_schedules
    DROP CONSTRAINT IF EXISTS fee_schedules_reason_len;
ALTER TABLE billing.fee_schedules
    ADD CONSTRAINT fee_schedules_reason_len
    CHECK (length(btrim(reason)) BETWEEN 3 AND 500);

COMMENT ON TABLE billing.fee_schedules IS
    'Неизменяемые версии условий вознаграждения платформы (5.9.3): общая ставка total_pct от '
    'ОДНОЙ базы и её распределение между сторонами в процентных пунктах (доли обязаны '
    'складываться в общую ставку). Значения снимком попадают в начисление: изменить условия '
    'задним числом нельзя (ADR-005).';
COMMENT ON COLUMN billing.fee_schedules.total_pct IS
    'Общая ставка вознаграждения от базы начисления. Доли сторон складываются в неё.';
COMMENT ON COLUMN billing.fee_schedules.investor_fee_pct IS
    'Доля инвестора в процентных пунктах общей ставки (не отдельный процент от базы).';
COMMENT ON COLUMN billing.fee_schedules.issuer_fee_pct IS
    'Доля привлекающего в процентных пунктах общей ставки (не отдельный процент от базы).';

-- Неизменяемость версии распространяется и на общую ставку.
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
       OR NEW.total_pct IS DISTINCT FROM OLD.total_pct
       OR NEW.rules_version IS DISTINCT FROM OLD.rules_version
       OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.valid_from IS DISTINCT FROM OLD.valid_from THEN
        RAISE EXCEPTION 'fee schedule terms are immutable; publish a new version instead'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

-- ====================================================== начисление по траншам
-- Одно начисление на ТРАНШ, а не на договор. UNIQUE(trigger_tranche_id)
-- остаётся и продолжает делать двойное начисление невозможным; UNIQUE по
-- договору уходит — иначе второй транш начислить было бы нечем.
ALTER TABLE billing.commission_accruals
    DROP CONSTRAINT IF EXISTS commission_accruals_agreement_id_key;
CREATE INDEX IF NOT EXISTS commission_accruals_agreement
    ON billing.commission_accruals (agreement_id, accrued_at);

ALTER TABLE billing.commission_accruals
    ADD COLUMN IF NOT EXISTS total_pct NUMERIC(5,2);
UPDATE billing.commission_accruals
   SET total_pct = investor_fee_pct + issuer_fee_pct
 WHERE total_pct IS NULL;
ALTER TABLE billing.commission_accruals
    ALTER COLUMN total_pct SET NOT NULL;

COMMENT ON TABLE billing.commission_accruals IS
    'Начисление вознаграждения платформы (5.9.3): одно на КАЖДЫЙ подтверждённый транш, база — '
    'сумма транша. UNIQUE(trigger_tranche_id) делает повторное начисление по тому же траншу '
    'физически невозможным. Ставки и их распределение — снимок условий на момент начисления.';
COMMENT ON COLUMN billing.commission_accruals.base_amount IS
    'База начисления: сумма ПОДТВЕРЖДЁННОГО транша. До 5.9.3 здесь была полная сумма договора.';

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
       OR NEW.total_pct IS DISTINCT FROM OLD.total_pct
       OR NEW.fee_schedule_id IS DISTINCT FROM OLD.fee_schedule_id
       OR NEW.agreement_id IS DISTINCT FROM OLD.agreement_id
       OR NEW.trigger_tranche_id IS DISTINCT FROM OLD.trigger_tranche_id
       OR NEW.currency IS DISTINCT FROM OLD.currency THEN
        RAISE EXCEPTION 'accrual money fields are immutable; use a compensating entry'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

-- Контекст создания начисления переименован вместе с командой.
CREATE OR REPLACE FUNCTION billing.forbid_manual_accrual()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, public
AS $$
BEGIN
    IF coalesce(current_setting('app.accrual_context', true), '') <> 'confirm_tranche' THEN
        RAISE EXCEPTION
            'commission accrual can be created only by billing.confirm_tranche()'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

-- ------------------------------------------------- проекция для Integration API
-- Проекция остаётся ПО СДЕЛКЕ: наружу интересно «сколько платформа начислила
-- по этому договору», а не по каждому траншу. Поэтому вместо DO NOTHING —
-- накопление: база и доли суммируются, дата — последнего начисления.
CREATE OR REPLACE FUNCTION billing.project_deal_commission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, billing, integration, pg_temp
AS $$
BEGIN
    INSERT INTO integration.deal_commissions
        (agreement_id, accrual_id, base_amount, currency,
         investor_fee_amount, issuer_fee_amount, accrued_at)
    VALUES (NEW.agreement_id, NEW.id, NEW.base_amount, NEW.currency,
            NEW.investor_fee_amount, NEW.issuer_fee_amount, NEW.accrued_at)
    ON CONFLICT (agreement_id) DO UPDATE
        SET accrual_id          = EXCLUDED.accrual_id,
            base_amount         = integration.deal_commissions.base_amount
                                  + EXCLUDED.base_amount,
            investor_fee_amount = integration.deal_commissions.investor_fee_amount
                                  + EXCLUDED.investor_fee_amount,
            issuer_fee_amount   = integration.deal_commissions.issuer_fee_amount
                                  + EXCLUDED.issuer_fee_amount,
            accrued_at          = EXCLUDED.accrued_at;
    RETURN NEW;
END $$;

COMMENT ON TABLE integration.deal_commissions IS
    'Проекция вознаграждения по сделке для Integration API (5.9.3): накопленный итог по всем '
    'подтверждённым траншам договора. base_amount — сумма подтверждённых траншей, а не сумма '
    'договора; accrued_at — дата последнего начисления. Пишется триггером биллинга.';

-- ====================================================== команда подтверждения
-- Подтверждение ТРАНША по банковскому событию. Заменяет confirm_first_tranche:
-- две команды для одного процесса разошлись бы на первом же исключении.
--
-- Что делает атомарно: транш → операция номинального счёта → (для первого
-- транша) договор в силу → начисление по этому траншу → журнал и outbox.
-- Повтор с тем же bank_transaction_ref возвращает прежний результат.
CREATE OR REPLACE FUNCTION billing.confirm_tranche(
    p_agreement_id         UUID,
    p_bank_transaction_ref TEXT,
    p_amount               NUMERIC,
    p_booked_at            TIMESTAMPTZ,
    p_statement_sha256     BYTEA,
    p_actor_id             UUID DEFAULT NULL,
    p_trace_id             TEXT DEFAULT NULL
) RETURNS TABLE (tranche_id UUID, accrual_id UUID, tranche_no INTEGER, already_processed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
-- `public` в пути не нужен: uuid_generate_v7 вызывается с явной схемой,
-- а лишняя схема в пути SECURITY DEFINER — это вектор подмены функции.
SET search_path = pg_catalog, billing, investments, audit, pg_temp
AS $$
DECLARE
    v_agreement   investments.investment_agreements%ROWTYPE;
    v_tranche     investments.investment_tranches%ROWTYPE;
    v_fee         billing.fee_schedules%ROWTYPE;
    v_accrual_id  UUID;
    v_now         TIMESTAMPTZ := now();
    v_existing    RECORD;
    v_no          INTEGER;
    v_confirmed   NUMERIC;
    v_first       BOOLEAN;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'tranche amount must be positive' USING ERRCODE = '23514';
    END IF;

    -- Идемпотентность: повторная доставка того же банковского события.
    SELECT t.id AS tranche_id, t.tranche_no, a.id AS accrual_id
      INTO v_existing
      FROM investments.investment_tranches t
      LEFT JOIN billing.commission_accruals a ON a.trigger_tranche_id = t.id
     WHERE t.bank_transaction_ref = p_bank_transaction_ref;
    IF FOUND THEN
        tranche_id := v_existing.tranche_id;
        accrual_id := v_existing.accrual_id;
        tranche_no := v_existing.tranche_no;
        already_processed := true;
        RETURN NEXT;
        RETURN;
    END IF;

    -- Блокировка договора: два параллельных вебхука не создадут два транша с
    -- одним номером и не начислят дважды.
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

    SELECT COALESCE(MAX(t.tranche_no), 0) + 1,
           COALESCE(SUM(t.amount) FILTER (WHERE t.status = 'confirmed'), 0)
      INTO v_no, v_confirmed
      FROM investments.investment_tranches t
     WHERE t.agreement_id = p_agreement_id;
    v_first := v_no = 1;

    IF v_first THEN
        IF v_agreement.status NOT IN ('signed','awaiting_first_tranche') THEN
            RAISE EXCEPTION 'agreement % is in status % and cannot accept the first tranche',
                p_agreement_id, v_agreement.status USING ERRCODE = '23514';
        END IF;
    ELSIF v_agreement.status <> 'effective' THEN
        RAISE EXCEPTION 'agreement % is in status % and cannot accept a tranche',
            p_agreement_id, v_agreement.status USING ERRCODE = '23514';
    END IF;

    -- Подтверждённые транши не могут превысить сумму договора: иначе
    -- вознаграждение начислялось бы на деньги, которых договор не предполагал.
    IF v_confirmed + p_amount > v_agreement.contract_amount THEN
        RAISE EXCEPTION
            'tranches (% + %) exceed contract amount % for agreement %',
            v_confirmed, p_amount, v_agreement.contract_amount, p_agreement_id
            USING ERRCODE = '23514';
    END IF;

    SELECT * INTO v_fee FROM billing.fee_schedules WHERE id = v_agreement.fee_schedule_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'fee schedule % not found', v_agreement.fee_schedule_id
            USING ERRCODE = 'P0002';
    END IF;

    PERFORM set_config('app.bank_event_context', 'on', true);
    PERFORM set_config('app.accrual_context', 'confirm_tranche', true);

    INSERT INTO investments.investment_tranches
        (id, agreement_id, tranche_no, amount, currency, status,
         bank_transaction_ref, received_nominal_at, transferred_at, confirmed_at)
    VALUES (public.uuid_generate_v7(), p_agreement_id, v_no, p_amount, v_agreement.currency,
            'confirmed', p_bank_transaction_ref, p_booked_at, v_now, v_now)
    RETURNING * INTO v_tranche;

    INSERT INTO investments.nominal_account_transactions
        (id, tranche_id, bank_transaction_ref, direction, amount, currency,
         booked_at, raw_statement_sha256)
    VALUES (public.uuid_generate_v7(), v_tranche.id, p_bank_transaction_ref, 'incoming',
            p_amount, v_agreement.currency, p_booked_at, p_statement_sha256);

    IF v_first THEN
        UPDATE investments.investment_agreements
           SET status = 'effective', effective_at = v_now, updated_at = v_now
         WHERE id = p_agreement_id;
    END IF;

    -- База — сумма ЭТОГО транша. Ставки и доли — снимок условий договора.
    v_accrual_id := public.uuid_generate_v7();
    INSERT INTO billing.commission_accruals
        (id, agreement_id, trigger_tranche_id, fee_schedule_id, base_amount, currency,
         total_pct, investor_fee_pct, issuer_fee_pct, status, accrued_at)
    VALUES (v_accrual_id, p_agreement_id, v_tranche.id, v_fee.id,
            p_amount, v_agreement.currency,
            v_fee.total_pct, v_fee.investor_fee_pct, v_fee.issuer_fee_pct, 'accrued', v_now);

    PERFORM audit.app_emit_event('investment.tranche.confirmed', p_actor_id, 'system',
        'investment_agreement', p_agreement_id,
        jsonb_build_object('tranche_id', v_tranche.id, 'tranche_no', v_no,
                           'amount', p_amount), p_trace_id);
    IF v_first THEN
        PERFORM audit.app_emit_event('investment.first_tranche.confirmed', p_actor_id, 'system',
            'investment_agreement', p_agreement_id,
            jsonb_build_object('tranche_id', v_tranche.id, 'amount', p_amount), p_trace_id);
        PERFORM audit.app_emit_event('investment.agreement.effective', p_actor_id, 'system',
            'investment_agreement', p_agreement_id,
            jsonb_build_object('effective_at', v_now), p_trace_id);
    END IF;
    PERFORM audit.app_emit_event('billing.commission.accrued', p_actor_id, 'system',
        'commission_accrual', v_accrual_id,
        jsonb_build_object('agreement_id', p_agreement_id,
                           'tranche_no', v_no,
                           'base_amount', p_amount,
                           'total_pct', v_fee.total_pct,
                           'investor_fee_pct', v_fee.investor_fee_pct,
                           'issuer_fee_pct', v_fee.issuer_fee_pct), p_trace_id);

    INSERT INTO audit.outbox_events
        (id, aggregate_type, aggregate_id, event_type, payload_jsonb, nats_subject,
         aggregate_version, message_key)
    VALUES
        (public.uuid_generate_v7(), 'investment_agreement', p_agreement_id,
         'investment.tranche.confirmed',
         jsonb_build_object('agreement_id', p_agreement_id, 'tranche_id', v_tranche.id,
                            'tranche_no', v_no, 'amount', p_amount, 'booked_at', p_booked_at),
         'investment.tranche.confirmed', v_no, p_agreement_id::text),
        (public.uuid_generate_v7(), 'commission_accrual', v_accrual_id,
         'billing.commission.accrued',
         jsonb_build_object('accrual_id', v_accrual_id, 'agreement_id', p_agreement_id,
                            'tranche_no', v_no, 'base_amount', p_amount),
         'billing.commission.accrued', 1, v_accrual_id::text);

    IF v_first THEN
        INSERT INTO audit.outbox_events
            (id, aggregate_type, aggregate_id, event_type, payload_jsonb, nats_subject,
             aggregate_version, message_key)
        VALUES
            (public.uuid_generate_v7(), 'investment_agreement', p_agreement_id,
             'investment.agreement.effective',
             jsonb_build_object('agreement_id', p_agreement_id, 'effective_at', v_now),
             'investment.agreement.effective', 0, p_agreement_id::text);
    END IF;

    tranche_id := v_tranche.id;
    accrual_id := v_accrual_id;
    tranche_no := v_no;
    already_processed := false;
    RETURN NEXT;
END $$;

COMMENT ON FUNCTION billing.confirm_tranche IS
    'Атомарно: операция номинального счёта → транш confirmed → (первый транш) договор effective '
    '→ начисление вознаграждения НА СУММУ ЭТОГО ТРАНША → журнал и outbox. Повтор с тем же '
    'bank_transaction_ref возвращает прежний результат (5.9.3, ADR-005).';

-- Команду вызывает ТОЛЬКО роль обработки банковских событий. Ни прикладная
-- роль, ни биллинговая её вызвать не могут: подтверждение транша — не
-- пользовательское действие, и лишний GRANT сделал бы его достижимым из
-- обычного запроса (M032).
REVOKE ALL ON FUNCTION billing.confirm_tranche(UUID, TEXT, NUMERIC, TIMESTAMPTZ, BYTEA, UUID, TEXT)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.confirm_tranche(UUID, TEXT, NUMERIC, TIMESTAMPTZ, BYTEA, UUID, TEXT)
    TO app_investments;

-- Прежняя команда удаляется, а не остаётся «на всякий случай»: две команды
-- одного процесса разошлись бы, и вторая стала бы обходом новой модели.
DROP FUNCTION IF EXISTS billing.confirm_first_tranche(
    UUID, TEXT, NUMERIC, TIMESTAMPTZ, BYTEA, UUID, TEXT);

-- ============================================================== зачёт услуг
-- СТРУКТУРЫ БЕЗ РАСЧЁТА. Правило зачёта (получатель, полное или частичное
-- покрытие, распределение по траншам, остаток, отмены и возвраты, перенос
-- между раундами) владельцем не утверждено, поэтому:
--
--   • правило версионируется и по умолчанию ВЫКЛЮЧЕНО;
--   • при выключенном правиле запись зачёта запрещена триггером — запрет
--     стоит в базе, а не в сервисе, и его не обойти ни новым маршрутом, ни
--     служебной консолью;
--   • ничего не рассчитывается автоматически: сумма зачёта — поле, которое
--     заполнит будущий расчёт по утверждённому правилу.
CREATE TABLE billing.fee_offset_rules (
    id           UUID PRIMARY KEY,
    version      INTEGER NOT NULL UNIQUE CHECK (version > 0),
    is_enabled   BOOLEAN NOT NULL DEFAULT false,
    -- Форма правила появится вместе с решением; пока — пустой объект.
    config_jsonb JSONB NOT NULL DEFAULT '{}',
    reason       TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
    is_active    BOOLEAN NOT NULL DEFAULT false,
    created_by   UUID REFERENCES identity.users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fee_offset_rules_one_active
    ON billing.fee_offset_rules (is_active) WHERE is_active;
COMMENT ON TABLE billing.fee_offset_rules IS
    'Версии правила зачёта оплаченных услуг в вознаграждение (5.9.3). По умолчанию выключено: '
    'правило не утверждено владельцем, а считать деньги по предположению нельзя.';

CREATE TABLE billing.fee_offsets (
    id               UUID PRIMARY KEY,
    accrual_id       UUID NOT NULL REFERENCES billing.commission_accruals(id),
    -- Что именно зачитывается: позиция оплаченной покупки запуска раунда.
    purchase_item_id UUID NOT NULL REFERENCES billing.round_purchase_items(id),
    rule_version     INTEGER NOT NULL REFERENCES billing.fee_offset_rules(version),
    amount           NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    currency         CHAR(3) NOT NULL,
    reason           TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Одна позиция покупки зачитывается в одно начисление один раз: иначе
    -- одна и та же оплаченная услуга уменьшила бы вознаграждение дважды.
    UNIQUE (accrual_id, purchase_item_id)
);
CREATE INDEX fee_offsets_accrual ON billing.fee_offsets (accrual_id);
COMMENT ON TABLE billing.fee_offsets IS
    'Зачёт оплаченной услуги в вознаграждение (5.9.3): структура без расчёта. Пока правило '
    'выключено, запись запрещена триггером.';

CREATE OR REPLACE FUNCTION billing.fee_offsets_enabled()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, billing, public
AS $$
    SELECT COALESCE((SELECT is_enabled FROM billing.fee_offset_rules WHERE is_active), false);
$$;

CREATE OR REPLACE FUNCTION billing.deny_fee_offsets()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, public
AS $$
BEGIN
    IF NOT billing.fee_offsets_enabled() THEN
        RAISE EXCEPTION
            'зачёт услуг выключен: правило не утверждено, запись зачёта запрещена'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER fee_offsets_disabled
    BEFORE INSERT OR UPDATE ON billing.fee_offsets
    FOR EACH ROW EXECUTE FUNCTION billing.deny_fee_offsets();

-- Зачёт — денежный факт: правится компенсирующей записью, не UPDATE.
CREATE OR REPLACE FUNCTION billing.forbid_fee_offset_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, public
AS $$
BEGIN
    RAISE EXCEPTION 'зачёт неизменяем: используйте компенсирующую запись'
        USING ERRCODE = '42501';
END $$;

CREATE TRIGGER fee_offsets_immutable
    BEFORE UPDATE OR DELETE ON billing.fee_offsets
    FOR EACH ROW EXECUTE FUNCTION billing.forbid_fee_offset_rewrite();

INSERT INTO billing.fee_offset_rules (id, version, is_enabled, is_active, reason)
VALUES (public.uuid_generate_v7(), 1, false, true,
        'Стартовое состояние: зачёт выключен до утверждения правила владельцем');

-- ------------------------------------------------------------------------ RLS
ALTER TABLE billing.fee_offset_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.fee_offset_rules FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing.fee_offsets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.fee_offsets      FORCE  ROW LEVEL SECURITY;

-- Правило зачёта — часть публичных условий обслуживания: его читает любой
-- вошедший, меняет администратор.
CREATE POLICY fee_offset_rules_read ON billing.fee_offset_rules FOR SELECT
    TO app_backend USING (app.current_user_id() IS NOT NULL);
CREATE POLICY fee_offset_rules_admin_write ON billing.fee_offset_rules FOR INSERT
    TO app_backend WITH CHECK (app.has_role('admin'));
CREATE POLICY fee_offset_rules_admin_update ON billing.fee_offset_rules FOR UPDATE
    TO app_backend USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

-- Зачёт видит администратор; стороны сделки увидят его в своём начислении,
-- когда правило заработает (сейчас записей нет по построению).
CREATE POLICY fee_offsets_admin_read ON billing.fee_offsets FOR SELECT
    TO app_backend USING (app.has_role('admin'));
CREATE POLICY fee_offsets_admin_write ON billing.fee_offsets FOR INSERT
    TO app_backend WITH CHECK (app.has_role('admin'));

GRANT SELECT, INSERT, UPDATE ON billing.fee_offset_rules TO app_backend;
GRANT SELECT, INSERT ON billing.fee_offsets             TO app_backend;

-- --------------------------------------------------------- глаголы аудита
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('investment.tranche.confirmed',
     'Подтверждён транш по банковскому событию',
     ARRAY['system']),
    ('billing.fee_schedule.published',
     'Опубликована версия условий вознаграждения',
     ARRAY['admin']),
    ('billing.fee_offset_rule.activated',
     'Активирована версия правила зачёта услуг',
     ARRAY['admin'])
ON CONFLICT (verb) DO NOTHING;
