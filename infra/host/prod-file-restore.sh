#!/bin/bash
# Восстановление одного файла — ТОЛЬКО test-1 (работа № 6 раздела 01). Конфигурация среды
# закреплена здесь: `--env test-1` подставляется всегда, свой `--env` не принимается, общий
# `.env` корня (конфигурация prod) команда не читает. Значения секретов не печатаются.
#
#   fifth-test op prod-file-restore <команда scripts/file-restore.mjs> [аргументы]
#   fifth-test op prod-file-restore paused  <метка>   окно перед переключением наступило?
#   fifth-test op prod-file-restore release <метка>   снять паузу испытания
set -Eeuo pipefail
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ROOT=/opt/fifth-element
PAUSE=/run/fifth-file-restore
cmd="${1:-}"
shift || true
case "$cmd" in
  paused | release)
    [[ "${1:-}" =~ ^[0-9a-f-]{36}$ ]] || { echo 'нужна метка паузы' >&2; exit 2; }
    if [ "$cmd" = paused ]; then test -f "$PAUSE/$1.waiting"; else touch "$PAUSE/$1"; fi
    exit $?
    ;;
esac
for a in "$@"; do
  [ "$a" != --env ] || { echo 'среда закреплена: test-1' >&2; exit 2; }
done
args=("$@")
for i in "${!args[@]}"; do
  if [ "${args[$i]}" = --pause-before-link ]; then
    [[ "${args[$((i + 1))]:-}" =~ ^$PAUSE/[0-9a-f-]{36}$ ]] || {
      echo "пауза — только в $PAUSE" >&2
      exit 2
    }
    install -d -m 700 "$PAUSE"
  fi
done
cd "$ROOT"
unset FIFTH_FILE_RESTORE_LOCAL
exec node scripts/file-restore.mjs "$cmd" --env test-1 "$@"
