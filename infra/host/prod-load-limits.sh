#!/bin/bash
# Временные лимиты частоты test-1 на время прогона ёмкости (блок 6, W32; план, раздел 2).
#
#   fifth-test op prod-load-limits apply     сохранить прежние значения и поднять лимиты
#   fifth-test op prod-load-limits restore   вернуть прежние значения и проверить защиту
#   fifth-test op prod-load-limits status    что действует сейчас
#
# Меняются только настройки среды test-1 (settings.env); комплект и образы те же. Ядро
# пересоздаётся штатно (`env.mjs start` → compose up). Прежний файл сохраняется отметкой:
# если отметка осталась от оборванного прогона, apply отказывает — сначала restore.
# Restore проверяет защиту по-настоящему: серия входов получает 429 с Retry-After.
set -u
ROOT=/opt/fifth-element
DIR="$ROOT/.local/envs/test-1"
FILE="$DIR/settings.env"
MARK="$DIR/settings.env.load-backup"
KEYS='RATE_LIMIT_IP_CEILING_PER_MIN RATE_LIMIT_AUTH_PER_MIN RATE_LIMIT_DEFAULT_PER_MIN'
declare -A LOAD=([RATE_LIMIT_IP_CEILING_PER_MIN]=100000 [RATE_LIMIT_AUTH_PER_MIN]=1000 [RATE_LIMIT_DEFAULT_PER_MIN]=1000)

show() {
  for k in $KEYS; do
    v=$(grep -E "^$k=" "$FILE" | tail -1 | cut -d= -f2-)
    echo "$k=${v:-(по умолчанию)}"
  done
}
restart() {
  cd "$ROOT" && node scripts/env.mjs start test-1 --text
}

case "${1:-}" in
  status)
    show
    [ -f "$MARK" ] && echo 'отметка: временные лимиты действуют' || echo 'отметки нет: обычные лимиты'
    ;;
  apply)
    [ -f "$MARK" ] && { echo 'отметка осталась от прошлого прогона — сначала restore' >&2; exit 2; }
    cp -p "$FILE" "$MARK"
    tmp=$(mktemp)
    grep -vE "^($(echo "$KEYS" | tr ' ' '|'))=" "$FILE" > "$tmp"
    for k in $KEYS; do echo "$k=${LOAD[$k]}" >> "$tmp"; done
    cat "$tmp" > "$FILE"; rm -f "$tmp"
    echo "применено $(date -u +%Y-%m-%dT%H:%M:%SZ):"; show
    restart
    ;;
  restore)
    if [ -f "$MARK" ]; then
      cat "$MARK" > "$FILE" && rm -f "$MARK"
      echo "возвращено $(date -u +%Y-%m-%dT%H:%M:%SZ):"; show
      restart
    else
      echo 'отметки нет — значения уже обычные:'; show
    fi
    # Защита на месте: 35 входов подряд с одного адреса — должен быть 429 с Retry-After.
    got=''
    for i in $(seq 1 35); do
      h=$(curl -s -o /dev/null -D - --max-time 10 -X POST -H 'Content-Type: application/json' \
        -H 'X-Fifth-Origin: render_check' \
        --data "{\"email\":\"limits-check-$i@test.local\",\"password\":\"x\"}" \
        http://127.0.0.1:18081/v1/auth/login | tr -d '\r')
      code=$(echo "$h" | head -1 | awk '{print $2}')
      if [ "$code" = 429 ]; then got=$(echo "$h" | grep -i '^retry-after:' | awk '{print $2}'); break; fi
    done
    if [ -n "$got" ]; then echo "защита работает: 429 на попытке $i, Retry-After $got"
    else echo 'ВНИМАНИЕ: 429 не получен — защита не подтверждена' >&2; exit 1; fi
    ;;
  *)
    echo 'команды: apply, restore, status' >&2; exit 2
    ;;
esac
