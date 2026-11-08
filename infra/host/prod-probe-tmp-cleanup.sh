#!/bin/bash
# Убрать временные каталоги test-probe.sh, оставленные ранним выходом (--stage kit/tools):
# в их docker/config.json — учётные данные GHCR запуска. Только каталоги mktemp в /tmp с
# этим файлом. Значений не печатает.
#
#   fifth-test op prod-probe-tmp-cleanup
set -Eeuo pipefail
n=0
for dir in /tmp/tmp.*; do
  [ -d "$dir" ] && [ -f "$dir/docker/config.json" ] || continue
  rm -rf "$dir"
  n=$((n + 1))
done
echo "убрано каталогов с учётными данными GHCR: $n"
left="$(find /tmp -maxdepth 3 -path '/tmp/tmp.*/docker/config.json' 2>/dev/null | wc -l)"
echo "осталось: $left"
[ "$left" = 0 ]
