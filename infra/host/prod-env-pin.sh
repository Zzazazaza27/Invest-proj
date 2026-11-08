#!/bin/bash
# Закрепить точку возврата тестовой среды, если реестр её не знал (среда ставилась env.mjs):
# комплект возврата не удаляется уборкой. Только проверенный комплект.
#
#   fifth-test op prod-env-pin <среда> <сборка возврата>
set -Eeuo pipefail
ID="$1"
BUILD="$2"
[[ "$ID" =~ ^test-[12]$ ]] || { echo 'среда: test-1 или test-2' >&2; exit 2; }
[[ "$BUILD" =~ ^[0-9]+\.[0-9]+-b[0-9]+\.[0-9]+$ ]] || { echo 'нужна сборка' >&2; exit 2; }
cd /opt/fifth-element
node scripts/kit.mjs check --build "$BUILD" | cut -c1-160
node scripts/kit.mjs pin --env "$ID" --rollback "$BUILD" | cut -c1-160
echo "закрепления: $(tr -d '\n ' <".local/kits/pins/$ID.json")"
