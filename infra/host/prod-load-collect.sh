#!/bin/bash
# Сборщик показателей и пороги прекращения нагрузочного прогона на test-1 (блок 6, W32;
# условия Тэнка 09–10.11). Запускается шагом fifth-test op, работает в фоне на сервере.
#
#   fifth-test op prod-load-collect start <run_id> <секунд>   начать сбор (фон), не дольше срока
#   fifth-test op prod-load-collect status <run_id>           состояние и причина остановки
#   fifth-test op prod-load-collect window <run_id> on|off    окно управляемого отказа (5xx не считать)
#   fifth-test op prod-load-collect stop <run_id>             остановить сбор
#   fifth-test op prod-load-collect export <run_id>           выгрузка: ряды, журнал ядра, запросы БД
#
# Только чтение платформы: сборщик ничего не меняет в средах. Выгрузка без секретов,
# идентификаторов объектов и параметров запросов: метод, шаблон маршрута, статус, длительность.
#
# Пороги прекращения (план W32, раздел 2), проверка раз в 5 с:
#   доступная память VPS < 1024 МиБ; свободно на / < 20 ГиБ; load1 > 8 подряд 2 мин;
#   prod или test-2 /v1/ready не 200 дольше 30 с; соединения PostgreSQL test-1 > 90 % max;
#   5xx test-1 > 5 % за минуту (кроме окна управляемого отказа).
set -u
ROOT=/var/tmp/fifth-load
cmd="${1:-}"
id="${2:-}"
[[ "$id" =~ ^[A-Za-z0-9._-]{3,64}$ ]] || { echo 'нужен run_id' >&2; exit 2; }
DIR="$ROOT/$id"
PG=fifth-test-1-postgres
CORE=fifth-test-1-core

pgq() {
  docker exec -i "$PG" sh -c 'PGPASSWORD="$(cat /run/secrets/POSTGRES_PASSWORD)" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d fifth_element -At -F"|"' 2>/dev/null
}
ready() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1"; }
cpu() { awk '/^cpu /{print $2+$3, $4+$7+$8, $9, $2+$3+$4+$5+$6+$7+$8+$9}' /proc/stat; }

# Подробный срез (Тэнк 10.11) — приросты за интервал, а не накопленное с запуска:
#  host.csv    уровень ХОСТА: ожидание диска (ядер), PSI cpu/io/memory some — доля времени
#              интервала, когда хотя бы одна задача ждала ресурс (/proc/pressure, total)
#  cgroup.csv  уровень КОНТЕЙНЕРА (cgroup v2): CPU за интервал (ядер), периоды и время
#              торможения по квоте за интервал, PSI cpu some контейнера — доля интервала
#  valkey.csv  Valkey test-1: команд за интервал и среднее время команды на сервере (мкс)
#  dbwait.csv  PostgreSQL test-1: активные запросы и чем ждут (тип ожидания), срез
detail() {
  local ts="$1" now_us; now_us=$(date +%s%N); now_us=$(( now_us / 1000 ))
  local dt=$(( now_us - ${D_PREV_US:-$now_us} )); D_PREV_US=$now_us
  # --- хост
  local iow psi_c psi_i psi_m
  iow=$(awk '/^cpu /{print $6}' /proc/stat)
  psi_c=$(sed -nE 's/^some .*total=([0-9]+)/\1/p' /proc/pressure/cpu)
  psi_i=$(sed -nE 's/^some .*total=([0-9]+)/\1/p' /proc/pressure/io)
  psi_m=$(sed -nE 's/^some .*total=([0-9]+)/\1/p' /proc/pressure/memory)
  if [ "$dt" -gt 0 ] && [ -n "${H_IOW:-}" ]; then
    awk -v ts="$ts" -v dt="$dt" -v hz="$(getconf CLK_TCK)" -v iow=$((iow - H_IOW)) \
      -v c=$((psi_c - H_C)) -v i=$((psi_i - H_I)) -v m=$((psi_m - H_M)) \
      'BEGIN{printf "%s,%.2f,%.1f,%.1f,%.1f\n", ts, iow/hz/(dt/1e6), 100*c/dt, 100*i/dt, 100*m/dt}' >> "$DIR/host.csv"
  fi
  H_IOW=$iow; H_C=$psi_c; H_I=$psi_i; H_M=$psi_m
  # --- контейнеры
  local name full f u p t tu pr key
  while read -r name full; do
    f=/sys/fs/cgroup/system.slice/docker-$full.scope
    [ -r "$f/cpu.stat" ] || continue
    read -r u p t tu <<< "$(awk '/^usage_usec/{u=$2} /^nr_periods/{p=$2} /^nr_throttled/{t=$2} /^throttled_usec/{x=$2} END{print u+0, p+0, t+0, x+0}' "$f/cpu.stat")"
    pr=$(sed -nE 's/^some .*total=([0-9]+)/\1/p' "$f/cpu.pressure" 2>/dev/null)
    key=${name//-/_}
    local pu="C_U_$key" pp="C_P_$key" pt="C_T_$key" ptu="C_TU_$key" ppr="C_PR_$key"
    if [ "$dt" -gt 0 ] && [ -n "${!pu:-}" ] && [ "$u" -ge "${!pu}" ]; then
      awk -v ts="$ts" -v n="$name" -v dt="$dt" -v u=$((u - ${!pu})) -v p=$((p - ${!pp})) \
        -v t=$((t - ${!pt})) -v tu=$((tu - ${!ptu})) -v pr=$(( ${pr:-0} - ${!ppr:-0} )) \
        'BEGIN{printf "%s,%s,%.3f,%d,%d,%.1f,%.1f\n", ts, n, u/dt, p, t, tu/1000, 100*pr/dt}' >> "$DIR/cgroup.csv"
    fi
    printf -v "$pu" '%s' "$u"; printf -v "$pp" '%s' "$p"; printf -v "$pt" '%s' "$t"
    printf -v "$ptu" '%s' "$tu"; printf -v "$ppr" '%s' "${pr:-0}"
  done < <(docker ps --no-trunc --format '{{.Names}} {{.ID}}' |
    grep -E '^fifth-test-1-|^fifth-test-2-(core|postgres|valkey|nats) |^fifth-(core|postgres|valkey|nats|web) ')
  # --- Valkey test-1: команды и время на сервере (INFO commandstats — накопительное)
  local vs
  vs=$(docker exec fifth-test-1-valkey sh -c 'REDISCLI_AUTH="$(cat /run/secrets/REDIS_PASSWORD)" valkey-cli INFO commandstats' 2>/dev/null |
    awk -F'[:=,]' '/^cmdstat_/{c+=$3; u+=$5} END{print c+0, u+0}')
  local vc vu; read -r vc vu <<< "$vs"
  if [ -n "${V_C:-}" ] && [ "${vc:-0}" -ge "$V_C" ]; then
    awk -v ts="$ts" -v c=$((vc - V_C)) -v u=$((vu - V_U)) \
      'BEGIN{printf "%s,%d,%.1f\n", ts, c, (c > 0 ? u/c : 0)}' >> "$DIR/valkey.csv"
  fi
  V_C=$vc; V_U=$vu
  # --- ожидания PostgreSQL test-1 (срез)
  echo "SELECT '$ts', count(*) FILTER (WHERE state = 'active'), coalesce(string_agg(w, ';'), '') FROM (SELECT state, CASE WHEN state = 'active' AND wait_event_type IS NOT NULL THEN wait_event_type || '/' || wait_event END AS w FROM pg_stat_activity WHERE datname = 'fifth_element' AND pid <> pg_backend_pid()) s;" | pgq >> "$DIR/dbwait.csv"
}

collect() {
  local until=$(( $(date +%s) + $1 ))
  local max_conn; max_conn=$(echo 'SHOW max_connections;' | pgq)
  echo 'SELECT pg_stat_statements_reset();' | pgq > /dev/null
  echo 'ts,cpu_user,cpu_sys,cpu_steal,mem_avail_mib,disk_free_gib,load1,pg_conn,pg_max,prod_ready,test2_ready,t1_req,t1_5xx' > "$DIR/vps.csv"
  echo 'ts,name,cpu_pct,mem' > "$DIR/containers.csv"
  echo 'ts,iowait_cores,psi_cpu_some_pct,psi_io_some_pct,psi_mem_some_pct  # уровень: хост' > "$DIR/host.csv"
  echo 'ts,name,cpu_cores,periods,throttled_periods,throttled_ms,psi_cpu_some_pct  # уровень: контейнер (cgroup), приросты за ~10 с' > "$DIR/cgroup.csv"
  echo 'ts,commands,avg_usec_per_command  # Valkey test-1, время на сервере' > "$DIR/valkey.csv"
  echo 'ts|active|waits  # PostgreSQL test-1, срез pg_stat_activity' > "$DIR/dbwait.csv"
  local high_load=0 prod_bad=0 t2_bad=0
  read -r u0 k0 s0 a0 <<< "$(cpu)"
  while [ "$(date +%s)" -lt "$until" ] && [ ! -f "$DIR/stop-request" ]; do
    sleep 5
    local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    read -r u1 k1 s1 a1 <<< "$(cpu)"
    local da=$(( a1 - a0 )); [ "$da" -gt 0 ] || da=1
    local cu cs st
    cu=$(awk -v d=$((u1-u0)) -v a=$da -v n="$(nproc)" 'BEGIN{printf "%.2f", n*d/a}')
    cs=$(awk -v d=$((k1-k0)) -v a=$da -v n="$(nproc)" 'BEGIN{printf "%.2f", n*d/a}')
    st=$(awk -v d=$((s1-s0)) -v a=$da -v n="$(nproc)" 'BEGIN{printf "%.2f", n*d/a}')
    u0=$u1; k0=$k1; s0=$s1; a0=$a1
    local mem disk load1 conn pr t2
    mem=$(awk '/^MemAvailable:/{printf "%d", $2/1024}' /proc/meminfo)
    disk=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
    load1=$(cut -d' ' -f1 /proc/loadavg)
    conn=$(echo 'SELECT count(*) FROM pg_stat_activity;' | pgq)
    pr=$(ready http://127.0.0.1:8080/v1/ready)
    t2=$(ready http://127.0.0.1:18082/v1/ready)
    # 5xx test-1 за последнюю минуту — по журналу ядра.
    local req err
    read -r req err <<< "$(docker logs --since 60s "$CORE" 2>&1 | grep -o '"status":[0-9]*' | awk -F: '{n++; if ($2>=500) e++} END{print n+0, e+0}')"
    echo "$ts,$cu,$cs,$st,$mem,$disk,$load1,$conn,$max_conn,$pr,$t2,$req,$err" >> "$DIR/vps.csv"
    docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' | grep -E '^fifth-test-1-|^fifth-(core|postgres|web),' | sed "s#^#$ts,#" >> "$DIR/containers.csv"
    # Подробности — раз в 10 с (каждый второй проход): дешевле для самой системы.
    tick=$(( ${tick:-0} + 1 ))
    [ $(( tick % 2 )) -eq 0 ] && detail "$ts"
    # Пороги.
    local why=''
    [ "${mem:-0}" -lt 1024 ] && why="доступная память ${mem} МиБ < 1024"
    [ -z "$why" ] && [ "${disk:-0}" -lt 20 ] && why="свободно на диске ${disk} ГиБ < 20"
    if awk -v l="$load1" 'BEGIN{exit !(l > 8)}'; then high_load=$((high_load+1)); else high_load=0; fi
    [ -z "$why" ] && [ "$high_load" -ge 24 ] && why="load1 > 8 дольше 2 мин"
    if [ "$pr" = 200 ]; then prod_bad=0; else prod_bad=$((prod_bad+1)); fi
    if [ "$t2" = 200 ]; then t2_bad=0; else t2_bad=$((t2_bad+1)); fi
    [ -z "$why" ] && [ "$prod_bad" -ge 6 ] && why="prod /v1/ready не 200 дольше 30 с ($pr)"
    [ -z "$why" ] && [ "$t2_bad" -ge 6 ] && why="test-2 /v1/ready не 200 дольше 30 с ($t2)"
    if [ -z "$why" ] && [ -n "$max_conn" ] && [ "${conn:-0}" -gt $(( max_conn * 9 / 10 )) ]; then
      why="соединений PostgreSQL test-1 $conn > 90 % из $max_conn"
    fi
    if [ -z "$why" ] && [ ! -f "$DIR/failure-window" ] && [ "${req:-0}" -ge 20 ] && [ $(( err * 100 )) -gt $(( req * 5 )) ]; then
      why="5xx test-1 $err из $req за минуту > 5 %"
    fi
    if [ -n "$why" ]; then
      echo "$ts $why" > "$DIR/STOP"
      echo "остановка: $why" >> "$DIR/collector.log"
      break
    fi
  done
  date -u +%Y-%m-%dT%H:%M:%SZ > "$DIR/finished"
}

case "$cmd" in
  start)
    secs="${3:-}"
    [[ "$secs" =~ ^[0-9]+$ ]] && [ "$secs" -le 14400 ] || { echo 'нужен срок, не больше 14400 с' >&2; exit 2; }
    if [ -f "$DIR/pid" ] && kill -0 "$(cat "$DIR/pid")" 2>/dev/null; then echo 'сбор уже идёт' >&2; exit 2; fi
    rm -rf "$DIR"; mkdir -p "$DIR"; chmod 700 "$ROOT" "$DIR"
    date -u +%Y-%m-%dT%H:%M:%SZ > "$DIR/started"
    ( setsid bash "$0" __collect "$id" "$secs" > "$DIR/collector.log" 2>&1 & echo $! > "$DIR/pid" )
    echo "сбор начат: $id на $secs с"
    ;;
  __collect)
    collect "$3"
    ;;
  status)
    [ -d "$DIR" ] || { echo 'нет такого сбора'; exit 1; }
    if [ -f "$DIR/STOP" ]; then echo "STOP $(cat "$DIR/STOP")"
    elif [ -f "$DIR/finished" ]; then echo "finished $(cat "$DIR/finished")"
    else echo "running $(tail -1 "$DIR/vps.csv" 2>/dev/null)"; fi
    ;;
  window)
    [ "${3:-}" = on ] && touch "$DIR/failure-window" || rm -f "$DIR/failure-window"
    echo "окно отказа: ${3:-off}"
    ;;
  stop)
    touch "$DIR/stop-request"
    for _ in $(seq 1 15); do [ -f "$DIR/finished" ] && break; sleep 1; done
    echo "сбор остановлен: $(cat "$DIR/finished" 2>/dev/null || echo 'не подтверждено')"
    ;;
  export)
    [ -d "$DIR" ] || { echo 'нет такого сбора' >&2; exit 1; }
    since=$(cat "$DIR/started"); till=$(cat "$DIR/finished" 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)
    echo '### vps.csv'; cat "$DIR/vps.csv"
    echo '### containers.csv'; cat "$DIR/containers.csv"
    echo '### stop'; cat "$DIR/STOP" 2>/dev/null || echo 'нет'
    for f in host.csv cgroup.csv valkey.csv dbwait.csv; do
      [ -f "$DIR/$f" ] && { echo "### $f"; cat "$DIR/$f"; }
    done
    echo '### core-requests.csv'
    echo 'time,method,route,status,duration_ms'
    # Из journald (переживает пересоздание контейнера, prod-env-journald); нет записей —
    # из журнала контейнера.
    { journalctl CONTAINER_NAME="$CORE" --since "${since/T/ }" --until "${till/T/ }" -o cat 2>/dev/null | grep -q . &&
        journalctl CONTAINER_NAME="$CORE" --since "${since/T/ }" --until "${till/T/ }" -o cat 2>/dev/null ||
        docker logs --since "$since" --until "$till" "$CORE" 2>&1; } | grep '"msg":"запрос"' |
      sed -nE 's/.*"t":"([^"]*)".*"method":"([A-Z]+)","route":"([^"]*)","status":([0-9]+),"durationMs":([0-9]+).*/\1,\2,\3,\4,\5/p'
    echo '### pg-statements.csv'
    echo "SELECT calls, round(total_exec_time::numeric, 1), round(mean_exec_time::numeric, 2), left(regexp_replace(query, '\\s+', ' ', 'g'), 120) FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 40;" | pgq
    ;;
  *)
    echo 'команды: start, status, window, stop, export' >&2; exit 2
    ;;
esac
