#!/bin/bash
# Служба «место на диске» (работа № 4 раздела 01, M181) на узле: таймер раз в минуту, отчёт
# всем средам узла (prod и .local/envs/*), тревоги Zabbix. Ставится в общей приёмке, по слову
# Томаса — затрагивает prod: при ≥ 85 % «Файлы» уходят в «только чтение».
#
#   fifth-test op prod-disk-guard-setup          установить и включить
#   fifth-test op prod-disk-guard-setup status   последний отчёт службы
#   fifth-test op prod-disk-guard-setup off      выключить таймер (ограничение, если стоит,
#                                                остаётся до следующего отчёта)
set -Eeuo pipefail
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ROOT=/opt/fifth-element
cd "$ROOT"
STATE="$(sed -n 's/^MONITOR_STATE_DIR=//p' .env | head -1)"
case "${1:-on}" in
  on)
    cp infra/systemd/fifth-disk-guard.service infra/systemd/fifth-disk-guard.timer /etc/systemd/system/
    systemctl daemon-reload
    systemctl start fifth-disk-guard.service
    systemctl enable --now fifth-disk-guard.timer >/dev/null 2>&1
    node scripts/monitoring.mjs configure | tail -3
    cat "${STATE:-/var/lib/fifth-monitor}/disk-guard.json"; echo
    ;;
  status)
    systemctl is-active fifth-disk-guard.timer || true
    cat "${STATE:-/var/lib/fifth-monitor}/disk-guard.json"; echo
    ;;
  off)
    systemctl disable --now fifth-disk-guard.timer >/dev/null 2>&1 || true
    echo 'служба места на диске выключена'
    ;;
  *) echo 'команды: on, status, off' >&2; exit 2 ;;
esac
