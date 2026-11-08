#!/bin/bash
# Короткий контроль тестовой среды после установки (выпуск W13–W21, п. 5 плана). Значений не
# печатает. Пишущие действия: одно сообщение в приёмник ошибок и, с --write, один пробный
# пользователь с обращением в поддержку (проверка ключа повтора) — только для test-1.
#
#   fifth-test op prod-env-control <среда> [--write]
set -Eeuo pipefail
ID="$1"
WRITE="${2:-}"
[[ "$ID" =~ ^test-[12]$ ]] || { echo 'среда: test-1 или test-2' >&2; exit 2; }
[[ -z "$WRITE" || ( "$WRITE" == --write && "$ID" == test-1 ) ]] || {
  echo '--write только для test-1' >&2
  exit 2
}
ROOT=/opt/fifth-element
DIR="$ROOT/.local/envs/$ID"
PROJECT="fifth-$ID"
PORT="$(sed -n 's/^FIFTH_WEB_PORT=//p' "$DIR/compose.env")"
BASE="http://127.0.0.1:$PORT"
ORIGIN="$(sed -n 's/^PUBLIC_BASE_URL=//p' "$DIR/settings.env" | head -1)"
[ -n "$ORIGIN" ] || ORIGIN="$BASE"
ORIGIN="$(node -e 'console.log(new URL(process.argv[1]).origin)' "$ORIGIN")"
FAIL=0
ok() { echo "  OK    $1"; }
bad() {
  echo "  FAIL  $1"
  FAIL=1
}
psql_env() {
  docker exec -e PGPASSWORD="$(cat "$DIR/secrets/POSTGRES_PASSWORD")" "$PROJECT-postgres" \
    psql -h 127.0.0.1 -U fifth_owner -d fifth_element -At -c "$1"
}
cd "$ROOT"

echo "▸ контроль $ID"
if docker exec "$PROJECT-core" node -e \
  "fetch('http://127.0.0.1:4400/ready').then((r)=>process.exit(r.status===200?0:1),()=>process.exit(1))"; then
  ok '/ready ядра — 200'
else
  bad '/ready ядра не 200'
fi
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/ready")"
[ "$code" = 200 ] && ok "публичный /v1/ready через web — $code" || bad "публичный /v1/ready — $code"

echo "  ·     миграций: $(psql_env 'SELECT count(*) || '"'"' / последняя '"'"' || max(id) FROM public.schema_migrations')"
groups="$(psql_env "SELECT string_agg(g, ' ' ORDER BY g) FROM (SELECT group_id || ':' || mode || '=' || CASE WHEN bool_and(ok) THEN 'ok' ELSE 'нет(' || string_agg(DISTINCT reason, ',') || ')' END AS g FROM availability.observations WHERE NOT stopped AND valid_until > now() GROUP BY group_id, mode) s" 2>/dev/null || echo 'таблицы групп нет (прежний комплект)')"
echo "  ·     группы: ${groups:-нет действующих наблюдений}"
backlog="$(psql_env "SELECT count(*) || ' неопубликованных, старейшее ' || coalesce(extract(epoch FROM now() - min(created_at))::int::text || ' с', '—') FROM audit.outbox_events WHERE published_at IS NULL")"
echo "  ·     outbox: $backlog"
# Застрявшие события: тип, попытки, возраст — чтобы отличить исчерпанные старые от растущего потока.
echo "  ·     outbox старше часа: $(psql_env "SELECT coalesce(string_agg(event_type || ' попыток ' || attempts || ' возраст ' || extract(epoch FROM now() - created_at)::int || ' с', '; '), 'нет') FROM audit.outbox_events WHERE published_at IS NULL AND created_at < now() - interval '1 hour'")"
echo "  ·     outbox за 10 мин: $(psql_env "SELECT count(*) FILTER (WHERE published_at IS NOT NULL) || ' опубликовано из ' || count(*) FROM audit.outbox_events WHERE created_at > now() - interval '10 minutes'")"
restarts="$(docker inspect -f '{{.RestartCount}}' "$PROJECT-core")"
[ "$restarts" = 0 ] && ok 'ядро без перезапусков' || bad "перезапусков ядра: $restarts"

RID="$(cat /proc/sys/kernel/random/uuid)"
body="{\"cabinet\":\"lab\",\"screen\":\"/\",\"version\":\"unknown\",\"code\":\"js.uncaught\",\"stage\":\"unknown\",\"requestId\":\"$RID\",\"count\":1}"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H "Origin: $ORIGIN" --data "$body" "$BASE/v1/client-errors")"
if [ "$code" = 202 ]; then
  ok 'приём ошибок интерфейса — 202'
  sleep 1
  if docker logs --since 2m "$PROJECT-core" 2>&1 | grep "$RID" | grep -q '"reported":"browser"'; then
    ok 'запись reported: browser в журнале ядра'
  else
    bad 'записи в журнале ядра нет'
  fi
elif [ "$code" = 404 ]; then
  echo "  ·     приёмника ошибок нет (прежний комплект) — $code"
else
  bad "приём ошибок интерфейса — $code"
fi
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H 'Origin: https://evil.example' --data "$body" "$BASE/v1/client-errors")"
[ "$code" = 403 ] || [ "$code" = 404 ] && ok "чужой Origin — $code" || bad "чужой Origin — $code"

if [ "$WRITE" = --write ]; then
  jar="$(mktemp)"
  email="ctl-$(date +%s)@test.local"
  pass="Pw-$(cat /proc/sys/kernel/random/uuid)"
  code="$(curl -s -o /dev/null -w '%{http_code}' -c "$jar" -X POST -H 'Content-Type: application/json' -H "Origin: $ORIGIN" \
    --data "{\"email\":\"$email\",\"password\":\"$pass\",\"displayName\":\"Контроль выпуска\",\"role\":\"founder\",\"locale\":\"ru-RU\",\"consents\":[{\"kind\":\"platform_rules\",\"version\":\"v1\",\"locale\":\"ru-RU\"},{\"kind\":\"tos\",\"version\":\"v1\",\"locale\":\"ru-RU\"},{\"kind\":\"pdn\",\"version\":\"v1\",\"locale\":\"ru-RU\"},{\"kind\":\"commission_terms\",\"version\":\"v1\",\"locale\":\"ru-RU\"}]}" \
    "$BASE/v1/auth/register")"
  [ "$code" -lt 300 ] && ok "вход пробного пользователя — $code" || bad "регистрация — $code"
  csrf="$(awk '$6 ~ /csrf/ {print $7}' "$jar" | tail -1)"
  key="$(cat /proc/sys/kernel/random/uuid)"
  t1="$(curl -s -b "$jar" -X POST -H 'Content-Type: application/json' -H "Origin: $ORIGIN" -H "X-CSRF-Token: $csrf" -H "Idempotency-Key: $key" \
    --data '{"kind":"support","subject":"Контроль выпуска","body":"Повтор с тем же ключом"}' "$BASE/v1/support/tickets" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).id??"")}catch{console.log("")}})')"
  t2="$(curl -s -b "$jar" -X POST -H 'Content-Type: application/json' -H "Origin: $ORIGIN" -H "X-CSRF-Token: $csrf" -H "Idempotency-Key: $key" \
    --data '{"kind":"support","subject":"Контроль выпуска","body":"Повтор с тем же ключом"}' "$BASE/v1/support/tickets" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).id??"")}catch{console.log("")}})')"
  [ -n "$t1" ] && [ "$t1" = "$t2" ] && ok 'обращение с ключом повтора — повтор даёт прежний результат' || bad 'повтор обращения с ключом не дал прежний результат'
  rm -f "$jar"
fi

[ "$FAIL" = 0 ] && echo '▸ контроль пройден' || echo '▸ контроль НЕ пройден'
exit "$FAIL"
