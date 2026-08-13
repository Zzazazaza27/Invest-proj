-- =============================================================================
-- M054 — RLS биллинга и ролей: три HIGH внешнего аудита 2026-08-13
--
-- 1. Самоактивация подписки. Политика `subscriptions_cancel FOR UPDATE`
--    проверяла только владение: `UPDATE ... SET status='active'` от имени
--    владельца обходил оплату, и `lab.can_list_project` пускал проект в
--    каталог бесплатно. Политика не видит OLD/NEW, поэтому переходы держит
--    BEFORE UPDATE триггер: пользовательский контекст умеет ТОЛЬКО отмену.
--
-- 2. Обход 4-eyes индивидуальной цены. CHECK требовал лишь
--    `set_by <> approved_by` — INSERT с custom_price и произвольными uuid
--    обеих «подписей» проходил мимо custom_price_proposals. Теперь INSERT с
--    ценой запрещён политикой, а UPDATE цены триггер сверяет с утверждённым
--    предложением (та же пара proposed_by/approved_by, та же цена).
--
-- 3. `user_roles_insert WITH CHECK (true)`: app_backend мог выдать admin
--    кому угодно с поддельным granted_by — любая ошибка авторизации в core
--    превращалась в полную эскалацию. Теперь выдача ролей — только админом
--    от своего имени; анонимный путь регистрации ограничен самовыбираемыми
--    ролями контракта (founder/investor) без granted_by.
-- =============================================================================

-- ------------------------------------------------------------- выдача ролей
DROP POLICY user_roles_insert ON identity.user_roles;
CREATE POLICY user_roles_insert ON identity.user_roles FOR INSERT TO app_backend
    WITH CHECK (
        -- Админ выдаёт роль от своего имени: granted_by нельзя подделать.
        (app.has_role('admin') AND granted_by = app.current_user_id())
        -- Регистрация: контекст ещё анонимный (set_config на пользователя
        -- происходит ПОСЛЕ вставки роли), granted_by пуст, роль — только из
        -- самовыбираемых контрактом (SelfServiceRoleSchema). admin/organizer
        -- этим путём не выдать.
        OR (app.current_user_id() IS NULL AND granted_by IS NULL
            AND role IN ('founder', 'investor'))
    );

-- ------------------------------------------------------- создание подписки
DROP POLICY subscriptions_create ON billing.subscriptions;
CREATE POLICY subscriptions_create ON billing.subscriptions FOR INSERT TO app_backend
    WITH CHECK (
        (user_id = app.current_user_id() OR app.has_role('admin'))
        -- Подписка рождается только неоплаченной и только по цене тарифа:
        -- вставка сразу 'active' обходила оплату, вставка с custom_price —
        -- контроль «четырёх глаз» (цена появляется позже, UPDATE'ом админа
        -- по утверждённому предложению — см. триггер ниже).
        AND status = 'pending_payment'
        AND custom_price IS NULL
        AND custom_price_set_by IS NULL
        AND custom_price_approved_by IS NULL
    );

-- ------------------------------------------------- переходы статуса подписки
CREATE OR REPLACE FUNCTION billing.enforce_subscription_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, app, pg_temp
AS $$
BEGIN
    -- Ограничивается именно app_backend — роль, под которой исполняются
    -- пользовательские запросы. Платёжный контур (app_billing) и владелец
    -- (миграции, backfill) работают по своим правилам и грантам.
    IF current_user <> 'app_backend' THEN
        RETURN NEW;
    END IF;

    IF app.has_role('admin') THEN
        -- Принадлежность и снапшоты создания неизменяемы даже админом.
        IF NEW.id <> OLD.id
           OR NEW.user_id <> OLD.user_id
           OR NEW.plan_id <> OLD.plan_id
           OR NEW.project_id IS DISTINCT FROM OLD.project_id
           OR NEW.created_at <> OLD.created_at THEN
            RAISE EXCEPTION 'принадлежность подписки неизменяема';
        END IF;
        -- Индивидуальная цена — только по утверждённому предложению с теми же
        -- подписями (4-eyes живёт в custom_price_proposals, не в паре uuid).
        IF NEW.custom_price IS DISTINCT FROM OLD.custom_price
           OR NEW.custom_price_set_by IS DISTINCT FROM OLD.custom_price_set_by
           OR NEW.custom_price_approved_by IS DISTINCT FROM OLD.custom_price_approved_by THEN
            IF NEW.custom_price IS NULL THEN
                RAISE EXCEPTION 'снятие индивидуальной цены не предусмотрено';
            END IF;
            PERFORM 1 FROM billing.custom_price_proposals p
             WHERE p.subscription_id = NEW.id
               AND p.status = 'approved'
               AND p.price = NEW.custom_price
               AND p.proposed_by = NEW.custom_price_set_by
               AND p.approved_by = NEW.custom_price_approved_by;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'индивидуальная цена без утверждённого предложения (4-eyes)';
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    -- Обычный пользователь: единственный допустимый переход — отмена своей
    -- подписки. Меняться могут ТОЛЬКО status и canceled_at; сравнение через
    -- jsonb покрывает и будущие колонки, которые появятся после этой миграции.
    IF NEW.status <> 'canceled'
       OR (to_jsonb(NEW) - 'status' - 'canceled_at') <> (to_jsonb(OLD) - 'status' - 'canceled_at') THEN
        RAISE EXCEPTION 'в пользовательском контексте подписку можно только отменить';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS subscriptions_transition_guard ON billing.subscriptions;
CREATE TRIGGER subscriptions_transition_guard
    BEFORE UPDATE ON billing.subscriptions
    FOR EACH ROW EXECUTE FUNCTION billing.enforce_subscription_update();

COMMENT ON FUNCTION billing.enforce_subscription_update() IS
    'Переходы статуса подписки: пользователь — только отмена; админ — без смены '
    'принадлежности, custom_price только по утверждённому предложению (M054).';
