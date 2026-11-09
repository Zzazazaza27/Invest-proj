#!/bin/bash
# Осмотр рабочей среды перед переходом на OpenBao. Ничего не меняет, значений не печатает.
set -uo pipefail
# Активное ядро (блок 09, задание 3): в режиме слотов — по файлу маршрута.
. "$(dirname "$(readlink -f "$0")")/core-slot.sh"
CORE="$(active_core)" || exit 2
ROOT=/opt/fifth-element
cd "$ROOT"
BUILD="${1:-2.1-b120.1}"
echo '== настройки без значений'
grep -E '^(NODE_ENV|KMS_MODE|AUTH_MODE|MONITOR_ENV|FIFTH_SECRETS_DIR|SESSION_COOKIE_NAME|CSRF_COOKIE_NAME|WEBHOOK_DELIVERY_MODE|DATABASE_SSL|TESTING_SESSIONS_ENABLED|MAIL_TRANSPORT|CORE_BIND_HOST|CORE_PUBLIC_URL|PUBLIC_BASE_URL)=' .env
echo "файлов секретов: $(find .local/secrets -type f | wc -l), в .env ссылок: $(grep -c '_FILE=' .env)"
grep -oE '^[A-Z0-9_]+_FILE=' .env | sed 's/_FILE=//' | tr '\n' ' '
echo
echo '== образ и состав'
cat .local/kits/pins/prod.json | cut -c1-200
docker inspect "$CORE" --format '{{.Config.Image}} {{.HostConfig.NetworkMode}}' 2>&1
docker inspect "$CORE" --format '{{range .Mounts}}{{.Source}} -> {{.Destination}} ({{.RW}}){{"\n"}}{{end}}' 2>&1
docker inspect "$CORE" --format '{{.Config.User}}' 2>&1
stat -c '%a %u %g %n' .env .local/secrets
echo '== проверка настроек production на новой сборке'
set -a
vars=()
while IFS= read -r name; do vars+=(-e "$name="); done < <(grep -oE '^KEK_[A-Z_]+_FILE' .env)
set +a
docker run --rm --network host --env-file .env "${vars[@]}" \
  -e NODE_ENV=production -e KMS_MODE=kms -e AUTH_MODE=local \
  -e OPENBAO_ADDR=https://127.0.0.1:8200 -e OPENBAO_CA_PATH=/x -e OPENBAO_TOKEN_PATH=/x \
  -v "$ROOT/.local/secrets:$ROOT/.local/secrets:ro" --entrypoint node "fifth/core:$BUILD" \
  -e "try{require('/app/apps/core/dist/config/env.js').loadEnv();console.log('настройки production приняты')}catch(e){console.log(String(e.message).slice(0,3000))}" 2>&1 | cut -c1-220
echo '== кто на узле читает ключи домена'
grep -rln 'KEK_' scripts/*.mjs scripts/lib/*.mjs infra/systemd 2>/dev/null | tr '\n' ' '
echo
systemctl list-timers 'fifth-*' --no-pager 2>/dev/null | awk 'NR>1{print $NF, $(NF-1)}' | head -20
echo '== почта и вход (без значений паролей)'
grep -E '^(MAIL_TRANSPORT|MAIL_SMTP_HOST|MAIL_SMTP_PORT|MAIL_SMTP_SECURITY|MAIL_SMTP_USER|MAIL_FROM|TRUSTED_PROXY_CIDRS|CORS_ALLOWED_ORIGINS|WEBHOOK_DELIVERY_MODE|NATS_URL|REDIS_PORT|MAIL_SMTP_EHLO_NAME)=' .env | cut -c1-120
ls /etc/exim4 2>/dev/null | head -5 | tr '\n' ' '; echo
grep -nE 'auth|tls_advertise|smarthost|route_list' /etc/exim4/exim4.conf.template 2>/dev/null | head -8 | cut -c1-90
echo '== nginx сайта'
grep -rlE '5espace' /etc/nginx/conf.d /home/*/conf/web 2>/dev/null | head -8
f="$(grep -rlE 'server_name +5espace.com' /etc/nginx /home/*/conf/web 2>/dev/null | head -1)"
echo "$f"; grep -nE 'listen|ssl_certificate|location|proxy_pass|ssl_client|ssl_verify' "$f" 2>/dev/null | head -24 | cut -c1-100
echo '== образ постгрес'
docker exec fifth-postgres sh -c 'id postgres; psql -U postgres -At -c "show ssl" 2>&1 | head -1' 2>&1 | cut -c1-80
echo '== кто слушает 443'
ss -ltnp 2>/dev/null | grep -E ':(80|443|2525) ' | cut -c1-110
ls /etc/caddy 2>/dev/null | head; grep -nE '5espace|reverse_proxy|client_auth|tls ' /etc/caddy/Caddyfile 2>/dev/null | head -14 | cut -c1-90
echo '== доставка почты'
tail -400 /var/log/exim4/mainlog 2>/dev/null | grep -E ' => | == |\*\* ' | tail -6 | sed -E 's/[A-Za-z0-9._%+-]+@/***@/g' | cut -c1-130
grep -nE 'smarthost|route_data|remote_smtp|port *=' /etc/exim4/exim4.conf.template 2>/dev/null | head -8 | cut -c1-90
ls /etc/exim4/domains 2>/dev/null | head; v-list-mail-accounts 2>/dev/null | head -3
/usr/local/hestia/bin/v-list-mail-domains admin plain 2>/dev/null | cut -c1-60 | head -5
