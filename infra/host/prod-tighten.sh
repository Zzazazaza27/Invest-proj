#!/bin/bash
# Замечания Тэнка: службам только нужные сертификаты, Valkey без обычного порта, наблюдение по TLS,
# PostgreSQL принимает сетевые подключения только по TLS. При сбое настройки возвращаются сами.
set -Eeuo pipefail
ROOT=/opt/fifth-element
TLS=/etc/fifth-tls
SERVICES="$TLS/services"
BEFORE="$ROOT/.local/env-before-tighten"
cd "$ROOT"
if grep -q "^FIFTH_TLS_DIR=$SERVICES" .env; then
  echo 'уже применено'
  exit 0
fi
cp -p .env "$BEFORE"
stack() { node scripts/infra.mjs compose --profile monitoring --profile monitoring-host "$@"; }
healthy() {
  for _ in $(seq 1 90); do
    [ "$(docker inspect "$1" --format '{{.State.Health.Status}}' 2>/dev/null)" = healthy ] && return 0
    sleep 2
  done
  return 1
}
url="$(sed -E 's#@[^/]*/#@127.0.0.1:5432/#' /run/fifth-secrets/DATABASE_URL_OWNER)"
hba_open() {
  docker exec -u 0 fifth-postgres sh -c "sed -i 's/^hostssl all all all /host all all all /' /var/lib/postgresql/data/pg_hba.conf"
  docker exec -e URL="$url" fifth-postgres sh -c 'psql "$URL" -At -c "SELECT pg_reload_conf()"' >/dev/null
}
back() {
  echo "сбой на строке $1: возвращаю прежние настройки"
  hba_open || true
  cp -p "$BEFORE" .env
  stack up -d --force-recreate --no-deps valkey nats zabbix-agent2-host zabbix-server-host zabbix-web core >/dev/null 2>&1 || true
  healthy fifth-core && echo 'рабочая среда вернулась'
  exit 1
}
trap 'back $LINENO' ERR

echo '▸ сертификаты служб отдельно от ключей центров'
install -d -m 755 "$SERVICES"
install -o root -g root -m 644 "$TLS/ca.crt" "$TLS/server.crt" "$SERVICES/"
install -o root -g 999 -m 640 "$TLS/server.key" "$SERVICES/server.key"

sed -i -e "s#^FIFTH_TLS_DIR=.*#FIFTH_TLS_DIR=$SERVICES#" -e '/^MONITOR_REDIS_URI=/d' .env

echo '▸ Valkey, NATS и наблюдение'
stack up -d --force-recreate --no-deps valkey nats >/dev/null 2>&1
healthy fifth-valkey
healthy fifth-nats
stack up -d --force-recreate --no-deps core zabbix-agent2-host zabbix-server-host zabbix-web >/dev/null 2>&1
healthy fifth-core
node scripts/monitoring.mjs configure | tail -1 | cut -c1-120

echo '▸ наблюдение видит службы по TLS'
sleep 150
node scripts/monitoring.mjs status --items | grep -E 'Valkey: отвечает|PostgreSQL: отвечает|открытых проблем' | cut -c1-120

echo '▸ PostgreSQL: сеть только по TLS'
docker exec -u 0 fifth-postgres sh -c "sed -i 's/^host all all all /hostssl all all all /' /var/lib/postgresql/data/pg_hba.conf"
docker exec -e URL="$url" fifth-postgres sh -c 'psql "$URL" -At -c "SELECT pg_reload_conf()"' >/dev/null
docker exec fifth-postgres sh -c "grep -cE '^hostssl all all all ' /var/lib/postgresql/data/pg_hba.conf"
if docker run --rm --network host -e PGPASSWORD=x -e PGSSLMODE=disable fifth/postgres:16 \
  psql -h 127.0.0.1 -p 5433 -U unicorn_owner -d postgres -c 'select 1' 2>&1 | grep -q 'no pg_hba.conf entry'; then
  echo 'без TLS сервер отказывает'
else
  echo 'подключение без TLS не отвергнуто'
  false
fi
sleep 70
grep -q '"ok": true' /var/lib/fifth-monitor/app-probe.json
node scripts/monitoring.mjs status --items | grep -E 'PostgreSQL: отвечает|открытых проблем' | cut -c1-120
trap - ERR
echo 'применено'
