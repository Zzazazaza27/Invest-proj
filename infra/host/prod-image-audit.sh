#!/bin/bash
# Какие образы фактически у тестовых сред и какие им положены. Только чтение, без значений секретов.
set -uo pipefail
ROOT=/opt/fifth-element
for id in test-1 test-2; do
  DIR="$ROOT/.local/envs/$id"
  echo "== $id"
  node -e "const i=JSON.parse(require('fs').readFileSync('$DIR/install.json'));console.log(JSON.stringify({kit:i.kit,build:i.build,createdAt:i.createdAt,updatedAt:i.updatedAt,history:i.history}))" | cut -c1-600
  grep -E '^FIFTH_(CORE|WEB|POSTGRES)_IMAGE=' "$DIR/compose.env"
  docker ps -a --filter "label=com.docker.compose.project=fifth-$id" \
    --format '{{.Names}}' | while read -r c; do
    docker inspect "$c" --format '{{.Name}} {{.Config.Image}} {{.Image}} создан {{.Created}} запуск {{.State.StartedAt}} {{.State.Status}}' | cut -c1-170
  done
done
echo '== рабочая среда'
grep -E '^FIFTH_(CORE|WEB|POSTGRES)_IMAGE=' "$ROOT/.env"
docker inspect fifth-core --format '{{.Config.Image}} {{.Image}}'
echo '== образы на узле'
docker images --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedAt}}' | grep -E '^fifth/(core|web|postgres)' | cut -c1-140
echo '== комплекты'
for f in "$ROOT"/.local/kits/*/kit.json; do
  node -e "const k=JSON.parse(require('fs').readFileSync('$f'));console.log(k.build||k.label,JSON.stringify(k.images).slice(0,420))"
done
