# Копия при недоступных файлах секретов (блок 5, задание 5). Подключается из test-probe.sh.
# Те же команды `backup.mjs` и то же чтение `<ИМЯ>_FILE`, значения искусственные. Свои база,
# каталог копий и `.env`: рабочая среда, её Agent и её копии не затрагиваются.
say 'площадка копии'
SANDBOX="$WORK/root"
SECRETS="$WORK/secrets"
BACKUP="$WORK/backup"
PG="$PROJECT-backup-pg"
SECRET=BACKUP_PGBACKREST_CIPHER_PASS
mkdir -p "$SANDBOX" "$SECRETS" "$BACKUP/pgbackrest"
cp -r scripts package.json "$SANDBOX/"
ln -s "$ROOT/node_modules" "$SANDBOX/node_modules"
(umask 077
  openssl rand -hex 24 >"$SECRETS/$SECRET"
  openssl rand -hex 24 >"$SECRETS/POSTGRES_PASSWORD")
cat >"$SANDBOX/.env" <<ENV
BACKUP_DIR=$BACKUP
BACKUP_KEYS_RECIPIENT=$ROOT/infra/openbao/thomas-recipient.asc
${SECRET}_FILE=$SECRETS/$SECRET
POSTGRES_PASSWORD_FILE=$SECRETS/POSTGRES_PASSWORD
ENV
chown 999:999 "$BACKUP/pgbackrest"
docker run -d --name "$PG" --network none \
  -e POSTGRES_USER=unicorn_owner -e POSTGRES_DB=fifth_element \
  -e POSTGRES_PASSWORD="$(cat "$SECRETS/POSTGRES_PASSWORD")" \
  -e PGBACKREST_STANZA=main -e PGBACKREST_PG1_PATH=/var/lib/postgresql/data \
  -e PGBACKREST_PG1_USER=unicorn_owner -e PGBACKREST_PG1_DATABASE=fifth_element \
  -e PGBACKREST_REPO1_PATH=/var/lib/pgbackrest -e PGBACKREST_REPO1_CIPHER_TYPE=aes-256-cbc \
  -e PGBACKREST_REPO1_CIPHER_PASS="$(cat "$SECRETS/$SECRET")" \
  -e PGBACKREST_LOG_LEVEL_FILE=off -e PGBACKREST_LOG_LEVEL_CONSOLE=warn \
  -v "$BACKUP/pgbackrest:/var/lib/pgbackrest" \
  --entrypoint docker-entrypoint.sh "fifth/postgres:$BUILD" postgres \
  -c wal_level=replica -c archive_mode=on -c 'archive_command=pgbackrest archive-push %p' >/dev/null
for _ in $(seq 1 40); do
  docker exec "$PG" psql -U unicorn_owner -d fifth_element -Atc 'select 1' >/dev/null 2>&1 && break
  sleep 1
done
job() { (cd "$SANDBOX" && BACKUP_PG_CONTAINER="$PG" node scripts/backup.mjs "$@"); }
signals() {
  node -e "
const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
for (const k of process.argv.slice(2)) console.log(k + ': ' + (s[k]?.status ?? 'нет'));
" "$BACKUP/state/signals.json" job-db job-set secrets
}

say 'копия при читаемых файлах'
job db | tail -1 | cut -c1-100
job check >/dev/null
signals

say 'файл секрета недоступен'
value="$(cat "$SECRETS/$SECRET")"
mv "$SECRETS/$SECRET" "$WORK/secret.away"
for command in db set; do
  if out="$(job "$command" 2>&1)"; then
    echo "$command прошла без файла секрета"
    false
  fi
  echo "$out" | tail -1 | cut -c1-160
  echo "$out" | grep -q 'не читается'
  if echo "$out" | grep -qF "$value"; then
    echo 'значение попало в вывод'
    false
  fi
done
job check >/dev/null
signals
signals | grep -q 'job-db: problem'
signals | grep -q 'job-set: problem'
signals | grep -q 'secrets: problem'
echo 'отказ явный, проблема в сигналах наблюдения'

say 'файл вернулся'
mv "$WORK/secret.away" "$SECRETS/$SECRET"
job db | tail -1 | cut -c1-100
job check >/dev/null
signals
signals | grep -q 'job-db: ok'
signals | grep -q 'secrets: ok'
echo 'повтор прошёл, проблема снята'

docker rm -f -v "$PG" >/dev/null
trap - ERR
report 'копия: отказ без файла секрета, сигнал и повтор проверены'
