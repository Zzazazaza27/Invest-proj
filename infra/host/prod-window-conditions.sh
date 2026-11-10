#!/bin/bash
# Условия окна замера — только чтение (W32, сопоставимая пара замеров, Тэнк 10.11).
#   fifth-test op prod-window-conditions
# Что работает на VPS в этот момент и что сработало за последний час: таймеры fifth-*
# (резервные копии, архиватор журналов, выгрузка мониторинга), активные службы fifth-*,
# сборщики нагрузки, journald (объём, поток записей), сеансы входа, число контейнеров,
# объём данных test-1. Секретов и содержимого нет.
set -u
echo "== время $(date -u +%Y-%m-%dT%H:%M:%SZ); $(uptime)"
echo '== таймеры fifth-* (следующий / последний запуск)'
systemctl list-timers 'fifth-*' --all --no-legend 2>/dev/null | awk '{$1=$1; print "  " $0}'
echo '== таймеры fifth-*: с какого момента действуют'
for t in $(systemctl list-timers 'fifth-*' --all --no-legend 2>/dev/null | grep -oE 'fifth-[a-z0-9@.-]+\.timer' | sort -u); do
  printf '  %-34s %s
' "$t" "$(systemctl show "$t" -p ActiveEnterTimestamp --value)"
done
echo '== службы fifth-* активны сейчас'
systemctl list-units 'fifth-*' --state=active,activating --no-legend 2>/dev/null | grep -v '\.timer' | awk '{print "  " $1, $3, $4}'
echo '== службы fifth-*, запускавшиеся за последний час'
journalctl --since '-1h' -o cat _SYSTEMD_UNIT=init.scope 2>/dev/null | grep -oE 'fifth-[a-z0-9@.-]+\.service' | sort | uniq -c | awk '{print "  " $0}'
echo '== сборщики нагрузки'
for d in /var/tmp/fifth-load/*/; do
  [ -f "$d/pid" ] || continue
  if kill -0 "$(cat "$d/pid")" 2>/dev/null && [ ! -f "$d/finished" ]; then echo "  идёт: $(basename "$d")"; fi
done
echo '== journald'
echo "  объём: $(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[KMGT]?B?' | head -1)"
echo "  записей за 5 мин: $(journalctl --since '-5min' -o cat 2>/dev/null | wc -l)"
echo "  из них test-1: $(journalctl --since '-5min' -o cat CONTAINER_NAME=fifth-test-1-core CONTAINER_NAME=fifth-test-1-postgres CONTAINER_NAME=fifth-test-1-web CONTAINER_NAME=fifth-test-1-valkey CONTAINER_NAME=fifth-test-1-nats 2>/dev/null | wc -l)"
echo "== сеансы входа: $(who | wc -l)"
echo "== контейнеров запущено: $(docker ps -q | wc -l)"
echo '== данные test-1'
docker exec -i fifth-test-1-postgres sh -c 'PGPASSWORD="$(cat /run/secrets/POSTGRES_PASSWORD)" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d fifth_element -At -F" "' <<'SQL' | awk '{print "  " $0}'
SELECT 'проектов', count(*)::text FROM lab.projects
UNION ALL SELECT 'материалов', count(*)::text FROM lab.project_materials
UNION ALL SELECT 'событий журнала', count(*)::text FROM audit.events
UNION ALL SELECT 'база', pg_size_pretty(pg_database_size('fifth_element'));
SQL
