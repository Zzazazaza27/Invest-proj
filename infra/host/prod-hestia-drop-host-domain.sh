#!/bin/bash
# Удалить из Hestia веб-домен прежнего имени узла (Томас 18.11): установщик Hestia завёл веб-домен
# под hostname (unicorn.ptr.network). Веб-служба Hestia выключена (WEB_SYSTEM='', см.
# docs/runbooks/hestiacp.md), и штатное удаление тоже отказывает (E_DISABLED). Поэтому на время
# удаления в hestia.conf ставится прежнее значение WEB_SYSTEM='nginx', домен удаляется без
# перезапуска служб, значение сразу возвращается. Системный nginx не запускается: он отнял бы
# 80/443 у Caddy.
#
#   fifth-test op prod-hestia-drop-host-domain <домен>
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
H=/usr/local/hestia
CONF="$H/conf/hestia.conf"
D="${1:-}"
[[ "$D" =~ ^[a-z0-9.-]+$ ]] || { echo 'нужен домен' >&2; exit 2; }
"$H/bin/v-list-web-domain" admin "$D" >/dev/null 2>&1 || {
  # v-list-web-domain тоже проверяет WEB_SYSTEM — смотрим в данные напрямую.
  grep -q "DOMAIN='$D'" "$H/data/users/admin/web.conf" || { echo "домена $D у admin нет"; exit 0; }
}
grep -q "^WEB_SYSTEM=''$" "$CONF" || { echo "WEB_SYSTEM не пустой — ожидалось ''; не трогаю" >&2; exit 1; }
cp -p "$CONF" "$CONF.bak-$(date -u +%Y%m%dT%H%M%SZ)"
restore() { sed -i "s/^WEB_SYSTEM=.*/WEB_SYSTEM=''/" "$CONF"; }
trap restore EXIT
echo "каталог домена: $(du -sh "/home/admin/web/$D" 2>/dev/null | cut -f1 || echo нет)"
sed -i "s/^WEB_SYSTEM=''$/WEB_SYSTEM='nginx'/" "$CONF"
"$H/bin/v-delete-web-domain" admin "$D" no
restore
trap - EXIT
echo "WEB_SYSTEM: $(grep '^WEB_SYSTEM=' "$CONF")"
echo "домен в web.conf: $(grep -c "DOMAIN='$D'" "$H/data/users/admin/web.conf")"
echo "nginx: $(systemctl is-enabled nginx 2>&1), $(systemctl is-active nginx 2>&1)"
echo "порты 80/443: $(ss -ltnp '( sport = :80 or sport = :443 )' | awk 'NR>1{print $6}' | grep -o '"[a-z-]*"' | sort -u | tr '\n' ' ')"
echo "пул php-fpm: $(ls /etc/php/*/fpm/pool.d/ | tr '\n' ' ')"
