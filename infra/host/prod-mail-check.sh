#!/bin/bash
# Проверка доставки: одно письмо через нынешний почтовый сервер и след в журнале. Настройки не меняет.
set -uo pipefail
TO="$1"
ID="probe-$(date +%s)"
echo '== релей'
ls -la /etc/exim4/smtp_relay.conf 2>&1 | cut -c1-80
grep -cE '^(host|port|user)' /etc/exim4/smtp_relay.conf 2>/dev/null
grep -E '^(host|port):' /etc/exim4/smtp_relay.conf 2>/dev/null | cut -c1-60
/usr/local/hestia/bin/v-list-mail-accounts admin 5espace.com plain 2>/dev/null | cut -f1 | head -5
echo '== исходящие порты'
for port in 25 587 2525; do
  timeout 6 bash -c "exec 3<>/dev/tcp/aspmx.l.google.com/$port" 2>/dev/null && echo "$port открыт" || echo "$port закрыт"
done
echo '== письмо'
printf 'From: no-reply@5espace.com\nTo: %s\nSubject: 5E delivery check %s\n\nПроверка доставки почты платформы. Отвечать не нужно.\n' "$TO" "$ID" |
  /usr/sbin/sendmail -f no-reply@5espace.com "$TO"
sleep 12
grep -F "$(echo "$TO" | cut -d@ -f2)" /var/log/exim4/mainlog | tail -4 | sed -E 's/[A-Za-z0-9._%+-]+@/***@/g' | cut -c1-200
echo "метка письма: $ID"
