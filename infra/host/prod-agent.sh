#!/bin/bash
# Agent рабочей среды. Настройка приходит на вход: в ней только имена, значений нет.
set -Eeuo pipefail
ROOT=/opt/fifth-element
cd "$ROOT"
install -d -m 750 -o 1990 -g 1000 /etc/fifth-openbao/agent
cat >/etc/fifth-openbao/agent/agent.hcl
chown 1990:1000 /etc/fifth-openbao/agent/agent.hcl
chmod 440 /etc/fifth-openbao/agent/agent.hcl
chown -R 1990 /etc/fifth-openbao/approle/prod-core
# /run чистится при перезагрузке: каталог создаётся заново до запуска контейнеров.
install -o root -g root -m 644 infra/host/fifth-secrets.tmpfiles /etc/tmpfiles.d/fifth-secrets.conf
systemd-tmpfiles --create /etc/tmpfiles.d/fifth-secrets.conf
install -o root -g 1000 -m 440 /etc/fifth-openbao/tls/tls.crt "$ROOT/.local/secrets/openbao-ca.crt"
docker compose -p fifth-openbao -f infra/openbao/docker-compose.yml --profile agent up -d --force-recreate agent 2>&1 | tail -1 | cut -c1-120
sleep 5
for _ in $(seq 1 30); do
  [ -s /run/fifth-secrets/openbao-token ] && [ -s /run/fifth-secrets/POSTGRES_PASSWORD ] && break
  sleep 1
done
[ -s /run/fifth-secrets/openbao-token ] || { docker logs --tail 12 fifth-openbao-agent 2>&1 | cut -c1-200; exit 1; }
echo "Agent работает, файлов: $(find /run/fifth-secrets -type f | wc -l)"
stat -c '%a %u %g %n' /run/fifth-secrets /run/fifth-secrets/openbao-token
