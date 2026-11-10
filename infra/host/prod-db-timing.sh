#!/bin/bash
# Время выполнения запроса в базе test-1 без нагрузки — только чтение (W32, разбор замедления).
#   fifth-test op prod-db-timing <id проекта> [повторов, по умолчанию 30]
# EXPLAIN (ANALYZE) карточки проекта lab.project_view_base(id): план и время исполнения
# в базе, повторно; и эталон процессора (сумма ряда), чтобы сравнивать сеансы замеров.
# Ничего не меняет: только SELECT.
set -u
PG=fifth-test-1-postgres
id="${1:-}"; n="${2:-30}"
[[ "$id" =~ ^[0-9a-f-]{36}$ ]] || { echo 'нужен id проекта' >&2; exit 2; }
[[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -le 200 ] || { echo 'повторов: до 200' >&2; exit 2; }
pgq() {
  docker exec -i "$PG" sh -c 'PGPASSWORD="$(cat /run/secrets/POSTGRES_PASSWORD)" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d fifth_element -At -P pager=off'
}
{
  echo "\\echo == план (первый запуск)"
  echo "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT * FROM lab.project_view_base('$id');"
  echo "\\echo == время исполнения, мс ($n раз)"
  for _ in $(seq 1 "$n"); do
    echo "EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) SELECT * FROM lab.project_view_base('$id');"
  done
  echo "\\echo == эталон процессора, мс (10 раз)"
  for _ in $(seq 1 10); do
    echo "EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) SELECT sum(i) FROM generate_series(1, 300000) i;"
  done
} | pgq | awk '
  /^Execution Time/ { if (seen) { v = $3; t[++k] = v } ; next }
  /^== / { if (k) { flush() } print; seen = ($0 ~ /время|эталон/); next }
  { if (!seen) print }
  function flush(   i, s, a, n) { n = k; for (i = 1; i <= n; i++) a[i] = t[i]; asort(a)
    for (i = 1; i <= n; i++) s += a[i]
    printf "  n=%d мин=%.2f медиана=%.2f p90=%.2f макс=%.2f среднее=%.2f\n", n, a[1], a[int((n+1)/2)], a[int(n*0.9)], a[n], s/n
    k = 0; delete t }
  END { if (k) flush() }'
