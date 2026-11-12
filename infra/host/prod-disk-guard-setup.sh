#!/bin/bash
# Служба «место на диске» (работа № 4 раздела 01, M181) на узле: таймер раз в минуту, отчёт
# базам сред узла, тревоги Zabbix. Ставится по слову Томаса.
#
#   fifth-test op prod-disk-guard-setup on test-1   ТОЛЬКО указанные среды (общая приёмка до
#                                                   выпуска prod: у prod ещё нет M181); Zabbix
#                                                   не перенастраивается — это вместе с выпуском
#   fifth-test op prod-disk-guard-setup on          все среды узла, включая prod, и настройка
#                                                   Zabbix — вместе с выпуском prod (M181)
#   fifth-test op prod-disk-guard-setup status      цели и последний отчёт службы
#   fifth-test op prod-disk-guard-setup off         выключить таймер (ограничение, если стоит,
#                                                   остаётся до следующего отчёта)
#
# Запуск без M181 у какой-либо цели — отказ первого отчёта: таймер выключается, ничего не
# остаётся включённым.
set -Eeuo pipefail
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ROOT=/opt/fifth-element
cd "$ROOT"
STATE="$(sed -n 's/^MONITOR_STATE_DIR=//p' .env | head -1)"
DROP=/etc/systemd/system/fifth-disk-guard.service.d
case "${1:-}" in
  on)
    TARGETS="${2:-}"
    if [ -n "$TARGETS" ]; then
      [[ "$TARGETS" =~ ^test-[0-9]+(,test-[0-9]+)*$ ]] || { echo 'цели: test-1[,test-2]' >&2; exit 2; }
    fi
    cp infra/systemd/fifth-disk-guard.service infra/systemd/fifth-disk-guard.timer /etc/systemd/system/
    if [ -n "$TARGETS" ]; then
      mkdir -p "$DROP"
      printf '# Общая приёмка до выпуска prod: только %s.\n[Service]\nExecStart=\nExecStart=/usr/bin/node scripts/disk-guard.mjs --path / --targets %s\n' \
        "$TARGETS" "$TARGETS" > "$DROP/targets.conf"
    else
      rm -f "$DROP/targets.conf"
    fi
    systemctl daemon-reload
    if ! systemctl start fifth-disk-guard.service; then
      systemctl disable --now fifth-disk-guard.timer >/dev/null 2>&1 || true
      echo 'первый отчёт не принят (нет M181 у цели?) — таймер не включён' >&2
      journalctl -u fifth-disk-guard.service -n 5 --no-pager -o cat >&2 || true
      exit 1
    fi
    systemctl enable --now fifth-disk-guard.timer >/dev/null 2>&1
    if [ -z "$TARGETS" ]; then
      node scripts/monitoring.mjs configure | tail -3
    else
      echo "цели: $TARGETS; Zabbix не перенастраивался (вместе с выпуском prod)"
    fi
    cat "${STATE:-/var/lib/fifth-monitor}/disk-guard.json"; echo
    ;;
  status)
    systemctl is-active fifth-disk-guard.timer || true
    if [ -f "$DROP/targets.conf" ]; then sed -n 's/.*--targets //p' "$DROP/targets.conf" | sed 's/^/цели: /'; else echo 'цели: все среды узла'; fi
    cat "${STATE:-/var/lib/fifth-monitor}/disk-guard.json"; echo
    ;;
  off)
    systemctl disable --now fifth-disk-guard.timer >/dev/null 2>&1 || true
    echo 'служба места на диске выключена'
    ;;
  *) echo 'команды: on [test-1], status, off' >&2; exit 2 ;;
esac
