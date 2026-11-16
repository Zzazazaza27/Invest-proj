#!/bin/bash
# Сигналы резервирования в состоянии «problem» (то, что Zabbix показывает тревогой
# «Резервирование: есть проблемы») — только чтение, без значений секретов.
#
#   fifth-test op prod-backup-problems
set -Eeuo pipefail
F=/var/backups/fifth-element/state/signals.json
[ -f "$F" ] || { echo "нет $F" >&2; exit 2; }
echo "сигналы от $(date -u -r "$F" +%Y-%m-%dT%H:%M:%SZ)"
node -e '
const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const bad = Object.entries(s).filter(([, v]) => v && v.status === "problem");
if (!bad.length) console.log("проблем нет");
for (const [k, v] of bad) {
  const { status, ...rest } = v;
  console.log(`${k}: ${JSON.stringify(rest).slice(0, 400)}`);
}' "$F"
