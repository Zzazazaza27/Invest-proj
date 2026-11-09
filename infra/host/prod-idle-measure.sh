#!/bin/bash
# Расход в простое по источникам (Томас и Тэнк 10.11). Только чтение.
#   fifth-test op prod-idle-measure [секунд, по умолчанию 300]
# Сопоставимые интервалы до и после правок: CPU (user, system, steal) из /proc/stat,
# запуски проверок здоровья (exec_start), прирост pg_stat_statements по каждой базе.
set -u
SEC="${1:-300}"
[[ "$SEC" =~ ^[0-9]+$ ]] || { echo 'нужно число секунд' >&2; exit 2; }
DBS="fifth-postgres fifth-test-1-postgres fifth-test-2-postgres"
q() {
  docker exec -i "$1" sh -c '
    if [ -f /run/secrets/POSTGRES_PASSWORD ]; then
      PGPASSWORD="$(cat /run/secrets/POSTGRES_PASSWORD)" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d fifth_element -At -F"|"
    else
      psql -U "$POSTGRES_USER" -d fifth_element -At -F"|"
    fi' 2>/dev/null
}
# Ключ — роль, база и запрос: один queryid лежит отдельной строкой на каждую роль.
snap() { echo "SELECT userid || ':' || dbid || ':' || queryid, calls, round(total_exec_time::numeric, 1) FROM pg_stat_statements;" | q "$1"; }
stat() { awk '/^cpu /{print $2+$3, $4+$7+$8, $9, $5+$6, $2+$3+$4+$5+$6+$7+$8+$9}' /proc/stat; }
tmp=$(mktemp -d)
date -u +'начало %Y-%m-%dT%H:%M:%SZ'
docker ps --format '{{.Names}}' | sort | tr '\n' ' '; echo
for pg in $DBS; do snap "$pg" > "$tmp/$pg.0"; done
s0=$(stat)
timeout "$SEC" docker events --filter event=exec_start --format '{{.Actor.Attributes.name}}' > "$tmp/exec" 2>/dev/null
s1=$(stat)
for pg in $DBS; do snap "$pg" > "$tmp/$pg.1"; done
echo "== CPU VPS за $SEC с, в ядрах из $(nproc)"
read u0 k0 t0 i0 a0 <<< "$s0"; read u1 k1 t1 i1 a1 <<< "$s1"
awk -v u=$((u1-u0)) -v k=$((k1-k0)) -v t=$((t1-t0)) -v a=$((a1-a0)) -v n="$(nproc)" \
  'BEGIN{printf "user %.2f  system %.2f  steal %.2f  всего занято %.2f\n", n*u/a, n*k/a, n*t/a, n*(u+k+t)/a}'
echo "== запуски проверок здоровья за $SEC с: всего, в секунду, по контейнерам"
n=$(wc -l < "$tmp/exec"); awk -v n="$n" -v s="$SEC" 'BEGIN{printf "%d (%.2f/с)\n", n, n/s}'
sort "$tmp/exec" | uniq -c | sort -rn
echo "== запросы к базам за $SEC с"
for pg in $DBS; do
  echo "-- $pg"
  if [ ! -s "$tmp/$pg.0" ]; then echo 'статистика недоступна'; continue; fi
  awk -F'|' -v s="$SEC" 'NR==FNR{c[$1]=$2; t[$1]=$3; next}
    ($1 in c) {dc=$2-c[$1]; dt=$3-t[$1]; C+=dc; T+=dt; if (dc>0) print dc, $1 > "/dev/stderr"}
    !($1 in c) {C+=$2; T+=$3; if ($2>0) print $2, $1 > "/dev/stderr"}
    END{printf "вызовов %d (%.1f/с), время исполнения %.0f мс\n", C, C/s, T}' \
    "$tmp/$pg.0" "$tmp/$pg.1" 2> "$tmp/$pg.top"
  sort -rn "$tmp/$pg.top" | head -10 | while read -r cnt key; do
    text=$(echo "SELECT left(regexp_replace(query, '\\s+', ' ', 'g'), 90) FROM pg_stat_statements WHERE queryid = ${key##*:} LIMIT 1;" | q "$pg")
    printf '%7d  %s\n' "$cnt" "$text"
  done
done
rm -rf "$tmp"
