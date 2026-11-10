#!/bin/bash
# Выпуск одного комплекта в test-2 и в рабочую среду одной командой (решение Томаса 10.11:
# пока test-2 и prod — одна связка, обе обновляются после прогона на test-1; разнести, когда
# test-2 станет тестом, а prod — продом).
#
#   fifth-test op prod-release-pair <сборка> <текущая test-2> <текущая prod>
#
# Порядок: test-2 (prod-env-release: копия базы, установка, сверка) → prod (prod-release:
# установка, сверка). Отказ на test-2 — prod не трогается. Возврат — по каждой среде её шагом
# с --rollback. Значений не печатает.
set -Eeuo pipefail
BUILD="${1:-}"
EXPECT_T2="${2:-}"
EXPECT_PROD="${3:-}"
re='^[0-9]+\.[0-9]+-b[0-9]+\.[0-9]+$'
[[ "$BUILD" =~ $re ]] || { echo 'нужна сборка' >&2; exit 2; }
[[ "$EXPECT_T2" == none || "$EXPECT_T2" =~ $re ]] || { echo 'нужна текущая сборка test-2' >&2; exit 2; }
[[ "$EXPECT_PROD" =~ $re ]] || { echo 'нужна текущая сборка prod' >&2; exit 2; }
HERE="$(dirname "$0")"

echo "== test-2: $EXPECT_T2 → $BUILD"
if ! bash "$HERE/prod-env-release.sh" test-2 "$BUILD" "$EXPECT_T2"; then
  echo 'test-2 не обновлена — prod НЕ трогаю' >&2
  exit 1
fi
echo "== prod: $EXPECT_PROD → $BUILD"
bash "$HERE/prod-release.sh" "$BUILD" "$EXPECT_PROD"
echo "== готово: test-2 и prod на $BUILD"
