#!/bin/bash
# Запас узла под ещё одну среду: сейчас и наблюдённые пики. Только чтение.
free -m | sed -n 1,3p
nproc
df -h / | cut -c1-60
du -sh /var/backups/fifth-element /var/lib/docker 2>/dev/null
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' | awk '{print $1, $2}' | sort -k2 -h | tail -24
cd /opt/fifth-element && node scripts/monitoring.mjs peaks 2>&1 | tail -3
