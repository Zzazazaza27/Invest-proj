#!/bin/bash
# Учётка администратора на тестовой среде: адрес учётки admin с рабочей среды, шифруется ключами
# среды. Пароль свой: хеш передаётся аргументом, общий с рабочей средой не используется.
#   prod-test-admin <идентификатор учётки> <среда> <хеш пароля, base64>
# На рабочей среде только чтение. Значения не печатаются.
set -Eeuo pipefail
ID="${1:?нужен идентификатор учётки}"
ENV_ID="${2:?нужна среда}"
hash="$(printf %s "${3:?нужен хеш}" | base64 -d)"
[[ "$ENV_ID" =~ ^test-[0-9]+$ ]] || { echo 'неверная среда'; exit 2; }
[[ "$ID" =~ ^[0-9a-f-]{36}$ ]] || { echo 'неверный идентификатор'; exit 2; }
DIR="/opt/fifth-element/.local/envs/$ENV_ID"
url="$(sed -E 's#@[^/]*/#@127.0.0.1:5432/#' /run/fifth-secrets/DATABASE_URL_OWNER)"
prod() { docker exec -i -e URL="$url" fifth-postgres sh -c 'psql "$URL" -v ON_ERROR_STOP=1 -At -F"|"'; }
test1() {
  docker exec -i -e PGPASSWORD="$(cat "$DIR/secrets/POSTGRES_PASSWORD")" "fifth-$ENV_ID-postgres" \
    psql -h 127.0.0.1 -U fifth_owner -d fifth_element -v ON_ERROR_STOP=1 -At
}
row="$(prod <<SQL
SELECT encode(contact_wrapped_dek, 'hex'), encode(email_ciphertext, 'hex'), display_name
  FROM identity.users u
 WHERE id = '$ID' AND status = 'active'
   AND EXISTS (SELECT 1 FROM identity.user_roles r WHERE r.user_id = u.id AND r.role = 'admin' AND r.revoked_at IS NULL);
SQL
)"
[ -n "$row" ] || { echo 'такого администратора нет'; exit 1; }
IFS='|' read -r dek cipher name <<<"$row"
email="$(printf '%s\n%s' "$dek" "$cipher" | docker exec -i fifth-core node -e "
require('reflect-metadata');
const {CryptoService}=require('/app/apps/core/dist/crypto/crypto.service.js');
const [d,c]=require('fs').readFileSync(0,'utf8').trim().split('\n');
new CryptoService().openField('passport_sensitive',Buffer.from(d,'hex'),Buffer.from(c,'hex'),'email')
  .then((v)=>process.stdout.write(v.toString('utf8')));")"
[ -n "$email" ]
sealed="$(printf %s "$email" | docker exec -i "fifth-$ENV_ID-core" node -e "
require('reflect-metadata');
const {CryptoService}=require('/app/apps/core/dist/crypto/crypto.service.js');
const email=require('fs').readFileSync(0,'utf8');const c=new CryptoService();
(async()=>{const s=await c.sealMany('passport_sensitive',{email});const i=await c.blindIndex(email,'email');
process.stdout.write([s.ciphertexts.email.toString('hex'),s.wrappedDek.toString('hex'),i.toString('hex')].join(' '));})();")"
read -r ciphertext wrapped index <<<"$sealed"
[ -n "$index" ]
unset email
test1 >/dev/null <<SQL
DO \$do\$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM identity.users WHERE email_hmac = decode('$index', 'hex');
  IF v_id IS NULL THEN
    INSERT INTO identity.users
      (id, email_ciphertext, contact_wrapped_dek, email_hmac, password_hash, display_name,
       primary_role, status, locale, origin)
    VALUES (public.uuid_generate_v7(), decode('$ciphertext', 'hex'), decode('$wrapped', 'hex'),
            decode('$index', 'hex'), \$h\$$hash\$h\$, \$n\$$name\$n\$, 'founder', 'pending_consents',
            'ru-RU', 'seed_acceptance')
    RETURNING id INTO v_id;
    INSERT INTO identity.consents (id, user_id, kind, version, locale, request_trace_hash)
    SELECT public.uuid_generate_v7(), v_id, t.kind, t.version, t.locale, digest('test-admin', 'sha256')
      FROM identity.consent_templates t
     WHERE t.superseded_at IS NULL AND t.locale = 'ru-RU'
       AND t.kind IN ('platform_rules', 'tos', 'pdn', 'commission_terms');
    UPDATE identity.users SET status = 'active' WHERE id = v_id;
  ELSE
    UPDATE identity.users SET password_hash = \$h\$$hash\$h\$, status = 'active' WHERE id = v_id;
  END IF;
  INSERT INTO identity.user_roles (user_id, role) VALUES (v_id, 'admin') ON CONFLICT DO NOTHING;
  INSERT INTO identity.user_roles (user_id, role) VALUES (v_id, 'founder') ON CONFLICT DO NOTHING;
END
\$do\$;
SQL
echo "администраторов на $ENV_ID: $(echo "SELECT count(*) FROM identity.user_roles WHERE role = 'admin' AND revoked_at IS NULL;" | test1)"
echo "учётка администратора на $ENV_ID готова, пароль свой"
