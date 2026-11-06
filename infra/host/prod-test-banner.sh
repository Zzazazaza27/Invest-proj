#!/bin/bash
# Плашка test-1 без пересборки образа: тот же скрипт в работающем контейнере. Настоящая правка
# приходит следующим комплектом, до него плашка держится до пересоздания контейнера.
set -Eeuo pipefail
cd /opt/fifth-element
docker cp infra/images/web-banner.sh fifth-test-1-web:/tmp/web-banner.sh
docker exec -u 0 fifth-test-1-web sh -c 'sh /tmp/web-banner.sh && nginx -t 2>&1 | tail -1 && nginx -s reload'
