-- M105 — основатель оформляет покупку сам.
--
-- В M095 покупки заводились как структуры при выключенных продажах, поэтому
-- писать в них мог только администратор. С появлением сквозного сценария
-- (M103) покупку оформляет КОМАНДА ПРОЕКТА — иначе «выбрать пакет» упирается
-- в оператора на каждом шаге.
--
-- Границы остаются прежними: покупатель записывает только СВОЮ покупку по
-- СВОЕМУ проекту. Подтверждение оплаты и отметка выполнения услуг сюда не
-- входят — это действия платформы, и они остались за администратором.
CREATE POLICY round_purchases_team_create ON billing.round_purchases FOR INSERT
    TO app_backend WITH CHECK (
        buyer_user_id = app.current_user_id()
        AND lab.is_project_member(project_id, app.current_user_id())
        -- Оформить можно только ожидающую оплаты покупку: «сразу оплачено»
        -- покупатель себе поставить не может.
        AND status = 'pending_payment'
        AND NOT is_test_payment);

CREATE POLICY round_purchase_items_team_create ON billing.round_purchase_items FOR INSERT
    TO app_backend WITH CHECK (
        EXISTS (
            SELECT 1 FROM billing.round_purchases p
             WHERE p.id = round_purchase_items.purchase_id
               AND p.buyer_user_id = app.current_user_id()
               AND p.status = 'pending_payment'
               AND lab.is_project_member(p.project_id, app.current_user_id()))
        -- Позиция заводится только неотмеченной: состояние работы ставит
        -- платформа, а не покупатель.
        AND fulfillment_status = 'planned');
