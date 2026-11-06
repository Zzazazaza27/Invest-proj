#!/bin/bash
# Откуда образы рабочей среды попадают в запуск тестовой среды. Только чтение: имена, без значений
# секретов; `config --images` ничего не запускает.
set -uo pipefail
ROOT=/opt/fifth-element
DIR="$ROOT/.local/envs/test-2"
echo '== имена FIFTH_ в окружении шага'
env | sed -n 's/^\(FIFTH_[A-Z_]*\)=.*/\1/p' | sort | tr '\n' ' '
echo
cfg() { docker compose --env-file "$DIR/compose.env" -f "$DIR/compose.yml" config --images 2>&1 | grep -E 'fifth/core' | sort -u | tr '\n' ' '; echo; }
echo '== из корня проекта, окружение шага'
cd "$ROOT"; cfg
echo '== из /, окружение шага'
cd /; cfg
echo '== из корня, чистое окружение'
cd "$ROOT"; env -i PATH="$PATH" HOME=/root bash -c "$(declare -f cfg); DIR=$DIR; cfg"
echo '== из корня, чужой образ в окружении'
FIFTH_CORE_IMAGE=fifth/core:2.1-b120.1 cfg
echo '== версия compose'
docker compose version --short
echo '== времена выпуска'
ls -la --time-style=long-iso "$ROOT"/.env* 2>/dev/null | cut -c30-
ls -la --time-style=long-iso "$ROOT"/.local/releases 2>/dev/null | tail -8 | cut -c30-
journalctl --since '2026-11-04' --no-pager -q _COMM=docker 2>/dev/null | tail -1 | cut -c1-80
docker inspect fifth-core --format 'ядро рабочей среды: создано {{.Created}}'
