#!/usr/bin/env node
/**
 * Живой прогон: избранные проекты инвестора (M063).
 *
 * Проверяется фактом:
 *
 *   1. инвестор добавляет проект из каталога и видит его в своём списке;
 *   2. повторное добавление не плодит дубль и не является ошибкой;
 *   3. удаление снимает отметку, повторное удаление — тоже не ошибка;
 *   4. состояние переживает выход и повторный вход (хранится на сервере);
 *   5. чужое избранное не читается и не изменяется — ни списком, ни прямым
 *      запросом, ни через БД под ролью приложения;
 *   6. основатель без роли инвестора добавить не может;
 *   7. проекта вне публичного каталога в избранном не появится, и ответ не
 *      различает «нет в каталоге» и «нет вовсе» — иначе это оракул
 *      существования чужих проектов;
 *   8. закладка не открывает данных сверх тизера каталога.
 *
 * Запуск: node scripts/smoke-favorites.mjs (нужны БД и core на 4300)
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
  return { call, state };
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

async function register(tag, role) {
  const client = makeClient();
  const email = `fav-${tag}-${suffix}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const { response, json } = await client.call('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: `Тест ${tag}`,
      role,
      locale: 'ru-RU',
      consents: CONSENTS,
    },
  });
  if (response.status >= 400) throw new Error(`регистрация ${tag}: ${JSON.stringify(json)}`);
  const [row] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
    blindIndex(email),
  ]);
  return { client, email, password, userId: row.id };
}

console.warn('\n=== ЖИВОЙ ПРОГОН: ИЗБРАННОЕ ИНВЕСТОРА ===\n');

const investor = await register('investor', 'investor');
const other = await register('other', 'investor');
const founder = await register('founder', 'founder');

// Проект берём из ПУБЛИЧНОГО каталога: избранное работает ровно с тем, что
// инвестор и так видит.
const catalog = await raw('/v1/catalog?limit=2');
const listed = catalog.json?.items ?? [];
if (listed.length === 0) {
  console.error('В публичном каталоге нет ни одного листинга — прогон невозможен.');
  console.error('Загрузите комплект: node scripts/seed-demo.mjs load');
  await pool.end();
  process.exit(1);
}
const projectId = listed[0].id;
const secondId = listed[1]?.id ?? null;

console.warn('[1] Добавление и список');
{
  const added = await investor.client.call(`/v1/investor/favorites/${projectId}`, {
    method: 'PUT',
  });
  check(
    'проект добавлен в избранное',
    added.response.status === 200,
    `HTTP ${added.response.status}`,
  );

  const list = await investor.client.call('/v1/investor/favorites');
  const ids = (list.json?.items ?? []).map((item) => item.id);
  check('проект виден в списке избранного', ids.includes(projectId), `в списке: ${ids.length}`);

  const item = (list.json?.items ?? []).find((entry) => entry.id === projectId);
  check(
    'в списке — карточка, а не голый идентификатор',
    typeof item?.title === 'string',
    item?.title,
  );
  check('момент добавления возвращается', typeof item?.favoritedAt === 'string', item?.favoritedAt);
  // Закладка не должна открывать данные, которых инвестор без неё не видит.
  const teaserKeys = new Set([
    'id',
    'title',
    'tagline',
    'stage',
    'taxonomyId',
    'geoCountry',
    'investmentAsk',
    'askCurrency',
    'listedAt',
    'raising',
    'favoritedAt',
  ]);
  const extra = Object.keys(item ?? {}).filter((key) => !teaserKeys.has(key));
  check('сверх тизера ничего не отдаётся', extra.length === 0, extra.join(', '));

  const idsOnly = await investor.client.call('/v1/investor/favorites/ids');
  check(
    'короткий список идентификаторов работает',
    (idsOnly.json?.items ?? []).includes(projectId),
    `${(idsOnly.json?.items ?? []).length} шт.`,
  );
}

console.warn('\n[2] Повторное добавление не плодит дубль');
{
  const again = await investor.client.call(`/v1/investor/favorites/${projectId}`, {
    method: 'PUT',
  });
  check(
    'повтор не является ошибкой',
    again.response.status === 200,
    `HTTP ${again.response.status}`,
  );
  const [row] = await sql(
    `SELECT count(*)::int AS n FROM lab.project_favorites WHERE user_id = $1 AND project_id = $2`,
    [investor.userId, projectId],
  );
  check('в базе ровно одна строка', row.n === 1, `строк: ${row.n}`);
}

console.warn('\n[3] Границы: чужое избранное');
{
  const otherList = await other.client.call('/v1/investor/favorites');
  const ids = (otherList.json?.items ?? []).map((item) => item.id);
  check(
    'чужое избранное не видно в своём списке',
    !ids.includes(projectId),
    `в списке: ${ids.length}`,
  );

  // Попытка снять чужую отметку своим запросом: маршрут не принимает чужого
  // владельца вовсе, поэтому проверяем ФАКТ в базе после вызова.
  await other.client.call(`/v1/investor/favorites/${projectId}`, { method: 'DELETE' });
  const [row] = await sql(
    `SELECT count(*)::int AS n FROM lab.project_favorites WHERE user_id = $1 AND project_id = $2`,
    [investor.userId, projectId],
  );
  check('чужая отметка уцелела', row.n === 1, `строк: ${row.n}`);

  const anon = await raw('/v1/investor/favorites');
  check('анониму список не отдаётся', anon.response.status === 401, `HTTP ${anon.response.status}`);
}

console.warn('\n[4] Границы в самой БД (RLS, а не только маршрут)');
{
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', other.userId]);
    await client.query('SELECT set_config($1, $2, true)', ['app.current_roles', 'investor']);
    await client.query('SET LOCAL ROLE app_backend');

    const seen = await client.query('SELECT project_id FROM lab.project_favorites');
    check(
      'под ролью приложения чужих строк не видно',
      seen.rowCount === 0,
      `строк: ${seen.rowCount}`,
    );

    const deleted = await client.query('DELETE FROM lab.project_favorites WHERE project_id = $1', [
      projectId,
    ]);
    check('чужую строку не удалить', deleted.rowCount === 0, `удалено: ${deleted.rowCount}`);

    let forged = 'нет отказа';
    try {
      await client.query(
        `INSERT INTO lab.project_favorites (user_id, project_id) VALUES ($1, $2)`,
        [investor.userId, projectId],
      );
    } catch (error) {
      forged = error.code;
    }
    check('отметку от чужого имени не поставить', forged === '42501', String(forged));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

console.warn('\n[5] Роль инвестора обязательна');
{
  const attempt = await founder.client.call(`/v1/investor/favorites/${projectId}`, {
    method: 'PUT',
  });
  check(
    'основатель добавить не может',
    attempt.response.status === 403,
    `HTTP ${attempt.response.status}`,
  );
  const [row] = await sql(
    `SELECT count(*)::int AS n FROM lab.project_favorites WHERE user_id = $1`,
    [founder.userId],
  );
  check('строки основателя в базе нет', row.n === 0, `строк: ${row.n}`);
}

console.warn('\n[6] Проект вне публичного каталога');
{
  // Черновик существует, но в каталоге его нет. Ответ обязан совпасть с
  // ответом на несуществующий идентификатор — иначе это оракул.
  const [draft] = await sql(
    `SELECT id FROM lab.projects
      WHERE id NOT IN (SELECT id FROM lab.v_public_catalog) AND deleted_at IS NULL
      LIMIT 1`,
  );
  const missing = await investor.client.call(`/v1/investor/favorites/${randomUUID()}`, {
    method: 'PUT',
  });
  check(
    'несуществующий проект — 404',
    missing.response.status === 404,
    `HTTP ${missing.response.status}`,
  );

  if (draft) {
    const hidden = await investor.client.call(`/v1/investor/favorites/${draft.id}`, {
      method: 'PUT',
    });
    check(
      'проект вне каталога — тот же 404, что и несуществующий',
      hidden.response.status === missing.response.status,
      `HTTP ${hidden.response.status} против ${missing.response.status}`,
    );
    const [row] = await sql(
      `SELECT count(*)::int AS n FROM lab.project_favorites WHERE project_id = $1`,
      [draft.id],
    );
    check('скрытый проект в избранное не попал', row.n === 0, `строк: ${row.n}`);
  } else {
    console.warn('  ---   проекта вне каталога на стенде нет — проверка не выполнялась');
  }
}

console.warn('\n[7] Состояние переживает выход и вход');
{
  if (secondId) {
    await investor.client.call(`/v1/investor/favorites/${secondId}`, { method: 'PUT' });
  }
  await investor.client.call('/v1/auth/logout', { method: 'POST' });
  const after = await investor.client.call('/v1/investor/favorites');
  check(
    'после выхода список не отдаётся',
    after.response.status === 401,
    `HTTP ${after.response.status}`,
  );

  const fresh = makeClient();
  await fresh.call('/v1/auth/login', {
    method: 'POST',
    body: { email: investor.email, password: investor.password },
  });
  const list = await fresh.call('/v1/investor/favorites');
  const ids = (list.json?.items ?? []).map((item) => item.id);
  check(
    'после повторного входа избранное на месте',
    ids.includes(projectId),
    `в списке: ${ids.length}`,
  );
  if (secondId) {
    check('оба проекта сохранились', ids.includes(secondId), ids.join(', '));
    // Свежее — сверху: человек ждёт последнее добавленное первым.
    check('порядок — от свежего к старому', ids[0] === secondId, ids.slice(0, 2).join(', '));
  }
}

console.warn('\n[8] Удаление');
{
  const fresh = makeClient();
  await fresh.call('/v1/auth/login', {
    method: 'POST',
    body: { email: investor.email, password: investor.password },
  });
  const removed = await fresh.call(`/v1/investor/favorites/${projectId}`, { method: 'DELETE' });
  check('отметка снята', removed.response.status === 200, `HTTP ${removed.response.status}`);

  const again = await fresh.call(`/v1/investor/favorites/${projectId}`, { method: 'DELETE' });
  check(
    'повторное удаление не ошибка',
    again.response.status === 200,
    `HTTP ${again.response.status}`,
  );

  const list = await fresh.call('/v1/investor/favorites');
  const ids = (list.json?.items ?? []).map((item) => item.id);
  check('проекта в списке больше нет', !ids.includes(projectId), ids.join(', '));

  const [row] = await sql(
    `SELECT count(*)::int AS n FROM lab.project_favorites WHERE user_id = $1 AND project_id = $2`,
    [investor.userId, projectId],
  );
  check('строки в базе нет', row.n === 0, `строк: ${row.n}`);
}

console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено.\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);
