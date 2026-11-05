# Вторая часть пробы test-1: подключается из test-probe.sh, когда ядро уже в kms/legacy.
# Формат vault, перенос, смена версии, версии подписей и восстановление на отдельной копии.
# Искусственные ключи среды. Рабочая среда не меняется, снимок OpenBao только читается.

in_core_image() {
  docker run --rm --network "$NET" \
    -v "$ROOT/scripts:/app/scripts:ro" -v "$VOLUME:/run/fifth-secrets:ro" \
    -v /etc/fifth-openbao/tls/tls.crt:/openbao-ca.crt:ro -v "$WORK/agent:/agent:ro" \
    -e "DATABASE_URL_OWNER=postgres://fifth_owner:$(cat "$DIR/secrets/POSTGRES_PASSWORD")@postgres:5432/fifth_element" \
    -e OPENBAO_ADDR=https://fifth-openbao:8200 -e OPENBAO_CA_PATH=/openbao-ca.crt \
    -e "OPENBAO_TOKEN_PATH=${1}" -e "OPENBAO_KEY_PREFIX=$ID" \
    "fifth/core:$BUILD" node "${@:2}"
}
migrate() { in_core_image /run/fifth-secrets/openbao-token "/app/scripts/crypto-migrate.mjs" "$@"; }
rotate() {
  in_core_image /agent/rotate-token /app/scripts/rotate-kek.mjs --transit \
    --domain passport_sensitive "$@"
}
sql() {
  docker exec -e PGPASSWORD="$(cat "$DIR/secrets/POSTGRES_PASSWORD")" "$1" \
    psql -h 127.0.0.1 -U fifth_owner -d fifth_element -At -c "$2"
}
recreate() {
  compose -f "$DIR/compose.agent.yml" up -d --force-recreate --no-deps core >/dev/null 2>&1
  ready
}

say 'запись в формате vault'
sed -i 's/^CRYPTO_WRITE_FORMAT=.*/CRYPTO_WRITE_FORMAT=vault/' "$DIR/settings.env"
recreate
login_check login "$USERS"
login_check register "$USERS" vault-mode
sql "$PROJECT-postgres" "SELECT count(*) FILTER (WHERE substring(contact_wrapped_dek from 1 for 6) = 'vault:'::bytea), count(contact_wrapped_dek) FROM identity.users"

old_row="$(sql "$PROJECT-postgres" "SELECT encode(contact_wrapped_dek, 'hex') || ' ' || encode(email_ciphertext, 'hex') FROM identity.users WHERE email_ciphertext IS NOT NULL AND substring(contact_wrapped_dek from 1 for 6) <> 'vault:'::bytea LIMIT 1")"
[ -n "$old_row" ]

say 'возврат после первой записи vault: выпуск, читающий оба формата'
sed -i 's/^CRYPTO_WRITE_FORMAT=.*/CRYPTO_WRITE_FORMAT=legacy/' "$DIR/settings.env"
recreate
login_check login "$USERS"
login_check register "$USERS" back-to-legacy
sed -i 's/^CRYPTO_WRITE_FORMAT=.*/CRYPTO_WRITE_FORMAT=vault/' "$DIR/settings.env"
recreate

say 'перенос старых записей'
if migrate verify >/dev/null 2>&1; then
  echo 'сверка до переноса прошла: это ложный успех'
  false
fi
migrate run --batch 2
migrate verify
login_check login "$USERS"

say 'смена версии ключа'
rotate --rotate
if rotate >/dev/null 2>&1; then
  echo 'осмотр после смены не видит отставших: это ложный успех'
  false
fi
login_check login "$USERS"
rotate --rewrap
login_check login "$USERS"
login_check register "$USERS" after-rotate

say 'версии подписей'
until_date="$(date -u -d '+1 day' +%FT%TZ)"
for name in LOCAL_AUTH_SIGNING_KEY CSRF_SIGNING_KEY INTEGRATION_TOKEN_SIGNING_KEY; do
  {
    echo "${name}_VERSIONS=v2:$(openssl rand -hex 48)"
    echo "${name}_ACTIVE=v2"
    echo "${name}_LEGACY_UNTIL=$until_date"
  } >>"$DIR/settings.env"
done
recreate
PROBE_EXPECT_KID=v2 login_check login "$USERS"

say 'отдельная копия: снимок OpenBao и база'
COPY=fifth-openbao-copy
COPY_PG=fifth-test-1-copy-postgres
COPY_DATA=fifth-openbao-copy-data
copy_cleanup() {
  docker rm -f "$COPY" "$COPY_PG" >/dev/null 2>&1 || true
  docker volume rm -f "$COPY_DATA" >/dev/null 2>&1 || true
}
trap 'copy_cleanup' RETURN
copy_cleanup
api() { curl -sk -H "X-Vault-Token: ${2:-}" "https://127.0.0.1:8200/v1/$1"; }
role="$(cat /etc/fifth-openbao/approle/prod-backup/role-id)"
secret="$(cat /etc/fifth-openbao/approle/prod-backup/secret-id)"
token="$(curl -sk -d "{\"role_id\":\"$role\",\"secret_id\":\"$secret\"}" \
  https://127.0.0.1:8200/v1/auth/approle/login | jq -r .auth.client_token)"
curl -skf -H "X-Vault-Token: $token" -o "$WORK/openbao.snap" \
  https://127.0.0.1:8200/v1/sys/storage/raft/snapshot
curl -sk -X POST -H "X-Vault-Token: $token" https://127.0.0.1:8200/v1/auth/token/revoke-self >/dev/null
echo "снимок снят: $(stat -c %s "$WORK/openbao.snap") байт"

docker run --rm -v "$COPY_DATA:/d" --user 0 --entrypoint chown \
  "$(sed -n 's/.*image: \(openbao.*\)$/\1/p' infra/openbao/docker-compose.yml | head -1)" -R 1990:1990 /d
docker run -d --name "$COPY" --user 1990:1990 -p 127.0.0.1:18300:8200 \
  -v "$ROOT/infra/openbao/openbao.hcl:/openbao/config/openbao.hcl:ro" \
  -v /etc/fifth-openbao/seal:/openbao/seal:ro -v /etc/fifth-openbao/tls:/openbao/tls:ro \
  -v "$COPY_DATA:/openbao/data" --tmpfs /openbao/audit:uid=1990,gid=1990 \
  "$(sed -n 's/.*image: \(openbao.*\)$/\1/p' infra/openbao/docker-compose.yml | head -1)" \
  server -config=/openbao/config/openbao.hcl >/dev/null
copy_api() { curl -sk "https://127.0.0.1:18300/v1/$1" "${@:2}"; }
for _ in $(seq 1 40); do
  [ "$(copy_api sys/health -o /dev/null -w '%{http_code}')" != 000 ] && break
  sleep 1
done
root="$(copy_api sys/init -X PUT -d '{"recovery_shares":1,"recovery_threshold":1}' | jq -r .root_token)"
for _ in $(seq 1 40); do
  [ "$(copy_api sys/health -o /dev/null -w '%{http_code}')" = 200 ] && break
  sleep 1
done
copy_api sys/storage/raft/snapshot-force -f -H "X-Vault-Token: $root" \
  --data-binary "@$WORK/openbao.snap" -o /dev/null -X POST
shred -u "$WORK/openbao.snap"
for _ in $(seq 1 60); do
  [ "$(copy_api sys/health -o /dev/null -w '%{http_code}')" = 200 ] && break
  sleep 1
done
[ "$(copy_api sys/health -o /dev/null -w '%{http_code}')" = 200 ]
echo 'копия OpenBao восстановлена и открылась сама'

docker run -d --name "$COPY_PG" --network none -e POSTGRES_PASSWORD=copy \
  --entrypoint docker-entrypoint.sh "fifth/postgres:$BUILD" postgres >/dev/null
for _ in $(seq 1 40); do
  docker exec "$COPY_PG" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
sleep 2
docker exec -e PGPASSWORD="$(cat "$DIR/secrets/POSTGRES_PASSWORD")" "$PROJECT-postgres" \
  psql -h 127.0.0.1 -U fifth_owner -d fifth_element -At -F, -c \
  "COPY (SELECT id, contact_wrapped_dek, email_ciphertext FROM identity.users WHERE email_ciphertext IS NOT NULL) TO STDOUT" |
  docker exec -i "$COPY_PG" sh -c \
    "psql -q -U postgres -c 'CREATE TABLE u (id uuid, dek bytea, email bytea)' && psql -q -U postgres -c 'COPY u FROM STDIN'"
row="$(docker exec "$COPY_PG" psql -U postgres -At -c \
  "SELECT encode(dek, 'hex') || ' ' || encode(email, 'hex') FROM u WHERE substring(dek from 1 for 6) = 'vault:'::bytea ORDER BY id DESC LIMIT 1")"
[ -n "$row" ]
hashes="$(node -e "const c=require('crypto');console.log(JSON.parse(require('fs').readFileSync(process.argv[1])).map((u)=>c.createHash('sha256').update(u.email).digest('hex')).join(','))" "$USERS")"
printf '%s\n%s\nhashes %s\n' "$row" "$old_row" "$hashes" >"$WORK/copy.rows"
laptop copy-check --data-binary "@$WORK/copy.rows" | tee "$WORK/copy.txt"
grep -q 'копия прочитана' "$WORK/copy.txt"
copy_cleanup
