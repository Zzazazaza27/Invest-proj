#!/bin/bash
# Журналы контейнеров test-1 в journald (W32, Тэнк 10.11): диагностика переживает
# пересоздание контейнера. Только test-1; test-2 и prod не трогаются.
#   fifth-test op prod-env-journald enable    флаг FIFTH_JOURNALD=1, пересоздание служб, проверка
#   fifth-test op prod-env-journald disable   снять флаг и пересоздать (возврат к json-file)
#   fifth-test op prod-env-journald status    драйвер журнала у служб и записи в journald
# Дополнение — infra/docker-compose.env-journald.yml; объём — общий предел journald на VPS.
set -u
ROOT=/opt/fifth-element
ENV=test-1
CENV="$ROOT/.local/envs/$ENV/compose.env"
[ -f "$CENV" ] || { echo "нет $CENV" >&2; exit 2; }

status() {
  for s in core web postgres valkey nats; do
    printf '%-24s %s\n' "fifth-$ENV-$s" "$(docker inspect -f '{{.HostConfig.LogConfig.Type}}' "fifth-$ENV-$s" 2>/dev/null || echo 'нет контейнера')"
  done
  echo "записей ядра в journald за 10 мин: $(journalctl CONTAINER_NAME="fifth-$ENV-core" --since '-10min' -o cat 2>/dev/null | wc -l)"
  journalctl CONTAINER_NAME="fifth-$ENV-core" -n 1 -o verbose 2>/dev/null |
    grep -E '^\s+(CONTAINER_NAME|SYSLOG_IDENTIFIER|FIFTH_ENV)=' || true
  echo "journald всего: $(journalctl --disk-usage 2>/dev/null | grep -o '[0-9.]*[KMGT]B*' | head -1)"
}
restart() { (cd "$ROOT" && node scripts/env.mjs start "$ENV" --text); }

case "${1:-}" in
  status) status ;;
  enable)
    grep -q '^FIFTH_JOURNALD=1$' "$CENV" || echo 'FIFTH_JOURNALD=1' >> "$CENV"
    restart || { echo 'перезапуск не удался — флаг оставлен, повтори enable или disable' >&2; exit 1; }
    status
    t=$(docker inspect -f '{{.HostConfig.LogConfig.Type}}' "fifth-$ENV-core")
    [ "$t" = journald ] || { echo "ядро пишет в $t, не в journald" >&2; exit 1; }
    sleep 15
    n=$(journalctl CONTAINER_NAME="fifth-$ENV-core" --since '-2min' -o cat | wc -l)
    [ "$n" -gt 0 ] || { echo 'в journald нет записей ядра' >&2; exit 1; }
    echo "включено: ядро $ENV пишет в journald ($n записей за 2 мин)"
    ;;
  disable)
    sed -i '/^FIFTH_JOURNALD=1$/d' "$CENV"
    restart || { echo 'перезапуск не удался' >&2; exit 1; }
    status
    ;;
  *) echo 'команды: enable, disable, status' >&2; exit 2 ;;
esac
