#!/bin/bash
# Копия пилотной среды вручную, с итогом.
cd /opt/fifth-element
bash -x infra/host/pilot-backup.sh 2>&1 | grep -vE "PASSWORD|SECRET|secret|access=" | tail -12 | cut -c1-200
cat /var/lib/fifth-monitor/pilot-backup.json
