#!/bin/bash
# Кто расходует CPU сервера в простое (Томас 10.11). Только чтение, секреты не выводятся.
#   fifth-test op prod-idle-facts
set -u
echo '== vmstat 1 с × 5 (us sy id wa st)'
vmstat 1 5
echo '== процессы хоста по CPU'
ps -eo pcpu,pmem,etimes,comm --sort=-pcpu | head -25
echo '== top, снимок'
top -b -n 1 -o %CPU | sed -n '1,5p'
echo '== контейнеры, 2 снимка'
docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' | sort -t' ' -k2 -rn | head -10
sleep 5
docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' | sort -t' ' -k2 -rn | head -10
echo '== запросы к ядрам за 5 минут: маршрут и число'
for c in fifth-core fifth-test-2-core fifth-test-1-core; do
  echo "-- $c"
  docker logs --since 5m "$c" 2>&1 | grep -o '"route":"[^"]*","status":[0-9]*' | sort | uniq -c | sort -rn | head -12
  printf 'строк журнала за 5 мин: '; docker logs --since 5m "$c" 2>&1 | wc -l
  echo 'частые сообщения:'
  docker logs --since 5m "$c" 2>&1 | grep -o '"msg":"[^"]*"' | sort | uniq -c | sort -rn | head -8
done
echo '== процессы внутри ядра prod'
docker top fifth-core -eo pid,pcpu,etimes,args 2>/dev/null | cut -c1-120 | head -8
echo '== PostgreSQL prod: активность'
docker exec fifth-postgres sh -c 'psql -U "$POSTGRES_USER" -d fifth_element -Atc "SELECT state, count(*) FROM pg_stat_activity GROUP BY 1 ORDER BY 2 DESC;"' 2>&1 | head -8
docker exec fifth-postgres sh -c 'psql -U "$POSTGRES_USER" -d fifth_element -Atc "SELECT calls, round(total_exec_time) AS ms, left(regexp_replace(query, '"'"'\s+'"'"', '"'"' '"'"', '"'"'g'"'"'), 90) FROM pg_stat_statements ORDER BY calls DESC LIMIT 12;"' 2>&1 | head -14
