#!/bin/bash
# Ступени p1 на test-1 с временными лимитами частоты и обязательным возвратом (W32).
# Возврат выполняется при любом исходе прогона, в том числе при обрыве.
#   bash scripts/load/steps-t1.sh <run_id> [доп. аргументы run.mjs, например --steps 16]
set -u
RUN="${1:?нужен run_id}"
shift
SSH=(ssh -i "$HOME/.ssh/maus_5e" -o IdentitiesOnly=yes -o BatchMode=yes maus@193.233.217.210)
op() { "${SSH[@]}" "sudo -n /usr/local/sbin/fifth-test op prod-load-limits $1"; }
restore() {
  echo '== возврат лимитов test-1'
  op restore
}
trap restore EXIT
echo '== временные лимиты test-1'
op apply || exit 1
export FIFTH_LOAD_BASE=https://test-1.5espace.com
export FIFTH_LOAD_BASIC_AUTH_FILE=.local/load/test-1-basic.txt
node scripts/load/run.mjs --run-id "$RUN" --mode steps --server-collect 3600 "$@"
