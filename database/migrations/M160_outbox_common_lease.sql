-- M160 — публикатор outbox и доставки вебхуков на общей аренде (блок 1, 1.3.6; блок 2, 2.4).
--
-- Прежняя аренда — имя экземпляра (`locked_by`): после потери срока тот же экземпляр мог
-- подтвердить чужой уже захват, а отметка «опубликовано» ставилась без условия аренды.
-- Общий модуль `background/lease.ts` даёт новый идентификатор на каждый захват
-- (`lease_id`) и завершающую запись только при текущем захвате и живом сроке.
--
-- Прежние колонки `locked_*` остаются до отдельной уборки: новая выборка их учитывает,
-- чтобы строка, захваченная прежней версией, не досталась двоим.

ALTER TABLE audit.outbox_events
    ADD COLUMN lease_id    UUID,
    ADD COLUMN lease_until TIMESTAMPTZ;

COMMENT ON COLUMN audit.outbox_events.lease_id IS
    'Захват публикатором (общий модуль аренды, M160): новый на каждый захват.';

ALTER TABLE integration.webhook_deliveries
    ADD COLUMN lease_id    UUID,
    ADD COLUMN lease_until TIMESTAMPTZ;

COMMENT ON COLUMN integration.webhook_deliveries.lease_id IS
    'Захват исполнителем доставки (общий модуль аренды, M160): новый на каждый захват.';
