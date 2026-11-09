#!/bin/bash
# Установка ежечасной выгрузки журнала аудита рабочей среды (2.1.5). Запускается при выпуске
# пакета, по согласованию. Повторный запуск безопасен: ключ не пересоздаётся, юниты и
# fifth-backup-read обновляются, выгрузка делает очередную порцию.
#
#   fifth-test op prod-audit-export-setup
#
# Ключ подписи Ed25519 создаётся один раз в /etc/fifth-audit-export (закрытый — только root).
# Открытый ключ печатается: его закрепляют в репозитории (infra/audit/export-signing.pub),
# по нему ноутбук проверяет подпись порций. Закрытый ключ не печатается.
set -Eeuo pipefail
ROOT=/opt/fifth-element
KEYDIR=/etc/fifth-audit-export
cd "$ROOT"
install -d -m 700 "$KEYDIR" /var/lib/fifth-audit-export
if [ ! -s "$KEYDIR/signing.key" ]; then
  node scripts/audit-export.mjs keygen --out "$KEYDIR/signing.key" --pub "$KEYDIR/signing.pub"
fi
chmod 600 "$KEYDIR/signing.key"
install -o root -g root -m 755 infra/host/fifth-backup-read /usr/local/sbin/
install -m 644 infra/systemd/fifth-audit-export.service infra/systemd/fifth-audit-export.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now fifth-audit-export.timer >/dev/null
systemctl start fifth-audit-export.service
echo "▸ выгрузка: $(systemctl show fifth-audit-export.service -p Result --value)"
cat /var/lib/fifth-monitor/audit-export.json
echo "▸ порций на сервере: $(ls /var/lib/fifth-audit-export/out | grep -c manifest.json)"
echo "▸ открытый ключ подписи (закрепить в infra/audit/export-signing.pub), SHA-256 $(sha256sum "$KEYDIR/signing.pub" | cut -c1-16):"
cat "$KEYDIR/signing.pub"
