#!/bin/bash
# Ссылки смены пароля и подтверждения почты на test-2: когда выданы, до какого срока, использованы ли.
# Только чтение, без токенов и адресов.
set -euo pipefail
DIR=/opt/fifth-element/.local/envs/test-2
docker exec -e PGPASSWORD="$(cat "$DIR/secrets/POSTGRES_PASSWORD")" fifth-test-2-postgres \
  psql -h 127.0.0.1 -U fifth_owner -d fifth_element -c \
  "SELECT purpose, created_at::timestamp(0) AS выдана, expires_at::timestamp(0) AS срок,
          used_at::timestamp(0) AS использована, now()::timestamp(0) AS сейчас
     FROM identity.verification_tokens ORDER BY created_at DESC LIMIT 8"
