#!/bin/bash
# Короткий контроль рабочей среды после установки (выпуск W13–W21, п. 5 плана). Без
# пользовательских записей: читает существующие данные служебной учёткой наблюдения, проходит
# пароль Caddy её учёткой, пишет одно диагностическое сообщение в приёмник ошибок. Значений не
# печатает.
#
#   fifth-test op prod-control
set -Eeuo pipefail
ROOT=/opt/fifth-element
SITE=https://5espace.com
CREDENTIALS=/etc/fifth-gate/monitor.credentials
cd "$ROOT"
FAIL=0
ok() { echo "  OK    $1"; }
bad() {
  echo "  FAIL  $1"
  FAIL=1
}
url="$(sed -E 's#@[^/]*/#@127.0.0.1:5432/#' /run/fifth-secrets/DATABASE_URL_OWNER)"
q() { docker exec -e URL="$url" fifth-postgres sh -c "psql \"\$URL\" -At -c \"$1\""; }
# Учётка наблюдения — из файла, в командной строке и выводе её нет.
auth() { curl -s --max-time 20 -K <(printf 'user = "%s"\n' "$(cat "$CREDENTIALS")") "$@"; }

echo '▸ контроль prod'
v="$(node scripts/release.mjs verify prod | cut -c1-300)"
echo "  ·     сверка: $v"
[[ "$v" == *'"ok":true'* ]] && ok 'сверка образов и миграций' || bad 'сверка'

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$SITE/v1/ready")"
[ "$code" = 401 ] && ok "без пароля Caddy — $code" || bad "без пароля Caddy — $code"
for path in /v1/ready / /lab/ /login/ /v1/features; do
  code="$(auth -o /dev/null -w '%{http_code}' "$SITE$path")"
  [ "$code" = 200 ] && ok "через Caddy с учёткой наблюдения $path — $code" || bad "$path — $code"
done

# Существующие данные через ядро: служебный вход и чтение контрольного проекта и его файла.
before="$(stat -c %Y /var/lib/fifth-monitor/app-probe.json 2>/dev/null || echo 0)"
systemctl start fifth-monitor-app-probe.service || true
for _ in $(seq 1 60); do
  [ "$(stat -c %Y /var/lib/fifth-monitor/app-probe.json 2>/dev/null || echo 0)" -gt "$before" ] && break
  sleep 2
done
if [ "$(stat -c %Y /var/lib/fifth-monitor/app-probe.json)" -gt "$before" ] &&
  grep -q '"ok": *true' /var/lib/fifth-monitor/app-probe.json; then
  ok 'служебный вход: контрольный проект и его файл прочитаны через ядро'
else
  bad 'служебное чтение контрольных данных не прошло'
fi

echo "  ·     миграций: $(q "SELECT count(*) || ' / последняя ' || max(id) FROM public.schema_migrations")"
echo "  ·     группы: $(q "SELECT string_agg(g, ' ' ORDER BY g) FROM (SELECT group_id || ':' || mode || '=' || CASE WHEN bool_and(ok) THEN 'ok' ELSE 'нет(' || string_agg(DISTINCT reason, ',') || ')' END AS g FROM availability.observations WHERE NOT stopped AND valid_until > now() GROUP BY group_id, mode) s")"
echo "  ·     outbox: $(q "SELECT count(*) || ' неопубликованных, старейшее ' || coalesce(extract(epoch FROM now() - min(created_at))::int::text || ' с', '—') FROM audit.outbox_events WHERE published_at IS NULL")"
echo "  ·     outbox за 10 мин: $(q "SELECT count(*) FILTER (WHERE published_at IS NOT NULL) || ' опубликовано из ' || count(*) FROM audit.outbox_events WHERE created_at > now() - interval '10 minutes'")"
echo "  ·     данные: $(q "SELECT 'пользователей ' || (SELECT count(*) FROM identity.users) || ', проектов ' || (SELECT count(*) FROM lab.projects)")"
restarts="$(docker inspect -f '{{.RestartCount}}' fifth-core)"
[ "$restarts" = 0 ] && ok 'ядро без перезапусков' || bad "перезапусков ядра: $restarts"

RID="$(cat /proc/sys/kernel/random/uuid)"
body="{\"cabinet\":\"lab\",\"screen\":\"/\",\"version\":\"unknown\",\"code\":\"js.uncaught\",\"stage\":\"unknown\",\"requestId\":\"$RID\",\"count\":1}"
code="$(auth -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H "Origin: $SITE" --data "$body" "$SITE/v1/client-errors")"
if [ "$code" = 202 ]; then
  ok 'приём ошибок интерфейса через Caddy — 202'
  sleep 2
  docker logs --since 2m fifth-core 2>&1 | grep "$RID" | grep -q '"reported":"browser"' &&
    ok 'запись reported: browser в журнале ядра' || bad 'записи в журнале ядра нет'
else
  bad "приём ошибок интерфейса — $code"
fi
code="$(auth -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H 'Origin: https://evil.example' --data "$body" "$SITE/v1/client-errors")"
[ "$code" = 403 ] && ok "чужой Origin — $code" || bad "чужой Origin — $code"

[ "$FAIL" = 0 ] && echo '▸ контроль пройден' || echo '▸ контроль НЕ пройден'
exit "$FAIL"
