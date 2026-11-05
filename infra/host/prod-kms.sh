#!/bin/bash
# Ядро рабочей среды в kms/legacy. Запись прежним форматом, поэтому шаг обратим: при сбое .env
# возвращается и ядро пересоздаётся. KEK на диске этим шагом не удаляются.
set -Eeuo pipefail
ROOT=/opt/fifth-element
cd "$ROOT"
[ -s /run/fifth-secrets/openbao-token ] || { echo 'нет токена Agent'; exit 1; }
BEFORE="$ROOT/.local/env-before-kms"
[ -e "$BEFORE" ] && grep -q '^KMS_MODE=kms' .env && { echo 'ядро уже в kms'; exit 0; }
cp -p .env "$BEFORE"
core() { node scripts/infra.mjs compose up -d --force-recreate --no-deps core >/dev/null 2>&1; }
healthy() {
  for _ in $(seq 1 60); do
    [ "$(docker inspect fifth-core --format '{{.State.Health.Status}}' 2>/dev/null)" = healthy ] && return 0
    sleep 2
  done
  return 1
}
back() {
  echo "сбой на строке $1: возвращаю прежний .env"
  docker logs --tail 12 fifth-core 2>&1 | cut -c1-220 || true
  cp -p "$BEFORE" .env
  rm -f "$BEFORE"
  core || true
  healthy && echo 'ядро вернулось на местные ключи'
  exit 1
}
trap 'back $LINENO' ERR
sed -i -e '/^KEK_[A-Z_]*_FILE=/d' -e 's/^KMS_MODE=.*/KMS_MODE=kms/' .env
cat >>.env <<EOF
CRYPTO_WRITE_FORMAT=legacy
OPENBAO_ADDR=https://127.0.0.1:8200
OPENBAO_CA_PATH=$ROOT/.local/secrets/openbao-ca.crt
OPENBAO_TOKEN_PATH=/run/fifth-secrets/openbao-token
OPENBAO_KEY_PREFIX=prod
EOF
core
healthy
before="$(stat -c %Y /var/lib/fifth-monitor/app-probe.json)"
for _ in $(seq 1 100); do
  [ "$(stat -c %Y /var/lib/fifth-monitor/app-probe.json)" -gt "$before" ] && break
  sleep 2
done
[ "$(stat -c %Y /var/lib/fifth-monitor/app-probe.json)" -gt "$before" ]
grep -q '"ok": true' /var/lib/fifth-monitor/app-probe.json
trap - ERR
echo 'ядро в kms/legacy, контрольный вход и чтение прошли'
