#!/bin/bash
# Боевой режим рабочей среды: TLS к PostgreSQL, Valkey и NATS, почта со входом, mTLS на входе,
# NODE_ENV=production. Ядро уже в kms/legacy на файлах Agent. Записи остаются прежним форматом.
# При сбое .env и Caddyfile возвращаются сами, службы пересоздаются.
set -Eeuo pipefail
TO="$1"
ROOT=/opt/fifth-element
TLS=/etc/fifth-tls
BEFORE="$ROOT/.local/env-before-production"
CADDY_BEFORE="$ROOT/.local/Caddyfile-before-production"
cd "$ROOT"
grep -q '^KMS_MODE=kms' .env || { echo 'сначала kms'; exit 1; }
if grep -q '^NODE_ENV=production' .env; then
  echo 'боевой режим уже включён'
  exit 0
fi
cp -p .env "$BEFORE"
cp -p /etc/caddy/Caddyfile "$CADDY_BEFORE"

services() { node scripts/infra.mjs compose up -d --force-recreate --no-deps "$@" >/dev/null 2>&1; }
healthy() {
  for _ in $(seq 1 90); do
    [ "$(docker inspect "$1" --format '{{.State.Health.Status}}' 2>/dev/null)" = healthy ] && return 0
    sleep 2
  done
  return 1
}
back() {
  echo "сбой на строке $1: возвращаю прежний режим"
  docker logs --tail 14 fifth-core 2>&1 | cut -c1-240 || true
  cp -p "$BEFORE" .env
  cp -p "$CADDY_BEFORE" /etc/caddy/Caddyfile
  systemctl reload caddy || true
  services valkey nats core || true
  healthy fifth-core && echo 'рабочая среда вернулась в прежний режим'
  exit 1
}
trap 'back $LINENO' ERR

echo '▸ PostgreSQL: TLS'
# Адрес с узла ведёт на опубликованный порт, внутри контейнера база на своём.
owner="$(sed -E 's#@[^/]*/#@127.0.0.1:5432/#' /run/fifth-secrets/DATABASE_URL_OWNER)"
pg() { docker exec -e URL="$owner" fifth-postgres sh -c "psql \"\$URL\" -At -c \"$1\""; }
docker cp "$TLS/server.crt" fifth-postgres:/var/lib/postgresql/data/server.crt
docker cp "$TLS/server.key" fifth-postgres:/var/lib/postgresql/data/server.key
docker exec -u 0 fifth-postgres sh -c \
  'cd /var/lib/postgresql/data && chown postgres server.crt server.key && chmod 600 server.key'
pg 'ALTER SYSTEM SET ssl = on' >/dev/null
pg 'SELECT pg_reload_conf()' >/dev/null
sleep 1
[ "$(pg 'SHOW ssl')" = on ]

echo '▸ сертификат центра для ядра'
printf 'C /run/fifth-secrets/internal-ca.crt 0440 1990 1000 - %s/ca.crt\n' "$TLS" >/etc/tmpfiles.d/fifth-tls.conf
systemd-tmpfiles --create /etc/tmpfiles.d/fifth-tls.conf

echo '▸ настройки'
sed -i -e '/^NODE_ENV=/d' -e '/^CORE_PUBLIC_URL=/d' -e '/^PUBLIC_BASE_URL=/d' -e '/^CORS_ALLOWED_ORIGINS=/d' \
  -e '/^SESSION_COOKIE_NAME=/d' -e '/^CSRF_COOKIE_NAME=/d' -e '/^DATABASE_SSL=/d' \
  -e '/^WEBHOOK_DELIVERY_MODE=/d' -e '/^TESTING_SESSIONS_ENABLED=/d' \
  -e '/^MAIL_SMTP_HOST=/d' -e '/^MAIL_SMTP_PORT=/d' -e '/^MAIL_SMTP_SECURITY=/d' -e '/^MAIL_SMTP_USER=/d' \
  -e '/^MAIL_SMTP_PASSWORD/d' -e 's#^REDIS_URL=redis://#REDIS_URL=rediss://#' -e 's#^NATS_URL=nats://#NATS_URL=tls://#' .env
cat >>.env <<EOF
NODE_ENV=production
NODE_EXTRA_CA_CERTS=/run/fifth-secrets/internal-ca.crt
FIFTH_TLS_DIR=$TLS
DATABASE_SSL=true
CORE_PUBLIC_URL=https://5espace.com
PUBLIC_BASE_URL=https://5espace.com
CORS_ALLOWED_ORIGINS=https://5espace.com
SESSION_COOKIE_NAME=__Host-ul_session
CSRF_COOKIE_NAME=__Host-ul_csrf
WEBHOOK_DELIVERY_MODE=live
INTEGRATION_CLIENT_CERT_HEADER=X-Client-Cert-Fingerprint
MAIL_SMTP_HOST=mail.5espace.com
MAIL_SMTP_PORT=587
MAIL_SMTP_SECURITY=starttls
MAIL_SMTP_USER=no-reply@5espace.com
MAIL_SMTP_PASSWORD_FILE=/run/fifth-secrets/MAIL_SMTP_PASSWORD
MONITOR_REDIS_URI=tcp://127.0.0.1:6381
EOF

echo '▸ проверка настроек до перезапуска'
core_image="$(docker inspect fifth-core --format '{{.Config.Image}}')"
docker run --rm --network host --env-file .env -v /run/fifth-secrets:/run/fifth-secrets:ro \
  --entrypoint node "$core_image" -e "require('/app/apps/core/dist/config/env.js').loadEnv();console.log('настройки production приняты')" 2>&1 | cut -c1-240

echo '▸ вход: mTLS'
node -e "
const fs=require('fs');const f='/etc/caddy/Caddyfile';let t=fs.readFileSync(f,'utf8');
const a='5espace.com {\n\timport fifth_access_log\n';
if(!t.includes(a))process.exit(1);
t=t.replace(a,()=>a+'\ttls {\n\t\tclient_auth {\n\t\t\tmode verify_if_given\n\t\t\ttrust_pool file {\n\t\t\t\tpem_file $TLS/integration-ca.crt\n\t\t\t}\n\t\t}\n\t}\n');
const b='\t\theader_up X-Forwarded-Proto {scheme}\n';
t=t.replace(b,()=>b+'\t\t# Заменяет присланное клиентом: значение даёт только проверенный сертификат.\n\t\theader_up X-Client-Cert-Fingerprint {http.request.tls.client.fingerprint}\n');
fs.writeFileSync(f,t)"
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
systemctl reload caddy

echo '▸ службы'
services valkey nats
healthy fifth-valkey
healthy fifth-nats
services core
healthy fifth-core
before="$(stat -c %Y /var/lib/fifth-monitor/app-probe.json)"
for _ in $(seq 1 100); do
  [ "$(stat -c %Y /var/lib/fifth-monitor/app-probe.json)" -gt "$before" ] && break
  sleep 2
done
[ "$(stat -c %Y /var/lib/fifth-monitor/app-probe.json)" -gt "$before" ]
grep -q '"ok": true' /var/lib/fifth-monitor/app-probe.json
echo 'контрольный вход и чтение прошли'

trap - ERR
echo '▸ письмо настоящим транспортом ядра'
docker exec -e TO="$TO" fifth-core node -e "
require('reflect-metadata');
const {createMailTransport}=require('/app/apps/core/dist/comms/mail.transport.js');
createMailTransport().send({to:process.env.TO,subject:'5E production mail check',text:'Боевой режим: письмо ушло с шифрованием и входом.'}).then(()=>console.log('релей принял письмо'),(e)=>console.log('письмо не ушло:',String(e.message).slice(0,160)))" 2>&1 | tail -2 | cut -c1-220

node scripts/monitoring.mjs configure | tail -1 | cut -c1-120
echo 'боевой режим включён'
