#!/bin/bash
# Подготовка боевого режима: учётка почты и центры сертификатов. Работающие службы не меняются.
set -Eeuo pipefail
ROOT=/opt/fifth-element
TLS=/etc/fifth-tls
SECRETS="$ROOT/.local/secrets"
cd "$ROOT"

say() { printf '%s\n' "$1"; }
install -d -m 755 "$TLS"

if [ ! -s "$TLS/ca.crt" ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out "$TLS/ca.key"
  chmod 600 "$TLS/ca.key"
  openssl req -x509 -new -key "$TLS/ca.key" -sha256 -days 3650 -subj '/CN=5E internal CA' \
    -addext 'basicConstraints=critical,CA:TRUE' -out "$TLS/ca.crt"
  openssl ecparam -name prime256v1 -genkey -noout -out "$TLS/server.key"
  openssl req -new -key "$TLS/server.key" -subj '/CN=internal' -out "$TLS/server.csr"
  printf 'subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:postgres,DNS:valkey,DNS:nats\n' >"$TLS/ext"
  openssl x509 -req -in "$TLS/server.csr" -CA "$TLS/ca.crt" -CAkey "$TLS/ca.key" -CAcreateserial \
    -days 1095 -sha256 -extfile "$TLS/ext" -out "$TLS/server.crt" 2>/dev/null
  # Valkey работает от uid 999, ключ ему нужен на чтение.
  chown root:999 "$TLS/server.key"
  chmod 640 "$TLS/server.key"
  rm -f "$TLS/server.csr" "$TLS/ext"
  say 'внутренние сертификаты созданы'
fi

if [ ! -s "$TLS/integration-ca.crt" ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out "$TLS/integration-ca.key"
  chmod 600 "$TLS/integration-ca.key"
  openssl req -x509 -new -key "$TLS/integration-ca.key" -sha256 -days 3650 \
    -subj '/CN=5E integration clients' -addext 'basicConstraints=critical,CA:TRUE' \
    -out "$TLS/integration-ca.crt"
  chmod 644 "$TLS/integration-ca.crt"
  say 'центр сертификатов интеграций создан'
fi
# Ключ центра интеграций нужен для выпуска клиентских сертификатов: он идёт в переходный комплект.
install -o root -g 1000 -m 440 "$TLS/integration-ca.key" "$SECRETS/INTEGRATION_CA_KEY"

if [ ! -s "$SECRETS/MAIL_SMTP_PASSWORD" ]; then
  (umask 077; openssl rand -hex 24 | tr -d '\r\n' >"$SECRETS/MAIL_SMTP_PASSWORD")
  chown root:1000 "$SECRETS/MAIL_SMTP_PASSWORD"
  chmod 440 "$SECRETS/MAIL_SMTP_PASSWORD"
  /usr/local/hestia/bin/v-add-mail-account admin 5espace.com no-reply "$(cat "$SECRETS/MAIL_SMTP_PASSWORD")"
  say 'учётка почты no-reply заведена'
fi
say 'подготовка завершена'
