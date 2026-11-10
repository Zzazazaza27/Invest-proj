# Часть боевой пробы test-1: mTLS Integration API через прокси и доставка вебхука наружу.
# Подключается из test-probe-production.sh. Рабочий сайт не затрагивается: на время проверки в блок
# test-1 общего Caddy добавляется один путь приёмника, затем файл возвращается как был.

M="$WORK/mtls"
mkdir -p "$M"
SUFFIX="$(date +%s)"
CLIENT_ID="probe-$SUFFIX"
CLIENT_SECRET="$(openssl rand -hex 32)"
CADDY_BACKUP="$WORK/Caddyfile.before"
MTLS="$PROJECT-mtls"
RECEIVER_PID=''

integration_cleanup() {
  docker rm -f "$MTLS" >/dev/null 2>&1 || true
  [ -z "$RECEIVER_PID" ] || kill "$RECEIVER_PID" 2>/dev/null || true
  if [ -f "$CADDY_BACKUP" ]; then
    cp -p "$CADDY_BACKUP" /etc/caddy/Caddyfile
    rm -f "$CADDY_BACKUP"
    systemctl reload caddy
  fi
}
trap 'integration_cleanup; fail $LINENO' ERR

say 'mTLS: сертификаты и служебная учётка'
openssl ecparam -name prime256v1 -genkey -noout -out "$M/client-ca.key"
openssl req -x509 -new -key "$M/client-ca.key" -sha256 -days 2 -subj '/CN=5E probe client CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -out "$M/client-ca.crt"
openssl ecparam -name prime256v1 -genkey -noout -out "$M/client.key"
openssl req -new -key "$M/client.key" -subj '/CN=probe' -out "$M/client.csr"
printf 'extendedKeyUsage=clientAuth\n' >"$M/ext"
openssl x509 -req -in "$M/client.csr" -CA "$M/client-ca.crt" -CAkey "$M/client-ca.key" -CAcreateserial \
  -days 2 -sha256 -extfile "$M/ext" -out "$M/client.crt" 2>/dev/null
fingerprint="$(openssl x509 -in "$M/client.crt" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d : | tr 'A-F' 'a-f')"
hash="$(docker exec "$PROJECT-core" node -e "require('argon2').hash(process.argv[1]).then(console.log)" "$CLIENT_SECRET")"
admin="$(pg 'SELECT id FROM identity.users ORDER BY created_at LIMIT 1')"
pg "INSERT INTO integration.service_accounts (id, client_id, name, client_secret_hash, mtls_cert_fingerprint, scopes, status, created_by) VALUES (public.uuid_generate_v7(), '$CLIENT_ID', '$CLIENT_ID', '$hash', '$fingerprint', ARRAY['webhooks:manage'], 'active', '$admin')" >/dev/null

say 'mTLS: прокси'
cp "$TLS/server.crt" "$TLS/server.key" "$M/"
cat >"$M/Caddyfile" <<EOF
{
	auto_https off
	admin off
}
https://:18443 {
	tls /t/server.crt /t/server.key {
		client_auth {
			mode verify_if_given
			trust_pool file {
				pem_file /t/client-ca.crt
			}
		}
	}
	reverse_proxy web:80 {
		header_up X-Client-Cert-Fingerprint {http.request.tls.client.fingerprint}
		header_up X-Real-IP {remote_host}
		header_up X-Forwarded-Proto {scheme}
	}
}
EOF
chmod -R a+rX "$M"
docker run -d --name "$MTLS" --network "$NET" -p 127.0.0.1:18443:18443 -v "$M:/t:ro" \
  caddy:2.10.2 caddy run --config /t/Caddyfile --adapter caddyfile >/dev/null
sleep 3
body="{\"clientId\":\"$CLIENT_ID\",\"clientSecret\":\"$CLIENT_SECRET\"}"
token_url=https://localhost:18443/v1/integration/token
post() { curl -sk -o "$M/answer" -w '%{http_code}' -H 'Content-Type: application/json' -d "$body" "$@" "$token_url"; }
none="$(post)"
spoof="$(post -H "X-Client-Cert-Fingerprint: $fingerprint")"
good="$(post --cert "$M/client.crt" --key "$M/client.key")"
echo "без сертификата: $none, с подложным заголовком: $spoof, с сертификатом: $good"
if [ "$none" != 401 ] || [ "$spoof" != 401 ] || [ "$good" != 201 ]; then
  echo 'mTLS работает неверно'
  cut -c1-200 "$M/answer"
  echo
  docker logs --tail 8 "$MTLS" 2>&1 | cut -c1-260
  docker logs --tail 30 "$PROJECT-core" 2>&1 | grep -E 'integration|stage|unauth' | tail -5 | cut -c1-300 || true
  docker run --rm --network "$NET" --entrypoint node "fifth/core:$BUILD" -e "fetch('http://web/v1/integration/token',{method:'POST',headers:{'content-type':'application/json','x-client-cert-fingerprint':process.argv[1]},body:process.argv[2]}).then(async(r)=>console.log('напрямую в статику:',r.status,(await r.text()).slice(0,120)))" "$fingerprint" "$body"
  false
fi
access="$(jq -r .accessToken "$M/answer")"

say 'вебхук на подконтрольный адрес'
cp -p /etc/caddy/Caddyfile "$CADDY_BACKUP"
node -e "
const fs=require('fs');const f='/etc/caddy/Caddyfile';let t=fs.readFileSync(f,'utf8');
const m=t.match(/test-1\.5espace\.com \{[\s\S]*?\n\}\n/);
if(!m)process.exit(1);
const inner=m[0].replace(/^test-1\.5espace\.com \{\n/,'').replace(/\}\n$/,'');
const auth=inner.match(/\tbasic_auth \{[\s\S]*?\n\t\}\n/)[0];
const rest=inner.replace(auth,'');
const proxy=rest.match(/\treverse_proxy .*\n/)[0];
const head=rest.replace(proxy,'');
fs.writeFileSync(f,t.replace(m[0],()=>'test-1.5espace.com {\n'+head+'\thandle /hook-probe/* {\n\t\treverse_proxy 127.0.0.1:18444\n\t}\n\thandle {\n'+auth.replace(/^/gm,'\t').trimEnd()+'\n\t'+proxy+'\t}\n}\n'));"
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
systemctl reload caddy
node -e "
const fs=require('fs');require('http').createServer((q,s)=>{let b='';q.on('data',(c)=>b+=c);q.on('end',()=>{fs.writeFileSync(process.argv[1],JSON.stringify({headers:q.headers,body:b}));s.writeHead(200);s.end('ok')})}).listen(18444,'127.0.0.1')" "$M/hook.json" &
RECEIVER_PID=$!
sleep 1
# Подписаться через API сейчас нельзя ни на одно событие: выдача скоупов закрыта намеренно. Адрес
# заводится напрямую, секрет шифруется настоящим сервисом, остальное — обычная доставка ядром.
VERB="$(pg 'SELECT verb FROM audit.event_type_registry ORDER BY verb LIMIT 1')"
hook_secret="$(openssl rand -hex 32)"
sealed="$(docker exec "$PROJECT-core" node -e "require('reflect-metadata');const {CryptoService}=require('/app/apps/core/dist/crypto/crypto.service.js');new CryptoService().sealDirect('webhook_secrets',process.argv[1],'webhook:signing').then((b)=>console.log(b.toString('hex')))" "$hook_secret" | tail -1)"
[ -n "$sealed" ]
account="$(pg "SELECT id FROM integration.service_accounts WHERE client_id = '$CLIENT_ID'")"
endpoint="$(pg "INSERT INTO integration.webhook_endpoints (id, service_account_id, url, subscribed_verbs, secret_ciphertext, secret_kms_key_id, secret_fingerprint, status) VALUES (public.uuid_generate_v7(), '$account', 'https://$ID.5espace.com/hook-probe/$SUFFIX', ARRAY['$VERB'], decode('$sealed', 'hex'), 'probe', sha256('$hook_secret'::bytea), 'active') RETURNING id" | head -1)"
[ -n "$endpoint" ]
# Событие — только носитель доставки вебхука: сразу отмечено опубликованным и разосланным,
# иначе издатель тоже берёт его и шлёт в NATS (прежде — по теме `unicorn.*` вне потока:
# 10 попыток и исчерпание, W32 10.11). Тема — как у ядра (`enqueue`: тема = тип события).
outbox="$(pg "INSERT INTO audit.outbox_events (id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_jsonb, nats_subject, schema_version, message_key, published_at, fanout_completed_at) VALUES (public.uuid_generate_v7(), 'project', public.uuid_generate_v7(), 1, '$VERB', '{\"check\":\"probe\"}'::jsonb, '$VERB', 1, 'probe-$SUFFIX', now(), now()) RETURNING id" | head -1)"
pg "INSERT INTO integration.webhook_deliveries (id, endpoint_id, event_id, status) VALUES (public.uuid_generate_v7(), '$endpoint', '$outbox', 'queued')" >/dev/null
for _ in $(seq 1 45); do
  [ -s "$M/hook.json" ] && break
  sleep 2
done
if [ ! -s "$M/hook.json" ]; then
  pg "SELECT status, attempts, response_code FROM integration.webhook_deliveries WHERE endpoint_id = '$endpoint'"
  echo 'вебхук не дошёл'
  false
fi
jq -e '.headers["fifth-signature"] and .headers["fifth-event-id"]' "$M/hook.json" >/dev/null
echo 'вебхук доставлен с подписью'
integration_cleanup
trap 'fail $LINENO' ERR
