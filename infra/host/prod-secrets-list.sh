#!/bin/bash
# Какие файлы прежних секретов ещё нужны. Только имена, значений не печатает.
set -uo pipefail
cd /opt/fifth-element
dir="$(sed -n 's/^FIFTH_SECRETS_DIR=//p' .env)"
echo "каталог: $dir"
echo '== строки _FILE в .env: куда ведут'
grep -E '^[A-Z0-9_]+_FILE=' .env | sed -E 's/^([A-Z0-9_]+)_FILE=(.*)$/\2 \1/' | awk '{d=$1; sub(/\/[^\/]*$/,"",d); c[d]++} END {for (k in c) print c[k], k}'
echo '== файлы каталога, на которые .env не ссылается'
for f in "$dir"/*; do
  n="$(basename "$f")"
  grep -qE "_FILE=.*/$n\$" .env || echo "$n"
done
echo '== файлы каталога, на которые .env ссылается'
for f in "$dir"/*; do
  n="$(basename "$f")"
  grep -qE "_FILE=.*/$n\$" .env && echo "$n"
done | tr '\n' ' '
echo
echo '== файлы /run/fifth-secrets'
ls /run/fifth-secrets | wc -l
echo '== точки возврата .env'
ls -la .local/ | grep -E 'env-before' | awk '{print $6,$7,$8,$9}'
echo '== кто читает каталог'
grep -rln 'FIFTH_SECRETS_DIR\|\.local/secrets' scripts infra --include=* 2>/dev/null | head -12
echo '== закрепления'
node scripts/kit.mjs pins --env prod 2>&1 | tail -4 | cut -c1-120
