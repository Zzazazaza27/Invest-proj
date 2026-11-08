#!/bin/bash
# Внеочередной комплект копий рабочей среды перед изменением: тот же запуск, что по расписанию
# (fifth-backup-set.service), и проверка, что появился НОВЫЙ комплект с READY. Печатает метку
# комплекта и время READY, значений не печатает.
#
#   fifth-test op prod-backup-set
set -Eeuo pipefail
SETS=/var/backups/fifth-element/sets
last="$(ls "$SETS" | sort | tail -1)"
systemctl start fifth-backup-set.service
[ "$(systemctl show fifth-backup-set.service -p Result --value)" = success ] || {
  echo 'задание комплекта завершилось неуспешно' >&2
  exit 1
}
next="$(ls "$SETS" | sort | tail -1)"
[ "$next" != "$last" ] || { echo 'нового комплекта нет' >&2; exit 1; }
[ -f "$SETS/$next/READY" ] || { echo "комплект $next без READY" >&2; exit 1; }
echo "комплект: $next, READY $(cat "$SETS/$next/READY"), сейчас $(date -u +%FT%TZ)"
