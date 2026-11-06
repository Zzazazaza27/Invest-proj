#!/bin/bash
# Прежние секреты. quarantine — убрать из рабочих путей и проверить среду, при сбое вернуть.
# shred — уничтожить убранное; после этого копия есть только в переходном комплекте Томаса.
set -Eeuo pipefail
ROOT=/opt/fifth-element
RETIRED="$ROOT/.local/retired"
cd "$ROOT"
case "${1:-}" in
  quarantine)
    [ ! -e "$RETIRED" ] || { echo 'уже убрано'; exit 0; }
    back() {
      echo "сбой на строке $1: возвращаю файлы на место"
      mv "$RETIRED/secrets" .local/secrets 2>/dev/null || true
      mv "$RETIRED"/env-before-* .local/ 2>/dev/null || true
      rmdir "$RETIRED" 2>/dev/null || true
      exit 1
    }
    trap 'back $LINENO' ERR
    install -d -m 700 "$RETIRED"
    mv .local/secrets "$RETIRED/secrets"
    mv .local/env-before-* "$RETIRED/"
    echo '▸ ядро заново, без прежних файлов'
    node scripts/infra.mjs compose up -d --force-recreate --no-deps core >/dev/null 2>&1
    for _ in $(seq 1 60); do
      [ "$(docker inspect fifth-core --format '{{.State.Health.Status}}' 2>/dev/null)" = healthy ] && break
      sleep 2
    done
    [ "$(docker inspect fifth-core --format '{{.State.Health.Status}}')" = healthy ]
    before="$(stat -c %Y /var/lib/fifth-monitor/app-probe.json)"
    for _ in $(seq 1 90); do
      [ "$(stat -c %Y /var/lib/fifth-monitor/app-probe.json)" -gt "$before" ] && break
      sleep 2
    done
    [ "$(stat -c %Y /var/lib/fifth-monitor/app-probe.json)" -gt "$before" ]
    grep -q '"ok": true' /var/lib/fifth-monitor/app-probe.json
    echo 'контрольный вход прошёл'
    node scripts/release.mjs verify prod | cut -c1-200
    echo '▸ комплект копии'
    last="$(ls /var/backups/fifth-element/sets | sort | tail -1)"
    systemctl start fifth-backup-set.service
    [ "$(systemctl show fifth-backup-set.service -p Result --value)" = success ]
    next="$(ls /var/backups/fifth-element/sets | sort | tail -1)"
    [ "$next" != "$last" ] && [ -f "/var/backups/fifth-element/sets/$next/READY" ]
    node -e "process.exit(JSON.parse(require('fs').readFileSync(process.argv[1])).openbao?.file ? 0 : 1)" \
      "/var/backups/fifth-element/sets/$next/catalog.json"
    echo "комплект $next готов, снимок OpenBao в нём"
    trap - ERR
    echo "убрано файлов: $(find "$RETIRED" -type f | wc -l), среда работает"
    ;;
  shred)
    [ -d "$RETIRED" ] || { echo 'нечего уничтожать'; exit 1; }
    find "$RETIRED" -type f -exec shred -u {} +
    rm -rf "$RETIRED"
    echo 'прежние секреты уничтожены'
    ;;
  *)
    echo 'шаги: quarantine, shred'
    exit 2
    ;;
esac
