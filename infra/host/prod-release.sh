#!/bin/bash
# Выпуск комплекта, читающего оба формата, в рабочую среду. Режим ключей не меняется.
set -Eeuo pipefail
BUILD="$1"
EXPECT="$2"
cd /opt/fifth-element
node scripts/kit.mjs load --build "$BUILD" | cut -c1-120
node scripts/release.mjs install prod --kit "$BUILD" --expect "$EXPECT" --actor maus --approved-by thomas | cut -c1-300
node scripts/release.mjs verify prod | cut -c1-300
cat .local/kits/pins/prod.json | tr -d '\n '
echo
