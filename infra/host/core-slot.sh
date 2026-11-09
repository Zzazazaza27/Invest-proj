# Активный слот ядра рабочей среды (блок 09, задание 3). Подключается: . "$(dirname "$0")/core-slot.sh"
#
# Файл маршрута в машиночитаемом виде пишет установщик рядом с файлом для nginx:
#   $CORE_ROUTE_JSON = /opt/fifth-element/.local/release/core-route.json
#   { "format": 1, "slot": "core-a" | "core-b", ... }
# Нет файла — режима слотов ещё нет: одно ядро fifth-core, служебный порт 4400 (как до задания 3).
# Файл есть, но не разбирается — ошибка: гадать, какое ядро активно, нельзя.
#
#   слот    контейнер      порт API   служебный порт
#   core-a  fifth-core     4300       4401
#   core-b  fifth-core-b   4310       4411
#   нет     fifth-core     4300       4400
# Постоянный служебный адрес 127.0.0.1:4400 в режиме слотов обслуживает nginx по маршруту.

CORE_ROUTE_JSON="${CORE_ROUTE_JSON:-/opt/fifth-element/.local/release/core-route.json}"

active_core_slot() {
  if [ ! -e "$CORE_ROUTE_JSON" ]; then
    echo none
    return 0
  fi
  local slot
  slot="$(sed -n 's/.*"slot"[[:space:]]*:[[:space:]]*"\(core-[ab]\)".*/\1/p' "$CORE_ROUTE_JSON" | head -1)"
  if [ -z "$slot" ] || ! grep -q '"format"[[:space:]]*:[[:space:]]*1' "$CORE_ROUTE_JSON"; then
    echo "core-slot: файл маршрута $CORE_ROUTE_JSON не разобран — активное ядро неизвестно" >&2
    return 2
  fi
  echo "$slot"
}

active_core() {
  local slot
  slot="$(active_core_slot)" || return 2
  case "$slot" in
    core-b) echo fifth-core-b ;;
    *) echo fifth-core ;;
  esac
}

active_core_port() {
  local slot
  slot="$(active_core_slot)" || return 2
  case "$slot" in
    core-b) echo 4310 ;;
    *) echo 4300 ;;
  esac
}

active_core_internal_port() {
  local slot
  slot="$(active_core_slot)" || return 2
  case "$slot" in
    core-a) echo 4401 ;;
    core-b) echo 4411 ;;
    *) echo 4400 ;;
  esac
}
