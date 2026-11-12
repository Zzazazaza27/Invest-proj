#!/bin/bash
# Отказ и восстановление контролируемого получателя вебхука (работа № 3 раздела 01) на тестовой
# среде. Получатель запускается на время сценария на петле узла (127.0.0.1:18444); публичные
# адреса A и B до него — подключение на узле, отдельный шаг общей приёмки.
#
#   fifth-test op prod-webhook-receiver <среда> <https-адрес A> <https-адрес B> [fail|timeout|reset]
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
ROOT=/opt/fifth-element
ENV_ID="${1:-}"
[[ "$ENV_ID" =~ ^test-[0-9]+$ ]] || { echo 'нужна тестовая среда: test-1' >&2; exit 2; }
URL_RE='^https://[A-Za-z0-9.-]+(:[0-9]{2,5})?/[A-Za-z0-9/_.-]*$'
[[ "${2:-}" =~ $URL_RE ]] || { echo 'нужен https-адрес A' >&2; exit 2; }
[[ "${3:-}" =~ $URL_RE ]] || { echo 'нужен https-адрес B' >&2; exit 2; }
MODE="${4:-fail}"
[[ "$MODE" =~ ^(fail|timeout|reset)$ ]] || { echo 'режим: fail, timeout или reset' >&2; exit 2; }
cd "$ROOT"
HOOK_RECEIVER_URL_A="$2" HOOK_RECEIVER_URL_B="$3" \
  exec node scripts/check-webhook-receiver.mjs --env "$ENV_ID" --mode "$MODE"
