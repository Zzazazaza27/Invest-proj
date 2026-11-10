#!/bin/bash
# Отказы ядра среды по журналу — только чтение (W32, разбор ошибок прогона).
#   fifth-test op prod-core-refusals <test-1|test-2> <с: 2026-11-10T10:00:00Z> <по> [статусы, по умолчанию 401,422]
# Строки журнала запросов ядра (main.ts, 8.4): время, метод, ШАБЛОН маршрута, статус, код
# результата, requestId, длительность. Адресов, параметров и тел в этой строке нет.
# Источники: journald (CONTAINER_NAME) и журнал контейнера (json-file; пропадает при
# пересоздании контейнера) — печатается, где что нашлось.
set -u
env="${1:-}"
case "$env" in
  test-1|test-2) box="fifth-$env-core" ;;
  *) echo 'среда: test-1 | test-2' >&2; exit 2 ;;
esac
from="${2:-}"; to="${3:-}"; st="${4:-401,422}"
iso='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
[[ "$from" =~ $iso && "$to" =~ $iso ]] || { echo 'время: 2026-11-10T10:00:00Z' >&2; exit 2; }
[[ "$st" =~ ^[0-9]{3}(,[0-9]{3})*$ ]] || { echo 'статусы: 401,422' >&2; exit 2; }
re="\"status\":($(echo "$st" | tr ',' '|'))[,}]"
pick() {
  grep -E '"msg":"запрос"' | grep -E "$re" |
    sed -nE 's/.*"t":"([^"]*)".*"method":"([A-Z]+)","route":"([^"]*)","status":([0-9]+),"durationMs":([0-9]+)(,"code":"([^"]*)")?.*"requestId":"([^"]*)".*/\1 \2 \3 \4 code=\7 requestId=\8 \5мс/p'
}
echo "== journald ($box)"
n=$(journalctl CONTAINER_NAME="$box" --since "${from/T/ }" --until "${to/T/ }" -o cat 2>/dev/null | pick | tee /dev/stderr | wc -l)
echo "строк: $n"
echo "== журнал контейнера ($box, создан $(docker inspect -f '{{.Created}}' "$box" 2>/dev/null))"
n=$(docker logs --since "$from" --until "$to" "$box" 2>&1 | pick | tee /dev/stderr | wc -l)
echo "строк: $n"
