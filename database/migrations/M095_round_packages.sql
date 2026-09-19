-- M095 — разовая оплата запуска раунда: услуги, пакеты, покупки (5.9.1).
--
-- План 0.2 §0г.2 п. 2 и 8, команда владельца 2026-09-19: основатель платит
-- РАЗОВО за запуск конкретного раунда. Размер запроса определяет подходящий
-- пакет по настраиваемой сетке; в пакет входят услуги, недостающие можно
-- докупить, более полный пакет можно выбрать самому. Цены, валюты,
-- диапазоны, состав и доступность — данные админки, а не константы кода.
--
-- Эта миграция вводит ТОЛЬКО структуры и их правила целостности. Продажи не
-- включаются: расчёт стоимости и оплата появятся отдельными шагами, а
-- условия страны по-прежнему держат `paidPackages.enabled` выключенным
-- (fail-closed в `assertCommercialConditions`).
--
-- Что здесь важно:
--
--   • услуга попадает в пакет ТОЛЬКО если помечена реализованной. Иначе
--     продавалось бы обещание: настройка не должна создавать возможность,
--     которой нет в продукте;
--   • предложение версионируется, как тарифы и условия страны: цена, состав
--     и диапазон замораживаются вместе с версией, а изменение публикуется
--     новой версией. Действующие версии одного кода не пересекаются по
--     времени, а диапазоны сумм не пересекаются внутри страны — иначе
--     «подходящий пакет» был бы неоднозначен;
--   • покупка хранит СНИМОК: цену, валюту, состав позиций и версию условий.
--     Изменение предложения не переписывает совершённую покупку;
--   • у покупки есть позиции с денежной базой — без них будущий зачёт услуг
--     в комиссию пришлось бы считать по прайсу задним числом, а для общей
--     цены пакета отдельные прайсы услуг не равны фактически уплаченному.
--
-- Деньги: NUMERIC(14,2) и валюта рядом. Плавающей точки нет нигде — ни в
-- схеме, ни в расчётах: 0.1 в IEEE-754 не представим, а копейки в
-- вознаграждении округлять «как получится» нельзя.

-- ------------------------------------------------------------------ услуги
CREATE TABLE billing.round_services (
    id           UUID PRIMARY KEY,
    code         TEXT NOT NULL UNIQUE
                 CHECK (code ~ '^[a-z][a-z0-9_]{2,40}$'),
    name         TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 160),
    description  TEXT CHECK (description IS NULL OR length(description) <= 1000),
    -- Реализована в продукте: только такую услугу можно включить в пакет или
    -- продать отдельно. Снятие отметки не трогает совершённые покупки.
    is_implemented BOOLEAN NOT NULL DEFAULT false,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by   UUID NOT NULL REFERENCES identity.users(id)
);
COMMENT ON TABLE billing.round_services IS
    'Каталог услуг запуска раунда (5.9.1): проверки, отчёты, разбор с экспертом. В пакет и в '
    'докупку попадают только услуги с is_implemented — продавать обещание нельзя.';

-- --------------------------------------------------------------- предложение
CREATE TABLE billing.round_packages (
    id           UUID PRIMARY KEY,
    code         TEXT NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{2,40}$'),
    version      INTEGER NOT NULL CHECK (version > 0),
    country_code TEXT NOT NULL REFERENCES billing.service_countries(code),
    name         TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 160),
    description  TEXT CHECK (description IS NULL OR length(description) <= 2000),
    price        NUMERIC(14,2) NOT NULL CHECK (price >= 0),
    currency     CHAR(3) NOT NULL,
    -- Сетка по размеру запроса: [min_target, max_target). NULL сверху —
    -- «и выше». Нижняя граница обязательна: пакет без начала диапазона
    -- нельзя сопоставить сумме.
    min_target   NUMERIC(14,2) NOT NULL CHECK (min_target >= 0),
    max_target   NUMERIC(14,2) CHECK (max_target IS NULL OR max_target > min_target),
    valid_from   TIMESTAMPTZ NOT NULL,
    valid_to     TIMESTAMPTZ,
    reason       TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
    created_by   UUID NOT NULL REFERENCES identity.users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (valid_to IS NULL OR valid_to > valid_from),
    UNIQUE (code, version)
);
CREATE INDEX round_packages_lookup
    ON billing.round_packages (country_code, valid_from, valid_to);
COMMENT ON TABLE billing.round_packages IS
    'Версии предложения «пакет запуска раунда» (5.9.1): цена, валюта, диапазон суммы запроса и '
    'срок действия. Изменение — новая версия; действующую версию переписать нельзя.';

CREATE TABLE billing.round_package_services (
    package_id UUID NOT NULL REFERENCES billing.round_packages(id) ON DELETE CASCADE,
    service_id UUID NOT NULL REFERENCES billing.round_services(id),
    PRIMARY KEY (package_id, service_id)
);
COMMENT ON TABLE billing.round_package_services IS
    'Состав пакета: какие услуги в него включены. Докупка живёт отдельно (round_service_offers).';

-- Цена отдельной услуги для докупки: та же логика версий, что у пакета.
CREATE TABLE billing.round_service_offers (
    id           UUID PRIMARY KEY,
    service_id   UUID NOT NULL REFERENCES billing.round_services(id),
    country_code TEXT NOT NULL REFERENCES billing.service_countries(code),
    version      INTEGER NOT NULL CHECK (version > 0),
    price        NUMERIC(14,2) NOT NULL CHECK (price >= 0),
    currency     CHAR(3) NOT NULL,
    valid_from   TIMESTAMPTZ NOT NULL,
    valid_to     TIMESTAMPTZ,
    reason       TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
    created_by   UUID NOT NULL REFERENCES identity.users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (valid_to IS NULL OR valid_to > valid_from),
    UNIQUE (service_id, country_code, version)
);
CREATE INDEX round_service_offers_lookup
    ON billing.round_service_offers (country_code, service_id, valid_from, valid_to);
COMMENT ON TABLE billing.round_service_offers IS
    'Цена докупаемой услуги по странам версиями (5.9.1). Нет действующей версии — услугу докупить '
    'нельзя, даже если она входит в какой-то пакет.';

-- ------------------------------------------------------------------ покупка
CREATE TABLE billing.round_purchases (
    id              UUID PRIMARY KEY,
    round_id        UUID NOT NULL REFERENCES lab.funding_rounds(id),
    project_id      UUID NOT NULL REFERENCES lab.projects(id),
    buyer_user_id   UUID NOT NULL REFERENCES identity.users(id),
    -- Снимок условий на момент покупки: версия пакета, версия условий страны
    -- и состав. Ссылка на пакет остаётся для разбора, но решает СНИМОК.
    package_id      UUID REFERENCES billing.round_packages(id),
    package_snapshot JSONB NOT NULL,
    country_code    TEXT NOT NULL REFERENCES billing.service_countries(code),
    policy_version  INTEGER NOT NULL CHECK (policy_version > 0),
    total_amount    NUMERIC(14,2) NOT NULL CHECK (total_amount >= 0),
    currency        CHAR(3) NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending_payment'
                    CHECK (status IN ('pending_payment','paid','cancelled','refunded')),
    invoice_id      UUID REFERENCES billing.invoices(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at         TIMESTAMPTZ,
    cancelled_at    TIMESTAMPTZ,
    CHECK (status <> 'paid' OR paid_at IS NOT NULL),
    CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL)
);
CREATE INDEX round_purchases_round ON billing.round_purchases (round_id);
CREATE INDEX round_purchases_project ON billing.round_purchases (project_id, created_at DESC);
COMMENT ON TABLE billing.round_purchases IS
    'Разовая покупка запуска раунда (5.9.1): снимок версии, цены, валюты, состава и условий '
    'страны. Изменение предложения совершённую покупку не переписывает.';

CREATE TABLE billing.round_purchase_items (
    id            UUID PRIMARY KEY,
    purchase_id   UUID NOT NULL REFERENCES billing.round_purchases(id) ON DELETE CASCADE,
    -- `package` — сам пакет одной позицией; `service` — докупленная услуга.
    kind          TEXT NOT NULL CHECK (kind IN ('package','service')),
    service_code  TEXT CHECK (service_code IS NULL OR service_code ~ '^[a-z][a-z0-9_]{2,40}$'),
    title         TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
    -- Денежная база позиции: сколько фактически уплачено именно за неё.
    -- Для услуг, входящих в пакет по общей цене, отдельной позиции нет —
    -- их прайс НЕ считается уплаченной суммой (это правило зачёта, 5.9).
    amount        NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
    currency      CHAR(3) NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (kind <> 'service' OR service_code IS NOT NULL)
);
CREATE INDEX round_purchase_items_purchase ON billing.round_purchase_items (purchase_id);
COMMENT ON TABLE billing.round_purchase_items IS
    'Позиции покупки с денежной базой (5.9.1): нужны будущему зачёту услуг в комиссию. Для общей '
    'цены пакета отдельные прайсы включённых услуг уплаченной суммой не считаются.';

-- ----------------------------------------------------------- правила целостности
-- 1. В пакет и в докупку — только реализованные услуги.
CREATE OR REPLACE FUNCTION billing.assert_service_implemented()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
DECLARE
    v_ok BOOLEAN;
BEGIN
    SELECT is_implemented INTO v_ok FROM billing.round_services WHERE id = NEW.service_id;
    IF NOT COALESCE(v_ok, false) THEN
        RAISE EXCEPTION 'услуга % не помечена реализованной: продавать её нельзя', NEW.service_id
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER round_package_services_implemented
    BEFORE INSERT OR UPDATE ON billing.round_package_services
    FOR EACH ROW EXECUTE FUNCTION billing.assert_service_implemented();
CREATE TRIGGER round_service_offers_implemented
    BEFORE INSERT OR UPDATE ON billing.round_service_offers
    FOR EACH ROW EXECUTE FUNCTION billing.assert_service_implemented();

-- 2. Версии одного кода пакета не пересекаются по времени, а действующие
--    диапазоны сумм не пересекаются внутри страны: иначе «подходящий пакет»
--    для суммы был бы неоднозначен, и расчёт зависел бы от порядка строк.
CREATE OR REPLACE FUNCTION billing.forbid_round_package_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('billing.round_package:' || NEW.country_code, 0));

    IF EXISTS (
        SELECT 1 FROM billing.round_packages p
         WHERE p.code = NEW.code AND p.id <> NEW.id
           AND tstzrange(p.valid_from, p.valid_to, '[)')
               && tstzrange(NEW.valid_from, NEW.valid_to, '[)')
    ) THEN
        RAISE EXCEPTION 'round_packages: пересечение периодов у кода %', NEW.code
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1 FROM billing.round_packages p
         WHERE p.country_code = NEW.country_code AND p.id <> NEW.id
           AND tstzrange(p.valid_from, p.valid_to, '[)')
               && tstzrange(NEW.valid_from, NEW.valid_to, '[)')
           AND numrange(p.min_target, p.max_target, '[)')
               && numrange(NEW.min_target, NEW.max_target, '[)')
    ) THEN
        RAISE EXCEPTION
            'round_packages: диапазоны суммы пересекаются в стране % (пакет %)',
            NEW.country_code, NEW.code USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER round_packages_no_overlap
    AFTER INSERT OR UPDATE ON billing.round_packages
    DEFERRABLE INITIALLY IMMEDIATE
    FOR EACH ROW EXECUTE FUNCTION billing.forbid_round_package_overlap();

-- 3. Цены услуги по стране тоже не пересекаются по времени.
CREATE OR REPLACE FUNCTION billing.forbid_service_offer_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended('billing.service_offer:' || NEW.service_id::text || NEW.country_code, 0));
    IF EXISTS (
        SELECT 1 FROM billing.round_service_offers o
         WHERE o.service_id = NEW.service_id AND o.country_code = NEW.country_code
           AND o.id <> NEW.id
           AND tstzrange(o.valid_from, o.valid_to, '[)')
               && tstzrange(NEW.valid_from, NEW.valid_to, '[)')
    ) THEN
        RAISE EXCEPTION 'round_service_offers: пересечение периодов услуги % в стране %',
            NEW.service_id, NEW.country_code USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER round_service_offers_no_overlap
    AFTER INSERT OR UPDATE ON billing.round_service_offers
    DEFERRABLE INITIALLY IMMEDIATE
    FOR EACH ROW EXECUTE FUNCTION billing.forbid_service_offer_overlap();

-- 4. Денежные условия действующей версии неизменяемы: цена правится только
--    публикацией новой версии. Объявление на будущее править можно.
CREATE OR REPLACE FUNCTION billing.forbid_active_round_package_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.valid_from > now() THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'нельзя удалить версию пакета, которая действует или действовала'
            USING ERRCODE = '42501';
    END IF;
    IF OLD.valid_from > now() THEN
        RETURN NEW;
    END IF;
    IF NEW.price IS DISTINCT FROM OLD.price
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.min_target IS DISTINCT FROM OLD.min_target
       OR NEW.max_target IS DISTINCT FROM OLD.max_target
       OR NEW.country_code IS DISTINCT FROM OLD.country_code
       OR NEW.code IS DISTINCT FROM OLD.code
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.valid_from IS DISTINCT FROM OLD.valid_from THEN
        RAISE EXCEPTION 'действующая версия пакета неизменяема: публикуйте новую'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER round_packages_history_immutable
    BEFORE UPDATE OR DELETE ON billing.round_packages
    FOR EACH ROW EXECUTE FUNCTION billing.forbid_active_round_package_rewrite();

-- 5. Покупка — исторический факт: снимок, суммы и принадлежность не меняются
--    ни одной ролью. Меняется только состояние оплаты.
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
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'снимок покупки неизменяем' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER round_purchases_immutable
    BEFORE UPDATE OR DELETE ON billing.round_purchases
    FOR EACH ROW EXECUTE FUNCTION billing.forbid_purchase_rewrite();

CREATE OR REPLACE FUNCTION billing.forbid_purchase_item_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'позиции покупки неизменяемы' USING ERRCODE = '42501';
END $$;

CREATE TRIGGER round_purchase_items_immutable
    BEFORE UPDATE OR DELETE ON billing.round_purchase_items
    FOR EACH ROW EXECUTE FUNCTION billing.forbid_purchase_item_rewrite();

-- ------------------------------------------------------------------- RLS
ALTER TABLE billing.round_services          ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.round_services          FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing.round_packages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.round_packages          FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing.round_package_services  ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.round_package_services  FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing.round_service_offers    ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.round_service_offers    FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing.round_purchases         ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.round_purchases         FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing.round_purchase_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.round_purchase_items    FORCE  ROW LEVEL SECURITY;

-- Предложение читают все вошедшие: основатель должен видеть, что ему
-- предстоит оплатить, до того как платить. Пишет только администратор.
CREATE POLICY round_services_read ON billing.round_services FOR SELECT TO app_backend
    USING (app.current_user_id() IS NOT NULL);
CREATE POLICY round_services_admin ON billing.round_services FOR ALL TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

CREATE POLICY round_packages_read ON billing.round_packages FOR SELECT TO app_backend
    USING (app.current_user_id() IS NOT NULL);
CREATE POLICY round_packages_admin ON billing.round_packages FOR ALL TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

CREATE POLICY round_package_services_read ON billing.round_package_services
    FOR SELECT TO app_backend USING (app.current_user_id() IS NOT NULL);
CREATE POLICY round_package_services_admin ON billing.round_package_services
    FOR ALL TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

CREATE POLICY round_service_offers_read ON billing.round_service_offers
    FOR SELECT TO app_backend USING (app.current_user_id() IS NOT NULL);
CREATE POLICY round_service_offers_admin ON billing.round_service_offers
    FOR ALL TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

-- Покупку видит команда проекта и админ: это её деньги и её раунд.
CREATE POLICY round_purchases_team ON billing.round_purchases FOR SELECT TO app_backend
    USING (lab.is_project_member(project_id, app.current_user_id()) OR app.has_role('admin'));
CREATE POLICY round_purchases_admin ON billing.round_purchases FOR ALL TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

CREATE POLICY round_purchase_items_team ON billing.round_purchase_items FOR SELECT TO app_backend
    USING (EXISTS (
        SELECT 1 FROM billing.round_purchases p
         WHERE p.id = purchase_id
           AND (lab.is_project_member(p.project_id, app.current_user_id())
                OR app.has_role('admin'))));
CREATE POLICY round_purchase_items_admin ON billing.round_purchase_items FOR ALL TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

GRANT SELECT, INSERT, UPDATE ON billing.round_services         TO app_backend;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.round_packages TO app_backend;
GRANT SELECT, INSERT, DELETE ON billing.round_package_services TO app_backend;
GRANT SELECT, INSERT, UPDATE ON billing.round_service_offers   TO app_backend;
GRANT SELECT, INSERT, UPDATE ON billing.round_purchases        TO app_backend;
GRANT SELECT, INSERT ON billing.round_purchase_items           TO app_backend;

-- --------------------------------------------------------- глаголы аудита
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('billing.round_service.created',
     'Заведена услуга запуска раунда',
     ARRAY['admin']),
    ('billing.round_service.updated',
     'Изменена услуга запуска раунда (в том числе отметка «реализована»)',
     ARRAY['admin']),
    ('billing.round_package.published',
     'Опубликована версия пакета запуска раунда',
     ARRAY['admin']),
    ('billing.round_package.closed',
     'Версия пакета снята с продажи',
     ARRAY['admin']),
    ('billing.round_service_offer.published',
     'Опубликована цена докупаемой услуги',
     ARRAY['admin'])
ON CONFLICT (verb) DO NOTHING;
