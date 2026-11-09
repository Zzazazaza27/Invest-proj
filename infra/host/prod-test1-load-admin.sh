#!/bin/bash
# Администратор test-1 для подготовки данных нагрузочного прогона (W32). Только test-1.
# Учётная запись заранее зарегистрирована через API test-1 (пароль сгенерирован Маусом и
# хранится вне Git); этот шаг выдаёт ей роль admin — с ней и testing.sessions.manage (M097).
#   fifth-test op prod-test1-load-admin grant <user_id>
#   fifth-test op prod-test1-load-admin revoke <user_id>
set -Eeuo pipefail
DIR=/opt/fifth-element/.local/envs/test-1
cmd="${1:-}"
uid="${2:-}"
[[ "$uid" =~ ^[0-9a-f-]{36}$ ]] || { echo 'нужен user_id' >&2; exit 2; }
sql() {
  docker exec -i -e PGPASSWORD="$(cat "$DIR/secrets/POSTGRES_PASSWORD")" fifth-test-1-postgres \
    psql -h 127.0.0.1 -U fifth_owner -d fifth_element -v ON_ERROR_STOP=1 -v uid="$uid" -At
}
case "$cmd" in
  grant)
    sql <<'SQL'
SELECT count(*) FROM identity.users WHERE id = :'uid' AND status = 'active' \gset u_
\if :u_count
  INSERT INTO identity.user_roles (user_id, role, granted_by)
  SELECT :'uid', 'admin', :'uid'
   WHERE NOT EXISTS (SELECT 1 FROM identity.user_roles
                      WHERE user_id = :'uid' AND role = 'admin' AND revoked_at IS NULL);
  -- Отдельная выдача полномочий не нужна: администратор держит все (app.has_capability,
  -- M097); выдавать её может только администратор через API — триггер M097.
  SELECT 'выдано: admin (полномочия администратора включают testing.sessions.manage)';
\else
  SELECT 'нет активной учётной записи с таким id';
\endif
SQL
    ;;
  revoke)
    sql <<'SQL'
UPDATE identity.user_roles SET revoked_at = now()
 WHERE user_id = :'uid' AND role = 'admin' AND revoked_at IS NULL;
UPDATE identity.staff_capability_grants
   SET revoked_at = now(), revoked_by = :'uid', revoke_reason = 'прогон W32 завершён'
 WHERE user_id = :'uid' AND revoked_at IS NULL;
SELECT 'снято';
SQL
    ;;
  *) echo 'команды: grant, revoke' >&2; exit 2 ;;
esac
