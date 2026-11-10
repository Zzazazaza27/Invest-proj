#!/bin/bash
# Окно сопоставимого замера на test-1 (W32, Тэнк 10.11): одинаковые параметры в каждом окне,
# приросты счётчиков за окно. Нагрузка — номинал, без повышения и без изменения квот.
#   bash scripts/load/window.sh <метка окна, например day-1110 | night-1111>
#
# Порядок (≈ 30 мин):
#  1. условия окна (prod-window-conditions): таймеры, службы, сборщики, journald, данные;
#  2. простой 5 мин: сборщик с подробными срезами (CPU и торможение контейнеров, PSI хоста и
#     контейнеров, Valkey, ожидания БД), без нагрузки;
#  3. время карточки в базе в контексте ядра (prod-db-timing, 30 раз) и эталон процессора;
#  4. свежий набор данных (20 участников, 200 проектов) — свой на окно;
#  5. нагрузка: p1-api, 2/с, 10 мин, k6 без Docker, тот же сборщик;
#  6. снова п. 3 и условия; уборка набора.
# Итог — out/suites/load-window-<метка>/. Окна сравнивает window-compare.mjs.
set -u
L="${1:?нужна метка окна}"
[[ "$L" =~ ^[a-z0-9-]{3,20}$ ]] || { echo 'метка: [a-z0-9-]{3,20}' >&2; exit 2; }
cd "$(dirname "$0")/../.."
OUT="out/suites/load-window-$L"
[ -e "$OUT" ] && { echo "окно $L уже есть: $OUT" >&2; exit 2; }
mkdir -p "$OUT"
SSH=(ssh -i "$HOME/.ssh/maus_5e" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20 maus@193.233.217.210)
op() { "${SSH[@]}" "sudo -n /usr/local/sbin/fifth-test op $*"; }
export FIFTH_LOAD_BASE=https://test-1.5espace.com
export FIFTH_LOAD_BASIC_AUTH_FILE=.local/load/test-1-basic.txt
export FIFTH_LOAD_ADMIN_PASSWORD_FILE=.local/load/test-1-admin-password.txt
FIFTH_LOAD_ADMIN_EMAIL=$(node -e "console.log(require('./.local/load/test-1.5espace.com-admin.json').email)")
export FIFTH_LOAD_ADMIN_EMAIL
RUN="t1-win-$L"
log() { echo "== $(date -u +%H:%M:%SZ) $*"; }

log "окно $L: условия до"
op prod-window-conditions > "$OUT/conditions-before.txt" 2>&1

log 'набор данных'
node scripts/load/seed.mjs seed --users 20 --projects 200 --run-id "$RUN" > "$OUT/seed.txt" 2>&1 ||
  { echo 'набор не заведён' >&2; tail -3 "$OUT/seed.txt" >&2; exit 1; }
read -r PID VID <<< "$(node -e "const d=require('./.local/load/$RUN/users.json');console.log(d.publicProjects[0], d.users[1].id)")"

log 'простой 5 мин'
CID="win-$L-idle"
op prod-load-collect start "$CID" 300 > /dev/null
sleep 310
op prod-load-collect export "$CID" > "$OUT/idle-export.txt"

log 'карточка в базе, до нагрузки'
op prod-db-timing "$PID" 30 "$VID" > "$OUT/db-timing-before.txt" 2>&1

log 'нагрузка p1-api 2/с 10 мин'
node scripts/load/run.mjs --run-id "$RUN" --mode base --rate 2 --duration 10m --burst 0 \
  --profile p1-api --native --server-collect 900 > "$OUT/load.txt" 2>&1
echo "run.mjs код $?" >> "$OUT/load.txt"

log 'карточка в базе, после нагрузки'
op prod-db-timing "$PID" 30 "$VID" > "$OUT/db-timing-after.txt" 2>&1
log 'условия после'
op prod-window-conditions > "$OUT/conditions-after.txt" 2>&1

log 'уборка набора'
node scripts/load/seed.mjs clean --run-id "$RUN" > "$OUT/clean.txt" 2>&1
ls -d "out/suites/load-$RUN"/p1-api-base-* > "$OUT/load-dir.txt" 2>/dev/null
log "готово: $OUT"
