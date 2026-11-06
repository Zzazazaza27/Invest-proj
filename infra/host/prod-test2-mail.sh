#!/bin/bash
# Письмо восстановления с test-2 на адрес администратора: подконтрольный адрес. Адрес не печатается.
set -Eeuo pipefail
DIR=/opt/fifth-element/.local/envs/test-2
row="$(docker exec -i -e PGPASSWORD="$(cat "$DIR/secrets/POSTGRES_PASSWORD")" fifth-test-2-postgres \
  psql -h 127.0.0.1 -U fifth_owner -d fifth_element -At -F' ' -c \
  "SELECT encode(contact_wrapped_dek, 'hex'), encode(email_ciphertext, 'hex') FROM identity.users u JOIN identity.user_roles r ON r.user_id = u.id WHERE r.role = 'admin' AND r.revoked_at IS NULL LIMIT 1")"
email="$(printf %s "$row" | docker exec -i fifth-test-2-core node -e "
require('reflect-metadata');
const {CryptoService}=require('/app/apps/core/dist/crypto/crypto.service.js');
const [d,c]=require('fs').readFileSync(0,'utf8').trim().split(' ');
new CryptoService().openField('passport_sensitive',Buffer.from(d,'hex'),Buffer.from(c,'hex'),'email')
  .then((v)=>process.stdout.write(v.toString('utf8')));")"
code="$(printf '{"email":"%s"}' "$email" | curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
  -H 'content-type: application/json' -H 'Origin: https://test-2.5espace.com' --data-binary @- https://test-2.5espace.com/v1/auth/password/forgot)"
unset email
echo "запрос: $code"
sleep 15
docker logs --since 1m fifth-test-2-core 2>&1 | grep -iE 'mail|smtp' | tail -4 | sed -E 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/***/g' | cut -c1-200
grep -E 'no-reply-test-2' /var/log/exim4/mainlog | tail -4 | sed -E 's/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+)/***@\1/g' | cut -c1-200
