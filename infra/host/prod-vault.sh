#!/bin/bash
# Запись формата vault и перенос старых записей. С первой записи выпуск 2.1-b104.1 их не прочитает:
# возврат только на выпуск, читающий vault, поэтому точка возврата переносится на него заранее.
set -Eeuo pipefail
BUILD="$1"
ROOT=/opt/fifth-element
cd "$ROOT"
if grep -q '^CRYPTO_WRITE_FORMAT=vault' .env; then
  echo 'запись vault уже включена'
else
  echo '▸ возврат: выпуск, читающий vault'
  [ -f ".local/kits/$BUILD/kit.json" ] || { echo "нет комплекта $BUILD"; exit 1; }
  node scripts/kit.mjs check --build "$BUILD" | cut -c1-120
  node scripts/kit.mjs pin --env prod --rollback "$BUILD" | cut -c1-120
  cp -p .env "$ROOT/.local/env-before-vault"
  sed -i 's/^CRYPTO_WRITE_FORMAT=.*/CRYPTO_WRITE_FORMAT=vault/' .env
  node scripts/infra.mjs compose up -d --force-recreate --no-deps core >/dev/null 2>&1
  for _ in $(seq 1 60); do
    [ "$(docker inspect fifth-core --format '{{.State.Health.Status}}' 2>/dev/null)" = healthy ] && break
    sleep 2
  done
  [ "$(docker inspect fifth-core --format '{{.State.Health.Status}}')" = healthy ]
fi
echo '▸ перенос старых записей'
image="$(docker inspect fifth-core --format '{{.Config.Image}}')"
migrate() {
  docker run --rm --network host -v "$ROOT/scripts:/app/scripts:ro" -v /run/fifth-secrets:/run/fifth-secrets:ro \
    -e "DATABASE_URL_OWNER=$(cat /run/fifth-secrets/DATABASE_URL_OWNER)" -e DATABASE_SSL=true \
    -e NODE_EXTRA_CA_CERTS=/run/fifth-secrets/internal-ca.crt -e OPENBAO_ADDR=https://127.0.0.1:8200 \
    -e OPENBAO_CA_PATH=/run/fifth-secrets/openbao-ca.crt -e OPENBAO_TOKEN_PATH=/run/fifth-secrets/openbao-token \
    -e OPENBAO_KEY_PREFIX=prod --entrypoint node "$image" /app/scripts/crypto-migrate.mjs "$@"
}
migrate run --batch 50
migrate verify
before="$(stat -c %Y /var/lib/fifth-monitor/app-probe.json)"
for _ in $(seq 1 60); do
  [ "$(stat -c %Y /var/lib/fifth-monitor/app-probe.json)" -gt "$before" ] && break
  sleep 2
done
grep -q '"ok": true' /var/lib/fifth-monitor/app-probe.json
echo 'запись vault включена, перенос сверен, контрольный вход прошёл'
