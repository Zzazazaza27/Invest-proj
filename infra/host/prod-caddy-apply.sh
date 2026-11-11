#!/bin/bash
# Основной Caddyfile площадки из Git (план выпуска W31–W33, раздел 6). Caddy общий для всех
# сред: шаги prepare/apply/restore выполняет Томас. Хеши паролей basic_auth в Git не хранятся —
# они в /etc/caddy/auth.env (root, 0600), Caddy получает их окружением службы и подставляет
# в {$CADDY_AUTH_<ИМЯ>}. Значения не печатаются.
#
#   fifth-test op prod-caddy-apply check     только чтение: готовность, расхождение, validate
#   fifth-test op prod-caddy-apply prepare   один раз: хеши из текущего файла → auth.env,
#                                            EnvironmentFile службе (daemon-reload); Caddy не
#                                            перезагружается, действующий файл не меняется
#   fifth-test op prod-caddy-apply apply     копия текущего, установка файла из Git, validate,
#                                            reload; отказ reload — возврат копии сам
#   fifth-test op prod-caddy-apply restore   вернуть последнюю копию и reload
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
ROOT=/opt/fifth-element
SRC="$ROOT/infra/caddy/Caddyfile"
LIVE=/etc/caddy/Caddyfile
AUTH=/etc/caddy/auth.env
DROPIN=/etc/systemd/system/caddy.service.d/fifth-auth.conf
MODE="${1:-check}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
chmod 700 "$TMP"

# Файл из Git без заголовка-комментария (как его сравнивает scripts/caddy-drift.mjs).
candidate() { sed '1,/^$/{/^#/d;/^$/d}' "$SRC" > "$TMP/Caddyfile"; }
# Хеши текущего файла заменены подстановками — для сравнения без секретов.
masked_live() {
  perl -pe 's/^(\t+)([A-Za-z0-9_-]+)[ \t]+\$2[aby]\$\S+[ \t]*$/$1.$2." {\$CADDY_AUTH_".uc($2)."}"/e' "$LIVE"
}
needed() { grep -o '{\$CADDY_AUTH_[A-Z0-9_]*}' "$TMP/Caddyfile" | tr -d '{}$' | sort -u; }
# Окружение для caddy validate — из auth.env, без вывода и без подстановки shell.
load_auth() {
  while IFS= read -r line; do
    [[ "$line" =~ ^(CADDY_AUTH_[A-Z0-9_]+)=\'(.*)\'$ ]] || continue
    export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
  done < "$AUTH"
}
validate() {
  ( load_auth; caddy validate --config "$1" --adapter caddyfile >"$TMP/validate.log" 2>&1 ) \
    && echo '  validate: ok' \
    || { echo '  validate: ОТКАЗ'; grep -v '\$2[aby]\$' "$TMP/validate.log" | tail -5; return 1; }
}
check() {
  candidate
  echo "== серверная копия $(git -c safe.directory=$ROOT -C $ROOT rev-parse --short HEAD)"
  if diff -q <(masked_live) "$TMP/Caddyfile" >/dev/null; then
    echo '  расхождение действующего файла с Git (без хешей): нет'
  else
    echo '  расхождение действующего файла с Git (без хешей):'
    diff <(masked_live) "$TMP/Caddyfile" | grep -v '\$2[aby]\$' | head -20 || true
  fi
  local missing=0
  if [ -f "$AUTH" ]; then
    echo "  auth.env: есть, права $(stat -c '%a %U' "$AUTH")"
    for v in $(needed); do grep -q "^$v='" "$AUTH" || { echo "  в auth.env нет $v"; missing=1; }; done
  else
    echo '  auth.env: нет (нужен prepare)'; missing=1
  fi
  if [ -f "$DROPIN" ] && systemctl show caddy -p EnvironmentFiles | grep -q "$AUTH"; then
    echo '  служба caddy: EnvironmentFile подключён'
    # systemd читает тот же файл так же, как load_auth: сверка по хешам значений, без вывода.
    if [ -f "$AUTH" ]; then
      systemd-run --quiet --wait --pipe --collect -p EnvironmentFile="$AUTH" /usr/bin/env \
        | grep '^CADDY_AUTH_' | sort | sha256sum > "$TMP/sd.sum"
      ( load_auth; env | grep '^CADDY_AUTH_' | sort | sha256sum ) > "$TMP/sh.sum"
      if cmp -s "$TMP/sd.sum" "$TMP/sh.sum"; then echo '  значения глазами systemd: совпадают'
      else echo '  значения глазами systemd: НЕ совпадают'; missing=1; fi
    fi
  else
    echo '  служба caddy: EnvironmentFile не подключён (нужен prepare)'; missing=1
  fi
  [ "$missing" = 0 ] && validate "$TMP/Caddyfile"
  echo "  caddy: $(systemctl is-active caddy)"
  return "$missing"
}

case "$MODE" in
  check) check ;;
  prepare)
    candidate
    umask 077
    : > "$TMP/auth.env"
    for v in $(needed); do
      user="$(echo "${v#CADDY_AUTH_}" | tr 'A-Z' 'a-z')"
      hashes="$(grep -P "^\t+$user[ \t]+\\\$2[aby]\\\$" "$LIVE" | awk '{print $2}' | sort -u)"
      n="$(printf '%s' "$hashes" | grep -c . || true)"
      [ "$n" = 1 ] || { echo "prepare: у $user в действующем файле хешей $n (нужен ровно один) — ничего не меняю" >&2; exit 1; }
      printf "%s='%s'\n" "$v" "$hashes" >> "$TMP/auth.env"
    done
    install -o root -g root -m 600 "$TMP/auth.env" "$AUTH"
    mkdir -p "$(dirname "$DROPIN")"
    printf '[Service]\nEnvironmentFile=%s\n' "$AUTH" > "$DROPIN"
    systemctl daemon-reload
    echo "prepare: auth.env записан ($(needed | wc -l) переменных), служба знает EnvironmentFile; Caddy не перезагружался"
    check
    ;;
  apply)
    check || { echo 'apply: проверка не пройдена — ничего не меняю' >&2; exit 1; }
    backup="$LIVE.before-git-$(date -u +%Y%m%dT%H%M%SZ)"
    cp -p "$LIVE" "$backup"
    echo "  копия: $backup"
    install -o root -g root -m 644 "$TMP/Caddyfile" "$LIVE"
    if systemctl reload caddy && sleep 2 && systemctl is-active -q caddy; then
      echo 'apply: файл из Git действует; дальше — матрица контроля'
    else
      echo 'apply: reload не прошёл — возвращаю копию' >&2
      cp -p "$backup" "$LIVE"
      systemctl reload caddy || systemctl restart caddy
      echo "  caddy: $(systemctl is-active caddy)"
      exit 1
    fi
    ;;
  restore)
    backup="$(ls -1t "$LIVE".before-git-* 2>/dev/null | head -1)"
    [ -n "$backup" ] || { echo 'restore: копии нет' >&2; exit 1; }
    cp -p "$backup" "$LIVE"
    systemctl reload caddy
    echo "restore: возвращён $backup; caddy $(systemctl is-active caddy)"
    ;;
  *) echo 'режимы: check, prepare, apply, restore' >&2; exit 2 ;;
esac
