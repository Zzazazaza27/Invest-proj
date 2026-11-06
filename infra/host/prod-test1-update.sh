#!/bin/bash
# test-1 на свой комплект при других образах в .env рабочей среды: повтор проверки, которая зависит
# от различия образов. Пределы ресурсов записаны в файл среды и переживают пересоздание контейнеров.
#   prod-test1-update <сборка>
set -Eeuo pipefail
BUILD="${1:?нужна сборка}"
ROOT=/opt/fifth-element
DIR="$ROOT/.local/envs/test-1"
cd "$ROOT"
for pair in MEM_POSTGRES=768m CPU_POSTGRES=1 MEM_CORE=768m CPU_CORE=1 MEM_VALKEY=128m CPU_VALKEY=0.25 \
  MEM_NATS=128m CPU_NATS=0.25 MEM_WEB=64m CPU_WEB=0.25; do
  grep -q "^FIFTH_${pair%%=*}=" "$DIR/compose.env" || echo "FIFTH_$pair" >>"$DIR/compose.env"
done
echo "рабочая среда: $(sed -n 's/^FIFTH_CORE_IMAGE=//p' .env)"
node scripts/env.mjs images test-1 --text | cut -c1-200
node scripts/env.mjs update test-1 --kit "$BUILD" | cut -c1-160
bad=0
for name in core web postgres; do
  want="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$DIR/install.json')).kit.images.$name)")"
  got="$(docker inspect "fifth-test-1-$name" --format '{{.Image}}')"
  [ "$want" = "$got" ] && echo "совпало $name ${got:7:12}" || { echo "РАСХОЖДЕНИЕ $name"; bad=1; }
done
docker inspect fifth-test-1-core --format 'предел памяти {{.HostConfig.Memory}}, процессор {{.HostConfig.NanoCpus}}'
curl -s -o /dev/null -w 'вход без пароля: %{http_code}\n' --max-time 15 https://test-1.5espace.com/
[ "$bad" = 0 ]
