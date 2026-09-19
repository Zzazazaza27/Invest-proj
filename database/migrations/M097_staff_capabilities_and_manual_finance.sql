-- M097 — функциональные полномочия сотрудников, ручная фиксация возврата
-- транша и корректировка начисленной комиссии (уточнение владельца
-- 2026-09-19).
--
-- Два НЕЗАВИСИМЫХ слоя доступа, которые до сих пор были одним:
--
--   1. ФУНКЦИОНАЛЬНОЕ ПОЛНОМОЧИЕ — какое действие сотрудник вправе делать
--      вообще («фиксировать возврат», «уменьшать начисление»). Каталог
--      типизирован и перечисляет РЕАЛИЗОВАННЫЕ функции: произвольную строку
--      администратор не заведёт, а невыданное полномочие запрещено.
--   2. ОБЛАСТЬ РАБОТЫ — с какими объектами сотрудник работает. Её задаёт уже
--      существующее назначение эксперта на проект (`experts.expert_assignments`
--      и `experts.is_assigned_reviewer`, M007/M021). Новой универсальной
--      ссылки «на любой объект» здесь не заводится: ссылка без контроля
--      целостности превращается в дыру.
--
-- Отсюда правило, которое нельзя получить одной галочкой: право фиксировать
-- возврат НЕ открывает все сделки платформы (нужна область), а назначение на
-- проект НЕ даёт права трогать комиссию (нужно полномочие). Роль `expert`
-- сама по себе не означает ни того, ни другого.
--
-- Возврат денег автоматическим не делается нигде: это ЗАПИСЬ О СОСТОЯВШЕМСЯ
-- событии, а не платёжная команда. Уменьшение начисленной комиссии — отдельная
-- запись, и она не означает, что деньги кому-то вернули.

-- ================================================== каталог полномочий
CREATE TABLE identity.staff_capabilities (
    code        TEXT PRIMARY KEY
                CHECK (code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$'),
    -- Раздел платформы: по нему каталог группируется в будущем экране.
    section     TEXT NOT NULL CHECK (length(section) BETWEEN 2 AND 60),
    -- Вид действия. Просмотр, создание, изменение, подтверждение и денежная
    -- корректировка — РАЗНЫЕ полномочия: одной общей галочкой их выдавать
    -- нельзя, поэтому вид хранится отдельно и виден в каталоге.
    action      TEXT NOT NULL CHECK (action IN
                ('view','create','update','confirm','financial_adjust','discuss')),
    title       TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
    description TEXT NOT NULL CHECK (length(description) BETWEEN 2 AND 500),
    -- Полномочие существует, только если проверка на него есть в коде.
    -- Иначе каталог обещал бы возможность, которой нет.
    is_implemented BOOLEAN NOT NULL DEFAULT true,
    -- Требуется ли к полномочию область работы (назначение на объект).
    requires_assignment BOOLEAN NOT NULL DEFAULT false,
    sort_order  INTEGER NOT NULL DEFAULT 100
);
COMMENT ON TABLE identity.staff_capabilities IS
    'Каталог функциональных полномочий сотрудника (M097): что вообще можно делать на платформе. '
    'Типизирован и описывает реализованные функции; администратор выбирает из каталога, а не '
    'придумывает строки. Область работы задаётся отдельно — назначением на объект.';

CREATE TABLE identity.staff_capability_grants (
    id          UUID PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES identity.users(id),
    capability  TEXT NOT NULL REFERENCES identity.staff_capabilities(code),
    reason      TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
    granted_by  UUID NOT NULL REFERENCES identity.users(id),
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_by  UUID REFERENCES identity.users(id),
    revoked_at  TIMESTAMPTZ,
    revoke_reason TEXT CHECK (revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 3 AND 500),
    CHECK (revoked_at IS NULL OR revoked_at >= granted_at),
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
-- Одно действующее полномочие на сотрудника: повторная выдача не плодит строк,
-- а отзыв закрывает доступ при СЛЕДУЮЩЕМ запросе — проверка идёт по факту.
CREATE UNIQUE INDEX staff_capability_grants_active_uq
    ON identity.staff_capability_grants (user_id, capability) WHERE revoked_at IS NULL;
CREATE INDEX staff_capability_grants_user
    ON identity.staff_capability_grants (user_id) WHERE revoked_at IS NULL;
COMMENT ON TABLE identity.staff_capability_grants IS
    'Выданные сотруднику полномочия (M097). Выдаёт только администратор; сотрудник не может '
    'расширить собственные права. Отзыв закрывает доступ на следующем запросе.';

-- Сотрудник не расширяет собственные права: выдача и отзыв — только под
-- ролью администратора. Запрет стоит в базе, а не только в сервисе.
CREATE OR REPLACE FUNCTION identity.assert_capability_grant_by_admin()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, identity, app, pg_temp
AS $$
BEGIN
    IF NOT app.has_role('admin') THEN
        RAISE EXCEPTION 'полномочия выдаёт и отзывает только администратор'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER staff_capability_grants_admin_only
    BEFORE INSERT OR UPDATE ON identity.staff_capability_grants
    FOR EACH ROW EXECUTE FUNCTION identity.assert_capability_grant_by_admin();

/**
 * Единое место проверки функционального полномочия.
 *
 * Администратор держит все полномочия, пока не появится полноценное
 * управление правами (решение владельца 2026-09-19): ручные денежные записи
 * сейчас доступны ему, и отдельной выдачи для этого не требуется. Эксперт не
 * получает ничего автоматически — ни по роли, ни по назначению.
 */
CREATE OR REPLACE FUNCTION app.has_capability(p_code TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, app, identity
AS $$
    SELECT app.has_role('admin')
        OR EXISTS (
            SELECT 1 FROM identity.staff_capability_grants g
             JOIN identity.staff_capabilities c ON c.code = g.capability
            WHERE g.user_id = app.current_user_id()
              AND g.capability = p_code
              AND g.revoked_at IS NULL
              AND c.is_implemented
        );
$$;
-- Проверку вызывают и RLS-политики, и сервис: права на неё нужны тем же
-- ролям, что и на `app.has_role` (M000).
GRANT EXECUTE ON FUNCTION app.has_capability(TEXT)
    TO app_public_read, app_backend, app_notifications, app_investments,
       app_integration, app_billing, app_readonly;

COMMENT ON FUNCTION app.has_capability(TEXT) IS
    'Единая точка проверки функционального полномочия (M097). Не заменяет проверку области '
    'работы: полномочие говорит «что можно делать», назначение — «с какими объектами».';

-- Стартовый каталог: раздел «Финансы». Перечислены ровно те функции, проверки
-- на которые появляются в этой же миграции и в сервисе. Остальные разделы
-- добавляются по мере того, как их проверки въезжают в код (TODO).
INSERT INTO identity.staff_capabilities
    (code, section, action, title, description, requires_assignment, sort_order) VALUES
    ('finance.return.discuss', 'Финансы', 'discuss',
     'Обсуждать возврат',
     'Участвовать в обсуждении возврата по сделке. Не даёт права фиксировать возврат.',
     true, 10),
    ('finance.tranche_return.record', 'Финансы', 'financial_adjust',
     'Фиксировать возврат транша',
     'Записывать фактически состоявшийся возврат по конкретному траншу. Это запись о событии, '
     'а не платёжная команда: деньги платформа не перечисляет.',
     true, 20),
    ('finance.commission.reduce', 'Финансы', 'financial_adjust',
     'Уменьшать начисленную комиссию',
     'Фиксировать уменьшение начисленного вознаграждения по конкретному начислению. Не означает '
     'возврата уже уплаченных денег.',
     true, 30),
    ('finance.commission.refund_paid', 'Финансы', 'financial_adjust',
     'Фиксировать возврат уплаченной комиссии',
     'Записывать фактически состоявшийся возврат уже оплаченного вознаграждения. Отдельно от '
     'уменьшения начисления и от возврата инвестиции.',
     true, 40);

-- ====================================================== возврат по траншу
-- ЗАПИСЬ О СОБЫТИИ. Исходный транш сохраняется: возврат его не переписывает и
-- не удаляет — иначе история сделки перестала бы соответствовать банковской.
CREATE TABLE investments.tranche_returns (
    id              UUID PRIMARY KEY,
    tranche_id      UUID NOT NULL REFERENCES investments.investment_tranches(id),
    amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    currency        CHAR(3) NOT NULL,
    -- Дата фактического возврата, а не момент записи: записать можно позже.
    occurred_on     DATE NOT NULL,
    reason          TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
    -- Подтверждение, если оно есть: ссылка на документ или банковский
    -- идентификатор. Необязательно — договорённость могла быть без бумаги.
    evidence_ref    TEXT CHECK (evidence_ref IS NULL OR length(btrim(evidence_ref)) BETWEEN 3 AND 200),
    recorded_by     UUID NOT NULL REFERENCES identity.users(id),
    -- Повторная отправка формы не создаёт вторую запись.
    idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 120),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Ошибочную запись не удаляют: её аннулируют с основанием, и это видно.
    cancelled_at    TIMESTAMPTZ,
    cancelled_by    UUID REFERENCES identity.users(id),
    cancel_reason   TEXT CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 3 AND 500),
    CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL)),
    CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL))
);
CREATE INDEX tranche_returns_tranche ON investments.tranche_returns (tranche_id);
COMMENT ON TABLE investments.tranche_returns IS
    'Фиксация фактически состоявшегося возврата по траншу (M097): сумма, дата, основание, '
    'подтверждение и автор. Не платёжная команда — платформа денег не перечисляет. Возвраты '
    'частичные; сумма действующих записей не превышает подтверждённую сумму транша.';

/**
 * Возврат записывается только по ПОДТВЕРЖДЁННОМУ траншу и в его валюте, а
 * сумма действующих возвратов не превышает сумму транша: вернуть больше, чем
 * поступило, нельзя ни по частям, ни разом.
 */
CREATE OR REPLACE FUNCTION investments.assert_tranche_return_fits()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, investments, pg_temp
AS $$
DECLARE
    v_tranche investments.investment_tranches%ROWTYPE;
    v_sum     NUMERIC(14,2);
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('tranche_return:' || NEW.tranche_id::text, 0));

    SELECT * INTO v_tranche FROM investments.investment_tranches WHERE id = NEW.tranche_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'транш % не найден', NEW.tranche_id USING ERRCODE = 'P0002';
    END IF;
    IF v_tranche.status <> 'confirmed' THEN
        RAISE EXCEPTION 'возврат записывается только по подтверждённому траншу (статус %)',
            v_tranche.status USING ERRCODE = '23514';
    END IF;
    IF NEW.currency <> v_tranche.currency THEN
        RAISE EXCEPTION 'валюта возврата (%) не совпадает с валютой транша (%)',
            NEW.currency, v_tranche.currency USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(SUM(amount), 0) INTO v_sum
      FROM investments.tranche_returns
     WHERE tranche_id = NEW.tranche_id AND cancelled_at IS NULL AND id <> NEW.id;

    IF v_sum + NEW.amount > v_tranche.amount THEN
        RAISE EXCEPTION
            'возвраты по траншу (% + %) превышают его сумму %',
            v_sum, NEW.amount, v_tranche.amount USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER tranche_returns_fit
    BEFORE INSERT ON investments.tranche_returns
    FOR EACH ROW EXECUTE FUNCTION investments.assert_tranche_return_fits();

-- Запись о возврате не переписывается: меняются только поля аннулирования,
-- и только один раз. Удаление запрещено — история остаётся историей.
CREATE OR REPLACE FUNCTION investments.forbid_tranche_return_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, investments, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'запись о возврате не удаляется: аннулируйте её с основанием'
            USING ERRCODE = '42501';
    END IF;
    IF OLD.cancelled_at IS NOT NULL THEN
        RAISE EXCEPTION 'запись о возврате уже аннулирована' USING ERRCODE = '42501';
    END IF;
    IF NEW.tranche_id IS DISTINCT FROM OLD.tranche_id
       OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.occurred_on IS DISTINCT FROM OLD.occurred_on
       OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
        RAISE EXCEPTION 'запись о возврате неизменяема: аннулируйте её и запишите верную'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER tranche_returns_immutable
    BEFORE UPDATE OR DELETE ON investments.tranche_returns
    FOR EACH ROW EXECUTE FUNCTION investments.forbid_tranche_return_rewrite();

-- ============================================== корректировка комиссии
-- Возврат инвестиции НЕ отменяет комиссию автоматически. Если решено
-- скорректировать вознаграждение, это отдельная запись с суммой, стороной и
-- основанием. Различаются два разных факта:
--
--   `accrual_reduction` — уменьшено НАЧИСЛЕНИЕ (денег никто не возвращал);
--   `paid_refund`       — фактически возвращены УЖЕ УПЛАЧЕННЫЕ деньги.
--
-- Одно не выводится из другого, и автоматических перечислений здесь нет.
CREATE TABLE billing.commission_adjustments (
    id              UUID PRIMARY KEY,
    accrual_id      UUID NOT NULL REFERENCES billing.commission_accruals(id),
    kind            TEXT NOT NULL CHECK (kind IN ('accrual_reduction','paid_refund')),
    -- Сторона-плательщик: чью долю корректируем.
    party           TEXT NOT NULL CHECK (party IN ('investor','issuer')),
    amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    currency        CHAR(3) NOT NULL,
    reason          TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
    recorded_by     UUID NOT NULL REFERENCES identity.users(id),
    idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 120),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX commission_adjustments_accrual ON billing.commission_adjustments (accrual_id, kind);
COMMENT ON TABLE billing.commission_adjustments IS
    'Ручная корректировка вознаграждения (M097): уменьшение начисления или фиксация возврата '
    'уже уплаченного — РАЗНЫЕ записи. Возврат инвестиции сам по себе комиссию не отменяет, '
    'автоматических перечислений нет.';

/** Корректировка не превышает долю стороны в этом начислении. */
CREATE OR REPLACE FUNCTION billing.assert_commission_adjustment_fits()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
DECLARE
    v_accrual billing.commission_accruals%ROWTYPE;
    v_share   NUMERIC(14,2);
    v_sum     NUMERIC(14,2);
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended('commission_adjustment:' || NEW.accrual_id::text || NEW.kind || NEW.party, 0));

    SELECT * INTO v_accrual FROM billing.commission_accruals WHERE id = NEW.accrual_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'начисление % не найдено', NEW.accrual_id USING ERRCODE = 'P0002';
    END IF;
    IF NEW.currency <> v_accrual.currency THEN
        RAISE EXCEPTION 'валюта корректировки (%) не совпадает с валютой начисления (%)',
            NEW.currency, v_accrual.currency USING ERRCODE = '23514';
    END IF;

    v_share := CASE NEW.party
                   WHEN 'investor' THEN v_accrual.investor_fee_amount
                   ELSE v_accrual.issuer_fee_amount
               END;

    SELECT COALESCE(SUM(amount), 0) INTO v_sum
      FROM billing.commission_adjustments
     WHERE accrual_id = NEW.accrual_id AND kind = NEW.kind AND party = NEW.party
       AND id <> NEW.id;

    IF v_sum + NEW.amount > v_share THEN
        RAISE EXCEPTION
            'корректировки (% + %) превышают долю стороны % в начислении (%)',
            v_sum, NEW.amount, NEW.party, v_share USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER commission_adjustments_fit
    BEFORE INSERT ON billing.commission_adjustments
    FOR EACH ROW EXECUTE FUNCTION billing.assert_commission_adjustment_fits();

CREATE OR REPLACE FUNCTION billing.forbid_commission_adjustment_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'корректировка неизменяема: запишите компенсирующую'
        USING ERRCODE = '42501';
END $$;

CREATE TRIGGER commission_adjustments_immutable
    BEFORE UPDATE OR DELETE ON billing.commission_adjustments
    FOR EACH ROW EXECUTE FUNCTION billing.forbid_commission_adjustment_rewrite();

-- ------------------------------------------------------------------------ RLS
ALTER TABLE identity.staff_capabilities        ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.staff_capabilities        FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.staff_capability_grants   ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.staff_capability_grants   FORCE  ROW LEVEL SECURITY;
ALTER TABLE investments.tranche_returns        ENABLE ROW LEVEL SECURITY;
ALTER TABLE investments.tranche_returns        FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing.commission_adjustments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.commission_adjustments     FORCE  ROW LEVEL SECURITY;

-- Каталог читает любой вошедший (сотрудник должен видеть, чего ему не хватает);
-- меняется он миграцией вместе с кодом, а не из интерфейса.
CREATE POLICY staff_capabilities_read ON identity.staff_capabilities FOR SELECT
    TO app_backend USING (app.current_user_id() IS NOT NULL);

-- Свои полномочия сотрудник видит; чужие — только администратор.
CREATE POLICY staff_capability_grants_read ON identity.staff_capability_grants FOR SELECT
    TO app_backend USING (user_id = app.current_user_id() OR app.has_role('admin'));
CREATE POLICY staff_capability_grants_admin_write ON identity.staff_capability_grants FOR INSERT
    TO app_backend WITH CHECK (app.has_role('admin'));
CREATE POLICY staff_capability_grants_admin_update ON identity.staff_capability_grants FOR UPDATE
    TO app_backend USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

-- Возвраты и корректировки: видит тот, кто вправе работать с этой сделкой —
-- сторона договора, администратор или сотрудник с полномочием и назначением
-- на проект сделки. Роль `expert` сама по себе не открывает ничего.
CREATE POLICY tranche_returns_read ON investments.tranche_returns FOR SELECT
    TO app_backend USING (
        app.has_role('admin')
        OR EXISTS (
            SELECT 1
              FROM investments.investment_tranches t
              JOIN investments.investment_agreements a ON a.id = t.agreement_id
              JOIN investments.investment_offers o ON o.id = a.offer_id
             WHERE t.id = tranche_returns.tranche_id
               AND (a.investor_id = app.current_user_id()
                    OR lab.is_project_member(o.project_id, app.current_user_id())
                    OR (app.has_capability('finance.tranche_return.record')
                        AND experts.is_assigned_reviewer(o.project_id, app.current_user_id())))
        ));
CREATE POLICY tranche_returns_write ON investments.tranche_returns FOR INSERT
    TO app_backend WITH CHECK (
        app.has_capability('finance.tranche_return.record')
        AND (app.has_role('admin')
             OR EXISTS (
                 SELECT 1
                   FROM investments.investment_tranches t
                   JOIN investments.investment_agreements a ON a.id = t.agreement_id
                   JOIN investments.investment_offers o ON o.id = a.offer_id
                  WHERE t.id = tranche_returns.tranche_id
                    AND experts.is_assigned_reviewer(o.project_id, app.current_user_id())))
    );
CREATE POLICY tranche_returns_cancel ON investments.tranche_returns FOR UPDATE
    TO app_backend USING (app.has_capability('finance.tranche_return.record'))
    WITH CHECK (app.has_capability('finance.tranche_return.record'));

CREATE POLICY commission_adjustments_read ON billing.commission_adjustments FOR SELECT
    TO app_backend USING (
        app.has_role('admin')
        OR app.has_capability('finance.commission.reduce')
        OR app.has_capability('finance.commission.refund_paid'));
CREATE POLICY commission_adjustments_write ON billing.commission_adjustments FOR INSERT
    TO app_backend WITH CHECK (
        (kind = 'accrual_reduction' AND app.has_capability('finance.commission.reduce'))
        OR (kind = 'paid_refund' AND app.has_capability('finance.commission.refund_paid')));

GRANT SELECT ON identity.staff_capabilities                     TO app_backend;
GRANT SELECT, INSERT, UPDATE ON identity.staff_capability_grants TO app_backend;
GRANT SELECT, INSERT, UPDATE ON investments.tranche_returns      TO app_backend;
GRANT SELECT, INSERT ON billing.commission_adjustments           TO app_backend;

-- --------------------------------------------------------- глаголы аудита
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('identity.capability.granted',
     'Сотруднику выдано функциональное полномочие',
     ARRAY['admin']),
    ('identity.capability.revoked',
     'У сотрудника отозвано функциональное полномочие',
     ARRAY['admin']),
    ('investments.tranche_return.recorded',
     'Зафиксирован фактический возврат по траншу',
     ARRAY['admin','expert']),
    ('investments.tranche_return.cancelled',
     'Аннулирована ошибочная запись о возврате',
     ARRAY['admin','expert']),
    ('billing.commission.adjusted',
     'Зафиксирована корректировка вознаграждения',
     ARRAY['admin','expert'])
ON CONFLICT (verb) DO NOTHING;
