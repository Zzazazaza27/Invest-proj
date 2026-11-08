#!/bin/bash
# Пилотная среда test-2 в боевом режиме (решение Тэнка 06.11: до настоящих данных — production и
# Transit со своими ключами среды). Порядок тот же, что у рабочей среды и пробы test-1:
#   1) копия до изменения; 2) свои ключи Transit и секреты в OpenBao, вход AppRole среды;
#   3) TLS к PostgreSQL, Valkey, NATS и хранилищу; 4) KMS_MODE=kms, запись прежним форматом,
#   NODE_ENV=production; 5) проверка и новая копия.
# Записи остаются прежним форматом: копия с KEK среды по-прежнему открывается без OpenBao, возврат
# к местным ключам не теряет данных. При сбое настройки возвращаются сами.
#
#   fifth-test op prod-test2-production <токен> [test-1]   с ноутбука: scripts/test-probe.mjs
# С test-1 — репетиция: весь путь, затем возврат в прежний режим тем же откатом, что при сбое.
# Комплект ключей открывает ноутбук ключом Томаса, на сервере закрытого ключа нет.
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
TOKEN="$1"
[[ "$TOKEN" =~ ^[0-9a-f]{32,64}$ ]] || { echo 'нужен токен'; exit 2; }
ROOT=/opt/fifth-element
ID="${2:-test-2}"
[[ "$ID" =~ ^test-[12]$ ]] || { echo 'среда: test-1 или test-2'; exit 2; }
REHEARSE=$([ "$ID" = test-1 ] && echo 1 || true)
PROJECT="fifth-$ID"
DIR="$ROOT/.local/envs/$ID"
NET="${PROJECT}_default"
TLS="$DIR/tls"
CA="$DIR/tls-ca"
AGENT_DIR="/run/fifth-secrets-$ID"
AGENT_CONF="/etc/fifth-openbao/$ID"
KEYS="/var/backups/fifth-element/openbao-keys/$ID"
BEFORE="$DIR/before-production"
ORIGIN="https://$ID.5espace.com"
S3TLS="$PROJECT-s3tls"
CADDY=/etc/caddy/Caddyfile
WORK="$(mktemp -d)"
cd "$ROOT"
PORT="$(sed -n 's/^FIFTH_WEB_PORT=//p' "$DIR/compose.env")"
# Копии ведутся только у пилотной среды.
backup() { [ -n "$REHEARSE" ] || bash infra/host/pilot-backup.sh; }

say() { printf '\n▸ %s\n' "$1"; }
laptop() { curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:18211/$1" "${@:2}"; }
report() { laptop report --data-binary "$1" >/dev/null || true; }
env_cmd() { node scripts/env.mjs "$@" --text | cut -c1-160; }
pg() {
  docker exec -e PGPASSWORD="$(cat "$DIR/secrets/POSTGRES_PASSWORD")" "$PROJECT-postgres" \
    psql -h 127.0.0.1 -U fifth_owner -d fifth_element -At -c "$1"
}

if grep -q '^NODE_ENV=production' "$DIR/settings.env"; then
  echo "$ID уже в боевом режиме"
  report "$ID уже в боевом режиме"
  exit 0
fi
grep -q '^KMS_MODE=local' "$DIR/settings.env" || { echo 'ожидался KMS_MODE=local'; exit 1; }
# Копии и контрольный файл ходят к Garage напрямую: адрес обязан быть тем же.
grep -qx 'S3_ENDPOINT=http://garage-1:3900' "$DIR/settings.env" || { echo 'хранилище среды не garage-1:3900'; exit 1; }
grep -A8 "^$ID.5espace.com {" "$CADDY" | grep -q "^	reverse_proxy 127.0.0.1:$PORT$" ||
  { echo 'вход test-2 в Caddyfile не в ожидаемом виде'; exit 1; }
docker inspect fifth-openbao --format '{{.State.Running}}' | grep -q true || { echo 'OpenBao не работает'; exit 1; }

# Возврат: прежние настройки и вход, службы без TLS. Записи прежним форматом читаются KEK среды.
restore_before() {
  [ -f "$BEFORE/settings.env" ] || return 0
  cp -p "$BEFORE/settings.env" "$DIR/settings.env"
  cp -p "$BEFORE/compose.env" "$DIR/compose.env"
  cp -p "$BEFORE/Caddyfile" "$CADDY" && systemctl reload caddy
  docker rm -f "$PROJECT-agent" "$S3TLS" >/dev/null 2>&1 || true
  node scripts/env.mjs start "$ID" --text | cut -c1-160
}
back() {
  echo "СБОЙ на строке $1: возвращаю прежний режим"
  docker logs --tail 12 "$PROJECT-core" 2>&1 | cut -c1-220 || true
  restore_before || true
  report "ОСТАНОВЛЕНО на строке $1, $ID возвращена в прежний режим"
  rm -rf "$WORK"
  exit 1
}
trap 'back $LINENO' ERR

say 'копия до изменения'
backup
install -d -m 700 "$BEFORE"
cp -p "$DIR/settings.env" "$DIR/compose.env" "$BEFORE/"
cp -p "$CADDY" "$BEFORE/Caddyfile"

say 'переходный комплект среды'
mkdir -p "$KEYS"
FIFTH_TRANSITION_ROOT="$DIR" FIFTH_TRANSITION_ENV=settings.env FIFTH_TRANSITION_SECRETS=secrets \
  FIFTH_OPENBAO_KEYS_DIR="$KEYS" FIFTH_OPENBAO_RECIPIENT="$ROOT/infra/openbao/thomas-recipient.asc" \
  fifth-transition-kit create
laptop kit --data-binary "@$KEYS/transition.gpg" >/dev/null

say 'ключи Transit и секреты среды в OpenBao: импорт с ноутбука'
mkdir "$WORK/agent"
laptop import | tar -x -C "$WORK/agent"
install -d -m 750 -o 1990 -g 1000 "$AGENT_CONF"
for f in agent.hcl role-id secret-id; do
  install -m 440 -o 1990 -g 1000 "$WORK/agent/$f" "$AGENT_CONF/$f"
done
# Токен смены версии ключа нужен только пробе: на сервере не остаётся.
shred -u "$WORK/agent/rotate-token" 2>/dev/null || rm -f "$WORK/agent/rotate-token"
grep -q "kv/data/$ID/core/" "$AGENT_CONF/agent.hcl"
if grep -q 'kv/data/prod/' "$AGENT_CONF/agent.hcl"; then
  echo 'в настройке Agent пути рабочей среды'
  false
fi

say 'сертификаты среды'
install -d -m 700 "$CA"
install -d -m 755 "$TLS"
if [ ! -s "$CA/ca.key" ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out "$CA/ca.key"
  openssl req -x509 -new -key "$CA/ca.key" -sha256 -days 3650 -subj "/CN=5E internal CA $ID" \
    -addext 'basicConstraints=critical,CA:TRUE' -out "$TLS/ca.crt"
  openssl ecparam -name prime256v1 -genkey -noout -out "$TLS/server.key"
  openssl req -new -key "$TLS/server.key" -subj '/CN=internal' -out "$WORK/server.csr"
  printf 'subjectAltName=DNS:postgres,DNS:valkey,DNS:nats,DNS:%s,DNS:localhost,IP:127.0.0.1\n' "$S3TLS" >"$WORK/ext"
  openssl x509 -req -in "$WORK/server.csr" -CA "$TLS/ca.crt" -CAkey "$CA/ca.key" \
    -CAserial "$CA/ca.srl" -CAcreateserial -days 1095 -sha256 -extfile "$WORK/ext" \
    -out "$TLS/server.crt" 2>/dev/null
fi
# Службы читают под своими пользователями; ключ центра остаётся в каталоге root.
chmod 444 "$TLS/ca.crt" "$TLS/server.crt" "$TLS/server.key"

say 'файлы Agent в памяти узла'
cat >/etc/tmpfiles.d/fifth-secrets-$ID.conf <<EOF
d $AGENT_DIR 0750 1990 1000 -
C $AGENT_DIR/openbao-ca.crt 0440 1990 1000 - /etc/fifth-openbao/tls/tls.crt
C $AGENT_DIR/internal-ca.crt 0440 1990 1000 - $TLS/ca.crt
EOF
systemd-tmpfiles --create "/etc/tmpfiles.d/fifth-secrets-$ID.conf"
# Ядро и Agent обращаются к OpenBao по сети среды; подключение переживает перезапуски.
docker inspect fifth-openbao --format '{{json .NetworkSettings.Networks}}' | grep -q "\"$NET\"" ||
  docker network connect "$NET" fifth-openbao

say 'PostgreSQL: TLS'
docker cp "$TLS/server.crt" "$PROJECT-postgres:/var/lib/postgresql/data/server.crt"
docker cp "$TLS/server.key" "$PROJECT-postgres:/var/lib/postgresql/data/server.key"
docker exec -u 0 "$PROJECT-postgres" sh -c \
  'cd /var/lib/postgresql/data && chown postgres server.crt server.key && chmod 600 server.key'
pg 'ALTER SYSTEM SET ssl = on' >/dev/null
pg 'SELECT pg_reload_conf()' >/dev/null
sleep 1
[ "$(pg 'SHOW ssl')" = on ]

say 'настройки: kms и production'
cat >>"$DIR/compose.env" <<EOF
FIFTH_TLS_DIR=$TLS
FIFTH_AGENT_DIR=$AGENT_DIR
FIFTH_OPENBAO_AGENT=$AGENT_CONF
EOF
sed -i -e '/^KEK_[A-Z_]*_FILE=/d' -e 's#^KMS_MODE=.*#KMS_MODE=kms#' \
  -e 's#=/run/secrets/#=/run/fifth-secrets/#' \
  -e '/^NODE_ENV=/d' -e '/^CORE_PUBLIC_URL=/d' -e '/^PUBLIC_BASE_URL=/d' -e '/^CORS_ALLOWED_ORIGINS=/d' \
  -e '/^SESSION_COOKIE_NAME=/d' -e '/^CSRF_COOKIE_NAME=/d' -e '/^REDIS_URL=/d' -e '/^NATS_URL=/d' \
  -e '/^WEBHOOK_DELIVERY_MODE=/d' -e '/^TESTING_SESSIONS_ENABLED=/d' -e '/^S3_ENDPOINT=/d' "$DIR/settings.env"
cat >>"$DIR/settings.env" <<EOF
CRYPTO_WRITE_FORMAT=legacy
OPENBAO_ADDR=https://fifth-openbao:8200
OPENBAO_CA_PATH=/run/fifth-secrets/openbao-ca.crt
OPENBAO_TOKEN_PATH=/run/fifth-secrets/openbao-token
OPENBAO_KEY_PREFIX=$ID
NODE_ENV=production
NODE_EXTRA_CA_CERTS=/run/fifth-secrets/internal-ca.crt
DATABASE_SSL=true
REDIS_URL=rediss://valkey:6379
NATS_URL=tls://nats:4222
S3_ENDPOINT=https://$S3TLS:9443
CORE_PUBLIC_URL=$ORIGIN
PUBLIC_BASE_URL=$ORIGIN
CORS_ALLOWED_ORIGINS=$ORIGIN
SESSION_COOKIE_NAME=__Host-ul_session
CSRF_COOKIE_NAME=__Host-ul_csrf
WEBHOOK_DELIVERY_MODE=live
INTEGRATION_CLIENT_CERT_HEADER=X-Client-Cert-Fingerprint
EOF

say 'Agent среды'
compose() {
  docker compose --env-file "$DIR/compose.env" -f "$DIR/compose.yml" \
    -f infra/docker-compose.env-production.yml "$@"
}
compose up -d --wait agent 2>&1 | tail -1 | cut -c1-120
echo "файлов Agent: $(find "$AGENT_DIR" -type f | wc -l)"
stat -c '%a %U:%G %n' "$AGENT_DIR"

say 'проверка настроек до перезапуска'
core_image="$(sed -n 's/^FIFTH_CORE_IMAGE=//p' "$DIR/compose.env")"
docker run --rm --network none --env-file "$DIR/settings.env" -v "$AGENT_DIR:/run/fifth-secrets:ro" \
  --entrypoint node "$core_image" -e \
  "try{require('/app/apps/core/dist/config/env.js').loadEnv();console.log('настройки production приняты')}
   catch(e){console.log(String(e.message).replace(/\s+/g,' ').slice(0,900))}" 2>&1 |
  tail -3 | cut -c1-900 | tee "$WORK/env-check"
grep -q 'настройки production приняты' "$WORK/env-check"

say 'вход: заголовок сертификата клиента не принимается от посетителя'
# Интеграций по mTLS на test-2 нет: присланный заголовок снимается, подделать отпечаток нельзя.
node -e "
const fs=require('fs');const f='$CADDY';let t=fs.readFileSync(f,'utf8');
const a='\treverse_proxy 127.0.0.1:$PORT\n';
const i=t.indexOf('$ID.5espace.com {');const j=t.indexOf(a,i);
if(i<0||j<0)process.exit(1);
if(t.slice(i,j+a.length+200).includes('X-Client-Cert-Fingerprint'))process.exit(0);
t=t.slice(0,j)+'\treverse_proxy 127.0.0.1:$PORT {\n\t\theader_up -X-Client-Cert-Fingerprint\n\t}\n'+t.slice(j+a.length);
fs.writeFileSync(f,t)"
caddy validate --config "$CADDY" --adapter caddyfile >/dev/null 2>&1
systemctl reload caddy

say 'службы среды'
env_cmd start "$ID"
for _ in $(seq 1 45); do
  [ "$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://127.0.0.1:$PORT/v1/auth/me")" = 401 ] && break
  sleep 2
done

say 'проверка'
docker ps --filter "name=$PROJECT-" --format '{{.Names}} {{.Status}}' | sort
code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://127.0.0.1:$PORT/v1/auth/me")"
echo "вход без сессии: $code"
[ "$code" = 401 ]
if docker exec "$PROJECT-core" sh -c 'ls /run/secrets 2>/dev/null | grep -q .'; then
  echo 'ядру виден каталог с KEK'
  false
fi
echo 'каталог с KEK ядру не виден'
docker exec "$PROJECT-core" printenv NODE_ENV KMS_MODE CRYPTO_WRITE_FORMAT | paste -sd' '
ssl="$(pg "SELECT count(*) FILTER (WHERE s.ssl), count(*) FROM pg_stat_ssl s JOIN pg_stat_activity a USING (pid) WHERE a.usename LIKE 'app_%'")"
echo "соединения ядра с базой по TLS / всего: $ssl"
[ "${ssl%%|*}" -gt 0 ] && [ "${ssl%%|*}" = "${ssl##*|}" ]
docker run --rm --network "$NET" --entrypoint node "$core_image" -e "
const tls=require('tls');
const c=tls.connect({host:'valkey',port:6379,servername:'valkey'},()=>{console.log('плохо: чужой CA принят');process.exit(1)});
c.on('error',(e)=>{console.log('Valkey без нашего центра отвергнут:',e.code);process.exit(0)});"
docker run --rm --network "$NET" --entrypoint node "$core_image" -e "
const c=require('net').connect(6378,'valkey',()=>{console.log('плохо: открытый порт Valkey');process.exit(1)});
c.on('error',()=>{console.log('открытого порта Valkey нет');process.exit(0)});"
# Контакт первой учётки открывается ключом из Transit: прежний формат, новый путь ключа.
row="$(pg "SELECT encode(contact_wrapped_dek, 'hex') || ' ' || encode(email_ciphertext, 'hex') FROM identity.users WHERE email_ciphertext IS NOT NULL AND substring(contact_wrapped_dek from 1 for 6) <> 'vault:'::bytea ORDER BY created_at LIMIT 1")"
printf %s "$row" | docker exec -i "$PROJECT-core" node -e "
require('reflect-metadata');
const {CryptoService}=require('/app/apps/core/dist/crypto/crypto.service.js');
const [d,c]=require('fs').readFileSync(0,'utf8').trim().split(' ');
new CryptoService().openField('passport_sensitive',Buffer.from(d,'hex'),Buffer.from(c,'hex'),'email')
  .then((v)=>console.log('контакт открыт через Transit, длина',v.length),(e)=>{console.log('не открылся:',e.message);process.exit(1)});"
docker exec "$PROJECT-core" node -e "
require('reflect-metadata');
const {S3Service}=require('/app/apps/core/dist/storage/s3.service.js');
new S3Service().headObject('_control/restore-check.bin').then((r)=>{console.log('хранилище через TLS отвечает, контрольный файл',r.exists?'виден':'не виден');process.exit(r.exists||'$REHEARSE'?0:1)},(x)=>{console.log('хранилище:',x.message);process.exit(1)});"

if [ -n "$REHEARSE" ]; then
  say 'репетиция: возврат в прежний режим'
  trap - ERR
  restore_before
  code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://127.0.0.1:$PORT/v1/auth/me")"
  echo "после возврата вход без сессии: $code"
  docker exec "$PROJECT-core" printenv NODE_ENV KMS_MODE | paste -sd' '
  rm -rf "$WORK"
  report 'РЕПЕТИЦИЯ ПРОЙДЕНА'
  echo 'РЕПЕТИЦИЯ ПРОЙДЕНА'
  exit 0
fi
trap - ERR
say 'копия после изменения'
backup
rm -rf "$WORK"
report 'test-2 В БОЕВОМ РЕЖИМЕ'
echo 'test-2 в боевом режиме: kms/legacy, production, TLS'
