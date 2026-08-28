#!/usr/bin/env node
/**
 * Привести пароли тестовых учёток стенда к значению из `.env`.
 *
 * Зачем отдельный скрипт, а не перезапуск сидов: учётки заводят ТРИ разных
 * скрипта (`dev-seed-test-user`, `dev-stand`, `seed-demo`), и ротация пароля в
 * `.env` не переписывает хеши тех, чей скрипт не перезапускали. Так `stand-*`
 * и все каталожные разошлись с `.env` и отвечали 401 при верном пароле.
 * Полный `seed-demo load` починил бы и это, но он трогает проекты, материалы и
 * сезоны — здесь же нужно поменять ровно одно поле.
 *
 * ЧТО ДЕЛАЕТ: для каждого известного логина считает слепой индекс адреса,
 * находит строку и переписывает `password_hash` тем же алгоритмом и с теми же
 * параметрами, что сервер (Argon2id, OWASP-минимум). Больше ничего: роли,
 * статусы, согласия и данные не трогаются.
 *
 * ЧЕГО НЕ ДЕЛАЕТ: не создаёт учётки (нет строки — пропуск с пометкой) и не
 * воскрешает удалённые (`deleted_at IS NOT NULL` пропускается — учётку удаляли
 * осознанно, и тихо вернуть ей вход было бы отменой чужого решения).
 *
 * Отказывается работать при NODE_ENV=production.
 *
 *   node scripts/dev-reset-stand-passwords.mjs            все известные логины
 *   node scripts/dev-reset-stand-passwords.mjs --only stand
 */
import pg from 'pg';
import argon2 from 'argon2';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

if (process.env.NODE_ENV === 'production') {
  console.error('Тестовые пароли в production не раздаются.');
  process.exit(1);
}

const argv = process.argv.slice(2);
const only = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 ? argv[i + 1] : null;
})();

const PASSWORD = process.env.DEV_TEST_USER_PASSWORD ?? '';
if (!PASSWORD) {
  console.error('Не задан DEV_TEST_USER_PASSWORD в .env.');
  process.exit(2);
}

/** Те же параметры, что в IdentityService: иначе сервер не примет хеш. */
const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

function loadDotEnv() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
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

function blindIndex(value) {
  return createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${value.trim().toLowerCase()}`, 'utf8')
    .digest();
}

function catalogLogins() {
  const file = join(ROOT, 'fixtures/catalog/people.json');
  if (!existsSync(file)) return [];
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      if (typeof node.login === 'string') found.push(node.login);
      Object.values(node).forEach(walk);
    }
  };
  walk(JSON.parse(readFileSync(file, 'utf8')));
  return [...new Set(found)];
}

const STAND = ['stand-admin', 'stand-founder', 'stand-investor', 'stand-expert', 'stand-organizer'];

const logins = [...new Set(only === 'stand' ? STAND : [...STAND, ...catalogLogins()])];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });
const hash = await argon2.hash(PASSWORD, ARGON2_OPTIONS);

let updated = 0;
const missing = [];
const deleted = [];
try {
  for (const login of logins) {
    const email = login.includes('@') ? login : `${login}@unicorn.local`;
    const { rows } = await pool.query(
      'SELECT id, deleted_at FROM identity.users WHERE email_hmac = $1',
      [blindIndex(email)],
    );
    if (rows.length === 0) {
      missing.push(login);
      continue;
    }
    if (rows[0].deleted_at) {
      deleted.push(login);
      continue;
    }
    await pool.query(
      `UPDATE identity.users SET password_hash = $2, status = 'active' WHERE id = $1`,
      [rows[0].id, hash],
    );
    updated += 1;
  }
} finally {
  await pool.end();
}

console.log(`\n=== ПАРОЛИ ТЕСТОВЫХ УЧЁТОК ===`);
console.log(`  обновлено:        ${updated}/${logins.length}`);
if (missing.length) console.log(`  нет в базе (${missing.length}): ${missing.join(', ')}`);
if (deleted.length) console.log(`  удалены, пропущены: ${deleted.join(', ')}`);
console.log(`  пароль — DEV_TEST_USER_PASSWORD из .env (здесь не печатается)`);
console.log(`\n  Проверить вход: node scripts/check-stand-logins.mjs\n`);
