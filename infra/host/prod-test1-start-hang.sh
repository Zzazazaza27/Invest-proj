#!/bin/bash
# Зависание ядра при первоначальном запуске на технической test-1 (решение Тэнка и Томаса
# 09.11.2026). Только test-1. Ядро перезапускается штатно, новый процесс замораживается ДО
# первого успешного /live — доказательство: в журнале этого процесса нет строки
# «служебный порт» (её ядро пишет сразу после того, как поднимает /live). Затем — снятие по
# пределу запуска (5 минут) со stage=start, контейнер снова здоров.
#
#   fifth-test op prod-test1-start-hang
set -Eeuo pipefail
C=fifth-test-1-core
restarts() { docker inspect -f '{{.RestartCount}}' "$C"; }
health() { docker inspect -f '{{.State.Health.Status}}' "$C"; }
lines() { docker inspect -f '{{range .State.Health.Log}}{{.Output}}{{end}}' "$C" | grep -o 'core-health[^|]*'; }
wait_for() { for _ in $(seq 1 "$2"); do eval "$1" && return 0; sleep 1; done; return 1; }
ok() { echo "  OK    $1"; }
bad() { echo "  FAIL  $1"; FAIL=1; }
FAIL=0

wait_for '[ "$(health)" = healthy ]' 120 || { echo 'test-1 не здорова — не начинаю' >&2; exit 1; }
before="$(restarts)"
since="$(date -u +%FT%TZ)"
docker restart -t 35 "$C" >/dev/null
pid=''
for _ in $(seq 1 100); do
  pid="$(docker exec "$C" node -e "const fs=require('fs');for(const p of fs.readdirSync('/proc').filter((d)=>/^\d+\$/.test(d)&&d!=='1')){try{if(fs.readFileSync('/proc/'+p+'/cmdline','utf8').startsWith('node\\0apps/core/dist/main.js')){process.kill(Number(p),'SIGSTOP');console.log(p)}}catch{}}" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] && break
  sleep 0.1
done
[[ "$pid" =~ ^[0-9]+$ ]] || { bad 'новый процесс ядра не найден'; exit 1; }
echo "  ·     заморожен процесс $pid, $(date -u +%T) UTC"
sleep 10
if docker logs --since "$since" "$C" 2>&1 | grep "\"instance\":\"[^\"]*:$pid\"" | grep -q 'служебный порт'; then
  bad 'процесс успел поднять /live до заморозки — это прежний сценарий, не запуск'
  exit 1
fi
ok 'заморожен до первого /live: строки «служебный порт» у процесса нет'
seen=''
for _ in $(seq 1 420); do
  l="$(lines | tail -1)"
  [[ "$l" == *'stage=start'*'action=kill'* ]] && seen="$l"
  [ "$(restarts)" -gt "$before" ] && break
  sleep 1
done
[ "$(restarts)" -gt "$before" ] && ok "снят по пределу запуска и перезапущен ($(date -u +%T) UTC)" || bad 'за 7 минут не снят'
[ -n "$seen" ] && ok "строка проверки: $seen" || echo '  ·     строку со stage=start в журнале проверки не застал (хранится 5 последних)'
if wait_for '[ "$(health)" = healthy ]' 120; then ok "снова здоров: $(lines | tail -1)"; else bad 'не вернулся в здоровое состояние'; fi
exit "$FAIL"
