#!/bin/bash
# Прогон p1 на test-1 с временными лимитами частоты (W32).
#   bash scripts/load/steps-t1.sh <run_id> [аргументы run.mjs, например --mode steps --steps 16]
#   LOAD_TTL=<сек> — срок исключения на сервере (по умолчанию 5400).
#   LOAD_SCRIPT=<скрипт> — вместо run.mjs, например scripts/load/w32-recover.mjs (ступени и
#   возврат к номиналу; он сам задаёт сбор на сервере, --server-collect ему не нужен).
# Главный возврат — серверный: apply заводит таймер, и сервер вернёт лимиты сам по
# истечении срока, даже если ноутбук уснул или связь оборвалась. Локальный trap лишь
# возвращает их раньше, когда прогон закончился штатно.
set -u
RUN="${1:?нужен run_id}"
shift
TTL="${LOAD_TTL:-5400}"
SSH=(ssh -i "$HOME/.ssh/maus_5e" -o IdentitiesOnly=yes -o BatchMode=yes maus@193.233.217.210)
op() { "${SSH[@]}" "sudo -n /usr/local/sbin/fifth-test op prod-load-limits $*"; }
restore() {
  echo '== возврат лимитов test-1'
  op restore
}
echo "== временные лимиты test-1 на $TTL с"
op apply "$TTL" || exit 1
trap restore EXIT
export FIFTH_LOAD_BASE=https://test-1.5espace.com
export FIFTH_LOAD_BASIC_AUTH_FILE=.local/load/test-1-basic.txt
if [ -n "${LOAD_SCRIPT:-}" ]; then
  node "$LOAD_SCRIPT" --run-id "$RUN" "$@"
else
  node scripts/load/run.mjs --run-id "$RUN" --server-collect 3600 "$@"
fi
