#!/bin/bash
# Сигналы наблюдения за пилотными копиями. Проверка отказа — на копии файла состояния, без записи
# в общие сигналы: считается только решение порога.
set -uo pipefail
cd /opt/fifth-element
node scripts/backup.mjs check 2>&1 | grep -E 'pilot-|ПРОБЛЕМА' | cut -c1-140
node -e "const s=JSON.parse(require('fs').readFileSync('/var/lib/fifth-monitor/pilot-offsite.json'));console.log('отметка выноса',s.set,s.at)"
grep -l pilot- /var/backups/fifth-element/state/signals.json 2>/dev/null
