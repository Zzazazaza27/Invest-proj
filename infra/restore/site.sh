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
#   site.sh hostenv    — критичные пакеты из архива окружения (HOSTENV_TAR), без сети и источников
#
# Сетевое пространство fifth: только петля, маршрута наружу нет. Docker, containerd и Caddy
# работают в нём (drop-in NetworkNamespacePath), восстановление запускается в нём же. Так
# изоляция не зависит от того, делит ли WSL сеть с другими дистрибутивами (Docker Desktop).
set -Eeuo pipefail
export LC_ALL=C.UTF-8
NS=fifth
# Пакеты площадки для info (протокол): Docker из Ubuntu или docker-ce — смотря по копии (HOST_PKGS).
PKGS='docker.io docker-ce containerd.io docker-compose-v2 docker-compose-plugin caddy nodejs git openssh-server curl ca-certificates gnupg iproute2 tar gzip jq'

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

hostenv)
  # Окружение узла из архива окружения (Тэнк 15.11): критичные пакеты ставятся из архива БЕЗ
  # обращения к репозиториям — без сети (unshare --net), с пустыми источниками и пустым кешем
  # списков apt: apt видит только установленное и файлы архива. Не хватило пакета — отказ.
  # Архив проверен на ноутбуке (подпись ключом комплектов, суммы) — HOSTENV_TAR, путь на площадке.
  [ -f "${HOSTENV_TAR:-}" ] || { echo 'HOSTENV_TAR: нет архива' >&2; exit 2; }
  hd=/var/lib/fifth-restore/hostenv
  rm -rf "$hd/x" "$hd/sel" "$hd/lists"; mkdir -p "$hd/x" "$hd/sel" "$hd/lists/partial"
  tar -xf "$HOSTENV_TAR" -C "$hd/x"
  root=$(find "$hd/x/hostenv" -mindepth 1 -maxdepth 1 -type d | head -1)
  [ -f "$root/archive.json" ] || { echo 'в архиве нет archive.json' >&2; exit 2; }
  # Из зависимостей — только те, которых нет или которые старше: установленное новее (пакеты
  # Ubuntu с обновлениями безопасности) не понижается.
  total=0 picked=0
  for f in "$root"/debs/*.deb; do
    total=$((total + 1))
    p=$(dpkg-deb -f "$f" Package) v=$(dpkg-deb -f "$f" Version)
    st=$(dpkg-query -W -f '${db:Status-Abbrev}' "$p" 2>/dev/null || true)
    have=$(dpkg-query -W -f '${Version}' "$p" 2>/dev/null || true)
    if [[ "$st" != ii* ]] || dpkg --compare-versions "$have" lt "$v"; then
      ln -f "$f" "$hd/sel/"; picked=$((picked + 1))
    fi
  done
  # Пакеты Docker из Ubuntu конфликтуют с docker-ce (удаление сети не требует).
  DEBIAN_FRONTEND=noninteractive apt-get remove -y -q docker.io docker-compose-v2 containerd runc >/dev/null 2>&1 || true
  echo "архив $(basename "$root"): пакетов $total, нет на площадке или старше $picked; сеть и источники apt отключены"
  # Единственный источник — локальный репозиторий из файлов архива (file:). Архив проверен по
  # подписи до передачи, поэтому trusted=yes относится только к нему.
  (cd "$hd/sel" && apt-ftparchive packages . > Packages)
  echo "deb [trusted=yes] file:$hd/sel ./" > "$hd/local.list"
  offline=(unshare --net -- env DEBIAN_FRONTEND=noninteractive apt-get -q
    -o DPkg::Lock::Timeout=600 -o Dir::Etc::SourceList="$hd/local.list"
    -o Dir::Etc::SourceParts=/dev/null -o Dir::State::Lists="$hd/lists")
  "${offline[@]}" update >/dev/null
  # Запрошенные при сборке пакеты — ровно их версии из архива; уже установленные не старше
  # (выборка выше их пропустила) остаются — их проверит общая сверка.
  in_repo=" $(awk '/^Package: /{print $2}' "$hd/sel/Packages" | tr '\n' ' ') "
  want=''
  for p in $(python3 -c 'import json,sys;print(" ".join(json.load(open(sys.argv[1]))["requested"]))' "$root/archive.json"); do
    [[ "$in_repo" == *" ${p%%=*} "* ]] && want="$want $p"
  done
  # shellcheck disable=SC2086
  [ -z "$want" ] || "${offline[@]}" install -y --no-install-recommends --allow-downgrades $want
  # Управляемые пакеты поставщиков закрепляются; пакетам Ubuntu обновления безопасности остаются.
  for p in $(node -e 'const e=require(process.argv[1]);for(const c of e.components) if(c.match==="exact") for(const n of Object.keys(c.packages)) console.log(n)' "$root/environment.json"); do
    apt-mark hold "$p" >/dev/null
  done
  echo "закреплены: $(apt-mark showhold | tr '\n' ' ')"
  ;;
prepare)
  [ "$(cat /proc/1/comm)" = systemd ] || { echo 'systemd не PID 1 — перезапусти дистрибутив' >&2; exit 1; }
  # Пакеты — до закрытия сети; источники записываются в info.
  # Посредник DNS WSL (/mnt/wsl/resolv.conf) 14.11 отвечал по 10 с и чаще не отвечал вовсе —
  # подготовка шла часами. На время подготовки — прямые серверы; WSL вернёт свой при перезапуске.
  if ! timeout 3 getent hosts archive.ubuntu.com >/dev/null; then
    rm -f /etc/resolv.conf
    printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /etc/resolv.conf
  fi
  for _ in $(seq 1 30); do getent hosts archive.ubuntu.com >/dev/null && break; sleep 2; done
  APT='-y -q -o DPkg::Lock::Timeout=600 --no-install-recommends'
  apt-get update -q -o DPkg::Lock::Timeout=600
  # shellcheck disable=SC2086
  DEBIAN_FRONTEND=noninteractive apt-get install $APT curl ca-certificates gnupg iproute2 tar gzip jq
  # HOST_PKGS — пакеты хоста из записи узла в копии, «имя=версия» через пробел
  # (restore-site-wsl prepare --set): окружение — по копии, а не по сегодняшнему main. Каждый —
  # ровно этой версии, из того же поставщика, что на узле; затем закрепляется (apt-mark hold),
  # чтобы автообновления Ubuntu его не сдвинули. Без HOST_PKGS — пакеты Ubuntu, как раньше.
  HOST_PKGS="${HOST_PKGS:-}"
  if [ -n "${HOSTENV_INSTALLED:-}" ]; then
    # Критичные пакеты уже поставлены из архива окружения копии (шаг hostenv, без сети).
    echo "критичные пакеты — из архива окружения $HOSTENV_INSTALLED"
  elif [ -z "$HOST_PKGS" ]; then
    # shellcheck disable=SC2086
    DEBIAN_FRONTEND=noninteractive apt-get install $APT docker.io docker-compose-v2 caddy
  else
    fetch() { curl -1sLf --retry 6 --retry-delay 5 --retry-all-errors "$@"; }
    install -d -m 0755 /etc/apt/keyrings
    vendors=''
    for p in $HOST_PKGS; do
      [[ "$p" =~ ^[a-z0-9][a-z0-9.+-]*=[A-Za-z0-9.+:~-]+$ ]] || { echo "HOST_PKGS: $p" >&2; exit 2; }
      case "${p%%=*}" in
        caddy) vendors="$vendors caddy" ;;
        docker-ce|docker-ce-cli|containerd.io|docker-compose-plugin|docker-buildx-plugin) vendors="$vendors docker" ;;
        nodejs) vendors="$vendors nodesource" ;;
      esac
    done
    # Поставщики — как на узле (его sources.list.d в копии: caddy-stable, docker, nodesource).
    for v in $(printf '%s\n' $vendors | sort -u); do
      case "$v" in
        caddy)
          fetch https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
            gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
          fetch https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list ;;
        docker)
          fetch https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
          echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release; echo "$VERSION_CODENAME") stable" \
            > /etc/apt/sources.list.d/docker.list
          # Пакеты Docker из Ubuntu конфликтуют с docker-ce.
          DEBIAN_FRONTEND=noninteractive apt-get remove -y -q docker.io docker-compose-v2 containerd runc >/dev/null 2>&1 || true ;;
        nodesource)
          fetch https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
            gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
          major=$(printf '%s\n' $HOST_PKGS | sed -n 's/^nodejs=\([0-9]*\)\..*/\1/p')
          echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${major}.x nodistro main" \
            > /etc/apt/sources.list.d/nodesource.list ;;
      esac
    done
    # DNS WSL временами не находит поставщика — тогда apt молча берёт пакет Ubuntu: повторяем,
    # пока индекс не получен без ошибок.
    for _ in 1 2 3 4 5 6; do
      apt-get update -q -o DPkg::Lock::Timeout=600 2>&1 | tee /tmp/apt-update.log
      grep -q '^\(Err\|W\):' /tmp/apt-update.log || break
      sleep 10
    done
    # Политика версии (Тэнк 14.11): пакеты поставщиков (Docker, Caddy, NodeSource) — ровно версия
    # копии; пакеты самой Ubuntu (ревизия вида «2ubuntu17.4») — та же версия программы, ревизия обновлений
    # безопасности — та же или новее: старые ревизии Ubuntu из репозитория убирает.
    ospkg() { [[ "$1" =~ [0-9]ubuntu[0-9] ]]; }
    upstream() { local v="${1#*:}"; echo "${v%-*}"; }
    want_list=''
    for p in $HOST_PKGS; do
      if ospkg "${p#*=}"; then want_list="$want_list ${p%%=*}"; else want_list="$want_list $p"; fi
    done
    # shellcheck disable=SC2086
    DEBIAN_FRONTEND=noninteractive apt-get install $APT --allow-downgrades $want_list
    # Закрепляются только пакеты поставщиков; пакетам Ubuntu обновления безопасности разрешены.
    for p in $HOST_PKGS; do ospkg "${p#*=}" || apt-mark hold "${p%%=*}" >/dev/null; done
    # Сверка — та же, что у restore-full до данных.
    bad=''
    for p in $HOST_PKGS; do
      n="${p%%=*}" w="${p#*=}"
      have=$(dpkg-query -W -f '${Version}' "$n" 2>/dev/null || echo нет)
      if ospkg "$w"; then
        [ "$(upstream "$have")" = "$(upstream "$w")" ] && dpkg --compare-versions "$have" ge "$w" ||
          bad="$bad $n: нужен $(upstream "$w") (ревизия ≥ $w), установлен $have;"
      else
        [ "$have" = "$w" ] || bad="$bad $n: нужен $w, установлен $have;"
      fi
    done
    [ -z "$bad" ] || { echo "версии не совпали:$bad" >&2; exit 1; }
    # sshd узла площадке не нужен: пакет есть ради сверки окружения, служба не работает.
    systemctl disable --now ssh ssh.socket >/dev/null 2>&1 || true
  fi
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
  # Docker и Caddy — в пространстве $NS. systemd даёт такой службе и своё пространство
  # монтирований, поэтому containerd запускает сам dockerd (дочерним, в том же пространстве):
  # отдельный containerd не увидел бы корневую ФС контейнера, смонтированную dockerd.
  rm -f /etc/systemd/system/containerd.service.d/zz-restore-netns.conf
  for u in docker caddy; do
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
  printf '[Service]
ExecStart=
ExecStart=/usr/bin/dockerd -H fd://
' > /etc/systemd/system/docker.service.d/zz-restore-own-containerd.conf
  systemctl daemon-reload
  systemctl enable --now fifth-restore-netns.service
  systemctl stop caddy || true
  systemctl disable caddy || true
  # Системный containerd не нужен: без маски dockerd подключился бы к его сокету.
  systemctl disable --now containerd >/dev/null 2>&1 || true
  systemctl mask containerd >/dev/null 2>&1 || true
  rm -f /run/containerd/containerd.sock
  # После замены docker.io на docker-ce docker.socket остаётся «failed», а dockerd -H fd:// без
  # него не стартует (14.11).
  systemctl reset-failed docker.socket docker >/dev/null 2>&1 || true
  systemctl enable --now docker.socket
  systemctl restart docker
  echo 'площадка подготовлена'
  ;;

check)
  j() { jq -n "$@"; }
  pid1=$(cat /proc/1/comm)
  # Диски Windows — по фактическим монтированиям (drvfs/9p); каталог драйверов GPU WSL
  # (/usr/lib/wsl/drivers, только чтение) пользовательских данных не содержит.
  mnt=$(awk '($3=="drvfs"||$3=="9p") && $2!="/usr/lib/wsl/drivers" {print $2}' /proc/mounts | tr '\n' ' ')
  [ -n "$mnt" ] || mnt=no
  # [interop] enabled=false в wsl.conf WSL соблюдает не всегда: 14.11 регистрация WSLInterop
  # оказалась включённой. Снимаем её на эту загрузку и пишем, что снимали; замер — после.
  interopRemoved=no
  if [ -e /proc/sys/fs/binfmt_misc/WSLInterop ]; then
    echo -1 > /proc/sys/fs/binfmt_misc/WSLInterop 2>/dev/null && interopRemoved=yes
  fi
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
  j --arg pid1 "$pid1" --arg mnt "$mnt" --arg interop "$interop" --arg interopRemoved "$interopRemoved" --arg route "$route" \
    --arg links "$links" --arg outside "$outside" --arg dockerns "$dockerns" --arg fifthns "$fifthns" \
    --arg sock "$sock" --arg dockerHost "${DOCKER_HOST:-}" --argjson info "$info" \
    '{pid1:$pid1, windowsDrives:$mnt, interop:$interop, interopRemoved:$interopRemoved, nsDefaultRoute:$route, nsLinks:$links,
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
  # Пакет, которого dpkg не знает (docker-compose-v2 на чистой площадке из архива), — не отказ.
  pk=$( { dpkg-query -W -f '${Package}\t${Version}\n' $PKGS 2>/dev/null || true; } | jq -R 'split("\t") | {(.[0]): .[1]}' | jq -s add)
  src=$( (grep -rh '^deb \|^URIs:' /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null || true) | sort -u | jq -R . | jq -s .)
  jq -n --arg os "$PRETTY_NAME" --arg kernel "$(uname -r)" --argjson packages "$pk" --argjson apt "$src" \
    '{os:$os, kernel:$kernel, packages:$packages, aptSources:$apt}'
  ;;

*)
  echo 'команды: wslconf, prepare, check, node <tar>, info' >&2
  exit 2
  ;;
esac
