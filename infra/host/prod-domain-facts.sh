#!/bin/bash
# Доменные настройки сред и их проверка (блок 13; Тэнк 10.11). Только чтение.
# Выводятся только адреса и имена — пароли, ключи и токены не читаются.
#   fifth-test op prod-domain-facts
set -u
ROOT=/opt/fifth-element
KEYS='CORE_PUBLIC_URL|PUBLIC_BASE_URL|CORS_ALLOWED_ORIGINS|S3_PUBLIC_ENDPOINT|MAIL_FROM|SMTP_FROM|MAIL_SMTP_HOST|MAIL_SMTP_EHLO_NAME|MAIL_SMTP_USER|SUPPORT_INBOX_EMAIL|S3_CORS_ALLOW_ORIGIN'
show() {
  local label="$1" file="$2"
  [ -f "$file" ] || return 0
  grep -hE "^($KEYS)=" "$file" | sed "s#^#$label: #"
}
echo '== prod'
show prod "$ROOT/.env"
for id in test-1 test-2; do
  echo "== $id"
  for f in "$ROOT/.local/envs/$id"/*.env "$ROOT/.local/envs/$id/env"; do show "$id $(basename "$f")" "$f"; done
done
echo '== ответы по адресам (код HTTP)'
for u in https://5espace.com/v1/health https://www.5espace.com/ https://test-2.5espace.com/v1/health https://files.5espace.com/; do
  printf '%s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$u")" "$u"
done
echo '== CORS хранилища для сред'
# Своя среда — 204, чужой сайт — 403: бакет среды принимает только свой кабинет.
for pair in 5espace.com:fifth-element test-1.5espace.com:fifth-test-1 test-2.5espace.com:fifth-test-2; do
  o="https://${pair%%:*}"
  b="${pair##*:}"
  own=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X OPTIONS -H "Origin: $o" -H 'Access-Control-Request-Method: POST' "https://files.5espace.com/$b")
  alien=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X OPTIONS -H 'Origin: https://example.org' -H 'Access-Control-Request-Method: POST' "https://files.5espace.com/$b")
  echo "$b: свой $o -> $own, чужой -> $alien"
done
echo '== сертификаты (срок)'
for h in 5espace.com www.5espace.com files.5espace.com test-1.5espace.com test-2.5espace.com mail.5espace.com panel.5espace.com; do
  end=$(echo | openssl s_client -servername "$h" -connect "$h:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  echo "$h ${end:-нет ответа}"
done
