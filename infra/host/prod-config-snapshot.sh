#!/bin/bash
# Снимок фактической конфигурации запущенных контейнеров (план выпуска W31–W33, дополнение Тэнка
# 10.11): до первого изменения на сервере зафиксировать, с какими файлами Compose и образами
# поднята каждая среда. Только чтение. Переменные окружения — ТОЛЬКО ИМЕНА, без значений.
#
#   fifth-test op prod-config-snapshot
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
ROOT=/opt/fifth-element

echo "== время $(date -u +%FT%TZ)"
echo "== серверная копия: $(git -c safe.directory=$ROOT -C $ROOT rev-parse --short HEAD)"

echo "== файлы Compose, на которые ссылаются контейнеры (SHA-256, начало)"
docker ps -q | xargs -r docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' \
  | tr ',' '\n' | sed '/^$/d' | sort -u | while read -r f; do
    if [ -f "$f" ]; then printf '  %s %s\n' "$(sha256sum "$f" | cut -c1-16)" "$f"
    else printf '  (нет файла) %s\n' "$f"; fi
  done

echo "== контейнеры"
for id in $(docker ps -q); do
  docker inspect --format '{{.Name}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.config-hash"}}|{{.Config.Image}}|{{.Image}}|{{.State.StartedAt}}|{{.RestartCount}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$id" \
    | awk -F'|' '{ printf "-- %s\n   проект %s; config-hash %.16s; образ %s (%.19s)\n   запущен %s; перезапусков %s\n   файлы %s\n", substr($1,2), $2, $3, $4, $5, $6, $7, $8 }'
  printf '   окружение (имена): '
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$id" | cut -d= -f1 | sed '/^$/d' | sort | tr '\n' ' '
  echo
  printf '   порты: '
  docker inspect --format '{{range $p, $b := .HostConfig.PortBindings}}{{$p}}->{{range $b}}{{.HostIp}}:{{.HostPort}} {{end}}{{end}}' "$id"
  echo
done
