#!/bin/bash
# Окружение узла через обёртку fifth-test (Томас 16.11: шаги узла запускает Маус после «да»
# Томаса в чате, без ввода пароля sudo). Изменяют узел только apply и rollback — по «да».
#
#   fifth-test op prod-host-env plan                 что изменит apply; только чтение
#   fifth-test op prod-host-env apply                host-env-apply apply --yes
#   fifth-test op prod-host-env rollback <отметка>   вернуть состояние до apply
#   fifth-test op prod-host-env check                сверка узла и раздел обновлений (как таймер)
#   fifth-test op prod-host-env updates              что поставит ближайший запуск автообновлений
#                                                    (--dry-run), настройка needrestart, таймер;
#                                                    только чтение
set -Eeuo pipefail
cd /opt/fifth-element
case "${1:-}" in
  plan) exec node scripts/host-env-apply.mjs plan ;;
  apply) exec node scripts/host-env-apply.mjs apply --yes ;;
  rollback)
    [[ "${2:-}" =~ ^[0-9TZ-]+$ ]] || { echo 'нужна отметка' >&2; exit 2; }
    exec node scripts/host-env-apply.mjs rollback "$2"
    ;;
  check) exec node scripts/monitor-host-env.mjs --print ;;
  updates)
    echo '== автообновления: пробный прогон (ничего не ставит)'
    # Полный список — в журнале пробного прогона; здесь пакеты к установке и итог.
    unattended-upgrade --dry-run -v 2>&1 | grep -E '^Packages that will be upgraded|^Allowed origins|^No packages|kernel|linux-image' |
      cut -c1-2000 || true
    echo '== needrestart (перезапуск служб после обновления библиотек)'
    grep -hE '^\s*\$nrconf\{(restart|kernelhints|override_rc)\}|docker|containerd' \
      /etc/needrestart/needrestart.conf /etc/needrestart/conf.d/*.conf 2>/dev/null | grep -v '^\s*#' || echo 'настроек не найдено'
    dpkg-query -W -f '${Package} ${Version}\n' needrestart 2>/dev/null || echo 'needrestart не установлен'
    echo '== ближайший запуск'
    systemctl list-timers apt-daily-upgrade.timer apt-daily.timer --no-pager | head -4
    ;;
  *)
    echo 'команды: plan, apply, rollback <отметка>, check, updates' >&2
    exit 2
    ;;
esac
