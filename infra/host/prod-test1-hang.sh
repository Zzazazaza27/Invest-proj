#!/bin/bash
# Предел перезапусков зависшего ядра на технической test-1 (решение Томаса 09.11.2026).
# Заморозки — только здесь, только test-1.
#
#   fifth-test op prod-test1-hang stop     три зависания → три перезапуска, четвёртое →
#                                          автовосстановление остановлено (тревога остаётся)
#   fifth-test op prod-test1-hang restore  ручной перезапуск, ожидание recovery=active
#   fifth-test op prod-test1-hang status   строка проверки и перезапуски
set -Eeuo pipefail
MODE="${1:-}"
[[ "$MODE" =~ ^(stop|restore|status)$ ]] || { echo 'режим: stop, restore или status' >&2; exit 2; }
C=fifth-test-1-core
restarts() { docker inspect -f '{{.RestartCount}}' "$C"; }
health() { docker inspect -f '{{.State.Health.Status}}' "$C"; }
last() { docker inspect -f '{{range .State.Health.Log}}{{.Output}}{{end}}' "$C" | grep -o 'core-health[^|]*' | tail -1; }
freeze() {
  docker exec "$C" node -e "const fs=require('fs');for(const p of fs.readdirSync('/proc').filter((d)=>/^\d+\$/.test(d)&&d!=='1')){try{if(fs.readFileSync('/proc/'+p+'/cmdline','utf8').startsWith('node\\0apps/core/dist/main.js')){process.kill(Number(p),'SIGSTOP');console.log(p)}}catch{}}"
}
wait_for() { # $1 — условие (bash), $2 — секунд
  for _ in $(seq 1 "$2"); do eval "$1" && return 0; sleep 1; done
  return 1
}
ok() { echo "  OK    $1"; }
bad() { echo "  FAIL  $1"; FAIL=1; }
FAIL=0

case "$MODE" in
  status)
    echo "  перезапусков $(restarts), здоровье $(health), $(last)"
    ;;
  stop)
    wait_for '[ "$(health)" = healthy ]' 90 || { echo 'test-1 не здорова — не начинаю' >&2; exit 1; }
    for n in 1 2 3; do
      before="$(restarts)"
      pid="$(freeze)"
      [[ "$pid" =~ ^[0-9]+$ ]] || { bad "заморозка $n: процесс не найден"; break; }
      if wait_for '[ "$(restarts)" -gt "$before" ]' 90 && wait_for '[ "$(health)" = healthy ]' 120; then
        ok "зависание $n: автоматически перезапущено, снова здорово (перезапусков $(restarts))"
      else
        bad "зависание $n: нет перезапуска или не вернулось"
      fi
    done
    before="$(restarts)"
    freeze >/dev/null
    if wait_for 'last | grep -q recovery=stopped' 90; then ok "четвёртое: $(last)"; else bad 'четвёртое: recovery=stopped нет'; fi
    sleep 20
    [ "$(restarts)" = "$before" ] && ok 'процесс не убит, перезапусков не прибавилось' || bad "перезапусков $(restarts)"
    [ "$(health)" = unhealthy ] && ok 'контейнер unhealthy' || bad "здоровье $(health)"
    systemctl start fifth-monitor-export.service
    grep -q '"recoveryStopped": true' /var/lib/fifth-monitor/containers.json &&
      ok 'выгрузка наблюдения: recoveryStopped' || bad 'в выгрузке признака нет'
    echo '  тревога «Автовосстановление ядра остановлено» должна прийти в Telegram; среда оставлена в остановке'
    ;;
  restore)
    docker restart "$C" >/dev/null
    if wait_for 'last | grep -q "live=1 recovery=active"' 120; then ok "после ручного перезапуска: $(last)"; else bad "отметка не снята: $(last)"; fi
    systemctl start fifth-monitor-export.service
    grep -q '"recoveryStopped": true' /var/lib/fifth-monitor/containers.json &&
      bad 'в выгрузке признак остался' || ok 'выгрузка наблюдения: признака нет'
    ;;
esac
exit "$FAIL"
