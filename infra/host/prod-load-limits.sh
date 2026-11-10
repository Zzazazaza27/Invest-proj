#!/bin/bash
# Временные лимиты частоты test-1 на время прогона ёмкости (блок 6, W32; план, раздел 2).
#
#   fifth-test op prod-load-limits apply <сек>  поднять лимиты на срок (60…14400 с)
#   fifth-test op prod-load-limits restore      вернуть прежние значения и проверить защиту
#   fifth-test op prod-load-limits status       что действует сейчас и до какого срока
#   fifth-test op prod-load-limits expire       возврат по сроку (вызывает таймер сервера)
#
# Меняются только настройки среды test-1 (settings.env); комплект и образы те же. Ядро
# пересоздаётся штатно (`env.mjs start` → compose up). Прежний файл сохраняется отметкой.
#
# Срок действия держит сам сервер: apply сначала заводит таймер systemd, который по
# истечении вызывает expire → restore. Возврат не зависит от клиента: сон ноутбука, обрыв
# связи или убитый на нём скрипт не оставят лимиты поднятыми. Таймер не завёлся — apply
# ничего не меняет. Перезагрузка сервера снимает таймер: тогда просроченную отметку
# возвращают status и следующий apply (check_expired).
# Restore проверяет защиту по-настоящему: серия входов получает 429 с Retry-After.
set -u
ROOT=/opt/fifth-element
DIR="$ROOT/.local/envs/test-1"
FILE="$DIR/settings.env"
MARK="$DIR/settings.env.load-backup"
EXPIRES="$DIR/settings.env.load-expires"
LOG="$DIR/load-limits.log"
UNIT=fifth-load-limits-expire
KEYS='RATE_LIMIT_IP_CEILING_PER_MIN RATE_LIMIT_AUTH_PER_MIN RATE_LIMIT_DEFAULT_PER_MIN'
declare -A LOAD=([RATE_LIMIT_IP_CEILING_PER_MIN]=100000 [RATE_LIMIT_AUTH_PER_MIN]=1000 [RATE_LIMIT_DEFAULT_PER_MIN]=1000)

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "$(now) $*" >> "$LOG"; }
show() {
  for k in $KEYS; do
    v=$(grep -E "^$k=" "$FILE" | tail -1 | cut -d= -f2-)
    # Действующее в ядре — из окружения контейнера, а не только из файла.
    live=$(docker exec fifth-test-1-core printenv "$k" 2>/dev/null)
    echo "$k=${v:-(по умолчанию)} в ядре: ${live:-(по умолчанию)}"
  done
}
restart() {
  cd "$ROOT" && node scripts/env.mjs start test-1 --text
}
cancel_timer() {
  systemctl stop "$UNIT.timer" "$UNIT.service" >/dev/null 2>&1 || true
  systemctl reset-failed "$UNIT.timer" "$UNIT.service" >/dev/null 2>&1 || true
}
# Срок истёк, а отметка на месте (например, сервер перезагружался и таймер пропал).
check_expired() {
  [ -f "$MARK" ] && [ -f "$EXPIRES" ] || return 1
  [ "$(date +%s)" -ge "$(cat "$EXPIRES")" ]
}
# Защита на месте: 35 входов подряд с одного адреса — должен быть 429 с Retry-After.
check_protection() {
  local got='' i h code
  for i in $(seq 1 35); do
    h=$(curl -s -o /dev/null -D - --max-time 10 -X POST -H 'Content-Type: application/json' \
      -H 'X-Fifth-Origin: render_check' \
      --data "{\"email\":\"limits-check-$i@test.local\",\"password\":\"x\"}" \
      http://127.0.0.1:18081/v1/auth/login | tr -d '\r')
    code=$(echo "$h" | head -1 | awk '{print $2}')
    if [ "$code" = 429 ]; then got=$(echo "$h" | grep -i '^retry-after:' | awk '{print $2}'); break; fi
  done
  if [ -n "$got" ]; then
    echo "защита работает: 429 на попытке $i, Retry-After $got"; log "защита работает (429 на попытке $i)"
  else
    echo 'ВНИМАНИЕ: 429 не получен — защита не подтверждена' >&2; log 'ВНИМАНИЕ: 429 не получен'; return 1
  fi
}
# Возврат: отметка → файл, ядро пересоздаётся, таймер снимается, защита проверяется.
do_restore() {
  if [ -f "$MARK" ]; then
    cat "$MARK" > "$FILE" && rm -f "$MARK" "$EXPIRES"
    restart
    log "возвращено ($1)"
    echo "возвращено $(now) ($1):"; show
  else
    rm -f "$EXPIRES"
    echo 'отметки нет — значения уже обычные:'; show
  fi
  cancel_timer
  check_protection
}

# Таймер и ручные команды не пересекаются.
exec 9>"$DIR/.load-limits.lock"
flock 9

case "${1:-}" in
  status)
    if check_expired; then
      echo 'срок истёк, а отметка на месте — возвращаю'; do_restore 'просрочено, status'; exit $?
    fi
    show
    if [ -f "$MARK" ]; then
      echo "отметка: временные лимиты действуют до $(date -u -d "@$(cat "$EXPIRES" 2>/dev/null || echo 0)" +%Y-%m-%dT%H:%M:%SZ)"
      if systemctl is-active --quiet "$UNIT.timer"; then echo 'таймер возврата: заведён'
      else echo 'ВНИМАНИЕ: таймера возврата нет'; fi
    else
      echo 'отметки нет: обычные лимиты'
    fi
    if [ -f "$LOG" ]; then echo 'журнал:'; tail -5 "$LOG"; fi
    ;;
  expire)
    if [ -f "$MARK" ]; then do_restore 'срок истёк, таймер сервера'; else cancel_timer; fi
    ;;
  apply)
    if check_expired; then do_restore 'просрочено, перед apply' || exit 1; fi
    [ -f "$MARK" ] && { echo 'отметка осталась от прошлого прогона — сначала restore' >&2; exit 2; }
    ttl="${2:-}"
    if ! [[ "$ttl" =~ ^[0-9]+$ ]] || [ "$ttl" -lt 60 ] || [ "$ttl" -gt 14400 ]; then
      echo 'нужен срок в секундах: 60…14400' >&2; exit 2
    fi
    command -v systemd-run >/dev/null || { echo 'нет systemd-run — без серверного срока не применяю' >&2; exit 2; }
    cancel_timer
    # Таймер заводится ДО изменения файла: не завёлся — ничего не меняем.
    if ! systemd-run --quiet --unit "$UNIT" --on-active="${ttl}s" --timer-property=AccuracySec=5s \
      /bin/bash "$ROOT/infra/host/prod-load-limits.sh" expire; then
      echo 'таймер возврата не заведён — лимиты не меняю' >&2; exit 1
    fi
    echo $(( $(date +%s) + ttl )) > "$EXPIRES"
    cp -p "$FILE" "$MARK"
    tmp=$(mktemp)
    grep -vE "^($(echo "$KEYS" | tr ' ' '|'))=" "$FILE" > "$tmp"
    for k in $KEYS; do echo "$k=${LOAD[$k]}" >> "$tmp"; done
    cat "$tmp" > "$FILE"; rm -f "$tmp"
    restart
    log "применено на ${ttl} с"
    echo "применено $(now); сервер вернёт сам не позже $(date -u -d "@$(cat "$EXPIRES")" +%Y-%m-%dT%H:%M:%SZ):"; show
    ;;
  restore)
    do_restore 'restore'
    ;;
  *)
    echo 'команды: apply <сек>, restore, status, expire' >&2; exit 2
    ;;
esac
