-- M176 — исчерпанные события outbox отдельно от рабочей очереди (W32, условие Тэнка 10.11).
--
-- В M152 `pending` и `oldestAgeSec` считались по ВСЕМ неопубликованным, включая исчерпавшие
-- попытки. Одно застрявшее событие (test-1, 05.11: проба интеграции, тема вне потока) держало
-- возраст очереди растущим бесконечно: порог «не публикуется дольше 5 мин» горел постоянно
-- и скрывал, разгружается ли рабочая очередь. Теперь:
--  * pending / oldestAgeSec — только рабочая очередь (попытки ещё есть: attempts < 10);
--  * exhausted / exhaustedOldestAgeSec — исчерпавшие попытки (10, как MAX_ATTEMPTS
--    публикатора): число и возраст старейшего — для отдельного сигнала;
--  * withError — как прежде, по всем неопубликованным.
-- Исчерпанные записи не удаляются и не сбрасываются: это разбор человеком.
-- Форма ответа расширена, прежние ключи сохранены (наблюдение читает их по имени).

CREATE OR REPLACE FUNCTION audit.queue_metrics()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, audit, lab, pg_temp
AS $$
    SELECT jsonb_build_object(
        'outbox', (
            SELECT jsonb_build_object(
                'pending', count(*) FILTER (WHERE attempts < 10),
                'oldestAgeSec', coalesce(extract(epoch FROM now() - min(created_at)
                    FILTER (WHERE attempts < 10))::bigint, 0),
                'exhausted', count(*) FILTER (WHERE attempts >= 10),
                'exhaustedOldestAgeSec', coalesce(extract(epoch FROM now() - min(created_at)
                    FILTER (WHERE attempts >= 10))::bigint, 0),
                'withError', count(*) FILTER (WHERE last_error IS NOT NULL))
              FROM audit.outbox_events
             WHERE published_at IS NULL),
        'uploads', (
            SELECT jsonb_build_object(
                'pending', count(*) FILTER (WHERE upload_state = 'pending'),
                'oldestPendingAgeSec', coalesce(extract(epoch FROM now() - min(created_at)
                    FILTER (WHERE upload_state = 'pending'))::bigint, 0),
                'needsAttention', count(*) FILTER (WHERE upload_state = 'needs_attention'))
              FROM lab.project_materials
             WHERE upload_state IN ('pending', 'needs_attention'))
    )
$$;

COMMENT ON FUNCTION audit.queue_metrics() IS
    'Размер и возраст очередей outbox и загрузок для служебного порта ядра (/queues), '
    'без идентификаторов и содержимого (блок 8, 8.3; M152). Outbox: рабочая очередь '
    '(attempts < 10) отдельно от исчерпавших попытки (M176).';

REVOKE ALL ON FUNCTION audit.queue_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.queue_metrics() TO app_backend;
