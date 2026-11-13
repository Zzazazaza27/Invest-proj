#!/bin/bash
# Первичный DNS 5espace.com на узле (Knot, scripts/dns-primary.mjs). Решение Томаса 13.11:
# NS домена — ns1/ns2.5espace.com на этом узле. Зоны — infra/dns/zones/*.zone серверной копии.
#
#   fifth-test op prod-dns up       выложить зоны, поднять / перезагрузить Knot, открыть 53 всем
#   fifth-test op prod-dns status   состояние зон в Knot и правила ufw для 53
#
# Передача зоны — только 1984 FreeDNS (как в пилоте 02.11).
set -Eeuo pipefail
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
cd /opt/fifth-element
export DNS_PRIMARY_LISTEN=193.233.217.210
export DNS_TRANSFER_ALLOW=93.95.224.6
case "${1:-}" in
  up)
    node scripts/dns-primary.mjs up
    # Домен отвечает отсюда — запросы со всего мира (UDP и TCP).
    ufw allow 53/udp >/dev/null
    ufw allow 53/tcp >/dev/null
    ufw status | grep -E '^53(/| )' || true
    ;;
  status)
    node scripts/dns-primary.mjs status
    ufw status | grep -E '^53(/| )' || true
    ;;
  *)
    echo 'команды: up, status' >&2
    exit 2
    ;;
esac
