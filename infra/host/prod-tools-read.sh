#!/bin/bash
# Обновляет только чтение копий: fifth-backup-read с отметкой о выносе пилотной копии.
set -Eeuo pipefail
install -o root -g root -m 755 /opt/fifth-element/infra/host/fifth-backup-read /usr/local/sbin/
install -d -m 755 /var/lib/fifth-monitor
echo 'fifth-backup-read обновлён'
