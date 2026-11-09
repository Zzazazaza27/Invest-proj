#!/bin/bash
# Установка ежечасной выгрузки журнала аудита: рабочая среда и test-2 (2.1.5). Запускается
# при выпуске пакета, по согласованию. Повторный запуск безопасен: ключ и пароль роли не
# пересоздаются, юниты и fifth-backup-read обновляются, выгрузки делают очередную порцию.
#
#   fifth-test op prod-audit-export-setup
#
# Роль выгрузки — app_archive_user (журнал только на чтение, M052). Для prod шаг готовит её
# вход: случайный пароль (только если адреса ещё нет), ALTER ROLE владельцем, адрес — в
# /etc/fifth-audit-export/prod.db-url (только root), проверка входа этой ролью. У test-2
# адрес роли уже в секретах среды. Перехода на владельца нет.
#
# Ключ подписи Ed25519 создаётся один раз (закрытый — только root). Открытый ключ
# печатается: его закрепляют в репозитории (infra/audit/export-signing.pub). Пароли и
# закрытый ключ не печатаются.
set -Eeuo pipefail
ROOT=/opt/fifth-element
KEYDIR=/etc/fifth-audit-export
cd "$ROOT"
install -d -m 700 "$KEYDIR" /var/lib/fifth-audit-export
if [ ! -s "$KEYDIR/signing.key" ]; then
  node scripts/audit-export.mjs keygen --out "$KEYDIR/signing.key" --pub "$KEYDIR/signing.pub"
fi
chmod 600 "$KEYDIR/signing.key"

# Вход роли выгрузки рабочей среды.
URL_FILE="$KEYDIR/prod.db-url"
owner="$(sed -E 's#@[^/]*/#@127.0.0.1:5432/#' /run/fifth-secrets/DATABASE_URL_OWNER)"
psql_owner() { docker exec -e URL="$owner" fifth-postgres sh -c "psql \"\$URL\" -v ON_ERROR_STOP=1 -At -c \"$1\""; }
[ "$(psql_owner "SELECT count(*) FROM pg_roles WHERE rolname = 'app_archive_user'")" = 1 ] ||
  { echo 'роли app_archive_user нет в рабочей базе — сначала выпуск с ролями' >&2; exit 1; }
if [ ! -s "$URL_FILE" ]; then
  pw="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  psql_owner "ALTER ROLE app_archive_user WITH LOGIN PASSWORD '$pw'" >/dev/null
  umask 077
  printf 'postgres://app_archive_user:%s@127.0.0.1:5432/fifth_element\n' "$pw" >"$URL_FILE"
  unset pw
fi
chmod 600 "$URL_FILE"
docker exec -e URL="$(cat "$URL_FILE")" fifth-postgres sh -c 'psql "$URL" -At -c "SELECT count(*) FROM ops.database_identity"' >/dev/null &&
  echo '▸ вход app_archive_user в рабочую базу: ok' ||
  { echo 'вход app_archive_user не прошёл' >&2; exit 1; }

install -o root -g root -m 755 infra/host/fifth-backup-read /usr/local/sbin/
install -m 644 'infra/systemd/fifth-audit-export@.service' 'infra/systemd/fifth-audit-export@.timer' /etc/systemd/system/
systemctl daemon-reload
for envid in prod test-2; do
  systemctl enable --now "fifth-audit-export@$envid.timer" >/dev/null
  systemctl start "fifth-audit-export@$envid.service" || true
  echo "▸ выгрузка $envid: $(systemctl show "fifth-audit-export@$envid.service" -p Result --value)"
  cat "/var/lib/fifth-monitor/audit-export-$envid.json" 2>/dev/null || echo '  (состояния нет)'
done
echo "▸ открытый ключ подписи (закрепить в infra/audit/export-signing.pub), SHA-256 $(sha256sum "$KEYDIR/signing.pub" | cut -c1-16):"
cat "$KEYDIR/signing.pub"
