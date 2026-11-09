#!/bin/bash
# Факты для плана нагрузки и отказов (блок 6; условия Тэнка 09.11). Только чтение.
# Секреты не выводятся: из настроек сред — только ресурсы, лимиты частоты и пул БД.
#   fifth-test op prod-load-facts
set -u
ROOT=/opt/fifth-element
echo '== VPS'
nproc
free -m | sed -n '1,3p'
swapon --show 2>/dev/null
df -h / /var/lib/docker 2>/dev/null | sort -u
uptime
echo '== контейнеры: CPU, память / лимит'
docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' | sort
echo '== лимиты контейнеров (CPU в нано, память в байтах, перезапуск)'
for c in $(docker ps --format '{{.Names}}' | sort); do
  docker inspect --format '{{.Name}} cpu={{.HostConfig.NanoCpus}} mem={{.HostConfig.Memory}} restart={{.HostConfig.RestartPolicy.Name}}' "$c"
done
echo '== сети контейнеров test-1 и общих служб'
for c in $(docker ps --format '{{.Names}}' | grep -E '^fifth-(test-1-|garage|openbao|nats$|valkey$|postgres$|core$)' | sort); do
  printf '%s ' "$c"
  docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c"
done
echo '== тома test-1'
for c in $(docker ps --format '{{.Names}}' | grep '^fifth-test-1-' | sort); do
  printf '%s ' "$c"
  docker inspect --format '{{range .Mounts}}{{.Type}}:{{.Name}}{{.Source}}->{{.Destination}} {{end}}' "$c" | sed "s#$ROOT#ROOT#g"
done
echo '== настройки test-1 (без секретов)'
for f in "$ROOT/.local/envs/test-1/compose.env" "$ROOT/.local/envs/test-1/core.env"; do
  [ -f "$f" ] && grep -E '^(FIFTH_(MEM|CPU)_[A-Z]+|FIFTH_[A-Z]+_IMAGE|RATE_LIMIT_[A-Z_]+|DATABASE_POOL_[A-Z_]+|NODE_ENV|FIFTH_ENV_MODE)=' "$f" | sed "s#^#$(basename "$f"): #"
done
ls "$ROOT/.local/envs/test-1" 2>/dev/null | tr '\n' ' '; echo
echo '== комплект и ядра test-1'
cat "$ROOT/.local/kits/pins/test-1.json" 2>/dev/null
docker ps --format '{{.Names}} {{.Image}}' | grep -E '^fifth-test-1-core'
echo '== PostgreSQL test-1: соединения'
docker exec fifth-test-1-postgres sh -c 'psql -U "$POSTGRES_USER" -d fifth_element -Atc "SHOW max_connections; SELECT count(*) FROM pg_stat_activity; SELECT count(*) FROM pg_extension WHERE extname = '"'"'pg_stat_statements'"'"';"' 2>&1 | head -4
