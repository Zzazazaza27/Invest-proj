#!/bin/bash
# Среда test-2 на свою сборку и проверка. Данные сохраняются.
set -Eeuo pipefail
cd /opt/fifth-element
node scripts/env.mjs update test-2 --kit "$1" | cut -c1-140
docker inspect fifth-test-2-core fifth-test-2-web fifth-test-2-postgres --format '{{.Name}} {{.Config.Image}}'
docker exec fifth-test-2-core sh -c 'grep -c MAIL_SUBJECT_PREFIX apps/core/dist/comms/mail.transport.js'
curl -s --max-time 15 https://test-2.5espace.com/login/ | grep -o 'details data-env-banner' | head -1
