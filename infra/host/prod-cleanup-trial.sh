#!/bin/bash
# Испытание очистки служебных копий на test-1 (работа № 8 раздела 01) — ТОЛЬКО для общей
# приёмки и только test-1. На серверных средах задача выключена до отдельного решения.
#
#   fifth-test op prod-cleanup-trial on    временно: задача включена, служебный проход фона
#                                          (токен — новый файл секрета среды); ядро пересоздаётся
#   fifth-test op prod-cleanup-trial run   один служебный проход изнутри контейнера ядра
#   fifth-test op prod-cleanup-trial off   вернуть настройки как были; ядро пересоздаётся
#
# Значения не печатаются.
set -Eeuo pipefail
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ROOT=/opt/fifth-element
ID=test-1
DIR="$ROOT/.local/envs/$ID"
SETTINGS="$DIR/settings.env"
SAVED="$DIR/settings.env.before-cleanup-trial"
TOKEN="$DIR/secrets/BACKGROUND_CONTROL_TOKEN"
cd "$ROOT"
core() {
  # Ядро среды: одно (`-core`) или активный слот при включённых слотах.
  for name in "fifth-$ID-core" "fifth-$ID-core-a" "fifth-$ID-core-b"; do
    [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = true ] && { echo "$name"; return; }
  done
  echo 'ядро test-1 не запущено' >&2
  exit 1
}
case "${1:-}" in
  on)
    [ -f "$SAVED" ] || cp -p "$SETTINGS" "$SAVED"
    (umask 077 && openssl rand -hex 24 >"$TOKEN")
    sed -i -e '/^UPLOAD_COPY_CLEANUP_ENABLED=/d' -e '/^BACKGROUND_CONTROL_TOKEN/d' "$SETTINGS"
    printf 'UPLOAD_COPY_CLEANUP_ENABLED=true\nBACKGROUND_CONTROL_TOKEN_FILE=/run/secrets/BACKGROUND_CONTROL_TOKEN\n' >>"$SETTINGS"
    node scripts/env.mjs start "$ID" --text | cut -c1-160
    echo 'очистка служебных копий на test-1: включена для испытания'
    ;;
  run)
    docker exec "$(core)" node -e "
const fs = require('fs');
const token = process.env.BACKGROUND_CONTROL_TOKEN
  ?? fs.readFileSync(process.env.BACKGROUND_CONTROL_TOKEN_FILE, 'utf8').trim();
fetch('http://127.0.0.1:' + (process.env.CORE_INTERNAL_PORT || 4400) + '/background/run/uploads.copy-cleanup', {
  method: 'POST', headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(300000),
}).then((r) => r.text()).then((t) => console.log(t), (e) => { console.log(JSON.stringify({ ran: false, reason: String(e) })); });
"
    ;;
  off)
    [ -f "$SAVED" ] || { echo 'испытание не включалось: сохранённых настроек нет' >&2; exit 2; }
    cp -p "$SAVED" "$SETTINGS"
    rm -f "$SAVED" "$TOKEN"
    node scripts/env.mjs start "$ID" --text | cut -c1-160
    echo 'очистка служебных копий на test-1: выключена, настройки как до испытания'
    ;;
  *)
    echo 'команды: on, run, off' >&2
    exit 2
    ;;
esac
