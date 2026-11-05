#!/bin/bash
# Соединить узлы Garage и включить то же самое при каждой загрузке.
set -Eeuo pipefail
cd /opt/fifth-element
install -o root -g root -m 644 infra/systemd/fifth-garage-connect.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable fifth-garage-connect.service >/dev/null 2>&1
node scripts/garage-init.mjs 2>&1 | tail -4 | cut -c1-140
sleep 5
curl -s --max-time 5 -o /dev/null -w 'хранилище: %{http_code}\n' http://127.0.0.1:3903/health
