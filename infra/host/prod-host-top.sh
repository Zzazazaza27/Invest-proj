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
