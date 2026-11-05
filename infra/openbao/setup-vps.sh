#!/bin/bash
# OpenBao на VPS (блок 5, задание 3). Запускается через sudo, штатно одной командой auto:
#
#   setup-vps.sh auto        вся установка без вопросов; значения на экран не выводятся
#   setup-vps.sh bootstrap   часть auto после запуска контейнера: ключи, настройка, отзыв root-токена
#   setup-vps.sh files      каталоги, Static seal key, сертификат; существующее не трогает
#   setup-vps.sh start       запуск контейнера
#   setup-vps.sh init        инициализация: ключ восстановления и root-токен печатаются один раз
#   setup-vps.sh configure   хранилища, политики, входы; спрашивает root-токен и новый пароль
#   setup-vps.sh revoke      отзыв root-токена после проверки личного входа
#   setup-vps.sh seal-copy   Static seal key для KeePassXC, только на экран
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${FIFTH_OPENBAO_DIR:-/etc/fifth-openbao}"
CONTAINER="${FIFTH_OPENBAO_CONTAINER:-fifth-openbao}"
OPENBAO_UID=1990
KEYS="${FIFTH_OPENBAO_KEYS_DIR:-/var/backups/fifth-element/openbao-keys}"
RECIPIENT="${FIFTH_OPENBAO_RECIPIENT:-$HERE/thomas-recipient.asc}"
RECIPIENT_FPR="${FIFTH_OPENBAO_RECIPIENT_FPR:-06D54B5532998568A88185A2BEA53785936C28C0}"

bao() {
  BAO_ADDR=https://127.0.0.1:8200 BAO_CACERT=/openbao/tls/tls.crt BAO_TOKEN="${TOKEN:-}" \
    docker exec -i -e BAO_ADDR -e BAO_CACERT -e BAO_TOKEN "$CONTAINER" bao "$@"
}
ask_token() {
  TOKEN="${FIFTH_OPENBAO_ROOT_TOKEN:-}"
  [ -n "$TOKEN" ] || { read -r -s -p 'root-токен: ' TOKEN; echo; }
}
initialized() {
  bao status -format=json 2>/dev/null | grep -q '"initialized": true'
}
# Ждёт, пока `bao status` вернёт один из кодов: 0 открыт, 2 запечатан или не инициализирован.
wait_status() {
  local rc try
  for try in $(seq 1 30); do
    rc=0
    bao status >/dev/null 2>&1 || rc=$?
    for want in "$@"; do [ "$rc" = "$want" ] && return 0; done
    sleep 1
  done
  echo "OpenBao не дошёл до нужного состояния, код $rc"
  exit 1
}
sha() {
  sha256sum | cut -d' ' -f1
}
stop_after() {
  if [ "${FIFTH_OPENBAO_STOP_AFTER:-}" = "$1" ]; then exit 3; fi
}
# Вход проверяется настоящим паролем; выданный при проверке токен сразу отзывается.
operator_login() {
  local pass=$1 issued
  issued="$(printf '%s' "$pass" | TOKEN='' bao write -field=token auth/userpass/login/thomas password=-)" || return 1
  TOKEN="$issued" bao token revoke -self >/dev/null
}
# Значения попадают только в рабочий каталог root и в комплект для ключа Томаса. Каталог живёт до
# конца шага: повтор после обрыва берёт из него токен и пароль, поэтому управление не теряется.
bootstrap() {
  local work="$DIR/auto" gnupg fpr token recovery pass seal
  if [ -s "$KEYS/meta.json" ] && [ ! -d "$work" ]; then
    echo 'ключи уже созданы'
    return 0
  fi
  gnupg="$(mktemp -d)"
  gpg --homedir "$gnupg" --batch -q --import <"$RECIPIENT" 2>/dev/null
  fpr="$(gpg --homedir "$gnupg" --batch --list-keys --with-colons | awk -F: '/^fpr/{print $10; exit}')"
  if [ "$fpr" != "$RECIPIENT_FPR" ]; then
    echo 'открытый ключ не тот: ключи не создаются'
    exit 1
  fi
  (umask 077; mkdir -p "$work" "$KEYS")
  [ -s "$work/password" ] || (umask 077; openssl rand -hex 24 | tr -d '\r\n' >"$work/password")
  if ! initialized; then
    (umask 077; bao operator init -recovery-shares=1 -recovery-threshold=1 >"$work/init.out")
  fi
  if [ ! -s "$work/init.out" ]; then
    echo 'OpenBao инициализирован, но значений этой установки нет: нужен разбор, повтор не поможет'
    exit 1
  fi
  stop_after init
  token="$(sed -n 's/^Initial Root Token: //p' "$work/init.out")"
  recovery="$(sed -n 's/^Recovery Key 1: //p' "$work/init.out")"
  pass="$(cat "$work/password")"
  seal="$(base64 -w0 "$DIR/seal/static.key")"
  if [ -z "$token" ] || [ -z "$recovery" ]; then
    echo 'значения инициализации не разобраны'
    exit 1
  fi
  wait_status 0
  if [ ! -s "$KEYS/emergency.gpg" ]; then
    (umask 077
     printf 'OPENBAO_RECOVERY_KEY=%s\nOPENBAO_THOMAS_PASSWORD=%s\nOPENBAO_STATIC_SEAL_B64=%s\n' \
       "$recovery" "$pass" "$seal" |
       gpg --homedir "$gnupg" --batch -q --trust-model always --encrypt --recipient "$fpr" \
         --output - >"$KEYS/emergency.gpg.tmp"
     mv "$KEYS/emergency.gpg.tmp" "$KEYS/emergency.gpg")
  fi
  rm -rf "$gnupg"
  if TOKEN="$token" bao token lookup >/dev/null 2>&1; then
    FIFTH_OPENBAO_ROOT_TOKEN="$token" FIFTH_OPENBAO_THOMAS_PASSWORD="$pass" bash "$0" configure
    if ! operator_login "$pass"; then
      echo 'личный вход не прошёл, root-токен не отозван: повтори команду'
      exit 1
    fi
    TOKEN="$token" bao token revoke -self >/dev/null
  fi
  stop_after revoke
  # Токен недействителен, поэтому единственная опора дальше — личный вход.
  if TOKEN="$token" bao token lookup >/dev/null 2>&1 || ! operator_login "$pass"; then
    echo 'root-токен не отозван или личный вход не работает: рабочий каталог сохранён'
    exit 1
  fi
  (umask 077
   printf '{"recipient":"%s","sealSha256":"%s","recoverySha256":"%s","passwordSha256":"%s","operatorLogin":true,"rootRevoked":true,"at":"%s"}\n' \
     "$fpr" "$(base64 -d <<<"$seal" | sha)" "$(printf '%s' "$recovery" | sha)" \
     "$(printf '%s' "$pass" | sha)" "$(date -u +%FT%TZ)" >"$KEYS/meta.json")
  shred -u "$work"/*
  rmdir "$work"
  echo 'ключи созданы и зашифрованы'
}
role() {
  local name=$1 ttl=$2
  bao write -force "auth/approle/role/$name" token_policies="$name" token_ttl="$ttl" token_max_ttl=4h >/dev/null
  (umask 077; mkdir -p "$DIR/approle/$name")
  (umask 077
   bao read -field=role_id "auth/approle/role/$name/role-id" >"$DIR/approle/$name/role-id"
   [ -s "$DIR/approle/$name/secret-id" ] ||
     bao write -f -field=secret_id "auth/approle/role/$name/secret-id" >"$DIR/approle/$name/secret-id")
}

case "${1:-}" in
  files)
    # Свой uid: 100 в образе на узле занят системной учёткой, а ключ читают только OpenBao и root.
    getent passwd "$OPENBAO_UID" >/dev/null ||
      useradd --system --uid "$OPENBAO_UID" --no-create-home --shell /usr/sbin/nologin openbao
    install -d -m 755 "$DIR" "$DIR/tls"
    install -d -m 500 -o "$OPENBAO_UID" "$DIR/seal"
    if [ ! -e "$DIR/seal/static.key" ]; then
      (umask 077; openssl rand -out "$DIR/seal/static.key" 32)
      chown "$OPENBAO_UID" "$DIR/seal/static.key"
      chmod 400 "$DIR/seal/static.key"
    fi
    if [ ! -e "$DIR/tls/tls.crt" ]; then
      openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
        -keyout "$DIR/tls/tls.key" -out "$DIR/tls/tls.crt" -days 1825 -subj /CN=localhost \
        -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' 2>/dev/null
      chown "$OPENBAO_UID" "$DIR/tls/tls.key"
      chmod 400 "$DIR/tls/tls.key"
    fi
    stat -c '%a %u %n' "$DIR/seal" "$DIR/seal/static.key" "$DIR/tls/tls.key"
    ;;
  start)
    compose=(docker compose -p fifth-openbao -f "$HERE/docker-compose.yml")
    "${compose[@]}" run --rm --no-deps --user 0 --entrypoint chown openbao -R "$OPENBAO_UID:$OPENBAO_UID" /openbao/data /openbao/audit
    "${compose[@]}" up -d
    ;;
  init)
    bao operator init -recovery-shares=1 -recovery-threshold=1
    echo 'Сохрани оба значения в KeePassXC сейчас: повторно они не показываются.'
    ;;
  configure)
    ask_token
    bao secrets list | grep '^kv/' >/dev/null || bao secrets enable -path=kv -version=2 kv
    bao secrets list | grep '^transit/' >/dev/null || bao secrets enable transit
    bao auth list | grep '^approle/' >/dev/null || bao auth enable approle
    bao auth list | grep '^userpass/' >/dev/null || bao auth enable userpass
    bao policy write prod-core - <"$HERE/policy-prod-core.hcl"
    bao policy write prod-backup - <"$HERE/policy-prod-backup.hcl"
    bao policy write operator - <"$HERE/policy-operator.hcl"
    role prod-core 1h
    role prod-backup 5m
    PASS="${FIFTH_OPENBAO_THOMAS_PASSWORD:-}"
    [ -n "$PASS" ] || { read -r -s -p 'новый пароль thomas в OpenBao: ' PASS; echo; }
    printf '%s' "$PASS" | bao write auth/userpass/users/thomas token_policies=operator password=- >/dev/null
    echo 'настроено'
    ;;
  revoke)
    ask_token
    bao token revoke -self
    ;;
  seal-copy)
    base64 -w0 "$DIR/seal/static.key"
    echo
    ;;
  bootstrap)
    bootstrap
    ;;
  auto)
    bash "$0" files
    bash "$0" start
    wait_status 0 2
    bootstrap
    cp "$HERE"/../systemd/fifth-monitor-openbao.* /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now fifth-monitor-openbao.timer
    (cd "$HERE/../.." && node scripts/monitoring.mjs configure)
    echo 'готово'
    ;;
  *)
    sed -n 2,11p "$0"
    exit 2
    ;;
esac
