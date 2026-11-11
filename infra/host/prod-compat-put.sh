#!/bin/bash
# Приём подписанного отчёта совместимости (compat.yml) на узел (план выпуска W31–W33, раздел 3).
# Файлы кладёт maus в /home/maus/compat-<кандидат>/ (scp); принимает kit.mjs compat-put —
# только подписанный закреплённым ключом отчёт о том же кандидате. Каталог после приёма удаляется.
#
#   fifth-test op prod-compat-put <кандидат>
set -Eeuo pipefail
BUILD="${1:-}"
[[ "$BUILD" =~ ^[0-9]+\.[0-9]+-b[0-9]+\.[0-9]+$ ]] || { echo 'нужна сборка кандидата' >&2; exit 2; }
SRC="/home/maus/compat-$BUILD"
[ -d "$SRC" ] && [ ! -L "$SRC" ] || { echo "нет каталога $SRC" >&2; exit 2; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Только плоские файлы отчёта и подписи, без ссылок.
find "$SRC" -maxdepth 1 -type f -name 'compat-*.json*' -exec cp {} "$WORK/" \;
cd /opt/fifth-element
node scripts/kit.mjs compat-put --build "$BUILD" --dir "$WORK" | cut -c1-200
rm -rf "$SRC"
