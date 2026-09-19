-- M103 — сквозной сценарий покупки пакета: явные альтернативы, сохранение
-- выбора, состояние выполнения услуг, тестовое подтверждение оплаты.
--
-- Решения владельца 2026-09-19:
--
--   • порядок: бесплатная проверка готовности → оплата → выполнение услуг →
--     окончательный допуск → открытие раунда. Возврат оплаты при отказе —
--     отдельное ручное урегулирование, автоматических перечислений нет;
--   • покупка относится к ОДНОМУ раунду. Пауза и возобновление повторной
--     оплаты не требуют; после закрытия или отмены новое привлечение — новая
--     покупка;
--   • срок действия покупки настраивается в пакете, по умолчанию 0 — без
--     ограничения. Ненулевой срок ВКЛЮЧАТЬ НЕЛЬЗЯ, пока не определены начало
--     отсчёта, влияние паузы и последствия истечения для открытого раунда;
--   • допустимые альтернативы пакета задаёт АДМИНИСТРАТОР явно. Ни цена, ни
--     совпадение состава не делают пакет заменой автоматически; проверка
--     состава остаётся предупреждением администратору.

-- ============================================ явные альтернативы пакета
CREATE TABLE billing.round_package_alternatives (
    package_id     UUID NOT NULL REFERENCES billing.round_packages(id) ON DELETE CASCADE,
    alternative_id UUID NOT NULL REFERENCES billing.round_packages(id) ON DELETE CASCADE,
    reason         TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
    created_by     UUID REFERENCES identity.users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (package_id, alternative_id),
    CHECK (package_id <> alternative_id)
);
CREATE INDEX round_package_alternatives_alt
    ON billing.round_package_alternatives (alternative_id);
COMMENT ON TABLE billing.round_package_alternatives IS
    'Чем администратор РАЗРЕШИЛ заменить требуемый пакет (M103). Список явный: ни цена, ни '
    'совпадение состава альтернативой не делают. Проверка состава — предупреждение '
    'администратору при настройке, а не правило допуска.';

/** Альтернатива живёт в той же стране: сетки стран независимы. */
CREATE OR REPLACE FUNCTION billing.assert_alternative_same_country()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
DECLARE
    v_a TEXT;
    v_b TEXT;
BEGIN
    SELECT country_code INTO v_a FROM billing.round_packages WHERE id = NEW.package_id;
    SELECT country_code INTO v_b FROM billing.round_packages WHERE id = NEW.alternative_id;
    IF v_a IS DISTINCT FROM v_b THEN
        RAISE EXCEPTION 'альтернатива из другой страны обслуживания (% и %)', v_a, v_b
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER round_package_alternatives_country
    BEFORE INSERT OR UPDATE ON billing.round_package_alternatives
    FOR EACH ROW EXECUTE FUNCTION billing.assert_alternative_same_country();

-- ==================================================== срок действия покупки
-- Настройка пакета. 0 — без ограничения срока: сегодня работает только это.
ALTER TABLE billing.round_packages
    ADD COLUMN IF NOT EXISTS validity_days INTEGER NOT NULL DEFAULT 0
    CHECK (validity_days >= 0);
COMMENT ON COLUMN billing.round_packages.validity_days IS
    'Срок действия покупки в днях; 0 — без ограничения (M103). Ненулевой срок включать нельзя, '
    'пока не определены начало отсчёта, влияние паузы и последствия истечения для открытого '
    'раунда — запрет стоит триггером.';

/**
 * Ненулевой срок не включается.
 *
 * Не потому, что его нельзя посчитать, а потому, что не решено главное: с
 * какого момента идёт отсчёт, останавливает ли его пауза и что происходит с
 * УЖЕ ОТКРЫТЫМ раундом, когда срок истёк. Включить настройку раньше ответа —
 * значит однажды закрыть кому-то работающее привлечение по правилу, которого
 * никто не формулировал.
 */
CREATE OR REPLACE FUNCTION billing.deny_package_validity_days()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
BEGIN
    IF NEW.validity_days <> 0 THEN
        RAISE EXCEPTION
            'срок действия покупки не включается: не определены начало отсчёта, влияние паузы '
            'и последствия истечения для открытого раунда'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER round_packages_validity_days
    BEFORE INSERT OR UPDATE ON billing.round_packages
    FOR EACH ROW EXECUTE FUNCTION billing.deny_package_validity_days();

-- ======================================================== сохранение выбора
-- Выбор основателя до оформления покупки. Денег здесь нет: это черновик
-- намерения, который переживает перезагрузку страницы.
CREATE TABLE billing.round_package_selections (
    round_id      UUID PRIMARY KEY REFERENCES lab.funding_rounds(id) ON DELETE CASCADE,
    package_code  TEXT CHECK (package_code IS NULL OR package_code ~ '^[a-z][a-z0-9_]{2,40}$'),
    service_codes TEXT[] NOT NULL DEFAULT '{}',
    updated_by    UUID REFERENCES identity.users(id),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE billing.round_package_selections IS
    'Сохранённый выбор пакета и докупаемых услуг до оформления покупки (M103). Черновик '
    'намерения: цен не фиксирует, обязательств не создаёт. Цена фиксируется снимком покупки.';

-- ======================================== покупка: срок, тест, выполнение
ALTER TABLE billing.round_purchases
    ADD COLUMN IF NOT EXISTS validity_days INTEGER NOT NULL DEFAULT 0
    CHECK (validity_days >= 0);
COMMENT ON COLUMN billing.round_purchases.validity_days IS
    'Снимок срока из пакета на момент покупки (M103). 0 — без ограничения. Последующее '
    'изменение пакета уже купленное не меняет.';

-- Тестовое подтверждение оплаты помечается прямо в покупке: иначе потом не
-- отличить настоящую оплату от проверочной.
ALTER TABLE billing.round_purchases
    ADD COLUMN IF NOT EXISTS is_test_payment BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN billing.round_purchases.is_test_payment IS
    'Оплата подтверждена ТЕСТОВЫМ действием, а не деньгами (M103). Метка неснимаемая: покупка '
    'с ней никогда не станет настоящей.';

ALTER TABLE billing.round_purchases
    ADD COLUMN IF NOT EXISTS status_reason TEXT
    CHECK (status_reason IS NULL OR length(btrim(status_reason)) BETWEEN 3 AND 500);

-- Черновик покупки: оформлена, но ещё не выставлена к оплате. Прежние
-- состояния сохраняются.
ALTER TABLE billing.round_purchases DROP CONSTRAINT IF EXISTS round_purchases_status_check;
ALTER TABLE billing.round_purchases
    ADD CONSTRAINT round_purchases_status_check
    CHECK (status IN ('pending_payment','paid','cancelled','refunded'));

-- Состояние выполнения услуг по КОНКРЕТНОЙ покупке.
--
-- Признак «услуга реализована» в каталоге отвечает на другой вопрос — есть ли
-- она в продукте вообще. Здесь — сделана ли она для этого основателя. Значение
-- ставит человек с основанием: автоматической отметки «выполнено» нет, иначе
-- работа эксперта и разбор ИИ считались бы сделанными по факту оплаты.
ALTER TABLE billing.round_purchase_items
    ADD COLUMN IF NOT EXISTS fulfillment_status TEXT NOT NULL DEFAULT 'planned'
    CHECK (fulfillment_status IN ('planned','in_progress','fulfilled','not_fulfilled'));
ALTER TABLE billing.round_purchase_items
    ADD COLUMN IF NOT EXISTS fulfillment_note TEXT
    CHECK (fulfillment_note IS NULL OR length(btrim(fulfillment_note)) BETWEEN 3 AND 1000);
ALTER TABLE billing.round_purchase_items
    ADD COLUMN IF NOT EXISTS fulfilled_by UUID REFERENCES identity.users(id);
ALTER TABLE billing.round_purchase_items
    ADD COLUMN IF NOT EXISTS fulfilled_at TIMESTAMPTZ;
COMMENT ON COLUMN billing.round_purchase_items.fulfillment_status IS
    'Выполнена ли услуга по ЭТОЙ покупке (M103). Ставится человеком с основанием; каталожный '
    'признак is_implemented отвечает на другой вопрос — есть ли услуга в продукте вообще.';

-- Деньги позиции по-прежнему неизменяемы; меняется только состояние работы.
CREATE OR REPLACE FUNCTION billing.forbid_purchase_item_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'позиции покупки не удаляются' USING ERRCODE = '42501';
    END IF;
    IF NEW.id <> OLD.id
       OR NEW.purchase_id <> OLD.purchase_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.service_code IS DISTINCT FROM OLD.service_code
       OR NEW.title IS DISTINCT FROM OLD.title
       OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.currency IS DISTINCT FROM OLD.currency THEN
        RAISE EXCEPTION 'денежные поля позиции неизменяемы' USING ERRCODE = '42501';
    END IF;
    IF NEW.fulfillment_status <> 'planned' AND NEW.fulfillment_note IS NULL THEN
        RAISE EXCEPTION 'смена состояния услуги требует основания' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

-- Снимок покупки по-прежнему неизменяем; тестовая метка не снимается.
CREATE OR REPLACE FUNCTION billing.forbid_purchase_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'покупку нельзя удалить: это финансовый факт' USING ERRCODE = '42501';
    END IF;
    IF NEW.id <> OLD.id
       OR NEW.round_id <> OLD.round_id
       OR NEW.project_id <> OLD.project_id
       OR NEW.buyer_user_id <> OLD.buyer_user_id
       OR NEW.package_snapshot IS DISTINCT FROM OLD.package_snapshot
       OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.country_code IS DISTINCT FROM OLD.country_code
       OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
       OR NEW.validity_days IS DISTINCT FROM OLD.validity_days
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'снимок покупки неизменяем' USING ERRCODE = '42501';
    END IF;
    IF OLD.is_test_payment AND NOT NEW.is_test_payment THEN
        RAISE EXCEPTION 'метку тестовой оплаты снять нельзя' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

/**
 * Одна действующая покупка на раунд.
 *
 * Покупка относится к КОНКРЕТНОМУ раунду (решение владельца): вторая
 * неотменённая покупка по тому же раунду означала бы двойную оплату одного и
 * того же. Отменённая и возвращённая не мешают оформить новую.
 */
CREATE UNIQUE INDEX round_purchases_active_per_round
    ON billing.round_purchases (round_id)
    WHERE status IN ('pending_payment', 'paid');

/**
 * Допуск к открытию раунда по оплате (порядок: проверка → оплата → услуги →
 * допуск → открытие).
 *
 * Возвращает причину отказа или NULL, если открывать можно. Одно место, куда
 * смотрит гейт: иначе «оплачено» и «услуги сделаны» разъехались бы по разным
 * проверкам.
 */
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
    'Что мешает открыть платный раунд (M103): нет покупки, не оплачена или услуги не выполнены. '
    'NULL — препятствий нет. Срок действия здесь не проверяется: ненулевой срок не включается.';

GRANT EXECUTE ON FUNCTION billing.round_purchase_blocker(UUID) TO app_backend;

-- ------------------------------------------------------------------------ RLS
ALTER TABLE billing.round_package_alternatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.round_package_alternatives FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing.round_package_selections   ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.round_package_selections   FORCE  ROW LEVEL SECURITY;

-- Альтернативы — часть предложения: их читает вошедший, меняет администратор.
CREATE POLICY round_package_alternatives_read ON billing.round_package_alternatives FOR SELECT
    TO app_backend USING (app.current_user_id() IS NOT NULL);
CREATE POLICY round_package_alternatives_admin_write ON billing.round_package_alternatives
    FOR INSERT TO app_backend WITH CHECK (app.has_role('admin'));
CREATE POLICY round_package_alternatives_admin_delete ON billing.round_package_alternatives
    FOR DELETE TO app_backend USING (app.has_role('admin'));

-- Выбор — дело команды проекта и администратора.
CREATE POLICY round_package_selections_team ON billing.round_package_selections FOR ALL
    TO app_backend USING (
        app.has_role('admin')
        OR EXISTS (SELECT 1 FROM lab.funding_rounds r
                    WHERE r.id = round_package_selections.round_id
                      AND lab.is_project_member(r.project_id, app.current_user_id())))
    WITH CHECK (
        app.has_role('admin')
        OR EXISTS (SELECT 1 FROM lab.funding_rounds r
                    WHERE r.id = round_package_selections.round_id
                      AND lab.is_project_member(r.project_id, app.current_user_id())));

GRANT SELECT, INSERT, DELETE ON billing.round_package_alternatives TO app_backend;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.round_package_selections TO app_backend;

-- --------------------------------------------------------- глаголы аудита
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('billing.package_alternative.added',
     'Пакету назначена допустимая альтернатива',
     ARRAY['admin']),
    ('billing.package_alternative.removed',
     'У пакета убрана допустимая альтернатива',
     ARRAY['admin']),
    ('billing.round_purchase.created',
     'Оформлена покупка запуска раунда',
     ARRAY['founder', 'admin']),
    ('billing.round_purchase.paid',
     'Покупка запуска раунда отмечена оплаченной',
     ARRAY['admin']),
    ('billing.round_purchase.item_fulfilled',
     'Изменено состояние выполнения услуги по покупке',
     ARRAY['admin', 'expert'])
ON CONFLICT (verb) DO NOTHING;
