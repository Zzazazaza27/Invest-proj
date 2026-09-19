-- M094 — удаление отменённой модели «подписка основателя по сумме» (5.9).
--
-- Решение владельца (план 0.2 §0г.2 п. 2, уточнение 2026-09-19): основатель
-- платит РАЗОВО за запуск конкретного раунда; ежемесячная подписка по сумме
-- привлечения отменена. Продукт не запущен, продуктовые данные тестовые,
-- поэтому старая модель удаляется целиком, а не остаётся «на совместимость»:
-- две конкурирующие модели одного процесса — источник ошибок дороже, чем
-- любая экономия на удалении.
--
-- Что уходит и почему именно это:
--
--   • барьер листинга (`lab.listing_requires_subscription`,
--     `lab.can_list_project`, триггер `projects_listing_requires_subscription`
--     и флаг `billing.listing_requires_subscription`) — публикация проекта
--     больше не зависит от тарифа основателя вовсе;
--   • `lab.projects.required_plan_id` — кеш тарифа. Он пересчитывался при
--     каждом изменении суммы и при смене режима видимости; новая модель о
--     тарифе основателя не знает. Кеш ради прежних вызовов не сохраняем;
--   • `billing.resolve_founder_plan` — резолвер тарифа по сумме;
--   • тарифы `founder_t1…t5` и подписки на них, их счета и платежи;
--   • индивидуальная цена (`custom_price*`, `billing.custom_price_proposals`)
--     — механизм существовал только для тарифа `founder_t5`;
--   • `billing.subscriptions.project_id` — подписка на КОНКРЕТНЫЙ проект была
--     формой подписки основателя. Подписка инвестора всегда на аккаунт.
--
-- Что остаётся: подписки инвесторов, счета, платежи, идемпотентность, аудит,
-- условия и начисления вознаграждения. Они нужны новым покупкам пакетов.

-- --------------------------------------------------- барьер листинга
DROP TRIGGER IF EXISTS projects_listing_requires_subscription ON lab.projects;
DROP FUNCTION IF EXISTS lab.enforce_listing_requires_subscription();
DROP FUNCTION IF EXISTS lab.can_list_project(UUID);
DROP FUNCTION IF EXISTS lab.listing_requires_subscription();
DELETE FROM audit.feature_flags WHERE key = 'billing.listing_requires_subscription';

-- --------------------------------------------------- тариф в проекте
ALTER TABLE lab.projects DROP CONSTRAINT IF EXISTS projects_required_plan_fk;
ALTER TABLE lab.projects DROP COLUMN IF EXISTS required_plan_id;
DROP FUNCTION IF EXISTS billing.resolve_founder_plan(NUMERIC, TIMESTAMPTZ);

-- --------------------------------------------------- данные старой модели
-- Порядок: платежи → счета → предложения цены → подписки → тарифы.
-- Счета и платежи удаляются ТОЛЬКО те, что относятся к подпискам основателя;
-- начисления вознаграждения и их счета не трогаются.
--
-- Блок обёрнут в проверку наличия колонки `audience`: без неё повторный
-- прогон миграции на уже очищенной базе падал бы на разборе запроса, а
-- миграция обязана быть применимой к той схеме, которую сама и оставляет.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'billing' AND table_name = 'subscription_plans'
                  AND column_name = 'audience') THEN
        DELETE FROM billing.payments p
         USING billing.invoices i, billing.subscriptions s, billing.subscription_plans sp
         WHERE p.invoice_id = i.id AND i.subscription_id = s.id AND s.plan_id = sp.id
           AND sp.audience = 'founder';
        DELETE FROM billing.invoices i
         USING billing.subscriptions s, billing.subscription_plans sp
         WHERE i.subscription_id = s.id AND s.plan_id = sp.id AND sp.audience = 'founder';
        DELETE FROM billing.subscriptions s
         USING billing.subscription_plans sp
         WHERE s.plan_id = sp.id AND sp.audience = 'founder';
        -- Версии тарифов защищены триггером M016: действовавшую цену нельзя
        -- удалить случайной командой. Здесь удаляется не цена, а целая
        -- отменённая модель, и делает это миграция схемы — поэтому защита
        -- снимается на одну команду и возвращается сразу же.
        EXECUTE 'ALTER TABLE billing.subscription_plans DISABLE TRIGGER subscription_plans_history_immutable';
        DELETE FROM billing.subscription_plans WHERE audience = 'founder';
        EXECUTE 'ALTER TABLE billing.subscription_plans ENABLE TRIGGER subscription_plans_history_immutable';
    END IF;
END $$;

-- --------------------------------------------------- индивидуальная цена
-- Политика создания подписки (M054) перечисляет колонки индивидуальной цены,
-- поэтому переписывается до удаления колонок. Правило то же: подписка
-- рождается неоплаченной и по цене тарифа.
DROP POLICY IF EXISTS subscriptions_create ON billing.subscriptions;
CREATE POLICY subscriptions_create ON billing.subscriptions FOR INSERT TO app_backend
    WITH CHECK (
        (user_id = app.current_user_id() OR app.has_role('admin'))
        AND status = 'pending_payment'
    );

-- Триггер переходов (M054) проверял индивидуальную цену и project_id —
-- ни того, ни другого больше нет. Остальное правило сохранено дословно:
-- принадлежность и снимки создания неизменяемы, пользователь может только
-- отменить свою подписку.
CREATE OR REPLACE FUNCTION billing.enforce_subscription_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, app, pg_temp
AS $$
BEGIN
    IF current_user <> 'app_backend' THEN
        RETURN NEW;
    END IF;

    IF app.has_role('admin') THEN
        IF NEW.id <> OLD.id
           OR NEW.user_id <> OLD.user_id
           OR NEW.plan_id <> OLD.plan_id
           OR NEW.created_at <> OLD.created_at THEN
            RAISE EXCEPTION 'принадлежность подписки неизменяема';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.status <> 'canceled'
       OR (to_jsonb(NEW) - 'status' - 'canceled_at') <> (to_jsonb(OLD) - 'status' - 'canceled_at') THEN
        RAISE EXCEPTION 'в пользовательском контексте подписку можно только отменить';
    END IF;
    RETURN NEW;
END $$;

DROP TABLE IF EXISTS billing.custom_price_proposals;
ALTER TABLE billing.subscriptions
    DROP CONSTRAINT IF EXISTS subscriptions_custom_price_check,
    DROP COLUMN IF EXISTS custom_price,
    DROP COLUMN IF EXISTS custom_price_set_by,
    DROP COLUMN IF EXISTS custom_price_approved_by;

-- --------------------------------------------------- подписка = аккаунт
DROP INDEX IF EXISTS billing.subscriptions_project;
DROP INDEX IF EXISTS billing.subscriptions_one_active_per_project;
DROP INDEX IF EXISTS billing.subscriptions_one_investor_active;
ALTER TABLE billing.subscriptions DROP COLUMN IF EXISTS project_id;
-- Одна незакрытая подписка на человека: без project_id условие проще и
-- выражает то же правило, что прежний индекс для инвестора.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_active_per_user
    ON billing.subscriptions (user_id)
    WHERE status IN ('pending_payment', 'active', 'past_due');

-- --------------------------------------------------- тарифы — только инвестору
ALTER TABLE billing.subscription_plans
    DROP COLUMN IF EXISTS ask_limit,
    DROP COLUMN IF EXISTS individual_pricing,
    DROP COLUMN IF EXISTS audience;
-- Перечень кодов был закрытым списком с тарифами основателя. Теперь код —
-- имя тарифа инвестора: состав задаётся в админке (5.9.4), а не миграцией.
ALTER TABLE billing.subscription_plans
    DROP CONSTRAINT IF EXISTS subscription_plans_code_check;
ALTER TABLE billing.subscription_plans
    DROP CONSTRAINT IF EXISTS subscription_plans_code_shape;
ALTER TABLE billing.subscription_plans
    ADD CONSTRAINT subscription_plans_code_shape
    CHECK (code ~ '^[a-z][a-z0-9_]{2,40}$');
ALTER TABLE billing.subscription_plans
    DROP CONSTRAINT IF EXISTS subscription_plans_check1;
ALTER TABLE billing.subscription_plans
    ALTER COLUMN price SET NOT NULL;
COMMENT ON TABLE billing.subscription_plans IS
    'Ежемесячные тарифы ИНВЕСТОРА версиями (M094): подписка основателя отменена — запуск раунда '
    'оплачивается разово (5.9). Цена, валюта и состав возможностей задаются в админке.';

DROP INDEX IF EXISTS billing.subscription_plans_lookup;
CREATE INDEX IF NOT EXISTS subscription_plans_lookup
    ON billing.subscription_plans (valid_from, valid_to);

-- --------------------------------------------------- форма подписки
CREATE OR REPLACE FUNCTION billing.enforce_subscription_shape()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, public
AS $$
DECLARE
    v_plan RECORD;
BEGIN
    SELECT * INTO v_plan FROM billing.subscription_plans WHERE id = NEW.plan_id;
    IF v_plan IS NULL THEN
        RAISE EXCEPTION 'subscription plan % not found', NEW.plan_id USING ERRCODE = 'P0002';
    END IF;
    -- Снимок цены обязан совпадать с ценой тарифа: изменение прайса не
    -- переписывает уже оформленную подписку, но и разойтись с ней нельзя.
    IF NEW.price_snapshot <> v_plan.price THEN
        RAISE EXCEPTION 'price_snapshot % does not match plan price %',
            NEW.price_snapshot, v_plan.price USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

-- Членство инвестора: все тарифы теперь инвесторские, различать аудиторию
-- больше нечем и незачем.
CREATE OR REPLACE FUNCTION lab.has_active_investor_membership(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, lab, billing, public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM billing.subscriptions s
         WHERE s.user_id = p_user_id AND s.status = 'active');
$$;
COMMENT ON FUNCTION lab.has_active_investor_membership(UUID) IS
    'Действующее членство инвестора: активная подписка аккаунта (M094 — подписки основателя '
    'удалены, все тарифы инвесторские).';

-- ------------------------------------------- неизменяемость версий тарифа
-- Триггер M016 перечисляет колонки денежных условий поимённо, и среди них
-- были ask_limit, individual_pricing и audience. После их удаления функция
-- падала бы на любом UPDATE («record new has no field ask_limit»), то есть
-- защита истории цен перестала бы работать вовсе. Переписывается тем же
-- правилом без удалённых полей.
CREATE OR REPLACE FUNCTION billing.forbid_active_plan_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, public
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
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
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.billing_period IS DISTINCT FROM OLD.billing_period
       OR NEW.features_jsonb IS DISTINCT FROM OLD.features_jsonb
       OR NEW.code IS DISTINCT FROM OLD.code
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.valid_from IS DISTINCT FROM OLD.valid_from THEN
        RAISE EXCEPTION
            'active plan version is immutable; publish a new version instead'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;
