#!/bin/bash
# Новые версии ключей подписи. Значения идут в файлы секретов, оттуда в комплект и OpenBao.
set -Eeuo pipefail
SECRETS=/opt/fifth-element/.local/secrets
for name in LOCAL_AUTH_SIGNING_KEY CSRF_SIGNING_KEY INTEGRATION_TOKEN_SIGNING_KEY; do
  file="$SECRETS/${name}_VERSIONS"
  if [ ! -s "$file" ]; then
    (umask 077; printf 'v2:%s' "$(openssl rand -hex 48)" >"$file")
    chown root:1000 "$file"
    chmod 440 "$file"
  fi
done
echo 'версии подписей подготовлены'
