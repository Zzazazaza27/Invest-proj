#!/bin/bash
# Временное подключение получателя вебхука (работа № 3, общая приёмка): два имени HTTPS на 443 →
# получатель на петле узла 127.0.0.1:18444. В рабочий Caddyfile добавляется одна строка import
# отдельного файла; остальные блоки не меняются. Перед перезагрузкой — caddy validate, при ошибке
# прежний Caddyfile возвращается. `off` убирает строку и файл.
#
#   fifth-test op prod-webhook-route on    hook-a/hook-b.test-1.5espace.com
#   fifth-test op prod-webhook-route off
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
CONF="$(systemctl show caddy -p ExecStart --value | grep -o -- '--config [^ ;]*' | awk '{print $2}')"
CONF="${CONF:-/etc/caddy/Caddyfile}"
[ -f "$CONF" ] || { echo "нет файла Caddy: $CONF" >&2; exit 1; }
TRIAL=/etc/caddy/webhook-trial.caddy
LINE="import $TRIAL"
BACKUP="/root/caddy-before-webhook-trial.Caddyfile"
apply() {
  if ! caddy validate --config "$CONF" --adapter caddyfile >/tmp/caddy-validate.log 2>&1; then
    tail -5 /tmp/caddy-validate.log >&2
    cp -p "$BACKUP" "$CONF"
    echo 'проверка Caddy не прошла — прежний Caddyfile возвращён' >&2
    exit 1
  fi
  systemctl reload caddy
}
case "${1:-}" in
  on)
    cat >"$TRIAL" <<'CADDY'
# Временно: испытание получателя вебхука (работа № 3). Убрать: fifth-test op prod-webhook-route off
hook-a.test-1.5espace.com, hook-b.test-1.5espace.com {
	reverse_proxy 127.0.0.1:18444
}
CADDY
    grep -qxF "$LINE" "$CONF" || { cp -p "$CONF" "$BACKUP" && printf '\n%s\n' "$LINE" >>"$CONF"; }
    apply
    # Ядро шлёт на публичный адрес узла из сети Docker: ufw пускает сети Docker к узлу только
    # по отдельным правилам (как 4300, 10051). Временно — 443, снимается в `off`.
    ufw allow proto tcp from 172.16.0.0/12 to any port 443 comment 'webhook trial (work 3)' >/dev/null
    echo "подключено: hook-a/hook-b.test-1.5espace.com → 127.0.0.1:18444 ($CONF); ufw 443 из сетей Docker"
    ;;
  off)
    if grep -qxF "$LINE" "$CONF"; then
      cp -p "$CONF" "$BACKUP"
      grep -vxF "$LINE" "$BACKUP" >"$CONF"
    fi
    # Файл убирается после успешной проверки: при возврате прежнего Caddyfile его import цел.
    apply
    rm -f "$TRIAL"
    ufw delete allow proto tcp from 172.16.0.0/12 to any port 443 >/dev/null 2>&1 || true
    echo 'подключение получателя и правило ufw сняты'
    ;;
  *)
    echo 'команды: on, off' >&2
    exit 2
    ;;
esac
