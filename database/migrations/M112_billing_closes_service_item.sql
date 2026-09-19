-- M112 — услугу закрывает платформа, а не тот, кто её заказал.
--
-- Разбор запускает основатель, но отметку «выполнено» ставит не он: у команды
-- проекта нет и не должно быть права менять состояние позиции покупки —
-- иначе любую услугу можно было бы закрыть самому себе.
--
-- Поэтому запись об исполнении делает денежный контур: то же место, где
-- отмечается поступление оплаты. Границы при этом не расширяются — запрет
-- закрывать услугу платформы без успешного разбора остаётся триггером M111 и
-- действует для ЛЮБОЙ роли, включая эту.

GRANT SELECT, UPDATE ON billing.round_purchase_items TO app_billing;

CREATE POLICY round_purchase_items_billing ON billing.round_purchase_items FOR SELECT
    TO app_billing USING (true);
CREATE POLICY round_purchase_items_billing_update ON billing.round_purchase_items FOR UPDATE
    TO app_billing USING (true) WITH CHECK (true);

COMMENT ON POLICY round_purchase_items_billing_update ON billing.round_purchase_items IS
    'Платформа закрывает позицию покупки по факту исполнения (M112). Денежные поля позиции '
    'по-прежнему неизменяемы, а услугу, которую выполняет платформа, нельзя закрыть без '
    'успешного разбора — оба запрета стоят триггерами и этой политикой не снимаются.';

-- Прогон читается и денежным контуром: без этого он не увидит, что разбор
-- действительно завершился успехом.
GRANT SELECT ON billing.purchase_item_runs TO app_billing;
CREATE POLICY purchase_item_runs_billing ON billing.purchase_item_runs FOR SELECT
    TO app_billing USING (true);
