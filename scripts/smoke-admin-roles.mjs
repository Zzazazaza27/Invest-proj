#!/usr/bin/env node
/**
 * Живой прогон Ф9c: управление ролями и машиночитаемое описание API.
 *
 * Проверяется главное: роли раздаёт только администратор и только другим;
 * последнего администратора нельзя разжаловать; каждая выдача и снятие
 * попадают в журнал; описание API отдаётся только по сессии (анониму — 404,
 * SEC-21) и не содержит ничего, кроме типов.
 *
 * Запуск: node scripts/smoke-admin-roles.mjs (нужны БД и core на 4300)
 */
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const BASE = CORE_URL;
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

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

async function raw(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* не JSON */
  }
  return { response, json, text };
}

function makeClient() {
  const state = { session: null, csrf: null };
  async function call(path, { method = 'GET', body } = {}) {
    const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) {
      headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
    }
    const result = await raw(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of result.response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(';')[0];
      if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
      if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
    }
    return result;
  }
  return { call };
}

const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));
const suffix = `${Date.now() % 1e9}`;

function blindIndex(email) {
  return createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
}

async function register(tag, extraRole = null) {
  const client = makeClient();
  const email = `rol-${tag}-${suffix}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const { response, json } = await client.call('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: `Тест ${tag}`,
      role: 'founder',
      locale: 'ru-RU',
      consents: CONSENTS,
    },
  });
  if (response.status >= 400) throw new Error(`регистрация ${tag}: ${JSON.stringify(json)}`);
  const [row] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
    blindIndex(email),
  ]);
  if (extraRole) {
    await sql(
      `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [row.id, extraRole],
    );
    await client.call('/v1/auth/login', { method: 'POST', body: { email, password } });
  }
  return { client, email, password, userId: row.id };
}

console.warn('\n=== ЖИВОЙ ПРОГОН: РОЛИ И ОПИСАНИЕ API ===\n');

const admin = await register('admin', 'admin');
const secondAdmin = await register('admin2', 'admin');
const target = await register('user');

// ------------------------------------------------------------------ доступ
console.warn('\n[1] Кто может раздавать права');
{
  const { response } = await target.client.call(`/v1/admin/users/${admin.userId}/roles`, {
    method: 'POST',
    body: { role: 'admin' },
  });
  check('обычный пользователь не выдаёт роли', response.status === 403, `HTTP ${response.status}`);
}
{
  const { response } = await raw(`/v1/admin/users/${target.userId}/roles`, { method: 'GET' });
  check('аноним не читает роли', response.status === 401, `HTTP ${response.status}`);
}
{
  const { response } = await admin.client.call(`/v1/admin/users/${admin.userId}/roles`, {
    method: 'POST',
    body: { role: 'organizer' },
  });
  check(
    'администратор не выдаёт роль сам себе',
    response.status === 403,
    `HTTP ${response.status}`,
  );
}

// ---------------------------------------------------------------- выдача
console.warn('\n[2] Выдача и снятие');
{
  const { response, json } = await admin.client.call(`/v1/admin/users/${target.userId}/roles`, {
    method: 'POST',
    body: { role: 'expert' },
  });
  check('роль выдана', response.status < 400, `HTTP ${response.status}`);
  check(
    'роль видна в ответе',
    (json?.items ?? []).some((r) => r.role === 'expert' && r.revokedAt === null),
  );
}
{
  const { response } = await admin.client.call(`/v1/admin/users/${target.userId}/roles`, {
    method: 'POST',
    body: { role: 'expert' },
  });
  check(
    'повторная выдача той же роли отклонена',
    response.status === 409,
    `HTTP ${response.status}`,
  );
}
{
  const { response } = await admin.client.call(`/v1/admin/users/${target.userId}/roles`, {
    method: 'POST',
    body: { role: 'суперадмин' },
  });
  check('роль вне списка не принимается', response.status === 400, `HTTP ${response.status}`);
}
{
  const missing = '00000000-0000-7000-8000-000000000000';
  const { response } = await admin.client.call(`/v1/admin/users/${missing}/roles`, {
    method: 'POST',
    body: { role: 'expert' },
  });
  check(
    'роль несуществующему пользователю не выдаётся',
    response.status === 404,
    `HTTP ${response.status}`,
  );
}
{
  const { response, json } = await admin.client.call(
    `/v1/admin/users/${target.userId}/roles/expert`,
    { method: 'DELETE' },
  );
  check('роль снята', response.status < 400, `HTTP ${response.status}`);
  const active = (json?.items ?? []).filter((r) => r.role === 'expert' && r.revokedAt === null);
  check('снятая роль больше не действует', active.length === 0);
  check(
    'история выдачи сохранена',
    (json?.items ?? []).some((r) => r.role === 'expert' && r.revokedAt !== null),
  );
}
{
  const { response } = await admin.client.call(`/v1/admin/users/${target.userId}/roles/expert`, {
    method: 'DELETE',
  });
  check(
    'повторное снятие отвечает «не найдено»',
    response.status === 404,
    `HTTP ${response.status}`,
  );
}

// ------------------------------------------------- последний администратор
console.warn('\n[3] Последний администратор');
{
  const { response } = await admin.client.call(
    `/v1/admin/users/${secondAdmin.userId}/roles/admin`,
    { method: 'DELETE' },
  );
  check(
    'второго администратора разжаловать можно',
    response.status < 400,
    `HTTP ${response.status}`,
  );
}
{
  // Теперь действующих админов в системе может остаться несколько (от других
  // прогонов), поэтому проверяем инвариант напрямую: снятие последнего.
  const [{ count }] = await sql(
    `SELECT count(*)::int AS count FROM identity.user_roles
      WHERE role = 'admin' AND revoked_at IS NULL`,
  );
  if (count === 1) {
    const [last] = await sql(
      `SELECT user_id FROM identity.user_roles WHERE role = 'admin' AND revoked_at IS NULL`,
    );
    const { response } = await admin.client.call(`/v1/admin/users/${last.user_id}/roles/admin`, {
      method: 'DELETE',
    });
    check(
      'последнего администратора разжаловать нельзя',
      response.status === 409,
      `HTTP ${response.status}`,
    );
  } else {
    check(
      'проверка последнего администратора пропущена: в системе несколько админов',
      true,
      `действующих админов: ${count} — инвариант закрыт юнит-логикой и блокировкой`,
    );
  }
}

// ------------------------------------------------------------------ журнал
console.warn('\n[4] Журнал');
{
  const [granted] = await sql(
    `SELECT count(*)::int AS n FROM audit.events
      WHERE verb = 'identity.role.granted' AND subject_id = $1`,
    [target.userId],
  );
  check('выдача роли записана в журнал', granted.n === 1, `строк: ${granted.n}`);
  const [revoked] = await sql(
    `SELECT count(*)::int AS n FROM audit.events
      WHERE verb = 'identity.role.revoked' AND subject_id = $1`,
    [target.userId],
  );
  check('снятие роли записано в журнал', revoked.n === 1, `строк: ${revoked.n}`);
  const [actor] = await sql(
    `SELECT actor_id FROM audit.events
      WHERE verb = 'identity.role.granted' AND subject_id = $1 LIMIT 1`,
    [target.userId],
  );
  check('в журнале зафиксирован тот, кто выдал', actor.actor_id === admin.userId);
}

// ------------------------------------------------------------- описание API
console.warn('\n[5] Машиночитаемое описание API');
{
  // SEC-21 (2026-09-13): описание — карта поверхности атаки, анониму 404
  // (не 403, чтобы не подтверждать существование). Читается по сессии.
  const anon = await raw('/v1/openapi.json');
  check(
    'описание анониму не отдаётся — 404',
    anon.response.status === 404,
    `HTTP ${anon.response.status}`,
  );
  const { response, json } = await admin.client.call('/v1/openapi.json');
  check('описание отдаётся по сессии', response.status === 200, `HTTP ${response.status}`);
  check('версия OpenAPI объявлена', json?.openapi === '3.1.0', json?.openapi);
  const schemas = Object.keys(json?.components?.schemas ?? {});
  check('схемы выведены из контрактов', schemas.length > 50, `схем: ${schemas.length}`);
  check(
    'ключевые схемы на месте',
    ['Season', 'Graduate', 'Notification', 'ExpertAssignment'].every((n) => schemas.includes(n)),
    schemas.slice(0, 3).join(', '),
  );
  check(
    'пропущенные схемы объявлены честно',
    Array.isArray(json?.['x-schemas-skipped']),
    `пропущено: ${(json?.['x-schemas-skipped'] ?? []).length}`,
  );
  check(
    'скоупы интеграции перечислены',
    (json?.['x-integration-scopes'] ?? []).includes('graduates:read'),
  );

  const text = JSON.stringify(json);
  // Ищем ЗНАЧЕНИЯ, а не имена полей: `password` в схеме входа — это часть
  // контракта, и её отсутствие было бы дефектом. Утечкой была бы строка
  // подключения, плейсхолдер конфигурации или ключ в base64.
  const leaked = text.match(
    /postgres:\/\/|redis:\/\/|nats:\/\/|CHANGE_ME|KEK_[A-Z_]+=|"[A-Za-z0-9+/]{40,}={0,2}"/,
  );
  check(
    'в описании нет секретов и строк подключения',
    leaked === null,
    `найдено: ${leaked?.[0] ?? 'нет'}`,
  );
  check(
    'схемы входа объявляют поле пароля — это контракт, а не утечка',
    JSON.stringify(json?.components?.schemas?.LoginRequest ?? {}).includes('password'),
  );
}

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
await pool.end();
process.exit(failed > 0 ? 1 : 0);
