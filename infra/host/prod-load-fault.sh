#!/bin/bash
# Управляемый отказ собственного контейнера test-1 под номинальной нагрузкой (W32, план,
# разделы 1 и 4). Только test-1: общие OpenBao и Garage не трогаются.
#
#   fifth-test op prod-load-fault queues                  очереди test-1 сейчас (одна строка)
#   fifth-test op prod-load-fault run <отказ> <collect_id>
#       отказ: core (kill и запуск) | postgres (60 с) | valkey (60 с) | nats (300 с)
#
# run: очереди до → окно отказа у сборщика (5xx не считать) → отказ → ожидание готовности →
# ожидание разгрузки очередей до исходного уровня (не дольше 10 мин) → окно закрыто.
# Вывод — строки CSV: E,<время>,<событие> и Q,<время>,<фаза>,<очереди…>.
# При любом выходе контейнер запускается снова и окно закрывается (trap).
set -u
PG=fifth-test-1-postgres
READY=http://127.0.0.1:18081/v1/ready
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
ev() { echo "E,$(now),$*"; }

pgq() {
  docker exec -i "$PG" sh -c 'PGPASSWORD="$(cat /run/secrets/POSTGRES_PASSWORD)" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d fifth_element -At -F","' 2>/dev/null
}
# outbox: не опубликовано, возраст старейшего, не разослано подписчикам;
# вебхуки в очереди; письма не завершены (pending, sending, unknown).
queues() {
  pgq <<'SQL'
SELECT
  (SELECT count(*) FROM audit.outbox_events WHERE published_at IS NULL),
  (SELECT coalesce(extract(epoch FROM now() - min(created_at))::int, 0)
     FROM audit.outbox_events WHERE published_at IS NULL),
  (SELECT count(*) FROM audit.outbox_events
    WHERE published_at IS NOT NULL AND fanout_completed_at IS NULL),
  (SELECT count(*) FROM integration.webhook_deliveries WHERE status IN ('queued','failed')),
  (SELECT count(*) FROM comms.mail_queue WHERE state IN ('pending','sending','unknown'));
SQL
}
q() { local v; v=$(queues); echo "Q,$(now),$1,${v:-нет ответа базы}"; }
ready() { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$READY")" = 200 ]; }

case "${1:-}" in
  queues)
    echo 'outbox_unpublished,outbox_oldest_s,outbox_fanout_pending,webhooks_pending,mail_pending'
    queues
    ;;
  run)
    kind="${2:-}"
    cid="${3:-}"
    [[ "$cid" =~ ^[A-Za-z0-9._-]{3,64}$ ]] || { echo 'нужен collect_id' >&2; exit 2; }
    case "$kind" in
      core) box=fifth-test-1-core; hold=5 ;;
      postgres) box=$PG; hold=60 ;;
      valkey) box=fifth-test-1-valkey; hold=60 ;;
      nats) box=fifth-test-1-nats; hold=300 ;;
      *) echo 'отказ: core | postgres | valkey | nats' >&2; exit 2 ;;
    esac
    window() { bash /opt/fifth-element/infra/host/prod-load-collect.sh window "$cid" "$1" >/dev/null 2>&1; }
    cleanup() {
      docker start "$box" >/dev/null 2>&1
      window off
    }
    trap cleanup EXIT
    ready || { ev 'test-1 не готова до отказа — отказ не выполняется'; exit 1; }
    echo 'type,ts,phase,outbox_unpublished,outbox_oldest_s,outbox_fanout_pending,webhooks_pending,mail_pending'
    q before
    base=$(queues | cut -d, -f1)
    window on
    if [ "$kind" = core ]; then
      docker kill "$box" >/dev/null && ev "kill $box"
    else
      docker stop -t 30 "$box" >/dev/null && ev "stop $box"
    fi
    t0=$(date +%s)
    while [ $(( $(date +%s) - t0 )) -lt "$hold" ]; do
      sleep 10
      [ "$kind" = postgres ] || q during
    done
    docker start "$box" >/dev/null && ev "start $box"
    t1=$(date +%s)
    until ready; do
      [ $(( $(date +%s) - t1 )) -gt 300 ] && { ev 'НЕ ГОТОВА 300 с после запуска'; exit 1; }
      sleep 2
    done
    ev "готова через $(( $(date +%s) - t1 )) с после запуска"
    # Разгрузка: не опубликованных outbox не больше, чем до отказа (+5 на текущую нагрузку).
    t2=$(date +%s)
    while :; do
      q after
      cur=$(queues | cut -d, -f1)
      if [ -n "$cur" ] && [ "$cur" -le $(( ${base:-0} + 5 )) ]; then
        ev "очередь outbox разгружена за $(( $(date +%s) - t2 )) с"; break
      fi
      [ $(( $(date +%s) - t2 )) -gt 600 ] && { ev 'outbox НЕ разгружен за 600 с'; exit 1; }
      sleep 10
    done
    # Сборщик считает 5xx за последнюю минуту: окно держится ещё 65 с, чтобы ошибки времени
    # отказа не остановили нагрузку, пока наблюдается восстановление.
    sleep 65
    q after
    window off
    ev 'окно отказа закрыто'
    ;;
  *)
    echo 'команды: queues, run <отказ> <collect_id>' >&2; exit 2
    ;;
esac
