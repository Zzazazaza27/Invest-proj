#!/bin/bash
# Режим доставки вебхуков test-1 (работа № 3, общая приёмка): live на время испытания получателя,
# затем capture. Пересоздаётся работающее ядро — активный слот (`env.mjs recreate-core`).
#
#   fifth-test op prod-env-webhook-mode live|capture
set -Eeuo pipefail
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MODE="${1:-}"
[[ "$MODE" =~ ^(live|capture)$ ]] || { echo 'режим: live или capture' >&2; exit 2; }
ROOT=/opt/fifth-element
SETTINGS="$ROOT/.local/envs/test-1/settings.env"
cd "$ROOT"
if grep -q '^WEBHOOK_DELIVERY_MODE=' "$SETTINGS"; then
  sed -i "s/^WEBHOOK_DELIVERY_MODE=.*/WEBHOOK_DELIVERY_MODE=$MODE/" "$SETTINGS"
else
  echo "WEBHOOK_DELIVERY_MODE=$MODE" >>"$SETTINGS"
fi
node scripts/env.mjs recreate-core test-1 --text | cut -c1-200
