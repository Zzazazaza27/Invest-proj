#!/usr/bin/env node
/**
 * Проверка немедленности отзыва прав.
 *
 * Находка внешнего аудита (SEC-08): роли берутся из токена, а токен живёт до
 * своего `exp`. Снятая в БД роль администратора продолжала действовать до
 * истечения сессии — то есть отзыв прав фактически откладывался на час.
 *
 * Прогон проверяет фактом: получить сессию с ролью, снять роль в БД, повторить
 * тот же запрос ТЕМ ЖЕ токеном.
 *
 * Запуск: node scripts/probe-role-revocation.mjs
 */
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

function loadDotEnv() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) process.env[trimmed.slice(0, eq).trim()] ??= trimmed.slice(eq + 1).trim();
  }
}

const BASE = process.env.CORE_URL ?? CORE_URL;
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'ul_csrf';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.warn(`  OK    ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.warn(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

function blindIndex(email) {
  return createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
}

function makeClient() {
  const state = { session: null, csrf: null };
  return {
    async call(path, { method = 'GET', body } = {}) {
      const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (method !== 'GET' && state.csrf) {
        headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
      }
      const response = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      for (const cookie of response.headers.getSetCookie?.() ?? []) {
        const pair = cookie.split(';')[0];
        if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
        if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
      }
      return response;
    },
  };
}

const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

console.warn('\n=== ПРОВЕРКА ОТЗЫВА ПРАВ ===\n');

const suffix = `${Date.now() % 1e9}`;
const email = `revoke-${suffix}@test.local`;
const password = `Pw-${randomUUID()}`;
const client = makeClient();

await client.call('/v1/auth/register', {
  method: 'POST',
  body: {
    email,
    password,
    displayName: 'Отзыв прав',
    role: 'founder',
    locale: 'ru-RU',
    consents: CONSENTS,
  },
});
const [user] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
  blindIndex(email),
]);

// Роль выдаётся напрямую в БД, затем сессия перевыпускается — иначе роли в
// токене просто не будет и проверять было бы нечего.
await sql(`INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin')`, [user.id]);
await client.call('/v1/auth/login', { method: 'POST', body: { email, password } });

const before = await client.call('/v1/admin/feature-flags');
check('с ролью админа доступ есть', before.status === 200, `HTTP ${before.status}`);

// Снятие роли ТЕМ ЖЕ способом, что и в приложении: через журнальную отметку и
// сдвиг рубежа сессий.
await sql(
  `UPDATE identity.user_roles SET revoked_at = now() WHERE user_id = $1 AND role = 'admin'`,
  [user.id],
);
// Тем же выражением, что и приложение: начало следующей секунды.
await sql(
  `UPDATE identity.users
      SET sessions_valid_from = date_trunc('second', now()) + interval '1 second'
    WHERE id = $1`,
  [user.id],
);

// Кеш рубежа живёт несколько секунд: ждём чуть дольше, чем он.
await new Promise((resolve) => setTimeout(resolve, 6000));

const after = await client.call('/v1/admin/feature-flags');
check(
  'после снятия роли ТОТ ЖЕ токен доступа не даёт',
  after.status === 401 || after.status === 403,
  `HTTP ${after.status}`,
);

// Контроль: пользователь должен снова войти и получить корректные (уже без
// admin) права — иначе «отзыв» превратился бы в блокировку учётной записи.
await client.call('/v1/auth/login', { method: 'POST', body: { email, password } });
const relogin = await client.call('/v1/admin/feature-flags');
check(
  'после повторного входа админский доступ не восстановился',
  relogin.status === 403,
  `HTTP ${relogin.status}`,
);
const me = await client.call('/v1/auth/me');
check('обычные маршруты работают после повторного входа', me.status === 200, `HTTP ${me.status}`);

await pool.end();
console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exitCode = failed > 0 ? 1 : 0;
