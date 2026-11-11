#!/bin/bash
# Разово закрепить дополнения Compose текущей сборки рабочей среды (секреты, TLS, слоты) в её
# действующем каталоге .local/envs/prod/compose/overlays (работа № 1 раздела 01). После этого
# infra.mjs берёт их оттуда, а синхронизация серверной копии репозитория конфигурацию prod не
# меняет. Контейнеры не пересоздаются. Запускает Томас.
#
#   fifth-test op prod-pin-overlays <текущая сборка prod>
set -Eeuo pipefail
BUILD="${1:-}"
[[ "$BUILD" =~ ^[0-9]+\.[0-9]+-b[0-9]+\.[0-9]+$ ]] || { echo 'нужна текущая сборка prod' >&2; exit 2; }
cd /opt/fifth-element
node scripts/kit-history.mjs check | tail -1
node scripts/release.mjs pin-overlays prod --build "$BUILD" | cut -c1-300
# Контроль: Compose собирается из закреплённых файлов, сравнение с запущенной конфигурацией.
node scripts/infra.mjs files | cut -c1-600
