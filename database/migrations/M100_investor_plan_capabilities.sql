-- M100 — возможности тарифов инвестора типизированным списком (5.9.4).
--
-- До сих пор состав тарифа жил в свободном `subscription_plans.features_jsonb`:
-- туда можно было записать что угодно, и из этого «что угодно» ничего не
-- следовало. Возможность, которой нет в продукте, выглядела в настройке
-- точно так же, как реализованная.
--
-- Здесь появляется КАТАЛОГ возможностей и связь «версия тарифа → возможности».
-- Три правила, из-за которых это не просто справочник:
--
--   1. каталог перечисляет РЕАЛИЗОВАННЫЕ возможности; невозможно привязать к
--      тарифу строку, которой нет в каталоге;
--   2. БАЗОВЫЙ ПРОСМОТР не закрывается ничем. Возможности с пометкой
--      `is_baseline` доступны любому инвестору всегда и к тарифу не
--      привязываются — запрет стоит триггером, а не соглашением;
--   3. ПЛАТНОЕ ОГРАНИЧЕНИЕ НЕ ВКЛЮЧАЕТСЯ. Матрица бесплатного и платного для
--      инвестора владельцем не утверждена (реестр решений), поэтому
--      `is_enforced` у всех возможностей = false, а включение запрещено
--      триггером. Настройка состава тарифа — можно; начать что-то закрывать
--      по ней — нельзя.
--
-- Что НЕ делается: поведение инвестора не меняется. Допуск к Investor View
-- по-прежнему решает флаг `billing.investor_access_requires_subscription`
-- (M087), и эта миграция его не трогает.

CREATE TABLE billing.plan_capabilities (
    code        TEXT PRIMARY KEY
                CHECK (code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$'),
    section     TEXT NOT NULL CHECK (length(section) BETWEEN 2 AND 60),
    title       TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
    description TEXT NOT NULL CHECK (length(description) BETWEEN 2 AND 500),
    -- Возможность есть в продукте. Нереализованную к тарифу не привязать.
    is_implemented BOOLEAN NOT NULL DEFAULT false,
    -- Базовая: доступна всем инвесторам всегда и тарифом не закрывается.
    is_baseline BOOLEAN NOT NULL DEFAULT false,
    -- Ограничение применяется на деле. Пока матрица не утверждена — false.
    is_enforced BOOLEAN NOT NULL DEFAULT false,
    sort_order  INTEGER NOT NULL DEFAULT 100,
    CHECK (NOT (is_baseline AND is_enforced))
);
COMMENT ON TABLE billing.plan_capabilities IS
    'Каталог возможностей тарифов инвестора (5.9.4): типизированный список вместо свободного '
    'features_jsonb. Базовый просмотр помечен is_baseline и тарифом не закрывается; is_enforced '
    'везде false — платные ограничения не включаются до утверждения матрицы владельцем.';

CREATE TABLE billing.plan_capability_links (
    plan_id    UUID NOT NULL REFERENCES billing.subscription_plans(id) ON DELETE CASCADE,
    capability TEXT NOT NULL REFERENCES billing.plan_capabilities(code),
    reason     TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
    created_by UUID REFERENCES identity.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (plan_id, capability)
);
COMMENT ON TABLE billing.plan_capability_links IS
    'Состав версии тарифа: какие возможности в неё входят (5.9.4). Версия тарифа неизменяема, '
    'поэтому состав меняется публикацией новой версии, а не правкой действующей.';

/**
 * К тарифу привязывается только реализованная и НЕ базовая возможность.
 *
 * Базовая — это то, что доступно всем: привязать её к платному тарифу
 * значит пообещать закрыть бесплатное. Нереализованная — обещание того,
 * чего нет.
 */
CREATE OR REPLACE FUNCTION billing.assert_plan_capability_linkable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
DECLARE
    v_row billing.plan_capabilities%ROWTYPE;
BEGIN
    SELECT * INTO v_row FROM billing.plan_capabilities WHERE code = NEW.capability;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'возможности % нет в каталоге', NEW.capability USING ERRCODE = '23503';
    END IF;
    IF NOT v_row.is_implemented THEN
        RAISE EXCEPTION 'возможность % не реализована: включать её в тариф нельзя', NEW.capability
            USING ERRCODE = '23514';
    END IF;
    IF v_row.is_baseline THEN
        RAISE EXCEPTION
            'возможность % базовая: она доступна всем инвесторам и тарифом не закрывается',
            NEW.capability USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER plan_capability_links_check
    BEFORE INSERT OR UPDATE ON billing.plan_capability_links
    FOR EACH ROW EXECUTE FUNCTION billing.assert_plan_capability_linkable();

/**
 * Включение платного ограничения запрещено, пока матрица не утверждена.
 *
 * Запрет стоит в БД, а не в сервисе: настройка, за которой нет решения
 * владельца, не должна включаться ни новым маршрутом, ни служебной консолью.
 * Снимать этот триггер — отдельная миграция вместе с утверждённой матрицей.
 */
CREATE OR REPLACE FUNCTION billing.deny_plan_capability_enforcement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
BEGIN
    IF NEW.is_enforced THEN
        RAISE EXCEPTION
            'платные ограничения возможностей инвестора не включаются: матрица бесплатного и '
            'платного не утверждена владельцем'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER plan_capabilities_not_enforced
    BEFORE INSERT OR UPDATE ON billing.plan_capabilities
    FOR EACH ROW EXECUTE FUNCTION billing.deny_plan_capability_enforcement();

/**
 * Возможности, доступные пользователю прямо сейчас.
 *
 * Пока ограничения не включены, доступно ВСЁ реализованное: функция говорит
 * правду о сегодняшнем поведении, а не о будущем замысле. Когда матрицу
 * утвердят, изменится тело функции — а не десяток мест, которые её зовут.
 */
CREATE OR REPLACE FUNCTION billing.investor_capabilities(p_user_id UUID)
RETURNS TABLE (capability TEXT, source TEXT)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, billing, pg_temp
AS $$
    SELECT c.code,
           CASE WHEN c.is_baseline THEN 'baseline'
                WHEN NOT c.is_enforced THEN 'not_enforced'
                ELSE 'plan'
           END
      FROM billing.plan_capabilities c
     WHERE c.is_implemented
       AND (c.is_baseline
            OR NOT c.is_enforced
            OR EXISTS (
                SELECT 1
                  FROM billing.subscriptions s
                  JOIN billing.plan_capability_links l ON l.plan_id = s.plan_id
                 WHERE s.user_id = p_user_id
                   AND s.status = 'active'
                   AND l.capability = c.code));
$$;
COMMENT ON FUNCTION billing.investor_capabilities(UUID) IS
    'Возможности инвестора сейчас (5.9.4). Источник: baseline — базовая и не закрывается; '
    'not_enforced — ограничение не включено, доступно всем; plan — по действующему тарифу. '
    'Пока матрица не утверждена, источник plan не встречается.';

GRANT EXECUTE ON FUNCTION billing.investor_capabilities(UUID) TO app_backend;

-- Стартовый каталог. Базовые — то, что инвестор видит всегда: каталог с
-- тизерами, избранное, карточка проекта по правам доступа. Остальные помечены
-- нереализованными, потому что их в продукте ещё нет: каталог описывает
-- сделанное, а не задуманное.
INSERT INTO billing.plan_capabilities
    (code, section, title, description, is_implemented, is_baseline, sort_order) VALUES
    ('catalog.browse', 'Просмотр', 'Каталог проектов',
     'Список проектов с тизерами. Базовая возможность: доступна любому инвестору всегда.',
     true, true, 10),
    ('catalog.favorites', 'Просмотр', 'Избранное',
     'Отмечать проекты и возвращаться к ним. Базовая возможность.',
     true, true, 20),
    ('project.investor_view', 'Просмотр', 'Карточка проекта для инвестора',
     'Полная карточка в объёме, который разрешил владелец проекта. Права на данные решает '
     'предикат доступа; тариф их не расширяет и не сужает.',
     true, true, 30),
    ('catalog.filter_by_round', 'Поиск', 'Фильтр по активному привлечению',
     'Отбирать проекты с открытым раундом. Кандидат в платные — не реализовано.',
     false, false, 40),
    ('notifications.matching_offers', 'Уведомления', 'Уведомления о подходящих предложениях',
     'Сообщения о новых раундах по интересам инвестора. Кандидат в платные — не реализовано.',
     false, false, 50),
    ('analytics.compare', 'Аналитика', 'Сравнение проектов',
     'Сопоставление нескольких проектов по показателям. Кандидат в платные — не реализовано.',
     false, false, 60),
    ('reports.access', 'Отчёты', 'Работа с отчётами',
     'Доступ к отчётам по проектам и сделкам. Кандидат в платные — не реализовано.',
     false, false, 70);

-- ------------------------------------------------------------------------ RLS
ALTER TABLE billing.plan_capabilities      ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.plan_capabilities      FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing.plan_capability_links  ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.plan_capability_links  FORCE  ROW LEVEL SECURITY;

-- Состав тарифа — часть публичных условий: инвестор должен видеть, за что
-- платит, до оплаты. Меняет только администратор.
CREATE POLICY plan_capabilities_read ON billing.plan_capabilities FOR SELECT
    TO app_backend, app_public_read USING (true);
CREATE POLICY plan_capabilities_admin_write ON billing.plan_capabilities FOR UPDATE
    TO app_backend USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

CREATE POLICY plan_capability_links_read ON billing.plan_capability_links FOR SELECT
    TO app_backend, app_public_read USING (true);
CREATE POLICY plan_capability_links_admin_write ON billing.plan_capability_links FOR INSERT
    TO app_backend WITH CHECK (app.has_role('admin'));
CREATE POLICY plan_capability_links_admin_delete ON billing.plan_capability_links FOR DELETE
    TO app_backend USING (app.has_role('admin'));

GRANT SELECT, UPDATE ON billing.plan_capabilities          TO app_backend;
GRANT SELECT ON billing.plan_capabilities                  TO app_public_read;
GRANT SELECT, INSERT, DELETE ON billing.plan_capability_links TO app_backend;
GRANT SELECT ON billing.plan_capability_links              TO app_public_read;

-- --------------------------------------------------------- глаголы аудита
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('billing.plan_capability.linked',
     'Возможность включена в состав версии тарифа',
     ARRAY['admin']),
    ('billing.plan_capability.unlinked',
     'Возможность исключена из состава версии тарифа',
     ARRAY['admin'])
ON CONFLICT (verb) DO NOTHING;
