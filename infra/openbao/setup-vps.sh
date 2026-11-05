#!/bin/bash
# OpenBao на VPS (блок 5, задание 3). Запускает Томас через sudo, шаги по очереди:
#
#   setup-vps.sh files       каталоги, Static seal key, сертификат; существующее не трогает
#   setup-vps.sh start       запуск контейнера
#   setup-vps.sh init        инициализация: ключ восстановления и root-токен печатаются один раз
#   setup-vps.sh configure   хранилища, политики, входы; спрашивает root-токен и новый пароль
#   setup-vps.sh revoke      отзыв root-токена после проверки личного входа
#   setup-vps.sh seal-copy   Static seal key для KeePassXC, только на экран
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${FIFTH_OPENBAO_DIR:-/etc/fifth-openbao}"
CONTAINER="${FIFTH_OPENBAO_CONTAINER:-fifth-openbao}"
OPENBAO_UID=100

bao() {
  BAO_ADDR=https://127.0.0.1:8200 BAO_CACERT=/openbao/tls/tls.crt BAO_TOKEN="${TOKEN:-}" \
    docker exec -i -e BAO_ADDR -e BAO_CACERT -e BAO_TOKEN "$CONTAINER" bao "$@"
}
ask_token() {
  TOKEN="${FIFTH_OPENBAO_ROOT_TOKEN:-}"
  [ -n "$TOKEN" ] || { read -r -s -p 'root-токен: ' TOKEN; echo; }
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
    docker compose -p fifth-openbao -f "$HERE/docker-compose.yml" up -d
    ;;
  init)
    bao operator init -recovery-shares=1 -recovery-threshold=1
    echo 'Сохрани оба значения в KeePassXC сейчас: повторно они не показываются.'
    ;;
  configure)
    ask_token
    bao secrets list | grep -q '^kv/' || bao secrets enable -path=kv -version=2 kv
    bao secrets list | grep -q '^transit/' || bao secrets enable transit
    bao auth list | grep -q '^approle/' || bao auth enable approle
    bao auth list | grep -q '^userpass/' || bao auth enable userpass
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
  *)
    sed -n 2,9p "$0"
    exit 2
    ;;
esac
