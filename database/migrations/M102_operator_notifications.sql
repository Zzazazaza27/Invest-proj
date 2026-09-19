-- M102 — уведомления команде по порогу суммы раунда (5.9.5).
--
-- Настройки участия оператора и уведомлений хранились с 5.6 (`operator.notify`
-- в условиях страны), но ничем не читались: включённая настройка ничего не
-- делала. Здесь появляется исполнение — и ровно в тех границах, которые
-- назвал владелец.
--
-- Что порог делает: создаёт запись уведомления, когда открывается раунд с
-- суммой не меньше порога.
--
-- Чего порог НЕ делает — и это важнее:
--
--   • не меняет вознаграждение: ставка и начисление считаются по условиям
--     сделки и подтверждённым траншам, порог в расчёт не входит;
--   • не меняет доступ: ни к проекту, ни к раунду, ни к материалам. Права
--     решает предикат аудитории;
--   • не делает участие оператора обязательным. `manualReviewRequired` —
--     отдельная настройка; «мы заметили крупный раунд» и «раунд не
--     открывается без проверки человеком» — разные вещи, и смешивать их
--     нельзя.
--
-- Повторная отправка одного события невозможна: ключ события уникален. Если
-- открытие раунда обработается дважды (повтор запроса, гонка, ретрай), второй
-- записи не появится.
CREATE TABLE comms.operator_notifications (
    id             UUID PRIMARY KEY,
    -- Ключ события: «что именно произошло». Уникален — отсюда защита от
    -- повторной отправки.
    event_key      TEXT NOT NULL UNIQUE CHECK (length(event_key) BETWEEN 8 AND 200),
    kind           TEXT NOT NULL CHECK (kind IN ('round_opened_over_threshold')),
    round_id       UUID REFERENCES lab.funding_rounds(id),
    project_id     UUID REFERENCES lab.projects(id),
    country_code   TEXT NOT NULL REFERENCES billing.service_countries(code),
    policy_version INTEGER NOT NULL CHECK (policy_version > 0),
    -- Снимок того, из-за чего сработало: сумма и порог на момент события.
    target_amount  NUMERIC(14,2) NOT NULL CHECK (target_amount >= 0),
    threshold      NUMERIC(14,2) NOT NULL CHECK (threshold >= 0),
    currency       CHAR(3) NOT NULL,
    recipients     TEXT[] NOT NULL CHECK (cardinality(recipients) > 0),
    -- Каким транспортом ушло. `none` — внешняя рассылка выключена: запись
    -- есть, письма нет. Врать «отправлено» нельзя.
    delivery_mode  TEXT NOT NULL CHECK (delivery_mode IN ('none', 'file', 'smtp')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX operator_notifications_round ON comms.operator_notifications (round_id);
COMMENT ON TABLE comms.operator_notifications IS
    'Уведомления команде по порогу суммы раунда (5.9.5). Порог только уведомляет: он не меняет '
    'вознаграждение, доступ и обязательность участия оператора. event_key уникален — повторная '
    'обработка одного события второй записи не создаёт.';
COMMENT ON COLUMN comms.operator_notifications.delivery_mode IS
    'Транспорт на момент записи. none — внешняя рассылка выключена (локально и на проверках): '
    'уведомление зафиксировано, но наружу ничего не ушло.';

-- Уведомление — факт: оно не переписывается и не удаляется.
CREATE OR REPLACE FUNCTION comms.forbid_operator_notification_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, comms, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'уведомление не переписывается и не удаляется' USING ERRCODE = '42501';
END $$;

CREATE TRIGGER operator_notifications_immutable
    BEFORE UPDATE OR DELETE ON comms.operator_notifications
    FOR EACH ROW EXECUTE FUNCTION comms.forbid_operator_notification_rewrite();

-- ------------------------------------------------------------------------ RLS
ALTER TABLE comms.operator_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.operator_notifications FORCE  ROW LEVEL SECURITY;

-- Это внутренняя переписка платформы: видит администратор. Основателю и
-- инвестору она не адресована и в их кабинетах не показывается.
CREATE POLICY operator_notifications_admin_read ON comms.operator_notifications FOR SELECT
    TO app_backend USING (app.has_role('admin'));
CREATE POLICY operator_notifications_insert ON comms.operator_notifications FOR INSERT
    TO app_backend WITH CHECK (true);

GRANT SELECT, INSERT ON comms.operator_notifications TO app_backend;

-- --------------------------------------------------------- глагол аудита
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('comms.operator_notification.recorded',
     'Зафиксировано уведомление команде по порогу суммы раунда',
     ARRAY['system', 'founder', 'admin'])
ON CONFLICT (verb) DO NOTHING;
