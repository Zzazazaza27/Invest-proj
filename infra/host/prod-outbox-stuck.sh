#!/bin/bash
# Неопубликованные события outbox — только чтение (W32, разбор по замечанию Тэнка 10.11).
#   fifth-test op prod-outbox-stuck <среда: test-1|test-2|prod> [id проекта …]
# Печатает неопубликованные события без содержимого (payload не выводится): id, тип,
# агрегат, попытки, срок следующей попытки, аренду, первые 300 знаков ошибки, время.
# С id проектов — сколько их событий всего и сколько не опубликовано (сверка испытания).
# Ничего не меняет: только SELECT.
set -u
env="${1:-}"
case "$env" in
  test-1) PG=fifth-test-1-postgres ;;
  test-2) PG=fifth-test-2-postgres ;;
  prod) PG=fifth-postgres ;;
  *) echo 'среда: test-1 | test-2 | prod' >&2; exit 2 ;;
esac
shift
ids=''
for p in "$@"; do
  [[ "$p" =~ ^[0-9a-f-]{36}$ ]] || { echo "не uuid: $p" >&2; exit 2; }
  ids="$ids${ids:+,}'$p'"
done
pgq() {
  docker exec -i "$PG" sh -c 'PGPASSWORD="$(cat /run/secrets/POSTGRES_PASSWORD)" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d fifth_element -v ON_ERROR_STOP=1 -P pager=off'
}
{
  echo '\echo == неопубликованные (published_at IS NULL)'
  cat <<'SQL'
SELECT id, event_type, aggregate_type, aggregate_id, aggregate_version, nats_subject,
       attempts, next_attempt_at, locked_at, left(coalesce(last_error, ''), 300) AS last_error,
       created_at, round(extract(epoch FROM now() - created_at))::bigint AS age_s
  FROM audit.outbox_events
 WHERE published_at IS NULL
 ORDER BY created_at;
SQL
  echo '\echo == опубликованы, но не разосланы подписчикам'
  echo 'SELECT count(*) FROM audit.outbox_events WHERE published_at IS NOT NULL AND fanout_completed_at IS NULL;'
  echo '\echo == всего событий, последнее опубликованное'
  echo 'SELECT count(*) AS total, max(published_at) AS last_published FROM audit.outbox_events;'
  if [ -n "$ids" ]; then
    echo '\echo == события указанных проектов'
    echo "SELECT aggregate_id, event_type, count(*) AS total, count(*) FILTER (WHERE published_at IS NULL) AS unpublished, max(published_at) AS last_published FROM audit.outbox_events WHERE aggregate_id IN ($ids) GROUP BY 1, 2 ORDER BY 1, 2;"
  fi
} | pgq
