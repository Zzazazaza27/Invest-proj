# Третья часть пробы test-1: боевой режим. Подключается из test-probe.sh, ядро уже в kms/legacy.
# TLS с проверкой к PostgreSQL, Valkey и NATS, NODE_ENV=production, настоящий вход и запись.

TLS="$DIR/tls"
ORIGIN="https://$ID.5espace.com"
say 'внутренние сертификаты'
mkdir -p "$TLS"
chmod 700 "$TLS"
if [ ! -s "$TLS/ca.crt" ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out "$TLS/ca.key"
  openssl req -x509 -new -key "$TLS/ca.key" -sha256 -days 3650 -subj "/CN=5E internal CA $ID" \
    -addext 'basicConstraints=critical,CA:TRUE' -out "$TLS/ca.crt"
  openssl ecparam -name prime256v1 -genkey -noout -out "$TLS/server.key"
  openssl req -new -key "$TLS/server.key" -subj '/CN=internal' -out "$TLS/server.csr"
  printf 'subjectAltName=DNS:postgres,DNS:valkey,DNS:nats,DNS:localhost,IP:127.0.0.1\n' >"$TLS/ext"
  openssl x509 -req -in "$TLS/server.csr" -CA "$TLS/ca.crt" -CAkey "$TLS/ca.key" -CAcreateserial \
    -days 1095 -sha256 -extfile "$TLS/ext" -out "$TLS/server.crt" 2>/dev/null
fi

say 'PostgreSQL: TLS'
pg() {
  docker exec -e PGPASSWORD="$(cat "$DIR/secrets/POSTGRES_PASSWORD")" "$PROJECT-postgres" \
    psql -h 127.0.0.1 -U fifth_owner -d fifth_element -At -c "$1"
}
docker cp "$TLS/server.crt" "$PROJECT-postgres:/var/lib/postgresql/data/server.crt"
docker cp "$TLS/server.key" "$PROJECT-postgres:/var/lib/postgresql/data/server.key"
docker exec -u 0 "$PROJECT-postgres" sh -c \
  'cd /var/lib/postgresql/data && chown postgres server.crt server.key && chmod 600 server.key'
pg "ALTER SYSTEM SET ssl = on" >/dev/null
pg "SELECT pg_reload_conf()" >/dev/null
sleep 1
[ "$(pg 'SHOW ssl')" = on ]

say 'Valkey и NATS: TLS'
cp -p "$DIR/secrets/valkey.conf" "$WORK/valkey.conf.before"
cp -p "$DIR/secrets/nats.conf" "$WORK/nats.conf.before"
install -m 444 "$TLS/server.crt" "$DIR/secrets/tls-server.crt"
install -m 444 "$TLS/server.key" "$DIR/secrets/tls-server.key"
install -m 444 "$TLS/ca.crt" "$DIR/secrets/tls-ca.crt"
chmod 644 "$DIR/secrets/valkey.conf" "$DIR/secrets/nats.conf"
cat >>"$DIR/secrets/valkey.conf" <<EOF
port 6378
tls-port 6379
tls-cert-file /run/secrets/tls-server.crt
tls-key-file /run/secrets/tls-server.key
tls-ca-cert-file /run/secrets/tls-ca.crt
tls-auth-clients no
EOF
cat >>"$DIR/secrets/nats.conf" <<EOF
tls { cert_file: "/run/secrets/tls-server.crt", key_file: "/run/secrets/tls-server.key" }
EOF
chmod 444 "$DIR/secrets/valkey.conf" "$DIR/secrets/nats.conf"
cat >"$DIR/compose.tls.yml" <<EOF
services:
  valkey:
    healthcheck:
      test: ['CMD-SHELL', 'REDISCLI_AUTH="\$\$(cat /run/secrets/REDIS_PASSWORD)" valkey-cli -p 6378 ping | grep -q PONG']
  core:
    volumes:
      - $TLS/ca.crt:/internal-ca.crt:ro
EOF
tcompose() { compose -f "$DIR/compose.agent.yml" -f "$DIR/compose.tls.yml" "$@"; }
tcompose up -d --force-recreate --no-deps valkey nats >/dev/null 2>&1

say 'настройки production'
cp -p "$DIR/settings.env" "$WORK/settings.tls-before"
sed -i -e '/^NODE_ENV=/d' -e '/^CORE_PUBLIC_URL=/d' -e '/^PUBLIC_BASE_URL=/d' -e '/^CORS_ALLOWED_ORIGINS=/d' \
  -e '/^SESSION_COOKIE_NAME=/d' -e '/^CSRF_COOKIE_NAME=/d' -e '/^REDIS_URL=/d' -e '/^NATS_URL=/d' \
  -e '/^WEBHOOK_DELIVERY_MODE=/d' -e '/^TESTING_SESSIONS_ENABLED=/d' "$DIR/settings.env"
cat >>"$DIR/settings.env" <<EOF
NODE_ENV=production
NODE_EXTRA_CA_CERTS=/internal-ca.crt
DATABASE_SSL=true
REDIS_URL=rediss://valkey:6379
NATS_URL=tls://nats:4222
CORE_PUBLIC_URL=$ORIGIN
PUBLIC_BASE_URL=$ORIGIN
CORS_ALLOWED_ORIGINS=$ORIGIN
SESSION_COOKIE_NAME=__Host-ul_session
CSRF_COOKIE_NAME=__Host-ul_csrf
WEBHOOK_DELIVERY_MODE=live
INTEGRATION_CLIENT_CERT_HEADER=X-Client-Cert-Fingerprint
EOF
tcompose up -d --force-recreate --no-deps core >/dev/null 2>&1
ready
for _ in $(seq 1 45); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$PROBE_URL_ENV/v1/auth/me")" != 502 ] && break
  sleep 2
done
docker logs --tail 40 "$PROJECT-core" 2>&1 | grep -E 'NATS|Valkey|redis|TLS|ssl' | tail -4 | cut -c1-200 || true

say 'настоящий вход в боевом режиме'
export PROBE_COOKIE_PREFIX=__Host- PROBE_ORIGIN="$ORIGIN"
login_check register "$USERS" production
login_check login "$USERS"
unset PROBE_COOKIE_PREFIX PROBE_ORIGIN

say 'проверка сертификатов в обе стороны'
docker run --rm --network "$NET" "fifth/core:$BUILD" node -e "
const tls=require('tls');
const c=tls.connect({host:'valkey',port:6379,servername:'valkey',rejectUnauthorized:true},()=>{console.log('плохо: чужой CA принят');process.exit(1)});
c.on('error',(e)=>{console.log('без нашего CA соединение отвергнуто:',e.code);process.exit(0)});"

say 'возврат test-1 в прежний режим'
cp -p "$WORK/settings.tls-before" "$DIR/settings.env"
chmod 644 "$DIR/secrets/valkey.conf" "$DIR/secrets/nats.conf"
cp "$WORK/valkey.conf.before" "$DIR/secrets/valkey.conf"
cp "$WORK/nats.conf.before" "$DIR/secrets/nats.conf"
chmod 444 "$DIR/secrets/valkey.conf" "$DIR/secrets/nats.conf"
rm -f "$DIR/secrets/tls-server.crt" "$DIR/secrets/tls-server.key" "$DIR/secrets/tls-ca.crt" "$DIR/compose.tls.yml"
pg "ALTER SYSTEM RESET ssl" >/dev/null
pg "SELECT pg_reload_conf()" >/dev/null
compose -f "$DIR/compose.agent.yml" up -d --force-recreate --no-deps valkey nats core >/dev/null 2>&1
ready
