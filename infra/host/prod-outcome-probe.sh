#!/bin/bash
# Обрыв соединений приложения с базой test-1 на N секунд (W32, план выпуска, раздел 4: 504 с
# outcome доходит до клиента через nginx и Caddy). PostgreSQL не останавливается: одна сессия
# владельца каждые 50 мс завершает соединения ролей app_* в работе или в открытой транзакции.
# Только test-1. Значений не печатает.
#
#   fifth-test op prod-outcome-probe <секунды 5..60>
set -Eeuo pipefail
SEC="${1:-}"
[[ "$SEC" =~ ^[0-9]+$ ]] && [ "$SEC" -ge 5 ] && [ "$SEC" -le 60 ] || { echo 'нужны секунды 5..60' >&2; exit 2; }
docker exec -i fifth-test-1-postgres sh -c \
  'PGPASSWORD="$(cat /run/secrets/POSTGRES_PASSWORD)" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d fifth_element -At -v ON_ERROR_STOP=1' <<SQL
DO \$\$
DECLARE
  stop timestamptz := clock_timestamp() + interval '$SEC seconds';
  n int := 0;
BEGIN
  WHILE clock_timestamp() < stop LOOP
    n := n + (SELECT count(*) FROM (
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = 'fifth_element' AND usename LIKE 'app\_%'
         AND state IN ('active', 'idle in transaction') AND pid <> pg_backend_pid()) t);
    PERFORM pg_sleep(0.05);
  END LOOP;
  RAISE NOTICE 'завершено соединений: %', n;
END
\$\$;
SQL
echo "обрыв окончен ($(date -u +%FT%TZ))"
