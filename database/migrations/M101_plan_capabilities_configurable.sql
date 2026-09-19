-- M101 — базовость возможности делается НАСТРОЙКОЙ, а не вечным запретом;
-- ответ «что доступно инвестору» согласуется с действующим барьером подписки.
--
-- Что исправляется. В M100 каталог, избранное и карточка инвестора были
-- помечены базовыми, и триггер запрещал привязывать их к тарифу. Это
-- зафиксировало в базе продуктовое решение, которого владелец не принимал:
-- стартовая бесплатность превратилась в правило, которое нельзя изменить,
-- даже когда матрица будет согласована.
--
-- Теперь `is_baseline` — обычная настройка администратора с основанием и
-- журналом. Пока возможность помечена базовой, привязать её к тарифу нельзя
-- (иначе настройка противоречила бы сама себе), но снять пометку —
-- разрешено. Запреты, которые остаются и не обсуждаются:
--
--   • нереализованную возможность в тариф не включить — это обещание того,
--     чего нет в продукте;
--   • платные ограничения не включаются, пока матрица не утверждена
--     владельцем.
--
-- Второе исправление. `investor_capabilities` сообщала «карточка доступна»,
-- не глядя на барьер подписки (`billing.investor_access_requires_subscription`,
-- M087), который эту самую карточку и закрывает. Два механизма существуют
-- одновременно, и ответ обязан учитывать оба.
--
-- И главное разделение, которое здесь закрепляется словами и кодом:
-- ДОСТУПНОСТЬ ФУНКЦИИ по тарифу — не то же самое, что ДОСТУП К ОБЪЕКТУ.
-- Настройка тарифа никогда не обходит режим проекта, согласие владельца,
-- адресные разрешения и отметки материалов: их решает предикат доступа.

-- Базовость меняется администратором: это стартовая настройка, а не догма.
COMMENT ON COLUMN billing.plan_capabilities.is_baseline IS
    'Стартовая настройка «доступно всем инвесторам». Меняется администратором с основанием '
    '(M101): пока пометка стоит, возможность к тарифу не привязывается; снять пометку можно, '
    'когда матрица бесплатного и платного будет согласована.';

-- Закрывает ли возможность действующий барьер подписки инвестора. Это ФАКТ о
-- сегодняшнем коде, а не настройка: барьер живёт отдельным флагом (M087) и
-- гейтит именно Investor View.
ALTER TABLE billing.plan_capabilities
    ADD COLUMN IF NOT EXISTS gated_by_membership BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN billing.plan_capabilities.gated_by_membership IS
    'Возможность закрыта действующим барьером подписки инвестора (флаг '
    'billing.investor_access_requires_subscription, M087). Второй механизм рядом с тарифом: '
    'ответ о доступности обязан учитывать оба.';

UPDATE billing.plan_capabilities
   SET gated_by_membership = true
 WHERE code = 'project.investor_view';

-- Пояснение к базовым: их состав может измениться после согласования матрицы.
UPDATE billing.plan_capabilities
   SET description = description || ' Сейчас помечена базовой — это стартовая настройка.'
 WHERE is_baseline
   AND description NOT LIKE '%стартовая настройка%';

/**
 * Что доступно инвестору и ПОЧЕМУ.
 *
 * Возвращает все реализованные возможности с ответом «доступна ли» и
 * причиной. Причина важнее флага: без неё нельзя отличить «бесплатно
 * навсегда» от «ограничение просто не включено».
 *
 *   `baseline`            — помечена базовой (стартовая настройка);
 *   `not_enforced`        — платное ограничение не включено, доступно всем;
 *   `plan`                — открыта действующим тарифом;
 *   `plan_required`       — закрыта: тарифа нет, а ограничение включено;
 *   `membership_required` — закрыта БАРЬЕРОМ ПОДПИСКИ (M087), независимо от
 *                           состава тарифа.
 *
 * Барьер проверяется ПЕРВЫМ: если он закрывает возможность, отвечать
 * «доступна» нельзя, какой бы ни была настройка тарифа.
 *
 * Функция говорит о ФУНКЦИЯХ, а не об объектах. Доступ к конкретному проекту
 * решает предикат `lab.project_audience`: режим владельца, его согласие,
 * адресные разрешения и отметки материалов. Ни тариф, ни барьер их не
 * заменяют и не обходят.
 */
-- Форма ответа меняется (добавился `available`), поэтому функция
-- пересоздаётся: сменить тип возвращаемого значения на месте нельзя.
DROP FUNCTION IF EXISTS billing.investor_capabilities(UUID);
CREATE FUNCTION billing.investor_capabilities(p_user_id UUID)
RETURNS TABLE (capability TEXT, available BOOLEAN, source TEXT)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, billing, lab, pg_temp
AS $$
    SELECT c.code,
           CASE
               WHEN c.gated_by_membership
                    AND lab.investor_access_requires_subscription()
                    AND NOT lab.has_active_investor_membership(p_user_id) THEN false
               WHEN c.is_baseline THEN true
               WHEN NOT c.is_enforced THEN true
               ELSE EXISTS (
                   SELECT 1
                     FROM billing.subscriptions s
                     JOIN billing.plan_capability_links l ON l.plan_id = s.plan_id
                    WHERE s.user_id = p_user_id
                      AND s.status = 'active'
                      AND l.capability = c.code)
           END AS available,
           CASE
               WHEN c.gated_by_membership
                    AND lab.investor_access_requires_subscription()
                    AND NOT lab.has_active_investor_membership(p_user_id)
                    THEN 'membership_required'
               WHEN c.is_baseline THEN 'baseline'
               WHEN NOT c.is_enforced THEN 'not_enforced'
               WHEN EXISTS (
                   SELECT 1
                     FROM billing.subscriptions s
                     JOIN billing.plan_capability_links l ON l.plan_id = s.plan_id
                    WHERE s.user_id = p_user_id
                      AND s.status = 'active'
                      AND l.capability = c.code) THEN 'plan'
               ELSE 'plan_required'
           END AS source
      FROM billing.plan_capabilities c
     WHERE c.is_implemented
     ORDER BY c.section, c.sort_order, c.code;
$$;
GRANT EXECUTE ON FUNCTION billing.investor_capabilities(UUID) TO app_backend;

COMMENT ON FUNCTION billing.investor_capabilities(UUID) IS
    'Доступность ФУНКЦИЙ инвестору с причиной (M101): барьер подписки проверяется раньше тарифа. '
    'Доступ к конкретному объекту решает предикат lab.project_audience — настройка тарифа его не '
    'заменяет и не обходит.';

-- --------------------------------------------------------- глагол аудита
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('billing.plan_capability.baseline_changed',
     'Изменена стартовая пометка «доступно всем» у возможности тарифа',
     ARRAY['admin'])
ON CONFLICT (verb) DO NOTHING;
