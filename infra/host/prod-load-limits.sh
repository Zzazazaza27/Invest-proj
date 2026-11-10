#!/bin/bash
# Временные лимиты частоты test-1 на время прогона ёмкости (блок 6, W32; план, раздел 2).
#
#   fifth-test op prod-load-limits apply <сек>  поднять лимиты на срок (60…14400 с)
#   fifth-test op prod-load-limits restore      вернуть прежние значения и подтвердить
#   fifth-test op prod-load-limits status       что действует, срок, таймер, журнал
#   fifth-test op prod-load-limits expire       возврат по сроку (вызывает таймер сервера)
#   fifth-test op prod-load-limits restore --simulate-restart-failure
#                                               узкая проверка: перезапуск «не удался»
#
# Меняются только настройки среды test-1 (settings.env); комплект и образы те же. Ядро
# пересоздаётся штатно (`env.mjs start` → compose up). Прежний файл сохраняется отметкой.
#
# Срок держит сервер, и он переживает перезагрузку: apply сначала ставит постоянный таймер
# systemd (файлы в /etc/systemd/system, OnCalendar = срок, Persistent=true). Если срок прошёл,
# пока сервер был выключен, таймер срабатывает сразу после загрузки (после docker.service).
# Таймер не встал — apply ничего не меняет. После успешного возврата таймер и его файлы
# снимаются: вне прогона на сервере ничего не остаётся.
#
# Возврат завершён только когда подтверждено: в ядре прежние значения (окружение контейнера)
# и защита работает (серия входов получает 429 с Retry-After). До этого отметка и срок
# сохраняются; любой отказ — явная ошибка (код 1) с записью в журнал, повтор — `restore`.
# Отказ при возврате по таймеру сам переставляет таймер на повтор через 5 минут.
set -u
ROOT=/opt/fifth-element
DIR="$ROOT/.local/envs/test-1"
FILE="$DIR/settings.env"
MARK="$DIR/settings.env.load-backup"
EXPIRES="$DIR/settings.env.load-expires"
LOG="$DIR/load-limits.log"
UNIT=fifth-load-limits-expire
UNIT_DIR=/etc/systemd/system
RETRY_SEC=300
KEYS='RATE_LIMIT_IP_CEILING_PER_MIN RATE_LIMIT_AUTH_PER_MIN RATE_LIMIT_DEFAULT_PER_MIN'
declare -A LOAD=([RATE_LIMIT_IP_CEILING_PER_MIN]=100000 [RATE_LIMIT_AUTH_PER_MIN]=1000 [RATE_LIMIT_DEFAULT_PER_MIN]=1000)
SIMULATE_RESTART_FAILURE=''

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
at() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "$(now) $*" >> "$LOG"; }
value_in() { grep -E "^$1=" "$2" 2>/dev/null | tail -1 | cut -d= -f2-; }
live() { docker exec fifth-test-1-core printenv "$1" 2>/dev/null; }
show() {
  for k in $KEYS; do
    v=$(value_in "$k" "$FILE")
    l=$(live "$k")
    echo "$k=${v:-(по умолчанию)} в ядре: ${l:-(по умолчанию)}"
  done
}
restart() {
  if [ -n "$SIMULATE_RESTART_FAILURE" ]; then
    echo 'ПРОВЕРКА: перезапуск ядра изображает отказ, ядро не трогается' >&2
    return 1
  fi
  (cd "$ROOT" && node scripts/env.mjs start test-1 --text)
}

# --- таймер срока: постоянный, переживает перезагрузку ---
arm_timer() {
  local when; when=$(date -u -d "@$1" '+%Y-%m-%d %H:%M:%S UTC')
  cat > "$UNIT_DIR/$UNIT.service" <<EOF
[Unit]
Description=Возврат временных лимитов test-1 (W32)
After=docker.service network-online.target
Wants=docker.service network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash $ROOT/infra/host/prod-load-limits.sh expire
EOF
  cat > "$UNIT_DIR/$UNIT.timer" <<EOF
[Unit]
Description=Срок временных лимитов test-1 (W32)

[Timer]
OnCalendar=$when
Persistent=true
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload &&
    systemctl enable "$UNIT.timer" >/dev/null 2>&1 &&
    systemctl restart "$UNIT.timer" &&
    systemctl is-enabled --quiet "$UNIT.timer" &&
    systemctl is-active --quiet "$UNIT.timer"
}
disarm_timer() {
  systemctl disable --now "$UNIT.timer" >/dev/null 2>&1 || true
  # Из самой службы возврата (expire) её не останавливаем — иначе она убьёт себя.
  [ "$MODE" = expire ] || systemctl stop "$UNIT.service" >/dev/null 2>&1 || true
  rm -f "$UNIT_DIR/$UNIT.timer" "$UNIT_DIR/$UNIT.service"
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl reset-failed "$UNIT.timer" "$UNIT.service" >/dev/null 2>&1 || true
}

check_expired() {
  [ -f "$MARK" ] && [ -f "$EXPIRES" ] || return 1
  [ "$(date +%s)" -ge "$(cat "$EXPIRES")" ]
}
# В ядре — значения из отметки (прежние): ключа нет в отметке — нет и в ядре.
live_matches_mark() {
  local k want got bad=0
  for k in $KEYS; do
    want=$(value_in "$k" "$MARK")
    got=$(live "$k")
    if [ "$want" != "$got" ]; then
      echo "  $k: в ядре '${got:-(по умолчанию)}', ожидалось '${want:-(по умолчанию)}'" >&2
      bad=1
    fi
  done
  docker exec fifth-test-1-core true >/dev/null 2>&1 || { echo '  ядро не запущено' >&2; bad=1; }
  return $bad
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
    echo '429 не получен — защита не подтверждена' >&2; return 1
  fi
}

# Возврат не завершён: отметка и срок остаются, отказ явный; по таймеру — повтор через 5 мин.
fail_restore() {
  log "ВОЗВРАТ НЕ ЗАВЕРШЁН ($REASON): $1 — отметка сохранена, повтор: restore"
  echo "ВОЗВРАТ НЕ ЗАВЕРШЁН: $1. Отметка и срок сохранены; повтор — restore." >&2
  if [ "$MODE" = expire ]; then
    if arm_timer $(( $(date +%s) + RETRY_SEC )); then
      log "повтор возврата по таймеру: $(at $(( $(date +%s) + RETRY_SEC )))"
    else
      log 'ВНИМАНИЕ: таймер повтора не встал'
    fi
  fi
  exit 1
}
do_restore() {
  REASON="$1"
  if [ ! -f "$MARK" ]; then
    rm -f "$EXPIRES"
    disarm_timer
    echo 'отметки нет — значения уже обычные:'; show
    check_protection || exit 1
    return 0
  fi
  cat "$MARK" > "$FILE" || fail_restore 'не записан файл настроек'
  restart || fail_restore 'перезапуск ядра не удался'
  live_matches_mark || fail_restore 'в ядре не прежние значения'
  check_protection || fail_restore 'защита не подтверждена'
  # Подтверждено — только теперь снимаются отметка, срок и таймер.
  rm -f "$MARK" "$EXPIRES"
  disarm_timer
  log "возвращено и подтверждено ($REASON)"
  echo "возвращено и подтверждено $(now) ($REASON):"; show
}

# Таймер и ручные команды не пересекаются.
exec 9>"$DIR/.load-limits.lock"
flock 9

MODE="${1:-}"
case "$MODE" in
  status)
    if check_expired; then
      echo 'срок истёк, а отметка на месте — возвращаю'; do_restore 'просрочено, status'; exit 0
    fi
    show
    if [ -f "$MARK" ]; then
      echo "отметка: временные лимиты до $(at "$(cat "$EXPIRES" 2>/dev/null || echo 0)")"
      if cmp -s "$MARK" "$FILE"; then echo 'ВНИМАНИЕ: возврат начат, но не подтверждён — нужен restore'; fi
      if systemctl is-enabled --quiet "$UNIT.timer" && systemctl is-active --quiet "$UNIT.timer"; then
        echo "таймер возврата: постоянный, $(systemctl show "$UNIT.timer" -p NextElapseUSecRealtime --value)"
      else
        echo 'ВНИМАНИЕ: таймера возврата нет'
      fi
    else
      echo 'отметки нет: обычные лимиты'
    fi
    if [ -f "$LOG" ]; then echo 'журнал:'; tail -6 "$LOG"; fi
    ;;
  expire)
    if [ -f "$MARK" ]; then do_restore 'срок истёк, таймер сервера'; else disarm_timer; fi
    ;;
  apply)
    if check_expired; then do_restore 'просрочено, перед apply'; fi
    [ -f "$MARK" ] && { echo 'отметка осталась от прошлого прогона — сначала restore' >&2; exit 2; }
    ttl="${2:-}"
    if ! [[ "$ttl" =~ ^[0-9]+$ ]] || [ "$ttl" -lt 60 ] || [ "$ttl" -gt 14400 ]; then
      echo 'нужен срок в секундах: 60…14400' >&2; exit 2
    fi
    until_s=$(( $(date +%s) + ttl ))
    # Таймер ставится ДО изменения файла: не встал — ничего не меняем.
    if ! arm_timer "$until_s"; then
      disarm_timer
      echo 'постоянный таймер возврата не встал — лимиты не меняю' >&2; exit 1
    fi
    echo "$until_s" > "$EXPIRES"
    cp -p "$FILE" "$MARK"
    tmp=$(mktemp)
    grep -vE "^($(echo "$KEYS" | tr ' ' '|'))=" "$FILE" > "$tmp"
    for k in $KEYS; do echo "$k=${LOAD[$k]}" >> "$tmp"; done
    cat "$tmp" > "$FILE"; rm -f "$tmp"
    if ! restart; then
      log 'применение: перезапуск не удался — отметка и таймер остаются, нужен restore'
      echo 'перезапуск не удался; отметка и таймер остаются — выполни restore' >&2; exit 1
    fi
    log "применено на ${ttl} с, срок $(at "$until_s")"
    echo "применено $(now); сервер вернёт сам не позже $(at "$until_s"), в том числе после перезагрузки:"; show
    ;;
  restore)
    [ "${2:-}" = --simulate-restart-failure ] && SIMULATE_RESTART_FAILURE=1
    do_restore "restore${SIMULATE_RESTART_FAILURE:+, проверка отказа перезапуска}"
    ;;
  *)
    echo 'команды: apply <сек>, restore [--simulate-restart-failure], status, expire' >&2; exit 2
    ;;
esac
