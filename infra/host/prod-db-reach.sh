#!/bin/bash
# Как узел и ядро достают базу рабочей среды — только чтение, без паролей (2.1.5: выгрузка
# аудита с узла). Печатает схему, хост, порт и параметры адресов, сети и порты контейнера.
#
#   fifth-test op prod-db-reach
set -Eeuo pipefail
shape() { node -e "const u=new URL(require('fs').readFileSync(process.argv[1],'utf8').trim());console.log(u.protocol+'//'+u.username+':***@'+u.host+u.pathname+(u.search||''))" "$1"; }
echo "владелец: $(shape /run/fifth-secrets/DATABASE_URL_OWNER)"
for f in /run/fifth-secrets/DATABASE_URL*; do echo "файл: $(basename "$f")"; done
echo "контейнер базы: $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}' fifth-postgres)"
echo "порты: $(docker port fifth-postgres 2>/dev/null | tr '\n' ' ')"
echo "сеть ядра: $(docker inspect -f '{{.HostConfig.NetworkMode}}' fifth-core)"
docker exec fifth-core sh -c 'env | grep -E "^DATABASE_URL=|^DATABASE_URL_FILE=|^PGSSL" | sed -E "s#(://[^:]+:)[^@]*@#\1***@#"'
ss -ltn | awk 'NR>1{print $4}' | grep -E ':(5432|6432|5433)$' || echo 'на узле порт базы не слушается'
