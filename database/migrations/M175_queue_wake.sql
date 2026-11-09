-- =============================================================================
-- M175 — сигнал «в очереди появилась работа» (расход в простое; Томас и Тэнк 10.11).
--
-- Фоновые опросы пустых очередей теперь засыпают с нарастающей паузой до 10 с. Чтобы новая
-- работа не ждала конца паузы, вставка в очередь шлёт NOTIFY: PostgreSQL доставляет его
-- только после фиксации транзакции и всем слушающим соединениям — каждому ядру и слоту.
-- Сигнал — подсказка, а не носитель работы: потерянное уведомление (обрыв слушателя,
-- перезапуск) работу не теряет — периодический опрос остаётся страховкой.
--
-- Триггеры уровня оператора: одна вставка пачки — одно уведомление; одинаковые уведомления
-- в одной транзакции PostgreSQL сливает сам.
--
-- migrate:compat-none: только новые триггеры и функция; прежнее ядро уведомления не слушает,
-- вставки в очереди работают как раньше.
-- =============================================================================
CREATE FUNCTION audit.queue_wake()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    PERFORM pg_notify('fifth_queue_wake', TG_ARGV[0]);
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION audit.queue_wake() IS
    'NOTIFY fifth_queue_wake <очередь> после вставки в очередь: будит уснувший опрос (M175).';

CREATE TRIGGER outbox_events_wake
    AFTER INSERT ON audit.outbox_events
    FOR EACH STATEMENT EXECUTE FUNCTION audit.queue_wake('outbox');

CREATE TRIGGER webhook_deliveries_wake
    AFTER INSERT ON integration.webhook_deliveries
    FOR EACH STATEMENT EXECUTE FUNCTION audit.queue_wake('webhooks');

CREATE TRIGGER mail_queue_wake
    AFTER INSERT ON comms.mail_queue
    FOR EACH STATEMENT EXECUTE FUNCTION audit.queue_wake('mail');
