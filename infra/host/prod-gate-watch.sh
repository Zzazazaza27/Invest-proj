#!/bin/bash
# Внешняя проверка 5e_watch проходит пароль на входе своей учёткой `watch`: другой доступ не даёт.
# Пароль приходит на stdin и нигде не сохраняется. При сбое настройки возвращаются.
set -Eeuo pipefail
CADDY=/etc/caddy/Caddyfile
BEFORE=/etc/caddy/Caddyfile.before-watch
SITE=https://5espace.com
IFS= read -r secret
[ "${#secret}" -ge 32 ] || { echo 'нужен пароль на stdin'; exit 2; }
cp -p "$CADDY" "$BEFORE"
back() {
  echo "сбой на строке $1: возвращаю прежний вход"
  cp -p "$BEFORE" "$CADDY"
  systemctl reload caddy || true
  exit 1
}
trap 'back $LINENO' ERR
HASH="$(caddy hash-password --plaintext "$secret")" node -e "
const fs=require('fs');const f='$CADDY';const t=fs.readFileSync(f,'utf8');
const m=t.match(/^5espace\.com \{\n[\s\S]*?\n\}\n/m);
if(!m||!/\n\t\tmonitor [^\n]*\n/.test(m[0]))process.exit(1);
const clean=m[0].replace(/\t\twatch [^\n]*\n/,'');
const next=clean.replace(/(\n\t\tmonitor [^\n]*\n)/,(a)=>a+'\t\twatch '+process.env.HASH+'\n');
fs.writeFileSync(f,t.replace(m[0],()=>next));"
caddy validate --config "$CADDY" --adapter caddyfile >/dev/null 2>&1
systemctl reload caddy
sleep 2
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }
auth() { code -K <(printf 'user = "watch:%s"\n' "$secret") "$1"; }
open="$(code "$SITE/")"
site="$(auth "$SITE/")"
pulse="$(auth "$SITE/_pulse.json")"
echo "без пароля $open, сайт $site, пульс $pulse"
[ "$open" = 401 ] && [ "$site" = 200 ] && [ "$pulse" = 200 ]
trap - ERR
unset secret
echo 'учётка watch на входе готова'
