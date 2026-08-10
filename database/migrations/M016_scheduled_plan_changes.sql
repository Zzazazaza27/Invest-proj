-- =============================================================================
-- M016 — запланированные изменения тарифов
--
-- Продуктовое требование: администратор объявляет новую цену заранее — «с 1-го
-- числа следующего месяца тариф стоит столько». До этой даты действует прежняя
-- версия, после — новая. Пользователь видит и текущую цену, и объявленную.
--
-- Отсюда следует, что запланированную версию нужно уметь ОТМЕНИТЬ: объявление
-- может оказаться ошибочным до вступления в силу. Отмена — это именно удаление
-- ещё не действовавшей версии, а не «закрытие периода»: закрытие оставило бы в
-- истории цену, которая никогда не применялась, и запутало бы и витрину, и
-- разбор споров.
--
-- Удаление ДЕЙСТВУЮЩЕЙ или УЖЕ ДЕЙСТВОВАВШЕЙ версии по-прежнему невозможно.
-- =============================================================================

CREATE OR REPLACE FUNCTION billing.forbid_active_plan_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, public
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        -- Отменить можно только объявление, которое ещё не вступило в силу.
        IF OLD.valid_from > now() THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION
            'нельзя удалить версию тарифа, которая уже действует или действовала; '
            'снимите её с продажи закрытием периода'
            USING ERRCODE = '42501';
    END IF;

    -- Объявленная будущая версия правится свободно: по ней ещё никто не подписан.
    IF OLD.valid_from > now() THEN
        RETURN NEW;
    END IF;

    IF NEW.price IS DISTINCT FROM OLD.price
       OR NEW.ask_limit IS DISTINCT FROM OLD.ask_limit
       OR NEW.individual_pricing IS DISTINCT FROM OLD.individual_pricing
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.billing_period IS DISTINCT FROM OLD.billing_period
       OR NEW.features_jsonb IS DISTINCT FROM OLD.features_jsonb
       OR NEW.code IS DISTINCT FROM OLD.code
       OR NEW.audience IS DISTINCT FROM OLD.audience
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.valid_from IS DISTINCT FROM OLD.valid_from THEN
        RAISE EXCEPTION
            'active plan version is immutable; publish a new version instead'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

-- Триггер обязан ловить и DELETE: без этого удаление шло бы мимо проверки.
DROP TRIGGER IF EXISTS subscription_plans_history_immutable ON billing.subscription_plans;
CREATE TRIGGER subscription_plans_history_immutable
    BEFORE UPDATE OR DELETE ON billing.subscription_plans
    FOR EACH ROW EXECUTE FUNCTION billing.forbid_active_plan_rewrite();

-- Право на удаление выдаётся, но пользуется им только админ (политика
-- plans_admin_write) и только для будущей версии (триггер выше).
GRANT DELETE ON billing.subscription_plans TO app_backend;

INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('billing.plan.schedule_canceled', 'Запланированное изменение тарифа отменено',
     ARRAY['admin','system'])
ON CONFLICT (verb) DO NOTHING;

COMMENT ON FUNCTION billing.forbid_active_plan_rewrite() IS
    'История тарифов неизменяема. Правится и удаляется только объявленная будущая '
    'версия; действующая закрывается по valid_to, но не переписывается.';
