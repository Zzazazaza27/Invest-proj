-- =============================================================================
-- M015 — события биллинга и административных действий
--
-- Регистрация verb'ов, которые начинает писать core в фазе биллинга и
-- админского кабинета. Реестр fail-closed: событие с незарегистрированным verb
-- не пишется вовсе, поэтому регистрация идёт до кода, а не после.
--
-- Отдельно про тарифы: изменение цены — это ПУБЛИКАЦИЯ НОВОЙ ВЕРСИИ, а не
-- правка старой (ADR-005). Поэтому verb называется `published`, а не `updated`:
-- в журнале должно быть видно, что появилась новая версия условий, под которой
-- пользователи будут подписываться, а прежние подписки продолжают жить на своём
-- снапшоте цены.
-- =============================================================================

INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('billing.plan.published',        'Опубликована новая версия тарифа',
     ARRAY['admin','system']),
    ('billing.plan.closed',           'Версия тарифа закрыта (снята с продажи)',
     ARRAY['admin','system']),
    ('billing.plan.draft_updated',    'Правка ещё не вступившей в силу версии тарифа',
     ARRAY['admin','system']),
    ('billing.subscription.created',  'Подписка оформлена',
     ARRAY['founder','investor','admin','system']),
    ('billing.subscription.canceled', 'Подписка отменена',
     ARRAY['founder','investor','admin','system']),
    ('billing.custom_price.proposed', 'Индивидуальная цена предложена',
     ARRAY['admin','system']),
    ('billing.custom_price.approved', 'Индивидуальная цена утверждена вторым администратором',
     ARRAY['admin','system']),
    ('admin.feature_flag.changed',    'Фичефлаг переключён',
     ARRAY['admin','system']),
    ('admin.listing.moderated',       'Листинг снят администратором',
     ARRAY['admin','organizer','system'])
ON CONFLICT (verb) DO NOTHING;

-- ---------------------------------------------------- защита истории тарифов
-- Опубликованная и уже действующая версия тарифа неизменяема в денежной части.
-- Без этого барьера «поправить цену» в админке означало бы переписать условия,
-- на которых люди уже подписались, — и сделать это незаметно.
--
-- Правки допускаются только для версии, которая ЕЩЁ НЕ ВСТУПИЛА В СИЛУ
-- (valid_from в будущем): это черновик, по нему ещё никто не подписан.
-- Закрытие версии (простановка valid_to) разрешено всегда — это снятие тарифа
-- с продажи, а не изменение условий прошлого.
CREATE OR REPLACE FUNCTION billing.forbid_active_plan_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, public
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'subscription plans cannot be deleted; close the period instead'
            USING ERRCODE = '42501';
    END IF;

    -- Черновик будущей версии правится свободно.
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

CREATE TRIGGER subscription_plans_history_immutable
    BEFORE UPDATE OR DELETE ON billing.subscription_plans
    FOR EACH ROW EXECUTE FUNCTION billing.forbid_active_plan_rewrite();

COMMENT ON FUNCTION billing.forbid_active_plan_rewrite() IS
    'Действующая версия тарифа неизменяема: менять можно только черновик будущей '
    'версии или закрыть период. Цена, под которой уже подписались, не переписывается.';
