#!/bin/bash
# Установка защищённого установщика. Запускает Томас, этим же шагом обновляется копия инструментов.
#   prod-install-setup <открытый ключ подписи, base64> <открытый SSH-ключ CI, base64>
# Закрытых ключей здесь нет. Выдача ключа CI — это второй аргумент: без него учётка без входа.
set -Eeuo pipefail
SIGN="${1:?нужен открытый ключ подписи}"
SSH_KEY="${2:-}"
ROOT=/opt/fifth-element
TOOLS=/opt/fifth-install/tools
ETC=/etc/fifth-install
cd "$ROOT"
[ -z "$(git status --porcelain scripts infra/host)" ] || { echo 'рабочая копия изменена'; exit 1; }
install -d -o root -g root -m 755 /opt/fifth-install "$TOOLS"
rm -rf "$TOOLS/scripts"
cp -r scripts "$TOOLS/scripts"
chown -R root:root "$TOOLS"
chmod -R go-w "$TOOLS"
install -o root -g root -m 755 infra/host/fifth-install /usr/local/sbin/fifth-install
install -d -o root -g root -m 755 "$ETC"
printf %s "$SIGN" | base64 -d >"$ETC/kit-signing.pub"
chmod 644 "$ETC/kit-signing.pub"
cat >"$ETC/policy.json" <<JSON
{
  "env": "prod",
  "approvedBy": "thomas",
  "rollbackFloor": "2.1-b120.1",
  "postgresSource": "$(node scripts/kit.mjs source | sed -E 's/.*"source":"([0-9a-f]+)".*/\1/')",
  "launchFiles": $(FIFTH_ROOT="$ROOT" node "$TOOLS/scripts/infra.mjs" files 2>/dev/null),
  "watchSeconds": 180,
  "probeFile": "/var/lib/fifth-monitor/app-probe.json",
  "siteUrl": "https://5espace.com/v1/health",
  "siteCredentials": "/etc/fifth-gate/monitor.credentials"
}
JSON
chmod 644 "$ETC/policy.json"
id fifth-ci >/dev/null 2>&1 || useradd --system --create-home --shell /bin/sh fifth-ci
echo 'fifth-ci ALL=(root) NOPASSWD: /usr/local/sbin/fifth-install' >/etc/sudoers.d/92-fifth-ci
chmod 440 /etc/sudoers.d/92-fifth-ci
visudo -cf /etc/sudoers.d/92-fifth-ci >/dev/null
install -d -o fifth-ci -g fifth-ci -m 700 /home/fifth-ci/.ssh
if [ -n "$SSH_KEY" ]; then
  printf 'restrict,command="sudo -n /usr/local/sbin/fifth-install" %s\n' "$(printf %s "$SSH_KEY" | base64 -d)" \
    >/home/fifth-ci/.ssh/authorized_keys
  chown fifth-ci:fifth-ci /home/fifth-ci/.ssh/authorized_keys
  chmod 600 /home/fifth-ci/.ssh/authorized_keys
  echo 'ключ CI выдан'
else
  rm -f /home/fifth-ci/.ssh/authorized_keys
  echo 'ключа CI нет: вход закрыт'
fi
echo "установщик на коде $(git rev-parse --short HEAD)"
