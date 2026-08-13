#!/usr/bin/env node
/**
 * Тестовый пользователь для разработки.
 *
 * Заводит учётную запись `ssurgut` со всеми ролями, нужными, чтобы пройти
 * платформу целиком: основатель, инвестор, эксперт, организатор,
 * администратор.
 *
 * Пароль берётся из `DEV_TEST_USER_PASSWORD` в `.env` и НЕ хранится в
 * репозитории: пароль в коде — это секрет в коде, даже если он «всего лишь
 * тестовый» (RULES.md §4). Файл `.env` в git не попадает.
 *
 * Скрипт отказывается работать при NODE_ENV=production. Перед выходом в
 * production запись должна быть удалена — см. TODO.md, раздел
 * «Обязательно до production».
 *
 * Почему учётка создаётся напрямую в базе, а не через /v1/auth/register:
 * запрошенный пароль короче политики регистрации (минимум 12 символов).
 * Ослаблять политику ради удобной тестовой учётки нельзя — это правило
 * защищает всех настоящих пользователей. Поэтому пароль хешируется тем же
 * алгоритмом и с теми же параметрами, что и на сервере, а запись заводится как
 * фикстура окружения, минуя правило регистрации, но не отменяя его.
 *
 * Хранилище логинов в этой системе — адрес: короткое имя дополняется доменом
 * `unicorn.local`. Форма входа в кабинете делает то же самое, поэтому в поле
 * достаточно ввести `ssurgut`.
 *
 * Использование: node scripts/dev-seed-test-user.mjs
 */
import pg from 'pg';
import argon2 from 'argon2';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

if (process.env.NODE_ENV === 'production') {
  console.error('Тестовые учётные записи в production не создаются.');
  process.exit(1);
}

const LOGIN = 'ssurgut';
const EMAIL = `${LOGIN}@unicorn.local`;
const PASSWORD = process.env.DEV_TEST_USER_PASSWORD ?? '';
if (!PASSWORD) {
  console.error(
    'Не задан DEV_TEST_USER_PASSWORD. Добавь его в .env — пароль тестовой ' +
      'учётки не хранится в репозитории.',
  );
  process.exit(1);
}
const ROLES = ['founder', 'investor', 'expert', 'organizer', 'admin'];

function loadDotEnv() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });

function blindIndex(value) {
  return createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${value.trim().toLowerCase()}`, 'utf8')
    .digest();
}

// Параметры Argon2id — те же, что в IdentityService: OWASP-минимум.
const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

/** Envelope-шифрование поля: формат и AAD совпадают с CryptoService. */
function sealContact(email) {
  const kek = Buffer.from(process.env.KEK_PASSPORT_SENSITIVE ?? '', 'base64');
  if (kek.length !== 32) throw new Error('KEK_PASSPORT_SENSITIVE не задан или неверной длины');
  const dek = randomBytes(32);
  const encrypt = (key, plaintext, aad) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  };
  const ciphertext = encrypt(dek, Buffer.from(email, 'utf8'), 'field:email');
  const wrappedDek = encrypt(kek, dek, 'wrap:passport_sensitive');
  dek.fill(0);
  return { ciphertext, wrappedDek };
}

const existing = await pool.query('SELECT id FROM identity.users WHERE email_hmac = $1', [
  blindIndex(EMAIL),
]);

let userId = existing.rows[0]?.id ?? null;

if (userId) {
  // Пароль всё равно переустанавливаем: скрипт должен быть идемпотентным и
  // приводить учётку к известному состоянию.
  await pool.query(
    `UPDATE identity.users SET password_hash = $2, status = 'active' WHERE id = $1`,
    [userId, await argon2.hash(PASSWORD, ARGON2_OPTIONS)],
  );
} else {
  const contact = sealContact(EMAIL);
  const created = await pool.query(
    `INSERT INTO identity.users
       (id, email_ciphertext, contact_wrapped_dek, email_hmac, password_hash,
        display_name, primary_role, status, locale)
     VALUES (public.uuid_generate_v7(), $1, $2, $3, $4,
             'Тестовый пользователь (ssurgut)', 'founder', 'pending_consents', 'ru-RU')
     RETURNING id`,
    [
      contact.ciphertext,
      contact.wrappedDek,
      blindIndex(EMAIL),
      await argon2.hash(PASSWORD, ARGON2_OPTIONS),
    ],
  );
  userId = created.rows[0].id;

  // Акцепты обязательных документов — те же четыре, без которых аккаунт не
  // активируется: фикстура не должна создавать состояние, невозможное в бою.
  await pool.query(
    `INSERT INTO identity.consents (id, user_id, kind, version, locale, request_trace_hash)
     SELECT public.uuid_generate_v7(), $1, t.kind, t.version, t.locale, digest('dev-seed-trace', 'sha256')
       FROM identity.consent_templates t
      WHERE t.superseded_at IS NULL AND t.locale = 'ru-RU'
        AND t.kind IN ('platform_rules','tos','pdn','commission_terms')`,
    [userId],
  );
  await pool.query(`UPDATE identity.users SET status = 'active' WHERE id = $1`, [userId]);
}

for (const role of ROLES) {
  await pool.query(
    `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, role],
  );
}

// KYC проходит отдельным администратором: самоодобрение запрещено триггером,
// а тестовому пользователю верификация нужна, чтобы публиковать листинги.
const reviewer = await pool.query(
  `SELECT u.id FROM identity.users u
     JOIN identity.user_roles r ON r.user_id = u.id AND r.role = 'admin'
    WHERE u.id <> $1 LIMIT 1`,
  [userId],
);
const reviewerId = reviewer.rows[0]?.id ?? null;

if (reviewerId) {
  await pool.query(
    `INSERT INTO kyc.kyc_verifications
       (id, user_id, kind, status, risk_level, sanctions_status, reviewed_by, decided_at, expires_at)
     SELECT public.uuid_generate_v7(), $1, 'identity', 'approved', 'low', 'clear', $2, now(),
            now() + interval '1 year'
      WHERE NOT EXISTS (
        SELECT 1 FROM kyc.kyc_verifications
         WHERE user_id = $1 AND kind = 'identity' AND status = 'approved')`,
    [userId, reviewerId],
  );
}

console.warn('Тестовый пользователь готов (ТОЛЬКО для разработки):');
console.warn(`  логин:  ${LOGIN}   (полный адрес: ${EMAIL})`);
// Значение пароля НЕ печатается: stdout попадает в транскрипты сессий и их
// чекпоинты (инцидент Ф25). Пароль и так лежит в .env — смотри туда.
console.warn('  пароль: значение из DEV_TEST_USER_PASSWORD в .env (не печатается)');
console.warn(`  роли:   ${ROLES.join(', ')}`);
console.warn(
  reviewerId
    ? '  KYC:    одобрен'
    : '  KYC:    НЕ одобрен — в базе нет другого администратора, а самоодобрение запрещено',
);
console.warn('\nУдалить перед выходом в production (см. TODO.md).');

await pool.end();
