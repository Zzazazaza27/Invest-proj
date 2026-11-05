#!/bin/bash
# Ядро рабочей среды целиком на файлах Agent, каталог с KEK ему больше не подключается.
# KEK остаются на диске для возврата, но вне доступа ядра. При сбое .env возвращается сам.
set -Eeuo pipefail
ROOT=/opt/fifth-element
cd "$ROOT"
OLD="$ROOT/.local/secrets"
EMPTY="$ROOT/.local/core-none"
BEFORE="$ROOT/.local/env-before-agent"
grep -q '^KMS_MODE=kms' .env || { echo 'сначала kms'; exit 1; }
if grep -q "^FIFTH_SECRETS_DIR=$EMPTY" .env; then
  echo 'ядро уже на файлах Agent'
  exit 0
fi
# Каждый файл, на который ссылается .env, обязан быть у Agent.
missing=0
while IFS= read -r name; do
  [ -s "/run/fifth-secrets/$name" ] || { echo "нет у Agent: $name"; missing=1; }
done < <(sed -n 's/^\([A-Z0-9_]*\)_FILE=.*/\1/p' .env)
[ "$missing" = 0 ]

install -o root -g root -m 644 infra/host/fifth-secrets.tmpfiles /etc/tmpfiles.d/fifth-secrets.conf
systemd-tmpfiles --create /etc/tmpfiles.d/fifth-secrets.conf
install -d -m 750 -o root -g 1000 "$EMPTY"
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
  core || true
  healthy && echo 'ядро вернулось на прежние файлы'
  exit 1
}
trap 'back $LINENO' ERR
sed -i -e "s#_FILE=$OLD/#_FILE=/run/fifth-secrets/#" -e "s#^FIFTH_SECRETS_DIR=.*#FIFTH_SECRETS_DIR=$EMPTY#" \
  -e 's#^OPENBAO_CA_PATH=.*#OPENBAO_CA_PATH=/run/fifth-secrets/openbao-ca.crt#' .env
core
healthy
if docker exec fifth-core sh -c "ls '$OLD' 2>/dev/null | grep -q ."; then
  echo 'ядру виден прежний каталог'
  false
fi
before="$(stat -c %Y /var/lib/fifth-monitor/app-probe.json)"
for _ in $(seq 1 100); do
  [ "$(stat -c %Y /var/lib/fifth-monitor/app-probe.json)" -gt "$before" ] && break
  sleep 2
done
[ "$(stat -c %Y /var/lib/fifth-monitor/app-probe.json)" -gt "$before" ]
grep -q '"ok": true' /var/lib/fifth-monitor/app-probe.json
trap - ERR
echo 'ядро на файлах Agent, каталог с KEK ему не виден, контрольный вход прошёл'
