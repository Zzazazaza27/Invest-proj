#!/usr/bin/env node
/**
 * Выдача роли администратора — ЛОКАЛЬНАЯ dev-утилита.
 *
 * Первый администратор не может появиться через API: роль `admin` не входит в
 * список ролей самостоятельной регистрации, и это правильно. В production её
 * выдаёт оператор через IdP; здесь — этот скрипт, работающий от имени владельца
 * схем.
 *
 * Скрипт отказывается работать при NODE_ENV=production: раздача админских прав
 * скриптом из репозитория в проде — это дыра, а не удобство.
 *
 * Использование:
 *   node scripts/dev-make-admin.mjs <email>            — повысить существующего
 *   node scripts/dev-make-admin.mjs <email> --create   — создать и повысить
 */
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

if (process.env.NODE_ENV === 'production') {
  console.error('Этот скрипт предназначен только для локальной разработки.');
  process.exit(1);
}

const email = process.argv[2];
const shouldCreate = process.argv.includes('--create');
if (!email) {
  console.error('Укажи адрес: node scripts/dev-make-admin.mjs <email> [--create]');
  process.exit(1);
}

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

const API = process.env.CORE_PUBLIC_URL ?? CORE_URL;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });

function blindIndex(value) {
  return createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${value.trim().toLowerCase()}`, 'utf8')
    .digest();
}

let password = null;

if (shouldCreate) {
  // Регистрация идёт через API, а не INSERT'ом: так пароль хешируется тем же
  // кодом, что и в бою, и акцепты условий проставляются по тем же правилам.
  password = `Adm-${randomUUID()}`;
  const consents = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
    kind,
    version: 'v1',
    locale: 'ru-RU',
  }));
  const response = await fetch(`${API}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      displayName: 'Администратор',
      role: 'founder',
      locale: 'ru-RU',
      consents,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    console.error(`Регистрация не удалась: ${response.status} ${await response.text()}`);
    await pool.end();
    process.exit(1);
  }
}

const { rows } = await pool.query('SELECT id FROM identity.users WHERE email_hmac = $1', [
  blindIndex(email),
]);
const user = rows[0];
if (!user) {
  console.error(`Пользователь ${email} не найден. Добавь --create, чтобы завести его.`);
  await pool.end();
  process.exit(1);
}

await pool.query(
  `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
  [user.id],
);

console.warn(`Роль admin выдана: ${email}`);
if (password) console.warn(`Пароль (только для локальной разработки): ${password}`);
console.warn('Роль появится в сессии после повторного входа.');

await pool.end();
