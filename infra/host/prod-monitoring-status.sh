#!/bin/bash
# Открытые проблемы наблюдения и свежая выгрузка контейнеров — только чтение. Для ожидания
# тревог: в отличие от prod-monitoring-configure не перенастраивает Zabbix (configure — сотни
# запросов API, и каждый — подключение к базе Zabbix в журнале; найдено 09.11.2026).
#
#   fifth-test op prod-monitoring-status
set -Eeuo pipefail
cd /opt/fifth-element
systemctl start fifth-monitor-export.service
echo "выгрузка: $(node -e "const c=JSON.parse(require('fs').readFileSync('/var/lib/fifth-monitor/containers.json','utf8')).containers;console.log('контейнеров',c.length,'— остановлено автовосстановление:',c.filter(x=>x.recoveryStopped).map(x=>x.name).join(', ')||'нет','— петля падений:',c.filter(x=>x.crashLoop).map(x=>x.name).join(', ')||'нет')")"
node scripts/monitoring.mjs status | grep -E 'открытых проблем|^ *\[[0-9]\]' | cut -c1-160 || true
