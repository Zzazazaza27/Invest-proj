#!/bin/bash
# Время выполнения запроса в базе test-1 без нагрузки — только чтение (W32, разбор замедления).
#   fifth-test op prod-db-timing <id проекта> [повторов, по умолчанию 30] [id зрителя]
# Контекст — как у ядра (unit-of-work asPublicRole): BEGIN READ ONLY, SET LOCAL ROLE
# app_public_read, app.current_user_id = зритель, app.current_roles = founder (без зрителя —
# анонимный). Тот же SQL, что шлёт ядро: SELECT * FROM lab.project_view_base($1).
# Плюс эталон процессора (сумма ряда), чтобы сравнивать окна замеров.
# Ничего не меняет: только SELECT в транзакции READ ONLY.
set -u
PG=fifth-test-1-postgres
id="${1:-}"; n="${2:-30}"; viewer="${3:-}"
[[ "$id" =~ ^[0-9a-f-]{36}$ ]] || { echo 'нужен id проекта' >&2; exit 2; }
[[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -le 200 ] || { echo 'повторов: до 200' >&2; exit 2; }
[ -z "$viewer" ] || [[ "$viewer" =~ ^[0-9a-f-]{36}$ ]] || { echo 'id зрителя — uuid' >&2; exit 2; }
roles=''
[ -n "$viewer" ] && roles=founder
pgq() {
  docker exec -i "$PG" sh -c 'PGPASSWORD="$(cat /run/secrets/POSTGRES_PASSWORD)" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d fifth_element -At -q -P pager=off'
}
ctx() {
  echo 'BEGIN READ ONLY;'
  echo 'SET LOCAL ROLE app_public_read;'
  echo "SELECT set_config('app.current_user_id', '$viewer', true) IS NULL;"
  echo "SELECT set_config('app.current_roles', '$roles', true) IS NULL;"
}
{
  echo "\\echo == контекст: роль app_public_read, зритель ${viewer:-аноним} ${roles}"
  echo '\echo == план (первый запуск)'
  ctx
  echo "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT * FROM lab.project_view_base('$id');"
  echo 'COMMIT;'
  echo "\\echo == время исполнения, мс ($n раз)"
  for _ in $(seq 1 "$n"); do
    ctx
    echo "EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) SELECT * FROM lab.project_view_base('$id');"
    echo 'COMMIT;'
  done
  echo '\echo == эталон процессора, мс (10 раз)'
  for _ in $(seq 1 10); do
    echo 'EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) SELECT sum(i) FROM generate_series(1, 300000) i;'
  done
} | pgq | awk '
  /^Execution Time/ { if (seen) { t[++k] = $3 } else print; next }
  /^== / { if (k) flush(); print; seen = ($0 ~ /время|эталон/); next }
  /^(f|t)$/ { next }
  { if (!seen) print }
  function flush(   i, s, a, m) { m = k; for (i = 1; i <= m; i++) a[i] = t[i]; asort(a)
    for (i = 1; i <= m; i++) s += a[i]
    printf "  n=%d мин=%.2f медиана=%.2f p90=%.2f макс=%.2f среднее=%.2f\n", m, a[1], a[int((m+1)/2)], a[int(m*0.9)], a[m], s/m
    k = 0; delete t }
  END { if (k) flush() }'
