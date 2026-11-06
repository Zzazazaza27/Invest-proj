#!/bin/bash
# Что лежит в рабочей базе. Только чтение, без адресов и значений.
set -uo pipefail
url="$(sed -E 's#@[^/]*/#@127.0.0.1:5432/#' /run/fifth-secrets/DATABASE_URL_OWNER)"
q() { docker exec -i -e URL="$url" fifth-postgres sh -c 'psql "$URL" -At -F" | "'; }
echo '== учётки: создана, роль, статус, вход, проектов'
q <<'SQL'
SELECT u.created_at::timestamp(0), u.primary_role, u.status, u.deleted_at IS NOT NULL,
       (SELECT max(ts)::timestamp(0) FROM audit.events e WHERE e.actor_id = u.id AND e.verb LIKE '%login%'),
       (SELECT count(*) FROM lab.founders_projects f WHERE f.user_id = u.id)
  FROM identity.users u ORDER BY u.created_at;
SQL
echo '== непустые таблицы вне служебных схем'
q <<'SQL'
SELECT schemaname || '.' || relname, n_live_tup FROM pg_stat_user_tables
 WHERE n_live_tup > 0 AND schemaname NOT IN ('audit', 'ops', 'public', 'intelligence')
 ORDER BY 1;
SQL
