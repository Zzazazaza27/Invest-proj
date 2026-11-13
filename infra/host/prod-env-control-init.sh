#!/bin/bash
# Контрольный объект тестовой среды (M153) — файл в бакете и запись в базе, как control-init на
# prod. Без него проверка кандидата при установке через слоты — 503. Идемпотентно.
#
#   fifth-test op prod-env-control-init <test-1|test-2>
set -Eeuo pipefail
ID="${1:-}"
[[ "$ID" =~ ^test-[12]$ ]] || { echo 'среда: test-1 или test-2' >&2; exit 2; }
cd /opt/fifth-element
node scripts/env-control-init.mjs "$ID"
