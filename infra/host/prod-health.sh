#!/bin/bash
# Сводка рабочей среды после перехода. Только чтение, значений не печатает.
set -uo pipefail
cd /opt/fifth-element
echo '== таймеры'
for unit in $(systemctl list-units --all --no-legend 'fifth-*.service' | awk '{print $1=="●"?$2:$1}'); do
  printf '%s %s %s\n' "$unit" "$(systemctl show "$unit" -p Result --value)" \
    "$(systemctl show "$unit" -p ExecMainExitTimestamp --value | cut -d' ' -f2-3)"
done
echo '== упавшие'
systemctl --failed --no-legend --no-pager | cut -c1-80
echo '== Zabbix'
node scripts/monitoring.mjs status 2>&1 | tail -12 | cut -c1-120
echo '== ошибки служб за час'
journalctl --since '1 hour ago' --no-pager -p err -u 'fifth-*' 2>/dev/null | tail -8 | cut -c1-200
echo '== письмо no restart'
grep -rlE 'no restart' /etc/cron.d /etc/cron.daily /usr/local/hestia/bin 2>/dev/null | head -5
crontab -l 2>/dev/null | head -0
grep -rn 'no restart\|restart failed' /usr/local/hestia/func/*.sh 2>/dev/null | head -4 | cut -c1-140
grep -hE '6:|31 6|^31' /var/spool/cron/crontabs/* 2>/dev/null | head -6 | cut -c1-120
tail -5 /usr/local/hestia/log/error.log 2>/dev/null | cut -c1-160
