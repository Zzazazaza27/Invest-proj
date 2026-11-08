#!/bin/bash
# Выпуск комплекта с миграциями в тестовую среду (выпуск W13–W21): копия базы среды, установка
# через release.mjs (блокировка, журнал, сверка), итог. Только test-1 и test-2; рабочая среда —
# prod-release.sh. Значений не печатает.
#
#   fifth-test op prod-env-release <среда> <сборка> <ожидаемая текущая> [--rollback]
set -Eeuo pipefail
ID="$1"
BUILD="$2"
EXPECT="$3"
ROLLBACK="${4:-}"
[[ "$ID" =~ ^test-[12]$ ]] || { echo 'среда: test-1 или test-2' >&2; exit 2; }
[[ "$BUILD" =~ ^[0-9]+\.[0-9]+-b[0-9]+\.[0-9]+$ ]] || { echo 'нужна сборка' >&2; exit 2; }
# none — в реестре среды ещё нет установок (среда ставилась env.mjs, не release.mjs).
[[ "$EXPECT" == none || "$EXPECT" =~ ^[0-9]+\.[0-9]+-b[0-9]+\.[0-9]+$ ]] || {
  echo 'нужна ожидаемая сборка или none' >&2
  exit 2
}
[[ -z "$ROLLBACK" || "$ROLLBACK" == --rollback ]] || { echo 'четвёртый аргумент — --rollback' >&2; exit 2; }
ROOT=/opt/fifth-element
DIR="$ROOT/.local/envs/$ID"
PROJECT="fifth-$ID"
DUMPS=/var/backups/fifth-element/release-dumps
cd "$ROOT"

# Копия базы среды до любых изменений: точка возврата данных на момент выпуска.
install -d -m 700 "$DUMPS"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="$DUMPS/$ID-$STAMP-before-$BUILD.dump"
docker exec -e PGPASSWORD="$(cat "$DIR/secrets/POSTGRES_PASSWORD")" "$PROJECT-postgres" \
  pg_dump -h 127.0.0.1 -U fifth_owner -d fifth_element -Fc >"$DUMP"
chmod 600 "$DUMP"
ENTRIES="$(docker exec -i "$PROJECT-postgres" pg_restore --list <"$DUMP" | grep -vc '^;')"
[ "$ENTRIES" -gt 100 ] || { echo "копия базы неполная: $ENTRIES записей" >&2; exit 1; }
MIGRATIONS="$(docker exec -e PGPASSWORD="$(cat "$DIR/secrets/POSTGRES_PASSWORD")" "$PROJECT-postgres" \
  psql -h 127.0.0.1 -U fifth_owner -d fifth_element -At -c 'SELECT count(*) FROM public.schema_migrations')"
echo "копия: $(basename "$DUMP"), записей $ENTRIES, миграций в базе $MIGRATIONS, $(du -h "$DUMP" | cut -f1)"

node scripts/kit.mjs check --build "$BUILD" | cut -c1-160
set +e
node scripts/release.mjs install "$ID" --kit "$BUILD" --expect "$EXPECT" \
  --actor maus --approved-by thomas $ROLLBACK | cut -c1-400
CODE="${PIPESTATUS[0]}"
# Отдельная итоговая сверка обязательна: её отказ — отказ шага, даже если установка
# сообщила успех. Печатается при любом исходе установки, для разбора.
node scripts/release.mjs verify "$ID" | cut -c1-400
VERIFY="${PIPESTATUS[0]}"
set -e
echo "закрепления: $(tr -d '\n ' <".local/kits/pins/$ID.json")"
echo "итог: установка $CODE, сверка $VERIFY"
[ "$CODE" = 0 ] || exit "$CODE"
[ "$VERIFY" = 0 ] || exit 1
