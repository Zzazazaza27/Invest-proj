#!/bin/bash
# Новые токены с kid. Прежние принимаются до конца наибольшего срока жизни сеанса и ещё час.
# Граница возврата для токенов: прежний выпуск токены с kid не поймёт, люди войдут заново.
set -Eeuo pipefail
ROOT=/opt/fifth-element
BEFORE="$ROOT/.local/env-before-signing"
cd "$ROOT"
if grep -q '^CSRF_SIGNING_KEY_ACTIVE=v2' .env; then
  echo 'версии подписей уже включены'
  exit 0
fi
for name in LOCAL_AUTH_SIGNING_KEY CSRF_SIGNING_KEY INTEGRATION_TOKEN_SIGNING_KEY; do
  [ -s "/run/fifth-secrets/${name}_VERSIONS" ] || { echo "нет у Agent: ${name}_VERSIONS"; exit 1; }
done
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
  docker logs --tail 10 fifth-core 2>&1 | cut -c1-220 || true
  cp -p "$BEFORE" .env
  core || true
  healthy && echo 'ядро вернулось'
  exit 1
}
trap 'back $LINENO' ERR
until_date="$(date -u -d '+25 hours' +%FT%TZ)"
for name in LOCAL_AUTH_SIGNING_KEY CSRF_SIGNING_KEY INTEGRATION_TOKEN_SIGNING_KEY; do
  {
    echo "${name}_VERSIONS_FILE=/run/fifth-secrets/${name}_VERSIONS"
    echo "${name}_ACTIVE=v2"
    echo "${name}_LEGACY_UNTIL=$until_date"
  } >>.env
done
core
healthy
before="$(stat -c %Y /var/lib/fifth-monitor/app-probe.json)"
for _ in $(seq 1 60); do
  [ "$(stat -c %Y /var/lib/fifth-monitor/app-probe.json)" -gt "$before" ] && break
  sleep 2
done
[ "$(stat -c %Y /var/lib/fifth-monitor/app-probe.json)" -gt "$before" ]
grep -q '"ok": true' /var/lib/fifth-monitor/app-probe.json
trap - ERR
echo "новые токены с kid, старые принимаются до $until_date"
