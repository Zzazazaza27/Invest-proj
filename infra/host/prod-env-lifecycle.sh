#!/bin/bash
# Правило lifecycle бакета тестовой среды (работа № 4, общая приёмка 1.5): незавершённые
# multipart — через сутки. Только бакет среды; бакет prod — отдельным решением (garage-init).
#
#   fifth-test op prod-env-lifecycle <test-1|test-2> [--probe|--list]
set -Eeuo pipefail
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ID="${1:-}"
[[ "$ID" =~ ^test-[12]$ ]] || { echo 'среда: test-1 или test-2' >&2; exit 2; }
ROOT=/opt/fifth-element
cd "$ROOT"
T="$ROOT/.local/secrets/GARAGE_ADMIN_TOKEN"; [ -f "$T" ] || T=/run/fifth-secrets/GARAGE_ADMIN_TOKEN
GARAGE_ADMIN_TOKEN="$(cat "$T")"
export GARAGE_ADMIN_TOKEN
REGION="$(sed -n 's/^S3_REGION=//p' "$ROOT/.local/envs/$ID/settings.env" | head -1)"
node scripts/garage-lifecycle.mjs "fifth-$ID" --region "${REGION:-garage}" ${2:+"$2"}
