#!/bin/bash
# Расход в простое по источникам за 60 с (Томас 10.11). Только чтение.
#   fifth-test op prod-idle-measure
set -u
SEC=60
q() { docker exec "$1" sh -c "psql -U \"\$POSTGRES_USER\" -d fifth_element -Atc \"$2\"" 2>/dev/null; }
snap() { q "$1" "SELECT queryid, calls, round(total_exec_time::numeric, 1) FROM pg_stat_statements;"; }
tmp=$(mktemp -d)
for pg in fifth-postgres fifth-test-1-postgres fifth-test-2-postgres; do snap "$pg" > "$tmp/$pg.0"; done
cpu0=$(awk '/^cpu /{print $2+$3+$4+$6+$7+$8, $5}' /proc/stat)
timeout "$SEC" docker events --filter event=exec_start --format '{{.Actor.Attributes.name}}' > "$tmp/exec" 2>/dev/null
cpu1=$(awk '/^cpu /{print $2+$3+$4+$6+$7+$8, $5}' /proc/stat)
for pg in fifth-postgres fifth-test-1-postgres fifth-test-2-postgres; do snap "$pg" > "$tmp/$pg.1"; done
echo "== CPU VPS за $SEC с (занято / всего, доля одного ядра из 4)"
read b0 i0 <<< "$cpu0"; read b1 i1 <<< "$cpu1"
awk -v b=$((b1-b0)) -v i=$((i1-i0)) 'BEGIN{printf "занято %.1f%% всего процессора = %.2f ядра\n", 100*b/(b+i), 4*b/(b+i)}'
echo "== запуски проверок здоровья (exec) за $SEC с: всего и по контейнерам"
wc -l < "$tmp/exec"
sort "$tmp/exec" | uniq -c | sort -rn | head -30
echo "== запросы к базам за $SEC с: всего вызовов и мс, затем самые частые"
for pg in fifth-postgres fifth-test-1-postgres fifth-test-2-postgres; do
  echo "-- $pg"
  join -j1 <(sort "$tmp/$pg.0") <(sort "$tmp/$pg.1") -t'|' | awk -F'|' '{c+=$4-$2; t+=$5-$3} END{printf "вызовов %d (%.1f/с), время %.0f мс\n", c, c/'"$SEC"', t}'
  join -j1 <(sort "$tmp/$pg.0") <(sort "$tmp/$pg.1") -t'|' | awk -F'|' '{print $4-$2, $1}' | sort -rn | head -6 | while read -r n id; do
    printf '%6d  %s\n' "$n" "$(q "$pg" "SELECT left(regexp_replace(query, '\s+', ' ', 'g'), 80) FROM pg_stat_statements WHERE queryid = $id LIMIT 1;")"
  done
done
rm -rf "$tmp"
