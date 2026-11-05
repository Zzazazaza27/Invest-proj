#!/bin/bash
# Блок 5, задание 3. Запускает Томас: sudo bash infra/host/apply-openbao-auto.sh
# Значения не печатаются. Повторный запуск безопасен.
set -euo pipefail
cd "$(dirname "$0")"
[ "$(id -u)" -eq 0 ] || { echo 'запускать через sudo'; exit 1; }
install -o root -g root -m 755 fifth-backup-read fifth-diag /usr/local/sbin/
bash ../openbao/setup-vps.sh auto
