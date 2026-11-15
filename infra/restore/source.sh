#!/bin/bash
# Узел-источник искусственного комплекта (работа № 5 раздела 01): дистрибутив WSL fifth-source
# с раскладкой рабочей среды — /opt/fifth-element, .env в корне, Compose с дополнением prod из
# образов, собранных локально, Caddy на узле, юниты копий и наблюдения, pgBackRest и комплект
# копий. Данные — только искусственные (демонстрационный комплект), ключ получателя копий —
# испытательный, не ключ Томаса. Вызывает scripts/restore-source-wsl.mjs.
#
#   source.sh packages            пакеты Ubuntu (единственный выход наружу)
#   source.sh code <bundle>       серверная копия из git bundle
#   source.sh up                  база, миграции, Garage, поток NATS, службы, Caddy, юниты
#   source.sh verify              вход, профиль, файл, запись через публичный вход (до комплекта)
#   source.sh seed                демонстрационные данные (из образа ядра: там pg и argon2)
#   source.sh set                 полная копия базы и комплект на момент T
#   source.sh activity before|after  живые действия через API до и после комплекта
#   source.sh audit               порция выгрузки аудита (ключ подписи — испытательный)
#   source.sh pull <каталог>      пригодный комплект — в каталог (сверка по описи)
set -Eeuo pipefail
export LC_ALL=C.UTF-8
ROOT=/opt/fifth-element
SITE=/var/lib/fifth-restore
PKGS='docker.io docker-compose-v2 caddy curl ca-certificates gnupg iproute2 tar gzip jq git'
CORE_IMAGE=fifth/core:src
cd /
# Docker после запуска дистрибутива иногда не стартует с первого раза (гонка с containerd).
ensure_docker() {
  for _ in 1 2 3 4 5; do
    docker info >/dev/null 2>&1 && return 0
    systemctl reset-failed docker docker.socket >/dev/null 2>&1 || true
    systemctl start docker >/dev/null 2>&1 || true
    sleep 3
  done
  echo 'Docker не запустился' >&2; return 1
}
[ "${1:-}" = packages ] || ensure_docker
# После перезапуска дистрибутива службы поднимаются не сразу: база и ядро должны быть готовы.
wait_ready() {
  for _ in $(seq 1 90); do
    [ "$(docker inspect -f "{{.State.Health.Status}}" fifth-postgres 2>/dev/null)" = healthy ] &&
      [ "$(docker inspect -f "{{.State.Health.Status}}" fifth-core 2>/dev/null)" = healthy ] &&
      [ "$(docker inspect -f "{{.State.Health.Status}}" fifth-garage-1 2>/dev/null)" = healthy ] && return 0
    sleep 2
  done
  echo "база, ядро или Garage не готовы" >&2; return 1
}
# Узлы Garage после перезапуска теряют друг друга (новые адреса Docker): соединить, как
# fifth-garage-connect на рабочем узле (служба стоит и здесь, но ждёт 45 с после загрузки).
case "${1:-}" in seed|set|activity|audit) wait_ready && (cd "$ROOT" && node scripts/garage-init.mjs >/dev/null) ;; esac

case "${1:-}" in
packages)
  # DNS дистрибутива поднимается не сразу после запуска.
  for _ in $(seq 1 30); do getent hosts archive.ubuntu.com >/dev/null && break; sleep 2; done
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends $PKGS
  systemctl enable --now docker
  echo 'пакеты источника установлены'
  ;;

node)
  # node — из образа ядра (тот же, что у рабочей среды), без внешнего источника.
  c=$(docker create "$CORE_IMAGE")
  docker cp "$c:/usr/local/bin/node" /usr/local/bin/node
  docker rm "$c" >/dev/null
  ln -sf /usr/local/bin/node /usr/bin/node
  node --version
  ;;

code)
  [ -d "$ROOT/.git" ] && { echo "код уже на месте: $(git -C "$ROOT" rev-parse --short HEAD)"; exit 0; }
  git clone -q "$2" "$ROOT"
  git -C "$ROOT" remote remove origin
  mkdir -p "$ROOT/.local" /var/backups/fifth-element /var/lib/fifth-monitor
  # Зависимости служебных скриптов узла (pg, argon2) — из образа ядра, без npm.
  c=$(docker create "$CORE_IMAGE") && docker cp "$c:/app/node_modules" "$ROOT/node_modules" && docker rm "$c" >/dev/null
  echo "код: $(git -C "$ROOT" rev-parse --short HEAD)"
  ;;

up)
  cd "$ROOT"
  # Хранилище pgBackRest — владельцу postgres образа (uid 999), как на рабочем узле.
  mkdir -p /var/backups/fifth-element/pgbackrest && chown 999:999 /var/backups/fifth-element/pgbackrest
  export COMPOSE_PROFILES=web,monitoring,monitoring-host
  node scripts/infra.mjs compose up -d postgres valkey nats garage-1 garage-2 garage-3
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' fifth-postgres 2>/dev/null)" = healthy ] && break
    sleep 2
  done
  # Миграции и роли — образом ядра (в нём pg), как при установке комплекта. Первый запуск
  # PostgreSQL перезапускается после initdb (проверка здоровья проходит и на временном
  # сервере) — поэтому повтор; миграции идемпотентны.
  ok=''
  for _ in 1 2 3 4 5; do
    if docker run --rm --network host --env-file .env -w /app/database "$CORE_IMAGE" sh -c \
      'node --experimental-strip-types src/migrate.ts && node --experimental-strip-types src/bootstrap-roles.ts' > /tmp/migrate.log 2>&1; then
      ok=1; tail -3 /tmp/migrate.log; break
    fi
    tail -2 /tmp/migrate.log; sleep 5
  done
  [ -n "$ok" ] || { echo 'миграции не прошли' >&2; exit 1; }
  node scripts/garage-init.mjs | tail -3
  # Секреты .env — ссылками <ИМЯ>_FILE на /run/fifth-secrets (OpenBao Agent): каталог нужен и здесь.
  docker run --rm --network host --env-file .env -v /run/fifth-secrets:/run/fifth-secrets:ro \
    "$CORE_IMAGE" node scripts/nats-init-stream.mjs | tail -2
  node scripts/infra.mjs compose up -d
  bash "$0" caddy
  # Юниты копий и наблюдения — как на рабочем узле.
  for u in fifth-backup-db fifth-backup-set fifth-backup-check fifth-monitor-export fifth-disk-guard; do
    cp infra/systemd/$u.service infra/systemd/$u.timer /etc/systemd/system/
  done
  cp infra/systemd/fifth-garage-connect.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable fifth-garage-connect.service >/dev/null 2>&1
  for u in fifth-backup-db fifth-backup-set fifth-backup-check fifth-monitor-export fifth-disk-guard; do
    systemctl enable --now $u.timer >/dev/null 2>&1
  done
  docker ps --format '{{.Names}} {{.Status}}' | sort
  ;;

caddy)
  # Caddy на узле: сайт и вход файлов (как files.5espace.com: только POST подписанной формы в
  # бакет), свой центр сертификатов (имена .test наружу не уходят).
  bucket=$(sed -n 's/^S3_BUCKET=//p' "$ROOT/.env")
  cat > /etc/caddy/Caddyfile <<CADDY
# Узел-источник искусственного комплекта (fifth-source).
src.5espace.test {
	tls internal
	reverse_proxy 127.0.0.1:8080
}

files-src.5espace.test {
	tls internal
	@upload {
		method POST
		path /$bucket
	}
	handle @upload {
		reverse_proxy 127.0.0.1:9000 {
			header_up Host {host}
		}
	}
	respond 404
}
CADDY
  for h in src.5espace.test files-src.5espace.test; do
    grep -q " $h\$" /etc/hosts || echo "127.0.0.1 $h" >> /etc/hosts
  done
  systemctl enable caddy >/dev/null 2>&1
  systemctl restart caddy
  ;;
verify)
  # Те же контрольные операции, что после восстановления (вход, профиль, файл, запись) — на
  # источнике до комплекта: заведомо неисправная установка не тратит часы восстановления.
  cd "$ROOT"
  wait_ready
  r=0
  db=$(sed -n 's/^DATABASE_URL_OWNER=//p' .env | sed 's#.*/##; s#?.*##')
  NODE_EXTRA_CA_CERTS=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt \
  RESTORE_ONLY_OPERATIONS=1 RESTORE_BASE=https://src.5espace.test \
  RESTORE_CORE_CONTAINER=fifth-core RESTORE_PG_CONTAINER=fifth-postgres RESTORE_DB="$db" \
  RESTORE_SESSION_COOKIE="$(sed -n 's/^SESSION_COOKIE_NAME=//p' .env)" \
  RESTORE_CSRF_COOKIE="$(sed -n 's/^CSRF_COOKIE_NAME=//p' .env)" \
    node scripts/restore-full-checks.mjs > /tmp/verify.log || r=$?
  grep -v '^{' /tmp/verify.log
  exit $r
  ;;
seed)
  cd "$ROOT"
  node scripts/seed-demo.mjs load | tail -5
  ;;

set)
  cd "$ROOT"
  node scripts/backup.mjs db | tail -2
  systemctl start fifth-monitor-export.service || true
  node scripts/backup.mjs set | tail -4
  ;;

activity)
  cd "$ROOT"
  node scripts/restore-source-activity.mjs "$2"
  ;;

audit)
  cd "$ROOT"
  mkdir -p /var/lib/fifth-audit-export
  # Переменные выгрузки — только этой команде (имя *_FILE в .env загрузчик принял бы за секрет).
  set -a; . ./.env; set +a
  AUDIT_EXPORT_DIR=/var/lib/fifth-audit-export \
    AUDIT_EXPORT_SIGNING_KEY=/etc/fifth-audit-export/signing.key \
    AUDIT_EXPORT_RECIPIENT="$ROOT/.local/backup-keys/recipient.asc" \
    AUDIT_EXPORT_MONITOR_FILE=/var/lib/fifth-monitor/audit-export.json \
    node scripts/audit-export.mjs run | tail -3
  ;;

pull)
  cd "$ROOT"
  node scripts/backup.mjs pull --from-dir /var/backups/fifth-element --to "$2" | tail -3
  ;;

*)
  echo 'команды: packages, code <bundle>, up, seed, set, pull <каталог>' >&2
  exit 2
  ;;
esac
