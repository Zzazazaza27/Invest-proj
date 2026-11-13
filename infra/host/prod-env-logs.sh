#!/bin/bash
# Журнал работающего ядра test-1 — активный слот по маршруту среды (core или core-b). Только
# чтение. Строки с секретами ядро не пишет (safe-log); вывод ограничен.
#
#   fifth-test op prod-env-logs [с <время UTC, напр. 2026-11-13T09:39:00Z>] [до <время>] [слово]
set -Eeuo pipefail
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
DIR=/opt/fifth-element/.local/envs/test-1
CORE=fifth-test-1-core
grep -q '"slot": *"core-b"' "$DIR/release/core-route.json" 2>/dev/null && CORE=fifth-test-1-core-b
TIME_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?Z$'
SINCE="${1:-}"
UNTIL="${2:-}"
WORD="${3:-}"
ARGS=()
if [ -n "$SINCE" ]; then [[ "$SINCE" =~ $TIME_RE ]] || { echo 'время: 2026-11-13T09:39:00Z' >&2; exit 2; }; ARGS+=(--since "$SINCE"); else ARGS+=(--tail 200); fi
if [ -n "$UNTIL" ]; then [[ "$UNTIL" =~ $TIME_RE ]] || { echo 'время: 2026-11-13T09:45:00Z' >&2; exit 2; }; ARGS+=(--until "$UNTIL"); fi
[[ -z "$WORD" || "$WORD" =~ ^[A-Za-z0-9._:-]{2,60}$ ]] || { echo 'слово: буквы, цифры, . _ : -' >&2; exit 2; }
echo "ядро: $CORE"
# Журнал ядра — journald (W08b) или файл Docker: docker logs читает оба.
if [ -n "$WORD" ]; then
  docker logs "${ARGS[@]}" "$CORE" 2>&1 | grep -F -- "$WORD" | tail -400 | cut -c1-600
else
  docker logs "${ARGS[@]}" "$CORE" 2>&1 | tail -400 | cut -c1-600
fi
