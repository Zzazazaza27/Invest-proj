#!/bin/bash
# Объём и состояние таблиц базы среды — только чтение (W32, разбор дневного замедления).
#   fifth-test op prod-db-facts <test-1|test-2>
# Размеры, живые и мёртвые строки, последние vacuum/analyze по основным таблицам; число
# изменений с последнего analyze; размер базы. Содержимого строк нет.
set -u
case "${1:-}" in
  test-1) PG=fifth-test-1-postgres ;;
  test-2) PG=fifth-test-2-postgres ;;
  *) echo 'среда: test-1 | test-2' >&2; exit 2 ;;
esac
docker exec -i "$PG" sh -c 'PGPASSWORD="$(cat /run/secrets/POSTGRES_PASSWORD)" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d fifth_element -P pager=off' <<'SQL'
SELECT pg_size_pretty(pg_database_size('fifth_element')) AS db_size, now() AS at;
SELECT schemaname || '.' || relname AS tbl, n_live_tup AS live, n_dead_tup AS dead,
       n_mod_since_analyze AS mod_since_analyze,
       pg_size_pretty(pg_total_relation_size(relid)) AS size,
       to_char(last_autovacuum, 'MM-DD HH24:MI') AS autovac,
       to_char(last_autoanalyze, 'MM-DD HH24:MI') AS autoanalyze,
       to_char(last_analyze, 'MM-DD HH24:MI') AS analyze
  FROM pg_stat_user_tables
 ORDER BY pg_total_relation_size(relid) DESC
 LIMIT 15;
SELECT count(*) AS active_backends,
       count(*) FILTER (WHERE wait_event_type IS NOT NULL AND state = 'active') AS waiting
  FROM pg_stat_activity WHERE datname = 'fifth_element';
SQL
