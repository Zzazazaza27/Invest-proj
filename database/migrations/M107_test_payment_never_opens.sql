-- M107 — покупка, оплаченная тестовым подтверждением, раунд не открывает.
--
-- До этой миграции защита стояла только на МАРШРУТЕ: подтвердить оплату
-- тестом нельзя в рабочем окружении и нельзя при выключенном флаге. Но допуск
-- (`billing.round_purchase_blocker`) смотрел лишь на статус «оплачено» — а
-- значит, запись с `is_test_payment = true`, оказавшаяся в рабочей базе не
-- через маршрут (перенос дампа, восстановление из копии, ручная правка,
-- миграция стенда), открыла бы платный раунд без единого рубля.
--
-- Запрета маршрута недостаточно: проверять надо саму покупку в момент
-- допуска. Поэтому здесь добавлено четвёртое, независимое условие — метка
-- оплаты учитывается при открытии, а не только при её проставлении.
--
-- Условие сформулировано fail-closed: тестовая оплата открывает раунд ТОЛЬКО
-- там, где явно включён флаг тестового подтверждения. В рабочей базе он
-- выключен (M104), записи флага может не быть вовсе — оба случая означают
-- отказ. Бэкенд поверх этого отказывает в production независимо от флага.

CREATE OR REPLACE FUNCTION billing.round_purchase_blocker(p_round_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, billing, pg_temp
AS $$
DECLARE
    v_purchase billing.round_purchases%ROWTYPE;
    v_unfinished INTEGER;
BEGIN
    SELECT * INTO v_purchase
      FROM billing.round_purchases
     WHERE round_id = p_round_id AND status IN ('pending_payment', 'paid')
     ORDER BY created_at DESC
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN 'покупка запуска не оформлена';
    END IF;
    IF v_purchase.status <> 'paid' THEN
        RETURN 'покупка не оплачена';
    END IF;

    -- Оплата тестом — не оплата. Такая покупка допускает открытие только там,
    -- где тестовое подтверждение и так разрешено явно.
    IF v_purchase.is_test_payment
       AND NOT COALESCE(
               (SELECT enabled FROM audit.feature_flags
                 WHERE key = 'billing.test_payment_confirmation'),
               false)
    THEN
        RETURN 'покупка оплачена тестовым подтверждением: настоящей оплаты по ней не было';
    END IF;

    SELECT count(*) INTO v_unfinished
      FROM billing.round_purchase_items i
     WHERE i.purchase_id = v_purchase.id
       AND i.fulfillment_status <> 'fulfilled';
    IF v_unfinished > 0 THEN
        RETURN format('услуги по покупке не выполнены: %s из %s',
                      v_unfinished,
                      (SELECT count(*) FROM billing.round_purchase_items
                        WHERE purchase_id = v_purchase.id));
    END IF;

    RETURN NULL;
END $$;

COMMENT ON FUNCTION billing.round_purchase_blocker(UUID) IS
    'Что мешает открыть платный раунд (M103, ужесточено M107): нет покупки, не оплачена, '
    'оплачена ТЕСТОМ при выключенном флаге тестового подтверждения, или услуги не выполнены. '
    'NULL — препятствий нет. Срок действия здесь не проверяется: ненулевой срок не включается.';
