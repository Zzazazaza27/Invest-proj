#!/bin/bash
# Ежечасная выгрузка журнала аудита среды (2.1.5) — fifth-audit-export@<среда>.service.
#
#   audit-export-run.sh prod | test-2
#
# Роль — только app_archive_user (журнал на чтение, M052). Перехода на владельца нет: нет
# адреса роли — выгрузка не идёт и сигнал audit-export-<среда> это показывает.
#   prod   — адрес в /etc/fifth-audit-export/prod.db-url (готовит prod-audit-export-setup);
#   test-2 — секрет среды DATABASE_URL_APP_ARCHIVE, хост — адрес контейнера базы среды.
# Значения не печатаются.
set -Eeuo pipefail
ENV_ID="${1:?нужна среда}"
ROOT=/opt/fifth-element
cd "$ROOT"
case "$ENV_ID" in
  prod)
    URL_FILE=/etc/fifth-audit-export/prod.db-url
    [ -s "$URL_FILE" ] || { echo 'нет адреса роли app_archive_user для prod' >&2; exit 1; }
    url="$(cat "$URL_FILE")"
    ;;
  test-2)
    secret="$ROOT/.local/envs/test-2/secrets/DATABASE_URL_APP_ARCHIVE"
    [ -s "$secret" ] || { echo 'нет секрета DATABASE_URL_APP_ARCHIVE у test-2' >&2; exit 1; }
    ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' fifth-test-2-postgres | awk '{print $1}')"
    [ -n "$ip" ] || { echo 'нет адреса контейнера базы test-2' >&2; exit 1; }
    url="$(sed -E "s#@postgres:5432/#@$ip:5432/#" "$secret")"
    ;;
  *)
    echo "неизвестная среда: $ENV_ID" >&2
    exit 2
    ;;
esac
AUDIT_EXPORT_DB_URL="$url" \
  AUDIT_EXPORT_DIR="/var/lib/fifth-audit-export/$ENV_ID" \
  AUDIT_EXPORT_MONITOR_FILE="/var/lib/fifth-monitor/audit-export-$ENV_ID.json" \
  exec /usr/bin/node scripts/audit-export.mjs run
