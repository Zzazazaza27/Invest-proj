#!/bin/bash
# Слоты ядра тестовой среды (план выпуска W31–W33, раздел 5). Значений не печатает.
#
#   fifth-test op prod-env-slots <enable|disable|state> <test-1|test-2> [--pilot-confirm]
#
# Рабочая среда — release.mjs slots-enable/slots-disable (Томас).
set -Eeuo pipefail
CMD="${1:-}"
ID="${2:-}"
EXTRA="${3:-}"
[[ "$CMD" =~ ^(enable|disable|state)$ ]] || { echo 'команда: enable, disable, state' >&2; exit 2; }
[[ "$ID" =~ ^test-[12]$ ]] || { echo 'среда: test-1 или test-2' >&2; exit 2; }
[[ -z "$EXTRA" || "$EXTRA" == --pilot-confirm ]] || { echo 'третий аргумент — --pilot-confirm' >&2; exit 2; }
cd /opt/fifth-element
# shellcheck disable=SC2086
node scripts/env.mjs "slots-$CMD" "$ID" $EXTRA --text
