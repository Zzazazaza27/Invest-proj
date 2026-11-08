#!/bin/bash
# Применить наблюдение как код (scripts/monitoring.mjs configure) и выгрузить состояние
# контейнеров сразу, не дожидаясь таймера. Печатает итог и открытые проблемы, значений не
# печатает.
#
#   fifth-test op prod-monitoring-configure
set -Eeuo pipefail
cd /opt/fifth-element
node scripts/monitoring.mjs configure | tail -1 | cut -c1-160
systemctl start fifth-monitor-export.service
echo "выгрузка: $(node -e "const c=JSON.parse(require('fs').readFileSync('/var/lib/fifth-monitor/containers.json','utf8')).containers;console.log('контейнеров',c.length,'— остановлено автовосстановление:',c.filter(x=>x.recoveryStopped).map(x=>x.name).join(', ')||'нет')")"
node scripts/monitoring.mjs status | grep -E 'открытых проблем|Автовосстановление|перезапускался|не работает' | cut -c1-160 || true
