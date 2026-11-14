#!/bin/bash
# Почему `docker save` образа ядра даёт архив без слоёв (14.11, общая приёмка 4б). Только чтение:
# сохраняет образ во временный файл, печатает число записей, размер и наличие config/слоёв,
# затем удаляет файл. Без значений секретов.
#
#   fifth-test op prod-image-save-check [образ ...]   по умолчанию fifth/core и fifth/web сборки prod
set -uo pipefail
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
docker version --format 'docker {{.Server.Version}}, API {{.Server.APIVersion}}'
docker info --format 'хранилище: {{.Driver}} {{json .DriverStatus}}' | cut -c1-200
if [ "${1:-}" = --kit ]; then
  # Полнота images.tar комплекта: у каждого образа из manifest.json есть config и все слои.
  [[ "${2:-}" =~ ^[0-9]+\.[0-9]+-b[0-9]+\.[0-9]+$ ]] || { echo 'нужна сборка'; exit 2; }
  k="/opt/fifth-element/.local/kits/$2/images.tar"
  [ -f "$k" ] || { echo "нет $k"; exit 1; }
  echo "$k: $(stat -c %s "$k") байт"
  tar -tf "$k" > /tmp/kit-list.$$
  tar -xOf "$k" manifest.json | node -e '
    const m=JSON.parse(require("fs").readFileSync(0));const have=new Set(require("fs").readFileSync(process.argv[1],"utf8").split(/\r?\n/));
    for(const e of m){const miss=[e.Config,...e.Layers].filter(x=>!have.has(x));console.log((e.RepoTags||[]).join(","),"слоёв",e.Layers.length,miss.length?"НЕТ "+miss.length:"полный");}' /tmp/kit-list.$$
  rm -f /tmp/kit-list.$$
  exit 0
fi
if [ $# -eq 0 ]; then
  set -- "$(docker inspect fifth-core --format '{{.Config.Image}}')" \
    "$(docker inspect fifth-web --format '{{.Config.Image}}')"
fi
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
for img in "$@"; do
  [[ "$img" =~ ^[A-Za-z0-9._/:@-]+$ ]] || { echo "образ: недопустимое имя"; continue; }
  id="$(docker image inspect "$img" --format '{{.Id}}' 2>/dev/null)" || { echo "$img: нет"; continue; }
  echo "== $img ($id)"
  docker image inspect "$img" --format 'размер {{.Size}}, слоёв {{len .RootFS.Layers}}'
  docker image inspect "$img" --format 'платформы: {{json .Descriptor}}' 2>/dev/null | cut -c1-200
  for mode in plain platform; do
    ref="$img"
    f="$T/x.tar"
    extra=(); [ "$mode" = platform ] && extra=(--platform linux/amd64)
    if docker save "${extra[@]}" -o "$f" "$ref" 2>"$T/err"; then
      n="$(tar -tf "$f" | grep -c '^blobs/sha256/.')"
      cfg="$(tar -xOf "$f" manifest.json 2>/dev/null | grep -o '"Config":"[^"]*"' | head -1 | sed 's/.*sha256\///;s/"//')"
      has="нет"; tar -tf "$f" | grep -q "$cfg" && has="есть"
      echo "save [$mode] $ref: код 0, $(stat -c %s "$f") байт, блоков $n, config ${cfg:0:12} — $has"
    else
      echo "save [$mode] $ref: ошибка $(tail -1 "$T/err" | cut -c1-200)"
    fi
    rm -f "$f"
  done
done
