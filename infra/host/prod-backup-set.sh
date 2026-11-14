#!/bin/bash
# Внеочередной комплект копий рабочей среды перед изменением: тот же запуск, что по расписанию
# (fifth-backup-set.service), и проверка, что появился НОВЫЙ комплект с READY. Печатает метку
# комплекта и время READY, значений не печатает.
#
#   fifth-test op prod-backup-set
set -Eeuo pipefail
SETS=/var/backups/fifth-element/sets
# Только готовые комплекты по имени, как в fifth-backup-read: в каталоге бывают и другие записи,
# и «последний по ls» оказывался не комплектом (14.11: «нового комплекта нет» при новом READY).
ready_last() {
  for d in "$SETS"/*; do
    n="$(basename "$d")"
    if [[ "$n" =~ ^[0-9TZ]+-[0-9a-f]+$ && -f "$d/READY" ]]; then echo "$n"; fi
  done | sort | tail -1
  # Под set -e код функции — код последней команды конвейера (tail), не проверки имени.
}
last="$(ready_last)"
systemctl start fifth-backup-set.service
[ "$(systemctl show fifth-backup-set.service -p Result --value)" = success ] || {
  echo 'задание комплекта завершилось неуспешно' >&2
  exit 1
}
next="$(ready_last)"
[ "$next" != "$last" ] || { echo 'нового комплекта нет' >&2; exit 1; }
[ -f "$SETS/$next/READY" ] || { echo "комплект $next без READY" >&2; exit 1; }
echo "комплект: $next, READY $(cat "$SETS/$next/READY"), сейчас $(date -u +%FT%TZ)"
