-- M108 — точка подключения оператора онлайн-платежей к УЖЕ существующим
-- покупкам и платежам. Второго биллинга здесь нет и не заводится.
--
-- Решение владельца 2026-09-19: пакеты запуска раунда, докупаемые услуги и
-- подписки инвестора будут оплачиваться через оператора онлайн-платежей.
-- Провайдер и получатель ещё не выбраны (предполагается ИП, конфигурация не
-- утверждена), поэтому здесь готовится МЕСТО подключения, а не интеграция с
-- конкретным сервисом.
--
-- Что уже было и переиспользуется без переписывания:
--
--   • billing.payments (M009) — сумма, валюта, provider, provider_ref,
--     статусы, idempotency_key UNIQUE, request_hash,
--     UNIQUE (provider, provider_ref);
--   • billing.invoices (M009) — счёт по подписке или начислению;
--   • денежный контур app_billing: роль приложения деньги не пишет;
--   • флаг billing.payments.enabled — приём платежей выключен (fail-closed).
--
-- Чего не хватало: платёж нельзя было связать с покупкой запуска раунда
-- (счёт требует подписку или начисление), не было разделения тестового и
-- рабочего режимов и не было защиты от повторной обработки уведомления
-- провайдера.
--
-- ВАЖНО о деньгах инвестора. Эта таблица — платежи В ПОЛЬЗУ ПЛАТФОРМЫ.
-- Переводы инвестора в проект и оплата комиссии сторонами здесь не проходят
-- и через провайдера оплаты услуг автоматически не направляются (решение
-- владельца). Комментарий M009 на этот счёт остаётся в силе.

-- ===================================================== платёж за покупку
ALTER TABLE billing.payments ALTER COLUMN invoice_id DROP NOT NULL;
ALTER TABLE billing.payments
    ADD COLUMN IF NOT EXISTS purchase_id UUID REFERENCES billing.round_purchases(id);
ALTER TABLE billing.payments
    ADD CONSTRAINT payments_one_subject CHECK (num_nonnulls(invoice_id, purchase_id) = 1);
CREATE INDEX payments_purchase ON billing.payments (purchase_id, status);
COMMENT ON COLUMN billing.payments.purchase_id IS
    'Платёж за покупку запуска раунда (M108). Ровно один предмет оплаты: либо счёт, либо покупка.';

-- ===================================================== тест и рабочий режим
-- Режим принадлежит ПЛАТЕЖУ, а не настройке: иначе завтрашнее переключение
-- задним числом переписало бы смысл вчерашних записей.
ALTER TABLE billing.payments
    ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'test'
    CHECK (mode IN ('test', 'live'));
ALTER TABLE billing.payments ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE billing.payments ADD COLUMN IF NOT EXISTS failure_reason TEXT
    CHECK (failure_reason IS NULL OR length(btrim(failure_reason)) BETWEEN 3 AND 500);
COMMENT ON COLUMN billing.payments.mode IS
    'test — платёж тестового адаптера, денег не двигает; live — настоящий приём (M108). '
    'Неизменяем. Рабочий режим включается только при поднятом billing.payments.enabled.';

-- Отменённый платёж — обычное состояние, а не ошибка: пользователь закрыл
-- страницу оплаты.
ALTER TABLE billing.payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE billing.payments ADD CONSTRAINT payments_status_check CHECK (status IN
    ('pending','authorized','succeeded','failed','canceled',
     'partially_refunded','refunded','chargeback'));

/**
 * Рабочий режим — только при явно включённом приёме платежей.
 *
 * Fail-closed: отсутствие записи флага означает отказ. Это тот же флаг, что
 * закрывает POST /v1/billing/payments, — второго рубильника не заводим.
 */
CREATE OR REPLACE FUNCTION billing.guard_payment_mode()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.mode IS DISTINCT FROM OLD.mode THEN
        RAISE EXCEPTION 'режим платежа неизменяем' USING ERRCODE = '42501';
    END IF;
    IF NEW.mode = 'live'
       AND NOT COALESCE((SELECT enabled FROM audit.feature_flags
                          WHERE key = 'billing.payments.enabled'), false)
    THEN
        RAISE EXCEPTION 'приём настоящих платежей выключен: платёж в рабочем режиме не создаётся'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER payments_mode_guard
    BEFORE INSERT OR UPDATE ON billing.payments
    FOR EACH ROW EXECUTE FUNCTION billing.guard_payment_mode();

/** Сумма, валюта и предмет оплаты — снимок: меняется только состояние. */
CREATE OR REPLACE FUNCTION billing.forbid_payment_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'платёж нельзя удалить: это финансовый факт' USING ERRCODE = '42501';
    END IF;
    IF NEW.id <> OLD.id
       OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
       OR NEW.purchase_id IS DISTINCT FROM OLD.purchase_id
       OR NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
        RAISE EXCEPTION 'денежные поля платежа неизменяемы' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER payments_no_rewrite
    BEFORE UPDATE OR DELETE ON billing.payments
    FOR EACH ROW EXECUTE FUNCTION billing.forbid_payment_rewrite();

/**
 * Одна незавершённая попытка оплаты на покупку.
 *
 * Защита от повторного исполнения на уровне данных: два одновременных нажатия
 * кнопки оплаты не создают двух платежей по одной покупке. Неуспешная и
 * отменённая попытки не мешают начать новую.
 */
CREATE UNIQUE INDEX payments_active_per_purchase
    ON billing.payments (purchase_id)
    WHERE purchase_id IS NOT NULL AND status IN ('pending', 'authorized', 'succeeded');

-- ============================================ уведомления провайдера
-- Сырое уведомление, как оно пришло. Нужно по трём причинам: доказать, что
-- подтверждение было проверяемым; не обработать одно событие дважды; понять
-- постфактум, что именно прислал провайдер.
CREATE TABLE billing.payment_events (
    id             UUID PRIMARY KEY,
    provider       TEXT NOT NULL,
    event_id       TEXT NOT NULL,
    event_type     TEXT NOT NULL,
    payment_id     UUID REFERENCES billing.payments(id),
    provider_ref   TEXT,
    signature_ok   BOOLEAN NOT NULL,
    payload_sha256 BYTEA NOT NULL,
    payload_jsonb  JSONB NOT NULL,
    received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_at     TIMESTAMPTZ,
    result         TEXT NOT NULL DEFAULT 'received'
                   CHECK (result IN ('received','applied','duplicate','rejected','ignored')),
    UNIQUE (provider, event_id)
);
CREATE INDEX payment_events_payment ON billing.payment_events (payment_id, received_at DESC);
COMMENT ON TABLE billing.payment_events IS
    'Уведомления оператора платежей как пришли (M108). UNIQUE (provider, event_id) — защита от '
    'повторной обработки одного события: второе такое же уведомление не исполняется заново. '
    'Возврат пользователя со страницы оплаты сюда не попадает и оплату не подтверждает.';

/** Уведомление — свершившийся факт: переписывать его нельзя. */
CREATE OR REPLACE FUNCTION billing.forbid_payment_event_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'уведомление провайдера не удаляется' USING ERRCODE = '42501';
    END IF;
    IF NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.event_id IS DISTINCT FROM OLD.event_id
       OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
       OR NEW.payload_jsonb IS DISTINCT FROM OLD.payload_jsonb
       OR NEW.signature_ok IS DISTINCT FROM OLD.signature_ok THEN
        RAISE EXCEPTION 'уведомление провайдера неизменяемо' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER payment_events_no_rewrite
    BEFORE UPDATE OR DELETE ON billing.payment_events
    FOR EACH ROW EXECUTE FUNCTION billing.forbid_payment_event_rewrite();

-- =================================================== подписка ≠ продление
-- Оплата подписки и АВТОМАТИЧЕСКОЕ ПРОДЛЕНИЕ — разные вещи. Рекуррентные
-- списания не включаются без отдельного решения владельца: сохранённое
-- средство платежа и списание без участия человека — это отдельная
-- договорённость с пользователем, а не следствие первой оплаты.
ALTER TABLE billing.subscriptions
    ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN billing.subscriptions.auto_renew IS
    'Автоматическое продление (M108). Всегда false: рекуррентные списания не включены. '
    'Оплата подписки — разовое действие пользователя; продление требует отдельного решения.';

CREATE OR REPLACE FUNCTION billing.deny_auto_renew()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
BEGIN
    IF NEW.auto_renew THEN
        RAISE EXCEPTION
            'автопродление не включается: рекуррентные списания требуют отдельного решения'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER subscriptions_deny_auto_renew
    BEFORE INSERT OR UPDATE ON billing.subscriptions
    FOR EACH ROW EXECUTE FUNCTION billing.deny_auto_renew();

-- ------------------------------------------------------------------ RLS
ALTER TABLE billing.payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.payment_events FORCE  ROW LEVEL SECURITY;

-- Сырое уведомление — служебные данные: их читает администратор, пишет
-- денежный контур. Пользователю показывается состояние платежа, а не payload.
CREATE POLICY payment_events_admin_read ON billing.payment_events FOR SELECT
    TO app_backend USING (app.has_role('admin'));
CREATE POLICY payment_events_service ON billing.payment_events FOR ALL
    TO app_billing USING (true) WITH CHECK (true);

GRANT SELECT ON billing.payment_events TO app_backend;
GRANT SELECT, INSERT, UPDATE ON billing.payment_events TO app_billing;

-- Платёж по покупке видит её покупатель: у таких платежей user_id — покупатель,
-- и действующей политики payments_own для этого достаточно.

-- --------------------------------------------------------- глаголы аудита
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('billing.payment.created',
     'Создан платёж за услугу платформы',
     ARRAY['founder', 'investor', 'admin']),
    ('billing.payment.confirmed',
     'Платёж подтверждён уведомлением провайдера',
     ARRAY['system', 'admin']),
    ('billing.payment.failed',
     'Платёж не прошёл или отменён',
     ARRAY['system', 'admin'])
ON CONFLICT (verb) DO NOTHING;
