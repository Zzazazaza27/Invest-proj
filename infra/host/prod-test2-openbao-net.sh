#!/bin/bash
# test-2 достаёт OpenBao через его сеть fifth-openbao_default, описанную в
# infra/docker-compose.env-production.yml, а не через ручное `docker network connect` (Тэнк 08.11).
# Пересоздаёт Agent и ядро test-2, снимает ручное подключение и проверяет, что ключи Transit
# доступны. Рабочая среда и сам OpenBao не перезапускаются. Данные test-2 сохраняются.
set -Eeuo pipefail
ROOT=/opt/fifth-element
ID=test-2
PROJECT="fifth-$ID"
DIR="$ROOT/.local/envs/$ID"
cd "$ROOT"
grep -q '^FIFTH_AGENT_DIR=' "$DIR/compose.env" || { echo 'test-2 не в боевом режиме'; exit 1; }
nets() { docker inspect "$1" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'; }
echo "OpenBao в сетях: $(nets fifth-openbao)"
nets fifth-openbao | grep -qw fifth-openbao_default

echo '▸ Agent и ядро входят в сеть OpenBao'
node scripts/env.mjs start "$ID" --text | cut -c1-160
for c in agent core; do echo "$c: $(nets "$PROJECT-$c")"; done
nets "$PROJECT-agent" | grep -qw fifth-openbao_default
nets "$PROJECT-core" | grep -qw fifth-openbao_default

echo '▸ ручное подключение снято'
if nets fifth-openbao | grep -qw "${PROJECT}_default"; then
  docker network disconnect "${PROJECT}_default" fifth-openbao
fi
echo "OpenBao в сетях: $(nets fifth-openbao)"
! nets fifth-openbao | grep -qw "${PROJECT}_default"

echo '▸ ключи Transit доступны ядру'
docker restart "$PROJECT-agent" >/dev/null
for _ in $(seq 1 30); do
  [ "$(docker inspect "$PROJECT-agent" --format '{{.State.Health.Status}}')" = healthy ] && break
  sleep 2
done
docker inspect "$PROJECT-agent" --format 'Agent после перезапуска: {{.State.Health.Status}}'
row="$(docker exec -e PGPASSWORD="$(cat "$DIR/secrets/POSTGRES_PASSWORD")" "$PROJECT-postgres" \
  psql -h 127.0.0.1 -U fifth_owner -d fifth_element -At -c \
  "SELECT encode(contact_wrapped_dek, 'hex') || ' ' || encode(email_ciphertext, 'hex') FROM identity.users WHERE email_ciphertext IS NOT NULL ORDER BY created_at LIMIT 1")"
printf %s "$row" | docker exec -i "$PROJECT-core" node -e "
require('reflect-metadata');
const {CryptoService}=require('/app/apps/core/dist/crypto/crypto.service.js');
const [d,c]=require('fs').readFileSync(0,'utf8').trim().split(' ');
new CryptoService().openField('passport_sensitive',Buffer.from(d,'hex'),Buffer.from(c,'hex'),'email')
  .then(()=>console.log('контакт открыт через Transit'),(e)=>{console.log('не открылся:',e.message);process.exit(1)});"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://$ID.5espace.com/v1/auth/me)"
echo "вход без сессии снаружи: $code"
[ "$code" = 401 ]
echo 'test-2: OpenBao по описанной сети'
