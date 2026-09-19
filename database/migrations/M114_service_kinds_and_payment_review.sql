-- M114 — две поправки, каждая про честность записи.
--
-- 1. РАЗБОР ПО ПРАВИЛАМ И ИИ-АНАЛИЗ — РАЗНЫЕ УСЛУГИ.
--
-- До сих пор способ исполнения назывался `ai_analysis`, а выполнялся расчётом
-- по правилам: языковой модели нет, ключа провайдера нет. Получалось, что
-- услуга, обещающая ИИ-анализ, закрывалась разбором другого рода. Теперь это
-- два разных значения, и закрыть одно другим нельзя.
--
-- Пока провайдер не выбран, услугу с обещанием ИИ-анализа нельзя даже
-- пометить реализованной — то есть нельзя включить в пакет и продать.
--
-- 2. ПОЗДНИЙ УСПЕХ ПЛАТЕЖА НЕ ТЕРЯЕТСЯ.
--
-- Проверенное сообщение оператора о поступлении денег — факт. Его нельзя
-- выбросить и нельзя объявить отменённым только потому, что попытка раньше
-- считалась неуспешной или покупка уже оплачена. Покупка при этом второй раз
-- не активируется: событие сохраняется как ТРЕБУЮЩЕЕ СВЕРКИ, а возможная
-- двойная оплата попадает в отдельную запись о расхождении. Автоматических
-- возвратов нет и не заводится: механизм сверки уточняется при подключении
-- оператора.

-- ===================================== 1. способ исполнения услуги
ALTER TABLE billing.round_services DROP CONSTRAINT IF EXISTS round_services_execution_kind_check;

-- Существующие услуги выполнялись разбором по правилам — так их и называем.
UPDATE billing.round_services SET execution_kind = 'rules_analysis'
 WHERE execution_kind = 'ai_analysis';

ALTER TABLE billing.round_services
    ADD CONSTRAINT round_services_execution_kind_check
    CHECK (execution_kind IN ('manual', 'rules_analysis', 'llm_analysis'));

COMMENT ON COLUMN billing.round_services.execution_kind IS
    'Кто и ЧЕМ выполняет услугу (M111, уточнено M114): manual — сотрудник; rules_analysis — '
    'платформа расчётом по правилам, без языковой модели; llm_analysis — платформа с языковой '
    'моделью. Разбор по правилам не закрывает услугу, обещающую ИИ-анализ.';

/**
 * Услугу с обещанием ИИ-анализа нельзя продавать, пока её нечем выполнить.
 *
 * Условие прямое: включённый флаг языковой модели И действующий ключ
 * провайдера. Нет любого из двух — услугу нельзя пометить реализованной, а
 * значит нельзя ни включить в пакет, ни продать отдельно (M095).
 */
CREATE OR REPLACE FUNCTION billing.guard_llm_service_implemented()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
DECLARE
    v_llm BOOLEAN;
    v_key INTEGER;
BEGIN
    IF NEW.execution_kind <> 'llm_analysis' OR NOT NEW.is_implemented THEN
        RETURN NEW;
    END IF;

    SELECT COALESCE(enabled, false) INTO v_llm
      FROM audit.feature_flags WHERE key = 'ai.scoring.llm.enabled';
    SELECT count(*) INTO v_key
      FROM scoring.ai_provider_credentials WHERE is_active;

    IF NOT COALESCE(v_llm, false) OR v_key = 0 THEN
        RAISE EXCEPTION
            'услуга обещает ИИ-анализ, но выполнить его нечем: нужен включённый флаг языковой '
            'модели и действующий ключ провайдера'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER round_services_llm_guard
    BEFORE INSERT OR UPDATE ON billing.round_services
    FOR EACH ROW EXECUTE FUNCTION billing.guard_llm_service_implemented();

/**
 * Услугу закрывает разбор ТОГО ЖЕ РОДА.
 *
 * Раньше проверялось только наличие успешного прогона. Этого мало: прогон по
 * правилам закрывал бы услугу, за которую заплатили как за ИИ-анализ.
 */
CREATE OR REPLACE FUNCTION billing.guard_item_fulfillment_source()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
DECLARE
    v_kind TEXT;
    v_engine TEXT;
BEGIN
    IF NEW.fulfillment_status <> 'fulfilled' OR NEW.service_code IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT s.execution_kind INTO v_kind
      FROM billing.round_services s WHERE s.code = NEW.service_code;

    IF v_kind IS NULL OR v_kind = 'manual' THEN
        RETURN NEW;
    END IF;

    SELECT r.engine INTO v_engine
      FROM billing.purchase_item_runs r
     WHERE r.item_id = NEW.id AND r.status = 'succeeded' AND r.result_ref IS NOT NULL
     ORDER BY r.finished_at DESC NULLS LAST
     LIMIT 1;

    IF v_engine IS NULL THEN
        RAISE EXCEPTION
            'услуга «%» выполняется платформой: отметка появится после успешного разбора',
            NEW.service_code
            USING ERRCODE = '42501';
    END IF;

    IF (v_kind = 'llm_analysis' AND v_engine <> 'llm')
       OR (v_kind = 'rules_analysis' AND v_engine NOT IN ('rules', 'heuristic')) THEN
        RAISE EXCEPTION
            'услуга «%» обещает разбор рода «%», а выполнен «%»: это разные услуги',
            NEW.service_code, v_kind, v_engine
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

-- Прогон помнит, какого рода разбор был ЗАКАЗАН: сравнивать с фактическим
-- движком нужно и при разборе разногласий, и на экране.
ALTER TABLE billing.purchase_item_runs
    ADD COLUMN IF NOT EXISTS required_kind TEXT
    CHECK (required_kind IS NULL OR required_kind IN ('rules_analysis', 'llm_analysis'));
COMMENT ON COLUMN billing.purchase_item_runs.required_kind IS
    'Род разбора, который обещала услуга на момент запуска (M114). Отличие от фактического '
    'движка — повод разбираться, а не закрывать позицию.';

-- Прогон хранит и то, вошли ли в разбор ОТВЕТЫ анкеты: отчёт по карточке
-- проекта и отчёт по поданной заявке — разные вещи, и называть их одинаково
-- нельзя (см. M115 и снимок входа).
ALTER TABLE billing.purchase_item_runs
    ADD COLUMN IF NOT EXISTS includes_answers BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN billing.purchase_item_runs.includes_answers IS
    'Участвовали ли ответы поданной версии заявки (M114). false — отчёт описывает карточку '
    'проекта, и «анализом версии заявки» его называть нельзя.';

-- ========================= 2. позднее подтверждение и расхождения
ALTER TABLE billing.payment_events DROP CONSTRAINT IF EXISTS payment_events_result_check;
ALTER TABLE billing.payment_events
    ADD CONSTRAINT payment_events_result_check
    CHECK (result IN ('received', 'applied', 'duplicate', 'rejected', 'ignored', 'needs_review'));

COMMENT ON COLUMN billing.payment_events.result IS
    'Что сделано с уведомлением (M108, дополнено M114). needs_review — сообщение проверено и '
    'содержит факт поступления денег, но применить его как обычное подтверждение нельзя: нужна '
    'сверка человеком.';

/**
 * Расхождение по деньгам — то, что платформа НЕ решает сама.
 *
 * Сюда попадает всё, где проверенное сообщение оператора расходится с нашей
 * записью: поздний успех по попытке, считавшейся неуспешной; подтверждение по
 * уже оплаченной покупке (возможная двойная оплата). Никаких автоматических
 * возвратов и списаний: запись существует, чтобы человек разобрался и
 * зафиксировал решение.
 */
CREATE TABLE billing.payment_discrepancies (
    id           UUID PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN (
                   'late_success_after_failure',
                   'possible_double_payment',
                   'amount_mismatch')),
    payment_id   UUID REFERENCES billing.payments(id),
    purchase_id  UUID REFERENCES billing.round_purchases(id),
    event_id     UUID REFERENCES billing.payment_events(id),
    amount       NUMERIC(14,2) CHECK (amount IS NULL OR amount >= 0),
    currency     CHAR(3),
    detail       TEXT NOT NULL CHECK (length(btrim(detail)) BETWEEN 3 AND 1000),
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    resolution   TEXT CHECK (resolution IS NULL OR length(btrim(resolution)) BETWEEN 3 AND 1000),
    resolved_by  UUID REFERENCES identity.users(id),
    resolved_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (status <> 'resolved' OR (resolution IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX payment_discrepancies_open
    ON billing.payment_discrepancies (created_at DESC) WHERE status = 'open';
CREATE INDEX payment_discrepancies_payment
    ON billing.payment_discrepancies (payment_id);

COMMENT ON TABLE billing.payment_discrepancies IS
    'Расхождения между сообщениями оператора платежей и записями платформы (M114). Возвраты и '
    'списания отсюда НЕ происходят: это материал для сверки человеком. Механизм сверки '
    'уточняется при подключении настоящего оператора.';

/** Факт расхождения не переписывается; закрывается только решением с текстом. */
CREATE OR REPLACE FUNCTION billing.forbid_discrepancy_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'расхождение по деньгам не удаляется' USING ERRCODE = '42501';
    END IF;
    IF NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
       OR NEW.event_id IS DISTINCT FROM OLD.event_id
       OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.detail IS DISTINCT FROM OLD.detail THEN
        RAISE EXCEPTION 'запись о расхождении неизменяема' USING ERRCODE = '42501';
    END IF;
    IF OLD.status = 'resolved' AND NEW.status = 'open' THEN
        RAISE EXCEPTION 'закрытое расхождение не открывается заново' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER payment_discrepancies_no_rewrite
    BEFORE UPDATE OR DELETE ON billing.payment_discrepancies
    FOR EACH ROW EXECUTE FUNCTION billing.forbid_discrepancy_rewrite();

-- ------------------------------------------------------------------ RLS
ALTER TABLE billing.payment_discrepancies ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.payment_discrepancies FORCE  ROW LEVEL SECURITY;

CREATE POLICY payment_discrepancies_admin ON billing.payment_discrepancies FOR ALL
    TO app_backend USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));
CREATE POLICY payment_discrepancies_service ON billing.payment_discrepancies FOR ALL
    TO app_billing USING (true) WITH CHECK (true);

GRANT SELECT, UPDATE ON billing.payment_discrepancies TO app_backend;
GRANT SELECT, INSERT, UPDATE ON billing.payment_discrepancies TO app_billing;

INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('billing.payment_discrepancy.recorded',
     'Зафиксировано расхождение по платежу',
     ARRAY['system', 'admin'])
ON CONFLICT (verb) DO NOTHING;
