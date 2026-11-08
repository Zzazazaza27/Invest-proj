#!/bin/bash
# Копия пилотной среды test-2: база, файлы, настройки с ключами. Всё шифруется на ключ Томаса,
# открыто лежит только опись. Хранится 14 последних копий. Значения не печатаются.
set -Eeuo pipefail
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ROOT=/opt/fifth-element
ID=test-2
DIR="$ROOT/.local/envs/$ID"
BACKUPS=/var/backups/fifth-element/pilot/$ID
STATE=/var/lib/fifth-monitor/pilot-backup.json
RECIPIENT="$ROOT/infra/openbao/thomas-recipient.asc"
KEEP=14
report() {
  printf '{"at":"%s","ok":%s,"detail":"%s"}\n' "$(date -u +%FT%TZ)" "$1" "$2" >"$STATE"
}
trap 'report false "сбой на строке $LINENO"' ERR
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUPS/$stamp"
work="$(mktemp -d -p /var/backups/fifth-element)"
trap 'rm -rf "$work"' EXIT
install -d -m 700 "$BACKUPS" "$target"
gpg --homedir "$work" --batch -q --import <"$RECIPIENT" 2>/dev/null
fpr="$(gpg --homedir "$work" --batch --list-keys --with-colons | awk -F: '/^fpr/{print $10; exit}')"
seal() { gpg --homedir "$work" --batch -q --trust-model always --encrypt --recipient "$fpr" --output "$1"; }

pg() {
  docker exec -i -e PGPASSWORD="$(cat "$DIR/secrets/POSTGRES_PASSWORD")" "fifth-$ID-postgres" "$@"
}
pg pg_dump -h 127.0.0.1 -U fifth_owner -d fifth_element -Fc | seal "$target/db.dump.gpg"
# Политики доступа ссылаются на роли, а копия базы их не содержит.
pg pg_dumpall -h 127.0.0.1 -U fifth_owner --roles-only | seal "$target/roles.sql.gpg"
counts="$(pg psql -h 127.0.0.1 -U fifth_owner -d fifth_element -At -F= -c \
  "SELECT 'users', count(*) FROM identity.users UNION ALL SELECT 'projects', count(*) FROM lab.projects UNION ALL SELECT 'materials', count(*) FROM lab.project_materials" | paste -sd, -)"

network="$(sed -n 's/^FIFTH_STORAGE_NETWORK=//p' "$DIR/compose.env")"
# Прямо к Garage в сети хранилища: адрес ядра в боевом режиме — вход с TLS на сертификате среды.
endpoint=http://garage-1:3900
mkdir "$work/files"
node -e "const k=JSON.parse(require('fs').readFileSync('$DIR/storage.json'));console.log(k.app.accessKeyId+' '+k.app.secretAccessKey)" >"$work/key"
read -r access secret <"$work/key"
rm -f "$work/key"
RCLONE_CONFIG_SRC_ACCESS_KEY_ID="$access" RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY="$secret" \
  docker run --rm --network "$network" -u 0:0 --entrypoint rclone -v "$work/files:/out" \
  -e RCLONE_CONFIG_SRC_TYPE=s3 -e RCLONE_CONFIG_SRC_PROVIDER=Other -e RCLONE_CONFIG_SRC_REGION=ru-central1 \
  -e RCLONE_CONFIG_SRC_ENDPOINT="$endpoint" -e RCLONE_CONFIG_SRC_ACCESS_KEY_ID -e RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY \
  fifth/postgres:16 copy "SRC:fifth-$ID" /out --quiet
unset secret access
objects="$(find "$work/files" -type f | wc -l)"
files_sum="$(cd "$work/files" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum | sha256sum | cut -d' ' -f1)"
tar -C "$work/files" -cf - . | seal "$target/files.tar.gpg"
tar -C "$DIR" -cf - secrets settings.env compose.env storage.json install.json | seal "$target/env.tar.gpg"

sum() { sha256sum "$target/$1" | cut -d' ' -f1; }
cat >"$target/manifest.json" <<JSON
{"at":"$stamp","env":"$ID","counts":"$counts","objects":$objects,"filesSum":"$files_sum",
 "sha256":{"db.dump.gpg":"$(sum db.dump.gpg)","roles.sql.gpg":"$(sum roles.sql.gpg)","files.tar.gpg":"$(sum files.tar.gpg)","env.tar.gpg":"$(sum env.tar.gpg)"}}
JSON
date -u +%FT%TZ >"$target/READY"
find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d | sort | head -n "-$KEEP" | xargs -r rm -rf
report true "$stamp"
echo "копия $stamp: $counts, файлов $objects, размер $(du -sh "$target" | cut -f1)"
