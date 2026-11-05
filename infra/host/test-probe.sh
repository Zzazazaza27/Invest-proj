#!/bin/bash
# Проба перехода на Transit и возврата на test-1 (блок 5, задание 5). Искусственные ключи среды,
# рабочая среда и её ключи не затрагиваются. Запускается из scripts/test-probe.mjs через туннель:
# ноутбук отдаёт комплект и принимает значения по $PROBE_URL, расшифровка — только на ноутбуке.
set -Eeuo pipefail
export PATH=/usr/local/sbin:$PATH
BUILD="$1"
ROOT=/opt/fifth-element
ID=test-1
DIR="$ROOT/.local/envs/$ID"
PORT=18181
PROJECT="fifth-$ID"
NET="${PROJECT}_default"
KEYS="/var/backups/fifth-element/openbao-keys/$ID"
AGENT="$PROJECT-agent"
VOLUME="$PROJECT-secrets-mem"
WORK="$(mktemp -d)"
USERS="$WORK/users.json"
export PROBE_URL_ENV="http://127.0.0.1:$PORT"
cd "$ROOT"

say() { printf '\n▸ %s\n' "$1"; }
laptop() { curl -fsS -H "Authorization: Bearer $PROBE_TOKEN" "$PROBE_URL/$1" "${@:2}"; }
report() { laptop "report" --data-binary "$1" >/dev/null || true; }
login_check() { PROBE_URL="$PROBE_URL_ENV" node scripts/probe-transit-login.mjs "$@"; }
compose() {
  docker compose --env-file "$DIR/compose.env" -f "$DIR/compose.yml" "$@"
}
ready() {
  for _ in $(seq 1 60); do
    docker exec "$PROJECT-core" node -e \
      "fetch('http://127.0.0.1:4400/ready').then((r)=>process.exit(r.status===200?0:1),()=>process.exit(1))" \
      >/dev/null 2>&1 && return 0
    sleep 2
  done
  echo 'среда не готова'
  docker logs --tail 15 "$PROJECT-core" 2>&1 | cut -c1-200 || true
  return 1
}
cleanup() {
  # Сбой посреди пробы не оставляет среду в режиме kms: повтор начинается с прежнего состояния.
  if [ -f "$WORK/settings.before" ]; then
    cp -p "$WORK/settings.before" "$DIR/settings.env"
    compose up -d --force-recreate --no-deps core >/dev/null 2>&1 || true
  fi
  rm -f "$DIR/compose.agent.yml"
  docker rm -f "$AGENT" >/dev/null 2>&1 || true
  docker network disconnect "$NET" fifth-openbao >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
fail() {
  code=$?
  echo "ПРОБА ОСТАНОВЛЕНА на строке $1, код $code"
  report "ПРОБА ОСТАНОВЛЕНА на строке $1"
  cleanup
  exit "$code"
}
trap 'fail $LINENO' ERR

say 'инструменты'
install -o root -g root -m 755 infra/host/fifth-backup-read infra/host/fifth-diag \
  infra/host/fifth-transition-kit infra/host/fifth-test /usr/local/sbin/
if [ -f "$ROOT/.local/secrets/GARAGE_ADMIN_TOKEN" ]; then
  GARAGE_ADMIN_TOKEN="$(cat "$ROOT/.local/secrets/GARAGE_ADMIN_TOKEN")"
  export GARAGE_ADMIN_TOKEN
fi

say "комплект $BUILD"
if [ ! -f "$ROOT/.local/kits/$BUILD/kit.json" ]; then
  mkdir "$WORK/kit" "$WORK/docker"
  laptop kit.tar | tar -x -C "$WORK/kit"
  export DOCKER_CONFIG="$WORK/docker"
  laptop ghcr-token | docker login ghcr.io -u probe --password-stdin >/dev/null
  node scripts/kit.mjs fetch --build "$BUILD" --dir "$WORK/kit" | cut -c1-160
  unset DOCKER_CONFIG
fi
node scripts/kit.mjs load --build "$BUILD" | cut -c1-160

say 'среда test-1 в прежнем режиме'
if [ -f "$DIR/install.json" ]; then
  node scripts/env.mjs start "$ID" --text | cut -c1-160 || true
  node scripts/env.mjs update "$ID" --kit "$BUILD" --text | cut -c1-160
else
  node scripts/env.mjs create "$ID" --kit "$BUILD" --web-port "$PORT" \
    --address "http://127.0.0.1:$PORT" --text | cut -c1-160
fi
PORT="$(sed -n 's/^FIFTH_WEB_PORT=//p' "$DIR/compose.env")"
PROBE_URL_ENV="http://127.0.0.1:$PORT"
ready
login_check register "$USERS" local-mode

say 'переходный комплект'
mkdir -p "$KEYS"
FIFTH_TRANSITION_ROOT="$DIR" FIFTH_TRANSITION_ENV=settings.env FIFTH_TRANSITION_SECRETS=secrets \
  FIFTH_OPENBAO_KEYS_DIR="$KEYS" FIFTH_OPENBAO_RECIPIENT="$ROOT/infra/openbao/thomas-recipient.asc" \
  fifth-transition-kit create
laptop kit --data-binary "@$KEYS/transition.gpg" >/dev/null

say 'импорт с ноутбука через туннель'
mkdir "$WORK/agent"
laptop import | tar -x -C "$WORK/agent"

say 'Agent'
docker volume create --driver local --opt type=tmpfs --opt device=tmpfs \
  --opt "o=size=8m,mode=0770,uid=1990,gid=1000" "$VOLUME" >/dev/null
docker network connect "$NET" fifth-openbao
chown -R 1990:1000 "$WORK/agent"
chmod 750 "$WORK" "$WORK/agent"
docker run -d --name "$AGENT" --network "$NET" --user 1990:1000 \
  -v "$WORK/agent:/agent:ro" -v /etc/fifth-openbao/tls/tls.crt:/openbao/tls/tls.crt:ro \
  -v "$VOLUME:/run/fifth-secrets" "$(sed -n 's/.*image: \(openbao.*\)$/\1/p' infra/openbao/docker-compose.yml | head -1)" \
  agent -config=/agent/agent.hcl >/dev/null
for _ in $(seq 1 30); do
  docker exec "$AGENT" test -s /run/fifth-secrets/openbao-token \
    -a -s /run/fifth-secrets/POSTGRES_PASSWORD && break
  sleep 1
done
docker exec "$AGENT" test -s /run/fifth-secrets/POSTGRES_PASSWORD

say 'ядро: kms, запись прежним форматом'
cp -p "$DIR/settings.env" "$WORK/settings.before"
sed -i -e '/^KEK_[A-Z_]*_FILE=/d' -e 's#^KMS_MODE=.*#KMS_MODE=kms#' \
  -e 's#=/run/secrets/#=/run/fifth-secrets/#' "$DIR/settings.env"
cat >>"$DIR/settings.env" <<EOF
CRYPTO_WRITE_FORMAT=legacy
OPENBAO_ADDR=https://fifth-openbao:8200
OPENBAO_CA_PATH=/openbao-ca.crt
OPENBAO_TOKEN_PATH=/run/fifth-secrets/openbao-token
OPENBAO_KEY_PREFIX=$ID
EOF
cat >"$DIR/compose.agent.yml" <<EOF
services:
  core:
    volumes:
      - $VOLUME:/run/fifth-secrets:ro
      - /etc/fifth-openbao/tls/tls.crt:/openbao-ca.crt:ro
volumes:
  $VOLUME:
    external: true
EOF
compose -f "$DIR/compose.agent.yml" up -d --force-recreate --no-deps core
ready
login_check login "$USERS"
login_check register "$USERS" kms-mode
counts="$(docker exec -e PGPASSWORD="$(cat "$DIR/secrets/POSTGRES_PASSWORD")" "$PROJECT-postgres"   psql -h 127.0.0.1 -U fifth_owner -d fifth_element -At -c   "SELECT count(*) FILTER (WHERE substring(contact_wrapped_dek from 1 for 6) = 'vault:'::bytea), count(contact_wrapped_dek) FROM identity.users")"
echo "записей vault и всего: $counts"
[ "${counts%%|*}" = 0 ] && [ "${counts##*|}" -ge 2 ]
echo 'записей vault нет: запись прежним форматом'

if [ "$(laptop stage)" = vault ]; then
  # shellcheck source=/dev/null
  . infra/host/test-probe-vault.sh
  say 'уборка'
  trap - ERR
  rm -f "$WORK/settings.before" "$WORK/users.json"
  # Записи уже в формате vault: среда остаётся в kms и останавливается, местным ключам их не прочитать.
  rm -f "$DIR/compose.agent.yml"
  docker rm -f "$AGENT" >/dev/null 2>&1 || true
  compose stop >/dev/null 2>&1 || true
  docker network disconnect "$NET" fifth-openbao >/dev/null 2>&1 || true
  rm -rf "$WORK"
  report 'ПРОБА ПРОЙДЕНА'
  echo 'ПРОБА ПРОЙДЕНА'
  exit 0
fi

say 'отказ службы ключей'
docker stop "$AGENT" >/dev/null
docker network disconnect "$NET" fifth-openbao
login_check down "$USERS"
echo 'без OpenBao вход отказывает отказом зависимости, перехода к местным ключам нет'
docker network connect "$NET" fifth-openbao
docker start "$AGENT" >/dev/null

say 'возврат к местным ключам из комплекта'
laptop restore.tar | FIFTH_TRANSITION_ROOT="$DIR" FIFTH_TRANSITION_ENV=settings.env \
  FIFTH_TRANSITION_SECRETS=secrets fifth-transition-kit restore
rm -f "$WORK/settings.before"
compose up -d --force-recreate --no-deps core
ready
login_check login "$USERS"
echo 'старое ядро читает и запись, сделанную в режиме kms'

say 'уборка'
trap - ERR
cleanup
rm -f "$DIR/compose.agent.yml"
node scripts/env.mjs stop "$ID" --text | cut -c1-120 || true
report 'ПРОБА ПРОЙДЕНА'
echo 'ПРОБА ПРОЙДЕНА'
