#!/bin/bash
# Сетевая диагностика из работающего ядра test-1 (только чтение): имя, TCP и HTTPS по шагам.
#
#   fifth-test op prod-env-net-diag [имя]
set -Eeuo pipefail
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
NAME="${1:-hook-a.test-1.5espace.com}"
[[ "$NAME" =~ ^[A-Za-z0-9.-]+$ ]] || { echo 'нужно имя' >&2; exit 2; }
DIR=/opt/fifth-element/.local/envs/test-1
SLOT="$(node -e "try{console.log(require('$DIR/release/core-route.json').slot||'core-a')}catch{console.log('core-a')}")"
CORE=fifth-test-1-core
[ "$SLOT" = core-b ] && CORE=fifth-test-1-core-b
echo "ядро: $CORE"
docker exec -e NAME="$NAME" "$CORE" node -e '
const dns = require("node:dns").promises, net = require("node:net");
const t = (host, port) => new Promise((ok) => { const s = net.connect({ host, port, timeout: 5000 });
  s.on("connect", () => { s.destroy(); ok("open"); }); s.on("timeout", () => { s.destroy(); ok("timeout"); });
  s.on("error", (e) => ok(e.code)); });
(async () => {
  const name = process.env.NAME;
  const a = await dns.lookup(name, { all: true }).then((r) => r.map((x) => x.address).join(","), (e) => "ERR " + e.code);
  console.log("имя " + name + ": " + a);
  console.log("tcp 193.233.217.210:443: " + await t("193.233.217.210", 443));
  console.log("tcp 1.1.1.1:443: " + await t("1.1.1.1", 443));
  for (const u of ["https://5espace.com/", "https://" + name + "/"]) {
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) }).then((x) => x.status, (e) => "ERR " + (e.cause?.code || e.name));
    console.log("https " + u + ": " + r);
  }
})();'
