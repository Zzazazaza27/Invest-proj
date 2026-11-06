#!/bin/bash
# Обычный вход на test-1 без пароля Caddy (решение Томаса 06.11). Запрет индексации остаётся.
# При сбое прежний файл возвращается. Значения не печатаются.
set -Eeuo pipefail
CADDY=/etc/caddy/Caddyfile
BEFORE=/etc/caddy/Caddyfile.before-test-open
cp -p "$CADDY" "$BEFORE"
back() {
  echo "сбой на строке $1: возвращаю прежний вход"
  cp -p "$BEFORE" "$CADDY"
  systemctl reload caddy || true
  exit 1
}
trap 'back $LINENO' ERR
node -e "
const fs=require('fs');const f='$CADDY';const t=fs.readFileSync(f,'utf8');
const m=t.match(/^test-1\.5espace\.com \{[\s\S]*?\n\}\n/m);
if(!m)process.exit(1);
const open=m[0].replace(/\tbasic_auth \{[\s\S]*?\n\t\}\n/,'');
fs.writeFileSync(f,t.replace(m[0],()=>open));"
caddy validate --config "$CADDY" --adapter caddyfile >/dev/null 2>&1
systemctl reload caddy
sleep 2
got="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://test-1.5espace.com/)"
echo "test-1: $got"
[ "$got" = 200 ]
prod="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://5espace.com/)"
echo "рабочая среда без пароля: $prod"
[ "$prod" = 401 ]
trap - ERR
echo 'на test-1 обычный вход'
