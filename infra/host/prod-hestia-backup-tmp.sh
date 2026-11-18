#!/bin/bash
# Брошенные рабочие каталоги копий Hestia (/backup/tmp.*): v-backup-user создаёт их на время
# прохода и удаляет при успехе; от неудачных проходов они остаются (Томас 18.11: «удали, если
# мусор»). Удаляются только каталоги старше суток и только когда копия не идёт.
#
#   fifth-test op prod-hestia-backup-tmp list     только чтение
#   fifth-test op prod-hestia-backup-tmp delete   удалить
set -Eeuo pipefail
list() { find /backup -maxdepth 1 -type d -name 'tmp.*' -mtime +1; }
case "${1:-list}" in
  list)
    echo "каталогов: $(list | wc -l), $(list | xargs -r du -sch | tail -1 | cut -f1)"
    echo "копия идёт: $(pgrep -f 'v-backup-user' >/dev/null && echo да || echo нет)"
    ;;
  delete)
    pgrep -f 'v-backup-user' >/dev/null && { echo 'идёт копия Hestia — не удаляю' >&2; exit 1; }
    n=$(list | wc -l)
    list | xargs -r rm -rf --
    echo "удалено каталогов: $n; осталось tmp.*: $(find /backup -maxdepth 1 -type d -name 'tmp.*' | wc -l)"
    ls -1 /backup/*.tar 2>/dev/null | xargs -r -n1 basename
    ;;
  *) echo 'команды: list, delete' >&2; exit 2 ;;
esac
