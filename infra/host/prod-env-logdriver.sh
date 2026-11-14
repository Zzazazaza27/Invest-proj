#!/bin/bash
# Куда пишут журнал контейнеры тестовой среды (Тэнк 13.11: оба слота ядра — одинаково). Только
# чтение: драйвер журнала каждого контейнера и сколько записей ядра лежит в journald за 10 минут.
#
#   fifth-test op prod-env-logdriver [test-1|test-2]
set -Eeuo pipefail
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV_ID="${1:-test-1}"
[[ "$ENV_ID" =~ ^test-[12]$ ]] || { echo 'среда: test-1 или test-2' >&2; exit 2; }
P="fifth-$ENV_ID"
for c in $(docker ps -a --filter "name=^${P}-" --format '{{.Names}}' | sort); do
  docker inspect "$c" --format '{{.Name}} {{.State.Status}} драйвер={{.HostConfig.LogConfig.Type}} тег={{index .HostConfig.LogConfig.Config "tag"}}' | sed 's#^/##'
done
for c in "$P-core" "$P-core-b"; do
  n=$(journalctl CONTAINER_NAME="$c" --since '-10min' --no-pager -o cat 2>/dev/null | wc -l)
  echo "journald $c за 10 мин: записей $n"
done
