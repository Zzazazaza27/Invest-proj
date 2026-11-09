#!/bin/sh
# Файл маршрута nginx по умолчанию (блок 09, задание 3).
#
# В режиме слотов рабочей среды каталог /etc/nginx/fifth-route подключается с узла, и
# route.conf в нём пишет установщик: адрес активного ядра, его служебный порт и каталог
# сборки статики. Без режима слотов (стенд, тестовые среды, рабочая среда до перехода)
# файла нет — пишем прежние значения: ядро ${CORE_HOST}:4300, служебный порт 4400,
# статика из образа или смонтированных каталогов /srv.
#
# Каталог подключён, а файла нет — ошибка: гадать, куда вести запросы, нельзя.
set -eu
DIR=/etc/nginx/fifth-route
FILE="$DIR/route.conf"
[ -f "$FILE" ] && exit 0
mkdir -p "$DIR"
if ! touch "$FILE" 2>/dev/null; then
  echo "fifth-route: $FILE отсутствует, каталог только для чтения — маршрут не задан" >&2
  exit 1
fi
cat > "$FILE" <<EOF
set \$core_api "${CORE_HOST:-host.docker.internal}:4300";
set \$core_internal "${CORE_HOST:-host.docker.internal}:4400";
set \$static_root /srv;
set \$static_prev /srv;
EOF
