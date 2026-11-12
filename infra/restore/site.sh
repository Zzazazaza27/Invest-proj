#!/bin/bash
# Площадка полного восстановления внутри своего дистрибутива WSL (работа № 5 раздела 01).
# Вызывает scripts/restore-site-wsl.mjs; руками не нужен.
#
#   site.sh wslconf    — /etc/wsl.conf: systemd, без дисков Windows и без запуска программ Windows
#   site.sh prepare    — пакеты (единственный выход наружу), своё сетевое пространство fifth без
#                        выхода наружу, Docker и Caddy — только в нём
#   site.sh check      — назначения и изоляция; JSON в stdout
#   site.sh node <tar> — node из образа ядра комплекта (без внешнего источника)
#   site.sh info       — ОС, пакеты, источники для протокола; JSON в stdout
#
# Сетевое пространство fifth: только петля, маршрута наружу нет. Docker, containerd и Caddy
# работают в нём (drop-in NetworkNamespacePath), восстановление запускается в нём же. Так
# изоляция не зависит от того, делит ли WSL сеть с другими дистрибутивами (Docker Desktop).
set -Eeuo pipefail
export LC_ALL=C.UTF-8
NS=fifth
PKGS='docker.io docker-compose-v2 caddy curl ca-certificates gnupg iproute2 tar gzip jq'

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
case "${1:-}" in check|node) ensure_docker ;; esac

case "${1:-}" in
wslconf)
  host="${2:-fifth-restore}"
  cat > /etc/wsl.conf <<EOF
[boot]
systemd=true
[automount]
enabled=false
mountFsTab=false
[interop]
enabled=false
appendWindowsPath=false
[network]
generateHosts=false
hostname=$host
[user]
default=root
EOF
  echo 'wsl.conf записан'
  ;;

prepare)
  [ "$(cat /proc/1/comm)" = systemd ] || { echo 'systemd не PID 1 — перезапусти дистрибутив' >&2; exit 1; }
  # Пакеты — до закрытия сети; источники записываются в info.
  # DNS дистрибутива поднимается не сразу после запуска.
  for _ in $(seq 1 30); do getent hosts archive.ubuntu.com >/dev/null && break; sleep 2; done
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends $PKGS
  # Сетевое пространство без выхода наружу — постоянной службой (переживает перезапуск).
  cat > /etc/systemd/system/fifth-restore-netns.service <<EOF
[Unit]
Description=5E restore site: network namespace without outside access
Before=containerd.service docker.service caddy.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'ip netns add $NS 2>/dev/null || true; ip -n $NS link set lo up'
[Install]
WantedBy=multi-user.target
EOF
  for u in containerd docker caddy; do
    mkdir -p /etc/systemd/system/$u.service.d
    cat > /etc/systemd/system/$u.service.d/zz-restore-netns.conf <<EOF
# Площадка восстановления: служба в сетевом пространстве $NS (только петля).
[Unit]
Requires=fifth-restore-netns.service
After=fifth-restore-netns.service
[Service]
NetworkNamespacePath=/run/netns/$NS
EOF
  done
  systemctl daemon-reload
  systemctl enable --now fifth-restore-netns.service
  systemctl stop caddy || true
  systemctl disable caddy || true
  systemctl restart containerd docker
  echo 'площадка подготовлена'
  ;;

check)
  j() { jq -n "$@"; }
  pid1=$(cat /proc/1/comm)
  # Диски Windows — по фактическим монтированиям (drvfs/9p); каталог драйверов GPU WSL
  # (/usr/lib/wsl/drivers, только чтение) пользовательских данных не содержит.
  mnt=$(awk '($3=="drvfs"||$3=="9p") && $2!="/usr/lib/wsl/drivers" {print $2}' /proc/mounts | tr '\n' ' ')
  [ -n "$mnt" ] || mnt=no
  interop=$( [ -e /proc/sys/fs/binfmt_misc/WSLInterop ] && cat /proc/sys/fs/binfmt_misc/WSLInterop | head -1 || echo absent )
  route=$(ip -n $NS route show default 2>/dev/null | head -1)
  # Внешних интерфейсов нет: только петля и мосты/пары Docker внутри пространства.
  links=$(ip -n $NS -o link show 2>/dev/null | awk -F': ' '{print $2}' | sed 's/@.*//' \
    | grep -vE '^(lo|docker0|br-[0-9a-f]+|veth[0-9a-f]+)$' | tr '\n' ' ' || true)
  outside=$( ip netns exec $NS timeout 6 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' 2>/dev/null && echo open || echo closed )
  dockerns=$(readlink /proc/$(pidof dockerd | awk '{print $1}')/ns/net 2>/dev/null || echo none)
  fifthns=$(ip netns exec $NS readlink /proc/self/ns/net)
  sock=$(readlink -f /var/run/docker.sock 2>/dev/null || echo none)
  info=$(docker info --format '{{json .}}' 2>/dev/null || echo '{}')
  j --arg pid1 "$pid1" --arg mnt "$mnt" --arg interop "$interop" --arg route "$route" \
    --arg links "$links" --arg outside "$outside" --arg dockerns "$dockerns" --arg fifthns "$fifthns" \
    --arg sock "$sock" --arg dockerHost "${DOCKER_HOST:-}" --argjson info "$info" \
    '{pid1:$pid1, windowsDrives:$mnt, interop:$interop, nsDefaultRoute:$route, nsLinks:$links,
      outside:$outside, dockerdNetns:$dockerns, fifthNetns:$fifthns, socket:$sock, dockerHost:$dockerHost,
      docker:{id:$info.ID, name:$info.Name, rootDir:$info.DockerRootDir, containers:$info.Containers,
              images:$info.Images, version:$info.ServerVersion}}'
  ;;

node)
  # node из образа ядра комплекта: тот же, что у рабочей среды; ничего не скачивается.
  tar_file="$2"
  id=$(docker load -i "$tar_file" | sed -n 's/^Loaded image ID: //p; s/^Loaded image: //p' | head -1)
  c=$(docker create "$id")
  docker cp "$c:/usr/local/bin/node" /usr/local/bin/node
  docker rm "$c" >/dev/null
  /usr/local/bin/node --version
  ;;

info)
  . /etc/os-release
  pk=$(dpkg-query -W -f '${Package}\t${Version}\n' $PKGS 2>/dev/null | jq -R 'split("\t") | {(.[0]): .[1]}' | jq -s add)
  src=$( (grep -rh '^deb \|^URIs:' /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null || true) | sort -u | jq -R . | jq -s .)
  jq -n --arg os "$PRETTY_NAME" --arg kernel "$(uname -r)" --argjson packages "$pk" --argjson apt "$src" \
    '{os:$os, kernel:$kernel, packages:$packages, aptSources:$apt}'
  ;;

*)
  echo 'команды: wslconf, prepare, check, node <tar>, info' >&2
  exit 2
  ;;
esac
