#!/bin/bash
# Есть ли учётка и в каком она состоянии. Только чтение, значений не печатает.
set -uo pipefail
EMAIL="$1"
index="$(docker exec -e EMAIL="$EMAIL" fifth-core node -e "require('reflect-metadata');const {CryptoService}=require('/app/apps/core/dist/crypto/crypto.service.js');new CryptoService().blindIndex(process.env.EMAIL,'email').then((b)=>console.log(b.toString('hex')))" | tail -1)"
url="$(sed -E 's#@[^/]*/#@127.0.0.1:5432/#' /run/fifth-secrets/DATABASE_URL_OWNER)"
q() { docker exec -e URL="$url" fifth-postgres sh -c "psql \"\$URL\" -At -F' | ' -c \"$1\""; }
echo "учётка: $(q "SELECT status, password_hash IS NOT NULL, created_at::date, updated_at::date, primary_role FROM identity.users WHERE email_hmac = decode('$index','hex')")"
id="$(q "SELECT id FROM identity.users WHERE email_hmac = decode('$index','hex')")"
[ -n "$id" ] || { echo 'учётки с таким адресом нет'; exit 0; }
echo "роли: $(q "SELECT string_agg(role, ',') FROM identity.user_roles WHERE user_id = '$id' AND revoked_at IS NULL")"
q "SELECT ts::date, verb FROM audit.events WHERE subject_id = '$id' OR actor_id = '$id' ORDER BY ts DESC LIMIT 6"
echo "пользователей всего: $(q "SELECT count(*) FROM identity.users WHERE deleted_at IS NULL")"
