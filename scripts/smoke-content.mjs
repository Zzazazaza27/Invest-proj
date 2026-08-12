#!/usr/bin/env node
/**
 * Живой прогон: управление контентом публичной витрины (M048/M049).
 *
 * Тексты лендинга были зашиты в исходники фронтенда — поменять формулировку
 * можно было только выкладкой. Часть этих текстов является публичным
 * утверждением оператора, поэтому у правки должны быть автор, основание и
 * история.
 *
 * Проверяется фактом:
 *   1. витрина читается БЕЗ авторизации;
 *   2. публиковать может только администратор;
 *   3. новая версия вытесняет прежнюю — двух действующих не бывает;
 *   4. прежняя версия остаётся в истории, а не стирается;
 *   5. снятие убирает блок с витрины, но не из истории;
 *   6. неизвестный ключ и не-https ссылка отвергаются на границе;
 *   7. каждая правка попадает в журнал с основанием.
 *
 * Запуск: node scripts/smoke-content.mjs (нужны БД и core на 4300)
 */
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const BASE = 'http://127.0.0.1:4300';
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
  const email = `cnt-${tag}-${suffix}@test.local`;
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

console.warn('\n=== ЖИВОЙ ПРОГОН: КОНТЕНТ ВИТРИНЫ ===\n');

const admin = await register('admin', 'admin');
const outsider = await register('outsider');

// 1. Витрина читается без авторизации.
{
  const { response, json } = await raw('/v1/content/landing');
  check('витрина читается анонимом', response.status === 200, `HTTP ${response.status}`);
  check(
    'ответ имеет форму контракта',
    Array.isArray(json?.blocks),
    JSON.stringify(json).slice(0, 80),
  );
}

// 2. Писать может только администратор.
{
  const { response } = await outsider.client.call('/v1/admin/content/landing', {
    method: 'POST',
    body: { key: 'hero_title', body: 'Чужая правка', reason: 'попытка' },
  });
  check('посторонний не публикует', response.status === 403, `HTTP ${response.status}`);
}

// 3. Публикация и вытеснение прежней версии.
let firstId = null;
{
  const first = await admin.client.call('/v1/admin/content/landing', {
    method: 'POST',
    body: { key: 'hero_title', body: 'Первая версия', reason: 'начальная публикация' },
  });
  firstId = first.json?.id ?? null;
  check(
    'публикация принята',
    first.response.status === 201 || first.response.status === 200,
    `HTTP ${first.response.status} ${JSON.stringify(first.json).slice(0, 120)}`,
  );

  const shown = await raw('/v1/content/landing');
  const hero = (shown.json?.blocks ?? []).find((b) => b.key === 'hero_title');
  check('опубликованный текст виден на витрине', hero?.body === 'Первая версия', hero?.body);

  const second = await admin.client.call('/v1/admin/content/landing', {
    method: 'POST',
    body: { key: 'hero_title', body: 'Вторая версия', reason: 'правка формулировки' },
  });
  check(
    'вторая публикация принята',
    second.response.status === 201 || second.response.status === 200,
  );

  const after = await raw('/v1/content/landing');
  const heroes = (after.json?.blocks ?? []).filter((b) => b.key === 'hero_title');
  check(
    'на витрине ровно одна действующая версия',
    heroes.length === 1,
    `версий: ${heroes.length}`,
  );
  check('видна именно новая версия', heroes[0]?.body === 'Вторая версия', heroes[0]?.body);
}

// 4. Прежняя версия не стёрта, а закрыта.
{
  const { json } = await admin.client.call('/v1/admin/content/landing/history?key=hero_title');
  const items = json?.items ?? [];
  check('история хранит обе версии', items.length >= 2, `версий в истории: ${items.length}`);
  const closed = items.find((b) => b.id === firstId);
  check(
    'первая версия закрыта, а не удалена',
    Boolean(closed?.validTo),
    `validTo: ${closed?.validTo}`,
  );
}

// 5. Снятие блока.
{
  const { json: before } = await raw('/v1/content/landing');
  const current = (before.blocks ?? []).find((b) => b.key === 'hero_title');
  const { response } = await admin.client.call(`/v1/admin/content/landing/${current.id}/withdraw`, {
    method: 'POST',
    body: { reason: 'проверка снятия' },
  });
  check(
    'снятие принято',
    response.status === 201 || response.status === 200,
    `HTTP ${response.status}`,
  );

  const { json: after } = await raw('/v1/content/landing');
  check(
    'снятый блок исчез с витрины',
    !(after.blocks ?? []).some((b) => b.key === 'hero_title'),
    `блоков: ${(after.blocks ?? []).length}`,
  );
  const { json: hist } = await admin.client.call(
    '/v1/admin/content/landing/history?key=hero_title',
  );
  check('снятый блок остался в истории', (hist?.items ?? []).length >= 2);
}

// 6. Проверка на границе.
{
  const bad = await admin.client.call('/v1/admin/content/landing', {
    method: 'POST',
    body: { key: 'неизвестный_ключ', body: 'текст', reason: 'проверка' },
  });
  check(
    'неизвестный ключ отвергнут',
    bad.response.status === 400 || bad.response.status === 422,
    `HTTP ${bad.response.status}`,
  );

  const insecure = await admin.client.call('/v1/admin/content/landing', {
    method: 'POST',
    body: {
      key: 'banner_primary',
      body: 'баннер',
      linkUrl: 'http://example.com',
      reason: 'проверка',
    },
  });
  check(
    'ссылка не по https отвергнута',
    insecure.response.status === 400 || insecure.response.status === 422,
    `HTTP ${insecure.response.status}`,
  );
}

// 7. Журнал.
{
  const rows = await sql(
    `SELECT verb, context_jsonb->>'reason' AS reason FROM audit.events
      WHERE verb LIKE 'content.landing_block.%' AND actor_id = $1
      ORDER BY ts DESC LIMIT 5`,
    [admin.userId],
  );
  check(
    'публикации попали в журнал',
    rows.filter((r) => r.verb.endsWith('published')).length >= 2,
    `записей: ${rows.length}`,
  );
  check(
    'снятие попало в журнал',
    rows.some((r) => r.verb.endsWith('withdrawn')),
  );
  check(
    'основание правки сохранено',
    rows.every((r) => r.reason && r.reason.length > 2),
  );
}

// Уборка: прогон не оставляет за собой контента.
await sql("DELETE FROM content.landing_blocks WHERE key IN ('hero_title','banner_primary')");
await sql('DELETE FROM identity.user_roles WHERE user_id = ANY($1)', [
  [admin.userId, outsider.userId],
]);
await pool.end();

console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено.\n`);
if (failed > 0) process.exitCode = 1;
