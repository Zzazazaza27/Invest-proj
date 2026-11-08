#!/bin/bash
# Петля падений на технической test-1 (решение Томаса 09.11.2026). Только test-1.
# Падение ядра — SIGTERM процессу ядра мимо обёртки: для обёртки это незапланированный выход.
#
#   fifth-test op prod-test1-crash loop    три падения → редкий режим (тревога «Ядро в петле падений»)
#   fifth-test op prod-test1-crash status  строка проверки, перезапуски, выгрузка
set -Eeuo pipefail
MODE="${1:-}"
[[ "$MODE" =~ ^(loop|status)$ ]] || { echo 'режим: loop или status' >&2; exit 2; }
C=fifth-test-1-core
restarts() { docker inspect -f '{{.RestartCount}}' "$C"; }
health() { docker inspect -f '{{.State.Health.Status}}' "$C"; }
last() { docker inspect -f '{{range .State.Health.Log}}{{.Output}}{{end}}' "$C" | grep -o 'core-health[^|]*' | tail -1; }
crash() {
  docker exec "$C" node -e "const fs=require('fs');for(const p of fs.readdirSync('/proc').filter((d)=>/^\d+\$/.test(d)&&d!=='1')){try{if(fs.readFileSync('/proc/'+p+'/cmdline','utf8').startsWith('node\\0apps/core/dist/main.js')){process.kill(Number(p),'SIGTERM');console.log(p)}}catch{}}"
}
wait_for() { for _ in $(seq 1 "$2"); do eval "$1" && return 0; sleep 1; done; return 1; }
ok() { echo "  OK    $1"; }
bad() { echo "  FAIL  $1"; FAIL=1; }
FAIL=0
case "$MODE" in
  status)
    systemctl start fifth-monitor-export.service
    echo "  перезапусков $(restarts), здоровье $(health), $(last)"
    grep -o '"name": "fifth-test-1-core"[^}]*' /var/lib/fifth-monitor/containers.json | tr -d '\n ' | cut -c1-200
    echo
    ;;
  loop)
    wait_for '[ "$(health)" = healthy ]' 120 || { echo 'test-1 не здорова — не начинаю' >&2; exit 1; }
    for n in 1 2 3; do
      before="$(restarts)"
      pid="$(crash)"
      [[ "$pid" =~ ^[0-9]+$ ]] || { bad "падение $n: процесс не найден"; break; }
      if [ "$n" -lt 3 ]; then
        wait_for '[ "$(restarts)" -gt "$before" ]' 60 && wait_for '[ "$(health)" = healthy ]' 120 &&
          ok "падение $n: контейнер перезапущен сразу, снова здоров" || bad "падение $n: не вернулось"
      else
        wait_for '[ "$(restarts)" -gt "$before" ]' 60 || bad 'падение 3: нет перезапуска'
      fi
    done
    if wait_for 'last | grep -q "mode=slow"' 60; then ok "редкий режим: $(last)"; else bad "mode=slow нет: $(last)"; fi
    systemctl start fifth-monitor-export.service
    grep -q '"crashLoop": true' /var/lib/fifth-monitor/containers.json &&
      ok 'выгрузка наблюдения: crashLoop' || bad 'в выгрузке признака нет'
    echo '  следующий запуск ядра — через 10 минут после предыдущего; затем три /live снимут режим'
    ;;
esac
exit "$FAIL"
