#!/bin/bash
# Контрольный файл в бакете test-2 и свежая копия с ним: проверка восстановления файлов.
# Файл случайный, с данными людей не связан, лежит отдельно в `_control/`. Печатается только хеш.
set -Eeuo pipefail
ROOT=/opt/fifth-element
ID=test-2
DIR="$ROOT/.local/envs/$ID"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
head -c 65536 /dev/urandom >"$work/restore-check.bin"
sha="$(sha256sum "$work/restore-check.bin" | cut -d' ' -f1)"
network="$(sed -n 's/^FIFTH_STORAGE_NETWORK=//p' "$DIR/compose.env")"
endpoint="$(sed -n 's/^S3_ENDPOINT=//p' "$DIR/settings.env")"
node -e "const k=JSON.parse(require('fs').readFileSync('$DIR/storage.json'));console.log(k.app.accessKeyId+' '+k.app.secretAccessKey)" >"$work/key"
read -r access secret <"$work/key" || true
rm -f "$work/key"
RCLONE_CONFIG_DST_ACCESS_KEY_ID="$access" RCLONE_CONFIG_DST_SECRET_ACCESS_KEY="$secret" \
  docker run --rm --network "$network" -u 0:0 --entrypoint rclone -v "$work:/in:ro" \
  -e RCLONE_CONFIG_DST_TYPE=s3 -e RCLONE_CONFIG_DST_PROVIDER=Other -e RCLONE_CONFIG_DST_REGION=ru-central1 \
  -e RCLONE_CONFIG_DST_ENDPOINT="$endpoint" -e RCLONE_CONFIG_DST_NO_CHECK_BUCKET=true \
  -e RCLONE_CONFIG_DST_ACCESS_KEY_ID -e RCLONE_CONFIG_DST_SECRET_ACCESS_KEY \
  fifth/postgres:16 copyto /in/restore-check.bin "DST:fifth-$ID/_control/restore-check.bin" --quiet
unset secret access
echo "контрольный файл: $sha"
bash "$ROOT/infra/host/pilot-backup.sh" | cut -c1-160
