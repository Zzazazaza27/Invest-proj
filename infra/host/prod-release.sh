#!/bin/bash
# Выпуск комплекта в рабочую среду через release.mjs (блокировка, журнал, сверка). Режим ключей
# не меняется. Возврат на прежний комплект — тем же шагом с --rollback: release.mjs без него
# более старую сборку не ставит.
#
#   fifth-test op prod-release <сборка> <ожидаемая текущая> [--rollback]
#   выпуск:  prod-release 2.1-b126.1 2.1-b120.1
#   возврат: prod-release 2.1-b120.1 2.1-b126.1 --rollback
set -Eeuo pipefail
BUILD="$1"
EXPECT="$2"
ROLLBACK="${3:-}"
[[ "$BUILD" =~ ^[0-9]+\.[0-9]+-b[0-9]+\.[0-9]+$ ]] || { echo 'нужна сборка' >&2; exit 2; }
[[ "$EXPECT" =~ ^[0-9]+\.[0-9]+-b[0-9]+\.[0-9]+$ ]] || { echo 'нужна ожидаемая сборка' >&2; exit 2; }
[[ -z "$ROLLBACK" || "$ROLLBACK" == --rollback ]] || { echo 'третий аргумент — --rollback' >&2; exit 2; }
cd /opt/fifth-element
node scripts/kit.mjs load --build "$BUILD" | cut -c1-120
set +e
node scripts/release.mjs install prod --kit "$BUILD" --expect "$EXPECT" \
  --actor maus --approved-by thomas $ROLLBACK | cut -c1-300
CODE="${PIPESTATUS[0]}"
# Отдельная итоговая сверка обязательна: её отказ — отказ шага.
node scripts/release.mjs verify prod | cut -c1-300
VERIFY="${PIPESTATUS[0]}"
set -e
echo "закрепления: $(tr -d '\n ' <.local/kits/pins/prod.json)"
echo "итог: установка $CODE, сверка $VERIFY"
[ "$CODE" = 0 ] || exit "$CODE"
[ "$VERIFY" = 0 ] || exit 1
