#!/bin/bash
# Временно убрать принятый отчёт совместимости кандидата и вернуть его (испытание работы № 1
# раздела 01: возврат без отчёта — отказ до изменений). Только test-сценарий; отчёт не удаляется —
# переносится в соседний каталог и возвращается тем же шагом. Значений не печатает.
#
#   fifth-test op prod-compat-hold <кандидат> <прежняя> hold|restore
set -Eeuo pipefail
BUILD="${1:-}"
PREV="${2:-}"
MODE="${3:-}"
re='^[0-9]+\.[0-9]+-b[0-9]+\.[0-9]+$'
[[ "$BUILD" =~ $re && "$PREV" =~ $re && "$MODE" =~ ^(hold|restore)$ ]] || {
  echo 'нужны <кандидат> <прежняя> hold|restore' >&2
  exit 2
}
KIT="/opt/fifth-element/.local/kits/$BUILD"
HELD="/opt/fifth-element/.local/kits/.held-compat-$BUILD"
NAME="compat-$PREV.json"
if [ "$MODE" = hold ]; then
  [ -f "$KIT/$NAME" ] || { echo "отчёта $NAME в $BUILD нет" >&2; exit 2; }
  install -d -m 700 "$HELD"
  mv "$KIT/$NAME" "$KIT/$NAME.sig" "$HELD/"
  echo "отчёт убран: $BUILD/$NAME"
else
  [ -f "$HELD/$NAME" ] || { echo "убранного отчёта нет" >&2; exit 2; }
  mv "$HELD/$NAME" "$HELD/$NAME.sig" "$KIT/"
  rmdir "$HELD"
  echo "отчёт возвращён: $BUILD/$NAME"
fi
