#!/bin/bash
# Ежечасная выгрузка журнала аудита рабочей среды (2.1.5) — запускает fifth-audit-export.service.
# Роль: app_archive_user, если её адрес есть в секретах; иначе соединение владельца ТОЛЬКО НА
# ЧТЕНИЕ (default_transaction_read_only) — выгрузка в базу не пишет. Значения не печатаются.
set -Eeuo pipefail
cd /opt/fifth-element
SECRETS=/run/fifth-secrets
if [ -s "$SECRETS/DATABASE_URL_APP_ARCHIVE" ]; then
  url="$(cat "$SECRETS/DATABASE_URL_APP_ARCHIVE")"
else
  base="$(sed -E 's#@[^/]*/#@127.0.0.1:5432/#' "$SECRETS/DATABASE_URL_OWNER")"
  case "$base" in *\?*) url="$base&options=-c%20default_transaction_read_only%3Don" ;;
    *) url="$base?options=-c%20default_transaction_read_only%3Don" ;; esac
fi
AUDIT_EXPORT_DB_URL="$url" exec /usr/bin/node scripts/audit-export.mjs run
