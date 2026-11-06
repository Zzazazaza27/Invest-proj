#!/bin/bash
# Пароль на входе рабочей среды (решение Томаса 06.11): Caddy перед сайтом и API, без исключений.
#   prod-gate <хеш пароля Томаса, base64>
# Наблюдение проходит тем же входом со своей учёткой. Домен файлов общий с test-1, его не трогаем.
# При сбое настройки возвращаются. Значения не печатаются.
set -Eeuo pipefail
OWNER_HASH="$(printf %s "${1:?нужен хеш}" | base64 -d)"
ROOT=/opt/fifth-element
CADDY=/etc/caddy/Caddyfile
BEFORE=/etc/caddy/Caddyfile.before-gate
GATE=/etc/fifth-gate
CREDENTIALS="$GATE/monitor.credentials"
SITE=https://5espace.com
cd "$ROOT"
if grep -q '^MONITOR_GATE_CREDENTIALS_PATH=' .env; then
  echo 'пароль на входе уже включён'
  exit 0
fi
cp -p "$CADDY" "$BEFORE"
cp -p .env .local/env-before-gate
back() {
  echo "сбой на строке $1: возвращаю прежний вход"
  cp -p "$BEFORE" "$CADDY"
  cp -p .local/env-before-gate .env
  systemctl reload caddy || true
  node scripts/monitoring.mjs configure >/dev/null 2>&1 || true
  exit 1
}
trap 'back $LINENO' ERR

install -d -o root -g root -m 700 "$GATE"
secret="$(openssl rand -hex 24)"
(umask 077; printf 'monitor:%s' "$secret" >"$CREDENTIALS")
monitor_hash="$(caddy hash-password --plaintext "$secret")"
OWNER_HASH="$OWNER_HASH" MONITOR_HASH="$monitor_hash" node -e "
const fs=require('fs');const f='$CADDY';let t=fs.readFileSync(f,'utf8');
const a=t.match(/^5espace\.com \{\n\timport fifth_access_log\n\ttls \{[\s\S]*?\n\t\}\n/m);
if(!a)process.exit(1);
const gate='\theader X-Robots-Tag \"noindex, nofollow\"\n\tbasic_auth {\n\t\tthomas '+process.env.OWNER_HASH+'\n\t\tmonitor '+process.env.MONITOR_HASH+'\n\t}\n';
fs.writeFileSync(f,t.replace(a[0],()=>a[0]+gate));"
caddy validate --config "$CADDY" --adapter caddyfile >/dev/null 2>&1
echo "MONITOR_GATE_CREDENTIALS_PATH=$CREDENTIALS" >>.env
systemctl reload caddy
sleep 2

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }
expect() {
  local want="$1" label="$2"
  shift 2
  local got
  got="$(code "$@")"
  echo "$label: $got"
  [ "$got" = "$want" ]
}
echo '▸ без пароля'
expect 401 'сайт' "$SITE/"
expect 401 'API' "$SITE/v1/health"
expect 401 'вход в приложение' -X POST -H 'content-type: application/json' -d '{}' "$SITE/v1/auth/login"
expect 401 'с действующей на вид сессией' -H 'cookie: __Host-session=x' "$SITE/v1/auth/me"
expect 401 'пульс' "$SITE/_pulse.json"
expect 401 'подложный пароль' -u monitor:x "$SITE/v1/health"
echo '▸ с паролем наблюдения'
expect 200 'API' -K <(printf 'user = "%s"\n' "$(cat "$CREDENTIALS")") "$SITE/v1/health"
echo '▸ соседние адреса'
expect 401 'test-1 по своему паролю' https://test-1.5espace.com/
files="$(code -X OPTIONS -H 'Origin: https://5espace.com' -H 'Access-Control-Request-Method: POST' https://files.5espace.com/fifth-element)"
echo "домен файлов: $files"
[ "$files" != 401 ]

echo '▸ наблюдение'
node scripts/monitoring.mjs configure | tail -1 | cut -c1-120
before="$(stat -c %Y /var/lib/fifth-monitor/app-probe.json)"
for _ in $(seq 1 90); do
  [ "$(stat -c %Y /var/lib/fifth-monitor/app-probe.json)" -gt "$before" ] && break
  sleep 2
done
[ "$(stat -c %Y /var/lib/fifth-monitor/app-probe.json)" -gt "$before" ]
grep -q '"ok": true' /var/lib/fifth-monitor/app-probe.json
echo 'контрольный вход прошёл через защиту'
trap - ERR
sleep 200
node scripts/monitoring.mjs status --items | grep -E 'Сайт:|открытых проблем' | cut -c1-120
echo 'рабочая среда закрыта паролем'
