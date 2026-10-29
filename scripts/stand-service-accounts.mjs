#!/usr/bin/env node
/**
 * Начальные учётные записи после обнуления стенда (29.10.2026).
 *
 *  - «Платформа» — служебный автор сохранённых справочников. Войти под ней
 *    нельзя: пароля нет, статус «приостановлена» с причиной, ролей нет.
 *  - Администратор — единственная рабочая учётка; роль admin.
 *
 * Обе регистрируются через API заранее (шифрование контактов и хеш пароля —
 * штатным кодом); скрипт только доводит их и печатает идентификаторы.
 * Запуск из корня репозитория стенда:
 *   node scripts/stand-service-accounts.mjs <email платформы> <email администратора>
 */
import pg from 'pg';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const envFile = join(process.cwd(), '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) process.env[t.slice(0, eq).trim()] ??= t.slice(eq + 1).trim();
  }
}
const [platformEmail, adminEmail] = process.argv.slice(2);
const hmac = (email) =>
  createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
const c = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
await c.connect();
const idOf = async (email) =>
  (await c.query('SELECT id FROM identity.users WHERE email_hmac = $1', [hmac(email)])).rows[0]?.id;
const platform = await idOf(platformEmail);
const admin = await idOf(adminEmail);
if (!platform || !admin) {
  console.error('учётки не найдены — сначала зарегистрируй их через API');
  process.exit(1);
}
await c.query('BEGIN');
await c.query(
  `UPDATE identity.users
      SET password_hash = NULL, display_name = 'Платформа', status = 'suspended',
          status_reason = 'служебный автор справочников, вход запрещён',
          status_changed_at = now(), sessions_valid_from = now()
    WHERE id = $1`,
  [platform],
);
await c.query('DELETE FROM identity.user_roles WHERE user_id = $1', [platform]);
await c.query(
  `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
  [admin],
);
await c.query('COMMIT');
await c.end();
console.log(JSON.stringify({ platform, admin }));
