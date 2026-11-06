#!/bin/bash
# Пилотная среда test-2 одним пакетом: среда, почта, вход, копии, учётка администратора.
#   prod-test2-create <сборка> <идентификатор учётки admin> <хеш нового пароля, base64>
# Повторный запуск продолжает с незавершённого шага. Значения не печатаются.
set -Eeuo pipefail
BUILD="$1"
ADMIN_ID="$2"
ADMIN_HASH="$3"
ROOT=/opt/fifth-element
ID=test-2
DIR="$ROOT/.local/envs/$ID"
CADDY=/etc/caddy/Caddyfile
SITE="https://$ID.5espace.com"
cd "$ROOT"
say() { printf '\n▸ %s\n' "$1"; }

say 'запас узла'
available="$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)"
disk="$(df --output=avail -BG / | tail -1 | tr -dc 0-9)"
echo "памяти доступно $available МБ, диска $disk ГБ"
[ "$available" -gt 3000 ] && [ "$disk" -gt 30 ]
getent ahostsv4 "$ID.5espace.com" | grep -q 193.233.217.210 || { echo 'нет записи DNS'; exit 1; }

say 'среда'
if [ ! -f "$DIR/install.json" ]; then
  node scripts/env.mjs create "$ID" --kit "$BUILD" --web-port 18082 --address "$SITE" \
    --files-url https://files.5espace.com --pilot | cut -c1-160
fi

say 'почта'
account="no-reply-$ID"
if ! /usr/local/hestia/bin/v-list-mail-accounts admin 5espace.com plain | cut -f1 | grep -qx "$account"; then
  /usr/local/hestia/bin/v-add-mail-account admin 5espace.com "$account" "$(cat "$DIR/secrets/MAIL_SMTP_PASSWORD")"
fi
echo "ящик $account"

say 'вход'
if ! grep -q "^$ID.5espace.com {" "$CADDY"; then
  cp -p "$CADDY" "$CADDY.before-$ID"
  cat >>"$CADDY" <<EOF

# Пилотная среда (решение Томаса 06.11): люди и сохраняемые данные, индексация запрещена.
$ID.5espace.com {
	import fifth_access_log
	header X-Robots-Tag "noindex, nofollow"
	reverse_proxy 127.0.0.1:18082
}
EOF
fi
caddy validate --config "$CADDY" --adapter caddyfile >/dev/null 2>&1
systemctl reload caddy
sleep 4
curl -s -o /dev/null -w 'сайт %{http_code}\n' --max-time 20 "$SITE/"
curl -sI --max-time 20 "$SITE/" | grep -qi 'x-robots-tag: noindex'
curl -s -o /dev/null -w 'рабочая среда без пароля %{http_code}\n' --max-time 15 https://5espace.com/

say 'учётка администратора'
bash infra/host/prod-test-admin.sh "$ADMIN_ID" "$ID" "$ADMIN_HASH"

say 'копии'
install -o root -g root -m 644 infra/systemd/fifth-pilot-backup.service infra/systemd/fifth-pilot-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now fifth-pilot-backup.timer >/dev/null 2>&1
bash infra/host/pilot-backup.sh
echo 'test-2 готова'
