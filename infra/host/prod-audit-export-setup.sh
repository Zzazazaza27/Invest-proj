#!/bin/bash
# Установка ежечасной выгрузки журнала аудита одной среды (2.1.5). Запускается при выпуске
# пакета, по согласованию, после выпуска комплекта с M167–M168 в эту среду. Повторный запуск
# безопасен: ключ и пароль роли не пересоздаются, юниты и fifth-backup-read обновляются.
#
#   fifth-test op prod-audit-export-setup test-2 | prod
#
# Роль выгрузки — app_archive_user (журнал только на чтение, M052). Её адрес и пароль — в
# секретах среды (prod: /run/fifth-secrets/DATABASE_URL_APP_ARCHIVE, test-2: секреты среды);
# шаг пароль роли НЕ меняет. Перехода на владельца нет.
#
# Исправление 09.11: прежняя версия шага задала роли prod новый пароль и положила адрес в
# /etc/fifth-audit-export/prod.db-url, не заметив готового секрета. Если этот файл есть,
# шаг возвращает роли пароль из секрета среды и удаляет файл.
#
# Проверка: два прохода подряд — порция N и N+1, вторая продолжает первую (хеш прежней описи,
# хвост цепочки), подпись описи — закреплённым открытым ключом, покрытие — время проверки.
# Открытый ключ печатается: его закрепляют в infra/audit/export-signing.pub. Пароли и
# закрытый ключ не печатаются.
set -Eeuo pipefail
ENV_ID="${1:?нужна среда: test-2 или prod}"
case "$ENV_ID" in prod | test-2) ;; *) echo "неизвестная среда: $ENV_ID" >&2; exit 2 ;; esac
ROOT=/opt/fifth-element
KEYDIR=/etc/fifth-audit-export
cd "$ROOT"
install -d -m 700 "$KEYDIR" /var/lib/fifth-audit-export
if [ ! -s "$KEYDIR/signing.key" ]; then
  node scripts/audit-export.mjs keygen --out "$KEYDIR/signing.key" --pub "$KEYDIR/signing.pub"
fi
chmod 600 "$KEYDIR/signing.key"

if [ "$ENV_ID" = prod ]; then
  SECRET=/run/fifth-secrets/DATABASE_URL_APP_ARCHIVE
  [ -s "$SECRET" ] || { echo 'нет секрета DATABASE_URL_APP_ARCHIVE у prod' >&2; exit 1; }
  if [ -e "$KEYDIR/prod.db-url" ]; then
    # Вернуть роли пароль из секрета среды (расхождение от прежней версии шага).
    owner="$(sed -E 's#@[^/]*/#@127.0.0.1:5432/#' /run/fifth-secrets/DATABASE_URL_OWNER)"
    pw="$(node -e "console.log(decodeURIComponent(new URL(require('fs').readFileSync('$SECRET','utf8').trim()).password))")"
    docker exec -i -e URL="$owner" fifth-postgres sh -c 'psql "$URL" -v ON_ERROR_STOP=1 -q' <<SQL
ALTER ROLE app_archive_user WITH PASSWORD '$pw';
SQL
    unset pw
    rm -f "$KEYDIR/prod.db-url"
    echo '▸ пароль app_archive_user возвращён к секрету среды, прежний файл адреса удалён'
  fi
fi

install -o root -g root -m 755 infra/host/fifth-backup-read /usr/local/sbin/
install -m 644 'infra/systemd/fifth-audit-export@.service' 'infra/systemd/fifth-audit-export@.timer' /etc/systemd/system/
systemctl daemon-reload

STATE="/var/lib/fifth-monitor/audit-export-$ENV_ID.json"
OUT="/var/lib/fifth-audit-export/$ENV_ID/out"
for pass in 1 2; do
  systemctl start "fifth-audit-export@$ENV_ID.service" || true
  echo "▸ проход $pass: $(systemctl show "fifth-audit-export@$ENV_ID.service" -p Result --value); $(cat "$STATE" 2>/dev/null || echo 'состояния нет')"
done
systemctl enable --now "fifth-audit-export@$ENV_ID.timer" >/dev/null
echo "▸ таймер: $(systemctl is-active "fifth-audit-export@$ENV_ID.timer"), следующий $(systemctl show "fifth-audit-export@$ENV_ID.timer" -p NextElapseUSecRealtime --value)"
# Роль соединения и продолжение серии — по описям, подпись — открытым ключом.
node --input-type=module -e "
import { readFileSync, readdirSync } from 'node:fs';
import { acceptPortion } from '$ROOT/scripts/lib/audit-export.mjs';
const out = '$OUT';
const pub = readFileSync('$KEYDIR/signing.pub', 'utf8');
const seqs = readdirSync(out).filter((n) => n.endsWith('.manifest.json')).map((n) => n.slice(0, 6)).sort();
let point = null;
for (const s of seqs) {
  point = acceptPortion(point, readFileSync(out + '/' + s + '.manifest.json'), readFileSync(out + '/' + s + '.manifest.sig', 'utf8'), readFileSync(out + '/' + s + '.jsonl.gpg'), pub).point;
}
console.log('▸ серия: порций ' + seqs.length + ', подписи и продолжение сошлись; покрыто до ' + point.checkedAt);
"
url_role() {
  if [ "$ENV_ID" = prod ]; then sed -E 's#^postgres://([^:]+):.*#\1#' /run/fifth-secrets/DATABASE_URL_APP_ARCHIVE
  else sed -E 's#^postgres://([^:]+):.*#\1#' "$ROOT/.local/envs/test-2/secrets/DATABASE_URL_APP_ARCHIVE"; fi
}
echo "▸ роль выгрузки: $(url_role)"
echo "▸ открытый ключ подписи (закрепить в infra/audit/export-signing.pub), SHA-256 $(sha256sum "$KEYDIR/signing.pub" | cut -c1-16):"
cat "$KEYDIR/signing.pub"
