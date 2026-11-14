#!/bin/bash
# Полнота архивов образов на узле (14.11, общая приёмка 4б: `docker save` давал архив ядра без
# слоёв). Только чтение: архив проверяется по manifest.json — у каждого образа есть config и все
# слои. Временные файлы удаляются. Без значений секретов.
#
#   fifth-test op prod-image-save-check [образ ...]   docker save; по умолчанию ядро и web prod
#   fifth-test op prod-image-save-check --kit <сборка> images.tar комплекта
#   fifth-test op prod-image-save-check --tree         какие платформы Docker считает доступными
set -uo pipefail
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
docker version --format 'docker {{.Server.Version}}, API {{.Server.APIVersion}}'
docker info --format 'хранилище: {{.Driver}} {{json .DriverStatus}}' | cut -c1-200
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

# Полнота архива: записи могут идти с «./» (tar -C каталог .) — сравниваем без него.
complete() {
  local f="$1"
  tar -tf "$f" | sed 's#^\./##' > "$T/list"
  { tar -xOf "$f" manifest.json 2>/dev/null || tar -xOf "$f" ./manifest.json; } | node -e '
    const fs=require("fs");const m=JSON.parse(fs.readFileSync(0));
    const have=new Set(fs.readFileSync(process.argv[1],"utf8").split(/\r?\n/));
    for(const e of m){const miss=[e.Config,...e.Layers].filter(x=>!have.has(x));
      console.log("  "+((e.RepoTags||[]).join(",")||"(без тега)"),"слоёв",e.Layers.length,miss.length?"НЕТ "+miss.length:"полный");}' "$T/list"
}

case "${1:-}" in
--tree)
  for r in fifth/core fifth/web; do docker image ls --tree "$r" 2>&1 | head -30 | cut -c1-160; done
  exit 0
  ;;
--kit)
  [[ "${2:-}" =~ ^[0-9]+\.[0-9]+-b[0-9]+\.[0-9]+$ ]] || { echo 'нужна сборка'; exit 2; }
  k="/opt/fifth-element/.local/kits/$2/images.tar"
  [ -f "$k" ] || { echo "нет $k"; exit 1; }
  echo "$k: $(stat -c %s "$k") байт"
  complete "$k"
  exit 0
  ;;
esac

if [ $# -eq 0 ]; then
  set -- "$(docker inspect fifth-core --format '{{.Config.Image}}')" \
    "$(docker inspect fifth-web --format '{{.Config.Image}}')"
fi
for img in "$@"; do
  [[ "$img" =~ ^[A-Za-z0-9._/:@-]+$ ]] || { echo "образ: недопустимое имя"; continue; }
  docker image inspect "$img" >/dev/null 2>&1 || { echo "$img: нет"; continue; }
  f="$T/x.tar"
  if docker save -o "$f" "$img" 2>"$T/err"; then
    echo "save $img: $(stat -c %s "$f") байт"
    complete "$f"
  else
    echo "save $img: ошибка $(tail -1 "$T/err" | cut -c1-200)"
  fi
  rm -f "$f"
done
