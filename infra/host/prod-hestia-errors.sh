#!/bin/bash
# Ошибки заданий Hestia (Томас 18.11: «что там в хестиа падает») — только чтение, без значений
# секретов: ключи конфигурации служб, коды ошибок Hestia, задания cron, журнал копий.
#
#   fifth-test op prod-hestia-errors
set -uo pipefail
H=/usr/local/hestia
echo '== службы в конфигурации Hestia'
grep -E '^(WEB_SYSTEM|WEB_PORT|WEB_SSL|PROXY_SYSTEM|MAIL_SYSTEM|IMAP_SYSTEM|DNS_SYSTEM|DB_SYSTEM|CRON_SYSTEM|BACKUP_SYSTEM|BACKUP|BACKUP_GZIP|BACKUP_MODE|BACKUPS|FTP_SYSTEM|FIREWALL_SYSTEM|VERSION)=' \
  "$H/conf/hestia.conf" | sort
echo '== коды ошибок (func/main.sh)'
grep -E '^E_[A-Z]+=(11|12|20)$' "$H/func/main.sh"
echo '== ошибки за 5 суток (error.log)'
[ -f "$H/log/error.log" ] && tail -n 400 "$H/log/error.log" | awk -v d="$(date -u -d '-5 day' +%F)" '$1 >= d' | tail -20
echo '== задания cron Hestia'
for f in /var/spool/cron/crontabs/hestiaweb /var/spool/cron/crontabs/admin /etc/cron.d/hestia*; do
  [ -f "$f" ] && { echo "-- $f"; grep -v '^\s*#' "$f" | grep -v '^\s*$' | cut -c1-160; }
done
echo '== копии пользователя admin'
grep -E '^(BACKUPS|BACKUP_EXCLUDE)' "$H/data/users/admin/user.conf" 2>/dev/null | sed -E 's/=.*/=…/' | head -3
ls -la /backup 2>/dev/null | tail -6
[ -f "$H/log/backup.log" ] && { echo '-- backup.log (хвост)'; tail -n 25 "$H/log/backup.log" | cut -c1-200; }
echo '== веб-домены admin'
"$H/bin/v-list-web-domains" admin plain 2>&1 | awk '{print $1}' | head
echo '== почтовые домены admin'
"$H/bin/v-list-mail-domains" admin plain 2>&1 | awk '{print $1}' | head
echo '== место'
df -h / /backup 2>/dev/null | tail -2
