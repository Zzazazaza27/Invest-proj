#!/bin/bash
# Права maus на работы с test-1 (решение Томаса 05.11). Запускает Томас один раз:
#   sudo bash infra/host/apply-test-access.sh
# Убрать: sudo rm /etc/sudoers.d/91-maus-test
set -euo pipefail
cd "$(dirname "$0")"
[ "$(id -u)" -eq 0 ] || { echo 'запускать через sudo'; exit 1; }
install -o root -g root -m 755 fifth-test fifth-backup-read fifth-diag fifth-transition-kit /usr/local/sbin/
rule="$(mktemp)"
echo 'maus ALL=(root) NOPASSWD: /usr/local/sbin/fifth-test' >"$rule"
visudo -cf "$rule" >/dev/null
install -o root -g root -m 440 "$rule" /etc/sudoers.d/91-maus-test
rm -f "$rule"
echo 'готово: maus может вести test-1'
