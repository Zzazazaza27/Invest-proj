-- M110 — состояние оплаты не откатывается назад.
--
-- До этой миграции повторное исполнение предотвращали два механизма, и оба —
-- косвенные: уникальность события оператора (`payment_events`) и уникальный
-- индекс «один незавершённый платёж на покупку». Оба не отвечают на вопрос,
-- который задаёт реальная жизнь оператора платежей:
--
--   • оператор прислал ДВА РАЗНЫХ события об одном успешном платеже
--     (например, `payment.succeeded` и следом `payment.captured`) — у них
--     разные идентификаторы, и уникальность события их не свяжет;
--   • опоздавшее событие по ПЕРВОЙ, уже неуспешной попытке пришло после того,
--     как основатель заплатил со второй попытки.
--
-- В обоих случаях запись обязана остаться такой, какой её сделало первое
-- решение: покупка активируется один раз, а подтверждённая оплата не
-- понижается случайным поздним событием. Проверка в коде для этого
-- недостаточна — она защищает только тот путь, который её вызывает.

/**
 * Состояние платежа движется вперёд, а не назад.
 *
 * Из `pending`/`authorized` можно уйти в любое состояние: решение ещё не
 * принято. Из `succeeded` — только в возврат или chargeback: деньги были, и
 * отрицать это задним числом нельзя. Из `failed`/`canceled` — никуда:
 * неуспешная попытка остаётся неуспешной, а платят заново новой попыткой.
 */
CREATE OR REPLACE FUNCTION billing.guard_payment_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;

    IF OLD.status IN ('failed', 'canceled') THEN
        RAISE EXCEPTION
            'платёж уже завершён как «%»: поздним событием это не меняется', OLD.status
            USING ERRCODE = '42501';
    END IF;

    IF OLD.status = 'succeeded'
       AND NEW.status NOT IN ('partially_refunded', 'refunded', 'chargeback') THEN
        RAISE EXCEPTION
            'подтверждённую оплату нельзя понизить до «%»', NEW.status
            USING ERRCODE = '42501';
    END IF;

    IF OLD.status IN ('partially_refunded', 'refunded', 'chargeback')
       AND NEW.status IN ('pending', 'authorized', 'succeeded', 'failed', 'canceled') THEN
        RAISE EXCEPTION
            'после возврата платёж не возвращается в состояние «%»', NEW.status
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER payments_transition_guard
    BEFORE UPDATE ON billing.payments
    FOR EACH ROW EXECUTE FUNCTION billing.guard_payment_transition();

/**
 * Покупка активируется один раз.
 *
 * Оплаченная покупка не возвращается в ожидание оплаты: это означало бы, что
 * уже оказанная услуга снова ждёт денег, а открытый по ней раунд повис. Отмена
 * и возврат — отдельные состояния, и они остаются доступны.
 *
 * Отдельно защищается момент оплаты: `paid_at` у оплаченной покупки не
 * переписывается. Иначе второе успешное уведомление «переставляло» бы дату
 * оплаты, и по записи нельзя было бы понять, когда деньги поступили на самом
 * деле.
 */
CREATE OR REPLACE FUNCTION billing.guard_purchase_activation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
BEGIN
    IF OLD.status = 'paid' AND NEW.status = 'pending_payment' THEN
        RAISE EXCEPTION 'оплаченная покупка не возвращается в ожидание оплаты'
            USING ERRCODE = '42501';
    END IF;
    IF OLD.status = 'paid' AND OLD.paid_at IS NOT NULL
       AND NEW.paid_at IS DISTINCT FROM OLD.paid_at THEN
        RAISE EXCEPTION 'момент оплаты покупки уже зафиксирован и не переписывается'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER round_purchases_activation_guard
    BEFORE UPDATE ON billing.round_purchases
    FOR EACH ROW EXECUTE FUNCTION billing.guard_purchase_activation();

COMMENT ON FUNCTION billing.guard_payment_transition() IS
    'Состояние платежа движется только вперёд (M110): завершённая попытка не переигрывается, '
    'подтверждённая оплата не понижается поздним событием оператора.';
COMMENT ON FUNCTION billing.guard_purchase_activation() IS
    'Покупка активируется один раз (M110): оплаченная не возвращается в ожидание оплаты, '
    'момент оплаты не переписывается повторным уведомлением.';
