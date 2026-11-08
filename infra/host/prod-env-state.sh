#!/bin/bash
# Состояние тестовой среды перед выпуском: текущая сборка по реестру, последние установки,
# закрепления, образы в работе, миграции. Только чтение, значений не печатает.
#
#   fifth-test op prod-env-state <среда>
set -Eeuo pipefail
ID="$1"
[[ "$ID" =~ ^test-[12]$ ]] || { echo 'среда: test-1 или test-2' >&2; exit 2; }
ROOT=/opt/fifth-element
DIR="$ROOT/.local/envs/$ID"
PROJECT="fifth-$ID"
cd "$ROOT"
psql_env() {
  docker exec -e PGPASSWORD="$(cat "$DIR/secrets/POSTGRES_PASSWORD")" "$PROJECT-postgres" \
    psql -h 127.0.0.1 -U fifth_owner -d fifth_element -At -c "$1"
}
echo "▸ состояние $ID"
echo "  сверка: $(node scripts/release.mjs verify "$ID" 2>&1 | cut -c1-300)"
echo "  установки (последние 5):"
psql_env "SELECT '    ' || to_char(started_at, 'YYYY-MM-DD HH24:MI') || ' ' || kind || ' ' || coalesce(expected_build, 'none') || ' → ' || build || ' ' || status FROM ops.installations ORDER BY started_at DESC LIMIT 5" 2>&1 | cut -c1-160 || echo '    реестра установок нет'
if [ -f ".local/kits/pins/$ID.json" ]; then
  echo "  закрепления: $(tr -d '\n ' <".local/kits/pins/$ID.json")"
else
  echo '  закреплений нет'
fi
for c in core web postgres; do
  echo "  $c: $(docker inspect -f '{{.Config.Image}} {{.Image}}' "$PROJECT-$c" 2>/dev/null | cut -c1-120 || echo 'нет контейнера')"
done
echo "  миграций: $(psql_env 'SELECT count(*) || '"'"' / последняя '"'"' || max(id) FROM public.schema_migrations')"
echo "  комплекты на узле: $(ls .local/kits | grep -v pins | tr '\n' ' ')"
