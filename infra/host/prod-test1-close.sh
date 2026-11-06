#!/bin/bash
# test-1 снова техническая: пароль на входе (новый, прежний попал в журнал), пределы ресурсов,
# учётка администратора с адресом Томаса приостановлена.
#   prod-test1-close <хеш пароля, base64>
set -Eeuo pipefail
HASH="$(printf %s "${1:?нужен хеш}" | base64 -d)"
ROOT=/opt/fifth-element
DIR="$ROOT/.local/envs/test-1"
CADDY=/etc/caddy/Caddyfile
cd "$ROOT"
cp -p "$CADDY" "$CADDY.before-test1-close"
back() {
  echo "сбой на строке $1: возвращаю прежний вход"
  cp -p "$CADDY.before-test1-close" "$CADDY"
  systemctl reload caddy || true
  exit 1
}
trap 'back $LINENO' ERR
HASH="$HASH" node -e "
const fs=require('fs');const f='$CADDY';const t=fs.readFileSync(f,'utf8');
const m=t.match(/^test-1\.5espace\.com \{\n[\s\S]*?\n\}\n/m);
if(!m)process.exit(1);
const open=m[0].replace(/\tbasic_auth \{[\s\S]*?\n\t\}\n/,'');
const closed=open.replace(/^test-1\.5espace\.com \{\n(\theader [^\n]*\n)?/,(a)=>a+'\tbasic_auth {\n\t\ttester '+process.env.HASH+'\n\t}\n');
fs.writeFileSync(f,t.replace(m[0],()=>closed));"
caddy validate --config "$CADDY" --adapter caddyfile >/dev/null 2>&1
systemctl reload caddy
sleep 2
got="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://test-1.5espace.com/)"
echo "test-1 без пароля: $got"
[ "$got" = 401 ]
trap - ERR

for spec in postgres:768m:1 core:768m:1 valkey:128m:0.25 nats:128m:0.25 web:64m:0.25; do
  IFS=: read -r name memory cpus <<<"$spec"
  docker update --memory "$memory" --memory-swap "$memory" --cpus "$cpus" "fifth-test-1-$name" >/dev/null
done
echo 'пределы ресурсов заданы'

docker exec -i -e PGPASSWORD="$(cat "$DIR/secrets/POSTGRES_PASSWORD")" fifth-test-1-postgres \
  psql -h 127.0.0.1 -U fifth_owner -d fifth_element -At <<'SQL' | tail -1
UPDATE identity.users SET status = 'suspended'
 WHERE id IN (SELECT user_id FROM identity.user_roles WHERE role = 'admin' AND revoked_at IS NULL)
RETURNING id;
SQL
echo 'test-1 закрыта'
