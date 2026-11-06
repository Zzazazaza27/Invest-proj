#!/bin/bash
# Запас узла под ещё одну среду. Только чтение.
free -m | sed -n 1,3p
df -h / /var/backups 2>/dev/null | cut -c1-60
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' | awk '{print $1, $2}' | sort -k2 -h | tail -24
ls /opt/fifth-element/.local/envs
