#!/bin/bash
# Отказ под номинальной нагрузкой на test-1 (W32): k6 2/с + сборщик на сервере + отказ и
# проверка последствий (fault-check.mjs). Лимиты частоты не поднимаются — номинал в них.
#   bash scripts/load/fault-t1.sh <run_id> core|postgres|valkey|nats
# Отказ генератора (run.mjs, код 3) — испытание не засчитывается.
set -u
RUN="${1:?нужен run_id}"
KIND="${2:?нужен отказ}"
export FIFTH_LOAD_BASE=https://test-1.5espace.com
export FIFTH_LOAD_BASIC_AUTH_FILE=.local/load/test-1-basic.txt
# Во время отказа платформы ответы могут задерживаться: остановку итераций считаем
# отказом генератора только после 4 мин; сетевые ошибки соединения — как обычно.
export GEN_STALL_SEC=240
DUR=15m; [ "$KIND" = nats ] && DUR=18m
LOG="out/load-fault-$KIND.txt"
node scripts/load/run.mjs --run-id "$RUN" --mode base --duration "$DUR" --server-collect 1500 \
  --max-upload 0 --burst 0 > "$LOG" 2>&1 &
K6=$!
CID=''
for _ in $(seq 1 60); do
  CID=$(grep -o 'сборщик на сервере: [A-Za-z0-9._-]*' "$LOG" | awk '{print $NF}')
  [ -n "$CID" ] && break
  sleep 2
done
[ -n "$CID" ] || { echo 'сборщик не запустился'; kill $K6; wait $K6; exit 1; }
OUT=$(grep -o 'отчёт: .*' "$LOG" | head -1 | cut -d' ' -f2-)
echo "== нагрузка идёт ($CID), отказ $KIND через 120 с; отчёт $OUT"
sleep 120
kill -0 $K6 2>/dev/null || { echo 'k6 завершился до отказа'; wait $K6; exit 1; }
node scripts/load/fault-check.mjs --run-id "$RUN" --kind "$KIND" --collect-id "$CID" --out "$OUT"
FC=$?
wait $K6
RC=$?
echo "== fault-check=$FC run=$RC"
grep -E 'ОТКАЗ ГЕНЕРАТОРА|ПОРОГ НА СЕРВЕРЕ|сводка' "$LOG"
[ "$RC" = 3 ] && { echo '== генератор отказал — испытание НЕ засчитывается'; exit 3; }
exit $FC
