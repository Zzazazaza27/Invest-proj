#!/bin/bash
# На test-1 не остаётся хеша пароля рабочей среды: вход этой учётки закрыт, роль снята.
set -Eeuo pipefail
DIR=/opt/fifth-element/.local/envs/test-1
docker exec -i -e PGPASSWORD="$(cat "$DIR/secrets/POSTGRES_PASSWORD")" fifth-test-1-postgres \
  psql -h 127.0.0.1 -U fifth_owner -d fifth_element -v ON_ERROR_STOP=1 -At <<'SQL'
WITH admins AS (
  UPDATE identity.user_roles SET revoked_at = now()
   WHERE role = 'admin' AND revoked_at IS NULL RETURNING user_id)
UPDATE identity.users SET password_hash = NULL WHERE id IN (SELECT user_id FROM admins);
SELECT count(*) FROM identity.user_roles WHERE role = 'admin' AND revoked_at IS NULL;
SQL
