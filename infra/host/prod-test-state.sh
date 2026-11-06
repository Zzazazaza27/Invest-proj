#!/bin/bash
# Учётки администратора на рабочей среде и состояние test-1. Только чтение, без значений.
set -uo pipefail
ROOT=/opt/fifth-element
DIR="$ROOT/.local/envs/test-1"
url="$(sed -E 's#@[^/]*/#@127.0.0.1:5432/#' /run/fifth-secrets/DATABASE_URL_OWNER)"
prod() { docker exec -i -e URL="$url" fifth-postgres sh -c 'psql "$URL" -At -F" | "'; }
test1() {
  docker exec -i -e PGPASSWORD="$(cat "$DIR/secrets/POSTGRES_PASSWORD")" fifth-test-1-postgres \
    psql -h 127.0.0.1 -U fifth_owner -d fifth_element -At -F' | '
}
list='SELECT u.id, u.created_at::date, u.primary_role, u.status,
       (SELECT string_agg(role, $$,$$) FROM identity.user_roles r WHERE r.user_id = u.id AND r.revoked_at IS NULL),
       (SELECT string_agg(capability, $$,$$) FROM identity.staff_capabilities c WHERE c.user_id = u.id),
       left(u.password_hash, 10)
  FROM identity.users u ORDER BY u.created_at;'
echo '== рабочая среда'
echo "$list" | prod 2>&1 | cut -c1-160
echo '== test-1'
echo "$list" | test1 2>&1 | cut -c1-160
echo '== настройки test-1'
grep -E '^(KMS_MODE|CRYPTO_WRITE_FORMAT|OPENBAO_ADDR|MAIL_TRANSPORT|NODE_ENV)=' "$DIR/settings.env" | cut -c1-80
docker ps --format '{{.Names}}' | grep test-1 | tr '\n' ' '
echo
docker logs --tail 4 fifth-test-1-core 2>&1 | cut -c1-160
