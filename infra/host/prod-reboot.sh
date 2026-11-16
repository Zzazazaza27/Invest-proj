#!/bin/bash
# Перезагрузка узла (Томас 16.11: после автообновления ядра и libc). Перезагружает только `now` —
# по «да» Томаса в чате; check и after только читают.
#
#   fifth-test op prod-reboot check   поднимется ли всё само: Docker, политики перезапуска, службы
#   fifth-test op prod-reboot now     перезагрузка через 10 секунд (команда успевает вернуться)
#   fifth-test op prod-reboot after   ядро, время работы, контейнеры не в работе, упавшие службы
set -Eeuo pipefail
not_running() {
  docker ps -a --format '{{.Names}} {{.State}} {{.Status}}' | awk '$2 != "running"' || true
}
case "${1:-}" in
  check)
    echo "ядро сейчас: $(uname -r); загрузится: $(ls -1 /boot/vmlinuz-* | sort -V | tail -1)"
    if [ -f /var/run/reboot-required.pkgs ]; then
      echo "ждут перезагрузки: $(sort -u /var/run/reboot-required.pkgs | tr '\n' ' ')"
    else
      echo 'перезагрузка не требуется'
    fi
    for u in docker.service containerd.service; do echo "$u: $(systemctl is-enabled "$u" 2>&1)"; done
    echo '== контейнеры без перезапуска (после перезагрузки не поднимутся сами)'
    docker ps -a --format '{{.Names}}' | while read -r c; do
      p=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$c")
      case "$p" in always | unless-stopped) ;; *) echo "$c: ${p:-нет}" ;; esac
    done
    echo "в работе: $(docker ps -q | wc -l) из $(docker ps -aq | wc -l)"
    echo '== не в работе сейчас'
    not_running
    echo '== службы fifth-* (включённые поднимутся сами)'
    systemctl list-unit-files --no-pager --no-legend 'fifth-*' | awk '{print $1": "$2}'
    echo "== упавшие службы: $(systemctl --failed --no-legend --no-pager | wc -l)"
    systemctl --failed --no-legend --no-pager || true
    ;;
  now)
    systemd-run --on-active=10 --unit=fifth-reboot --description='перезагрузка по fifth-test' \
      /bin/systemctl reboot
    echo "перезагрузка назначена на $(date -u -d '+10 sec' +%H:%M:%SZ)"
    ;;
  after)
    echo "ядро: $(uname -r); работает с $(uptime -s) ($(uptime -p))"
    echo "перезагрузка требуется: $([ -f /var/run/reboot-required ] && echo да || echo нет)"
    echo "в работе: $(docker ps -q | wc -l) из $(docker ps -aq | wc -l)"
    echo '== не в работе'
    not_running
    echo "== упавшие службы: $(systemctl --failed --no-legend --no-pager | wc -l)"
    systemctl --failed --no-legend --no-pager || true
    timedatectl show -p NTPSynchronized
    ;;
  *)
    echo 'команды: check, now, after' >&2
    exit 2
    ;;
esac
