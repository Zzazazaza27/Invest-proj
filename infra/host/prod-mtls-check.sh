#!/bin/bash
# Положительный mTLS на рабочем домене. Временный клиент: с сертификатом проходит, с теми же
# учётными данными без сертификата и с подложным заголовком отказ. В любом исходе клиент
# приостанавливается, его токены теряют силу, закрытый ключ уничтожается. Значения не печатаются.
set -Eeuo pipefail
TLS=/etc/fifth-tls
BASE=https://5espace.com
WORK="$(mktemp -d -p /dev/shm)"
CLIENT_ID="probe-mtls-$(date +%s)"
url="$(sed -E 's#@[^/]*/#@127.0.0.1:5432/#' /run/fifth-secrets/DATABASE_URL_OWNER)"
sql() { docker exec -i -e URL="$url" fifth-postgres sh -c 'psql "$URL" -v ON_ERROR_STOP=1 -At'; }
suspend() {
  echo "UPDATE integration.service_accounts SET status = 'suspended', token_epoch = token_epoch + 1
    WHERE client_id = '$CLIENT_ID' AND status <> 'suspended'" | sql >/dev/null
}
cleanup() {
  suspend || echo "клиент $CLIENT_ID не приостановлен, сделай это вручную"
  find "$WORK" -type f -exec shred -u {} + 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

openssl ecparam -name prime256v1 -genkey -noout -out "$WORK/client.key"
openssl req -new -key "$WORK/client.key" -subj "/CN=$CLIENT_ID" -out "$WORK/client.csr"
printf 'extendedKeyUsage=clientAuth\n' >"$WORK/ext"
openssl x509 -req -in "$WORK/client.csr" -CA "$TLS/integration-ca.crt" -CAkey "$TLS/integration-ca.key" \
  -CAcreateserial -CAserial "$WORK/serial" -days 1 -sha256 -extfile "$WORK/ext" -out "$WORK/client.crt" 2>/dev/null
fingerprint="$(openssl x509 -in "$WORK/client.crt" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d : | tr 'A-F' 'a-f')"
secret="$(openssl rand -hex 32)"
printf '{"clientId":"%s","clientSecret":"%s"}' "$CLIENT_ID" "$secret" >"$WORK/body"
hash="$(printf %s "$secret" | docker exec -i fifth-core node -e \
  "let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>require('argon2').hash(s).then(console.log))")"
sql >/dev/null <<SQL
INSERT INTO integration.service_accounts
  (id, client_id, name, client_secret_hash, mtls_cert_fingerprint, scopes, status, created_by)
VALUES (public.uuid_generate_v7(), '$CLIENT_ID', '$CLIENT_ID', '$hash', '$fingerprint', ARRAY['webhooks:manage'], 'active',
  (SELECT id FROM identity.users ORDER BY created_at LIMIT 1));
SQL
echo "клиент $CLIENT_ID заведён, срок сертификата сутки"

post() {
  curl -sS --max-time 20 -o "$WORK/answer" -w '%{http_code}' -H 'Content-Type: application/json' \
    --data-binary "@$WORK/body" "$@" "$BASE/v1/integration/token"
}
cert=(--cert "$WORK/client.crt" --key "$WORK/client.key")
none="$(post)"
spoof="$(post -H "X-Client-Cert-Fingerprint: $fingerprint")"
good="$(post "${cert[@]}")"
echo "токен: без сертификата $none, подложный заголовок $spoof, с сертификатом $good"
[ "$none" = 401 ] && [ "$spoof" = 401 ] && [ "$good" = 201 ]
node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1])).accessToken)" \
  "$WORK/answer" >"$WORK/token"
printf 'header "Authorization: Bearer %s"\n' "$(cat "$WORK/token")" >"$WORK/auth"
get() { curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -K "$WORK/auth" "$@" "$BASE/v1/integration/webhooks"; }
before="$(get "${cert[@]}")"
echo "запрос с токеном: $before"
[ "$before" = 200 ]

suspend
sleep 7
after="$(get "${cert[@]}")"
again="$(post "${cert[@]}")"
echo "после приостановки: токен $after, новая выдача $again"
[ "$after" = 401 ] && [ "$again" = 401 ]
left="$(echo "SELECT status FROM integration.service_accounts WHERE client_id = '$CLIENT_ID'" | sql)"
echo "клиент: $left"
echo 'mTLS на рабочем домене подтверждён'
