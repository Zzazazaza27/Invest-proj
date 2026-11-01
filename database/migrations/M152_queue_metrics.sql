-- M152 — показатели очередей для наблюдения (5Э MVP, работа 2.1-W08a).
--
-- Требования: блок 8, 8.3 «Наблюдение за фоновыми процессами» — размер
-- очереди и возраст самой старой ожидающей записи.
--
-- Одна функция только на чтение, без расширения прав ролей на сами таблицы:
-- служебный порт ядра (`/queues`) вызывает её пулом приложения без
-- пользовательского контекста. Возвращаются только числа и возраст —
-- ни идентификаторов, ни содержимого событий и загрузок.
--
-- Очереди:
--  * outbox — неопубликованные события (`published_at IS NULL`); отдельно —
--    исчерпавшие попытки (10, как MAX_ATTEMPTS публикатора) и с ошибкой;
--  * загрузки материалов — «ожидает» и «требует вмешательства».

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
                'pending', count(*),
                'oldestAgeSec', coalesce(extract(epoch FROM now() - min(created_at))::bigint, 0),
                'exhausted', count(*) FILTER (WHERE attempts >= 10),
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
    'без идентификаторов и содержимого (блок 8, 8.3; M152).';

REVOKE ALL ON FUNCTION audit.queue_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.queue_metrics() TO app_backend;
