#!/bin/bash
# Что нагружает VPS — только чтение (W32). Имена процессов без аргументов: в аргументах
# могут быть секреты.
#   fifth-test op prod-host-top
set -u
uptime
echo '== vmstat 1 5 (r — ждут CPU, b — ждут ввода-вывода, wa — ожидание диска, st — кража)'
vmstat 1 5
echo '== давление (PSI)'
for r in cpu io memory; do echo "$r: $(head -1 /proc/pressure/$r 2>/dev/null)"; done
echo '== процессы по CPU (имя без аргументов)'
ps -eo pid,user,pcpu,pmem,stat,etime,comm --sort=-pcpu | head -25
echo '== число процессов по имени (топ 15)'
ps -eo comm= | sort | uniq -c | sort -rn | head -15
echo '== состояния R и D'
ps -eo stat= | cut -c1 | sort | uniq -c
# Торможение по квоте CPU (cgroup v2 cpu.stat): периоды, в которых контейнер упёрся в квоту,
# и суммарное время торможения с запуска контейнера.
echo '== торможение по квоте CPU: контейнер, периодов, заторможено, время торможения с'
for id in $(docker ps -q); do
  name=$(docker inspect -f '{{.Name}}' "$id" | tr -d /)
  full=$(docker inspect -f '{{.Id}}' "$id")
  f=/sys/fs/cgroup/system.slice/docker-$full.scope/cpu.stat
  [ -r "$f" ] || continue
  awk -v n="$name" '/^nr_periods/{p=$2} /^nr_throttled/{t=$2} /^throttled_usec/{u=$2}
    END{if (p>0) printf "%-26s %9d %8d %8.1f\n", n, p, t, u/1e6}' "$f"
done | sort -k4 -rn
