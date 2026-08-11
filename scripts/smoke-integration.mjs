#!/usr/bin/env node
/**
 * Живой прогон Ф9: Integration API.
 *
 * Проверяется главное: наружу не уходит ничего сверх заявленного скоупа;
 * персональных данных нет ни в одном ответе; обезличенная проекция исчезает в
 * тот же момент, когда отозвано согласие; проект, не ставший выпускником, для
 * внешней системы не существует; секрет клиента возвращается ровно один раз и
 * перестаёт работать сразу после ротации.
 *
 * Запуск: node scripts/smoke-integration.mjs (нужны поднятая БД и core на 4300)
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

/** Вызов Integration API с токеном сервисного клиента. */
async function api(path, token, { method = 'GET', body } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return raw(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
  const email = `int-${tag}-${suffix}@test.local`;
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

console.warn('\n=== ЖИВОЙ ПРОГОН: INTEGRATION API ===\n');

const founder = await register('f');
const admin = await register('a', 'admin');

// Предусловия: выпускник с паспортом и IRS, и обычный проект-невыпускник.
const [taxonomy] = await sql(`SELECT id FROM lab.project_taxonomy WHERE slug = 'fintech'`);
const [season] = await sql(`SELECT id FROM seasons.seasons ORDER BY number DESC LIMIT 1`);

async function makeProject(title, status) {
  const [row] = await sql(
    `INSERT INTO lab.projects (id, taxonomy_id, season_id, title, stage, status, investment_ask,
                               required_plan_id)
     VALUES (public.uuid_generate_v7(), $1, $2, $3, 'growth', $4, 5000000,
             billing.resolve_founder_plan(5000000))
     RETURNING id`,
    [taxonomy.id, season.id, title, status],
  );
  await sql(
    `INSERT INTO lab.founders_projects (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [row.id, founder.userId],
  );
  return row.id;
}

const graduate = await makeProject(`Выпускник ${suffix}`, 'graduated');
const draft = await makeProject(`Черновик ${suffix}`, 'submitted');

await sql(
  `INSERT INTO scoring.irs_scores (id, project_id, value) VALUES (public.uuid_generate_v7(), $1, 83.25)`,
  [graduate],
);
await sql(
  `INSERT INTO scoring.investment_passports (id, project_id, version, jsonb_data, disclosure_tier,
                                             published_at)
   VALUES (public.uuid_generate_v7(), $1, 1, '{"summary":"тизер выпускника"}'::jsonb, 'teaser', now())`,
  [graduate],
);
// Второй проект — с паспортом уровня full: проверяем, что запрос teaser НЕ
// получит более раскрытую версию. Инвариант passports_one_current не даёт
// держать два опубликованных паспорта на одном проекте.
const graduateFull = await makeProject(`Выпускник с full ${suffix}`, 'graduated');
await sql(
  `INSERT INTO scoring.investment_passports (id, project_id, version, jsonb_data, disclosure_tier,
                                             published_at)
   VALUES (public.uuid_generate_v7(), $1, 1, '{"detail":"полное раскрытие"}'::jsonb, 'full', now())`,
  [graduateFull],
);

// ---------------------------------------------------------- сервисный аккаунт
console.warn('\n[1] Сервисный аккаунт и токен');
let clientId = `capital-${suffix}`;
let clientSecret;
let accountId;
{
  const { response } = await founder.client.call('/v1/admin/service-accounts', {
    method: 'POST',
    body: {
      name: 'Чужой',
      clientId: `evil-${suffix}`,
      scopes: ['deals:read'],
      mtlsCertFingerprint: 'a'.repeat(64),
    },
  });
  check(
    'обычный пользователь не заводит сервисный аккаунт',
    response.status === 403,
    `HTTP ${response.status}`,
  );
}
{
  const { response } = await admin.client.call('/v1/admin/service-accounts', {
    method: 'POST',
    body: {
      name: 'Capital',
      clientId,
      scopes: ['graduates:read', 'passport:read', 'deals:read', 'listing:create', 'seasons:read'],
      mtlsCertFingerprint: 'not-a-fingerprint',
    },
  });
  check(
    'отпечаток сертификата обязан быть sha256',
    response.status === 400,
    `HTTP ${response.status}`,
  );
}
{
  const { response, json } = await admin.client.call('/v1/admin/service-accounts', {
    method: 'POST',
    body: {
      name: 'Capital',
      clientId,
      scopes: ['graduates:read', 'passport:read', 'deals:read', 'listing:create', 'seasons:read'],
      mtlsCertFingerprint: 'b'.repeat(64),
    },
  });
  check('админ заводит сервисный аккаунт', response.status < 400, `HTTP ${response.status}`);
  clientSecret = json?.clientSecret;
  accountId = json?.id;
  check(
    'секрет выдан один раз в ответе',
    typeof clientSecret === 'string' && clientSecret.length >= 32,
  );
}
{
  const { json } = await admin.client.call('/v1/admin/service-accounts');
  const listed = (json?.items ?? []).find((a) => a.id === accountId);
  // Проверяем ОТСУТСТВИЕ ключа в ответе, а не его значение: сравнивать поле с
  // именем секрета нельзя даже в прогоне — правило SAST на это и рассчитано.
  check('в списке аккаунтов секрета нет', listed !== undefined && !('clientSecret' in listed));
  const [row] = await sql(
    'SELECT client_secret_hash FROM integration.service_accounts WHERE id = $1',
    [accountId],
  );
  check('в БД лежит argon2id-хеш, а не секрет', row.client_secret_hash.startsWith('$argon2id$'));
}
{
  const { response } = await raw('/v1/integration/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret: 'x'.repeat(48) }),
  });
  check('неверный секрет — отказ', response.status === 401, `HTTP ${response.status}`);
}
{
  const { response } = await raw('/v1/integration/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: `нет-такого-${suffix}`, clientSecret: 'x'.repeat(48) }),
  });
  check(
    'неизвестный клиент отвечает так же, как неверный секрет',
    response.status === 401,
    `HTTP ${response.status}`,
  );
}

let token;
{
  const { response, json } = await raw('/v1/integration/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  check('токен выдан по client_credentials', response.status < 400, `HTTP ${response.status}`);
  token = json?.accessToken;
  check(
    'токен ограничен по времени жизни',
    typeof json?.expiresIn === 'number' && json.expiresIn <= 3600,
    `expiresIn=${json?.expiresIn}`,
  );
  check(
    'скоупы возвращены клиенту',
    Array.isArray(json?.scopes) && json.scopes.includes('graduates:read'),
  );
}

// -------------------------------------------------------------------- доступ
console.warn('\n[2] Скоупы и границы доступа');
{
  const { response } = await api('/v1/integration/graduates', null);
  check('без токена доступа нет', response.status === 401, `HTTP ${response.status}`);
}
{
  const { response } = await api('/v1/integration/graduates', `${token}x`);
  check('подделанная подпись токена отклонена', response.status === 401, `HTTP ${response.status}`);
}
{
  // Пользовательская сессия — не пропуск в интеграционный контур: у него свой
  // субъект и свой формат токена.
  const { response } = await admin.client.call('/v1/integration/graduates');
  check(
    'сессия администратора не открывает Integration API',
    response.status === 401,
    `HTTP ${response.status}`,
  );
}
{
  const { response } = await api(`/v1/integration/projects/${graduate}/public-profile`, token);
  check('скоупа show:read нет — отказ', response.status === 403, `HTTP ${response.status}`);
}

// ---------------------------------------------------------------- проекции
console.warn('\n[3] Проекции');
{
  const { response, json } = await api('/v1/integration/graduates', token);
  check('выпускники отдаются', response.status === 200, `HTTP ${response.status}`);
  const item = (json?.items ?? []).find((g) => g.projectId === graduate);
  check('выпускник в выдаче с фактическим IRS', item?.irs === 83.25, `irs=${item?.irs}`);
  check(
    'сумма запроса — строка, копейки не теряются',
    typeof item?.investmentAsk === 'string',
    `${item?.investmentAsk}`,
  );
  check('момент выпуска проставлен триггером', typeof item?.graduatedAt === 'string');
  check(
    'невыпускник в выдачу не попадает',
    !(json?.items ?? []).some((g) => g.projectId === draft),
  );
  check('версия данных объявлена', json?.dataVersion === 1);
  const leaked = JSON.stringify(json).match(/email|phone|passport|inn|userId|founder/i);
  check(
    'в выдаче нет ПДн и идентификаторов людей',
    leaked === null,
    `найдено: ${leaked?.[0] ?? 'нет'}`,
  );
}
{
  const { response, json } = await api(
    `/v1/integration/projects/${graduate}/passport?tier=teaser`,
    token,
  );
  check('паспорт уровня teaser отдаётся', response.status === 200, `HTTP ${response.status}`);
  check('данные паспорта на месте', json?.data?.summary === 'тизер выпускника');
}
{
  const { response } = await api(
    `/v1/integration/projects/${graduate}/passport?tier=dataroom`,
    token,
  );
  check(
    'уровень dataroom маршрут не принимает вовсе',
    response.status === 400,
    `HTTP ${response.status}`,
  );
}
{
  const { response } = await api(
    `/v1/integration/projects/${graduateFull}/passport?tier=teaser`,
    token,
  );
  check(
    'паспорт уровня full не выдаётся под видом teaser',
    response.status === 404,
    `HTTP ${response.status}`,
  );
}
{
  const { response, json } = await api(
    `/v1/integration/projects/${graduateFull}/passport?tier=full`,
    token,
  );
  check(
    'запрошенный уровень full отдаётся',
    response.status === 200 && json?.data?.detail === 'полное раскрытие',
    `HTTP ${response.status}`,
  );
}
{
  const { response } = await api(`/v1/integration/projects/${draft}/passport`, token);
  check(
    'паспорт невыпускника не существует для внешней системы',
    response.status === 404,
    `HTTP ${response.status}`,
  );
}
{
  const { response, json } = await api(`/v1/integration/projects/${graduate}/irs-history`, token);
  check(
    'история IRS отдаётся',
    response.status === 200 && json?.items?.length >= 1,
    `HTTP ${response.status}, строк: ${json?.items?.length}`,
  );
}
{
  const { response, json } = await api('/v1/integration/deals', token);
  check('агрегаты договоров отдаются', response.status === 200, `HTTP ${response.status}`);
  const leaked = JSON.stringify(json).match(/investorId|issuerId|email|phone|inn/i);
  check(
    'в агрегатах договоров нет сторон сделки',
    leaked === null,
    `найдено: ${leaked?.[0] ?? 'нет'}`,
  );
}
{
  const { response, json } = await api('/v1/integration/seasons/current', token);
  check(
    'метроном сезона отдаётся',
    response.status === 200 && json?.season !== undefined,
    `HTTP ${response.status}`,
  );
}

// ------------------------------------------------------------ внешний листинг
console.warn('\n[4] Регистрация внешнего листинга');
const remoteId = `capital-listing-${suffix}`;
let refId;
{
  const { response, json } = await api('/v1/integration/listings', token, {
    method: 'POST',
    body: { projectId: draft, remoteSystem: 'unicorn-capital', remoteType: 'listing', remoteId },
  });
  check(
    'листинг невыпускника не регистрируется',
    response.status === 404,
    `HTTP ${response.status} ${json?.detail ?? ''}`,
  );
}
{
  const { response, json } = await api('/v1/integration/listings', token, {
    method: 'POST',
    body: { projectId: graduate, remoteSystem: 'unicorn-capital', remoteType: 'listing', remoteId },
  });
  check('листинг выпускника зарегистрирован', response.status < 400, `HTTP ${response.status}`);
  refId = json?.id;
}
{
  const { response, json } = await api('/v1/integration/listings', token, {
    method: 'POST',
    body: { projectId: graduate, remoteSystem: 'unicorn-capital', remoteType: 'listing', remoteId },
  });
  check(
    'повтор идемпотентен и возвращает ту же ссылку',
    response.status < 400 && json?.id === refId,
    `HTTP ${response.status}`,
  );
}
{
  const other = await makeProject(`Второй выпускник ${suffix}`, 'graduated');
  const { response } = await api('/v1/integration/listings', token, {
    method: 'POST',
    body: { projectId: other, remoteSystem: 'unicorn-capital', remoteType: 'listing', remoteId },
  });
  check(
    'чужой внешний идентификатор не переприсваивается',
    response.status === 409,
    `HTTP ${response.status}`,
  );
}

// ------------------------------------------------------------------ согласие
console.warn('\n[5] Обезличенная проекция и согласие');
const showClientId = `show-${suffix}`;
let showToken;
{
  const { json } = await admin.client.call('/v1/admin/service-accounts', {
    method: 'POST',
    body: {
      name: 'Шоу',
      clientId: showClientId,
      scopes: ['show:read'],
      mtlsCertFingerprint: 'c'.repeat(64),
    },
  });
  const { json: tokenJson } = await raw('/v1/integration/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: showClientId, clientSecret: json.clientSecret }),
  });
  showToken = tokenJson?.accessToken;
  check('клиент медиаконтура получил токен', typeof showToken === 'string');
}
{
  const { response } = await api(`/v1/integration/projects/${graduate}/public-profile`, showToken);
  check('без согласия проекции не существует', response.status === 404, `HTTP ${response.status}`);
}
let consentId;
{
  const [row] = await sql(
    `INSERT INTO identity.publication_consents
       (id, user_id, project_id, scope, document_version, document_sha256)
     VALUES (public.uuid_generate_v7(), $1, $2, 'top100_public', 'v1', digest('doc','sha256'))
     RETURNING id`,
    [founder.userId, graduate],
  );
  consentId = row.id;
  const { response, json } = await api(
    `/v1/integration/projects/${graduate}/public-profile`,
    showToken,
  );
  check('с согласием проекция отдаётся', response.status === 200, `HTTP ${response.status}`);
  check('проекция обезличена', JSON.stringify(json ?? {}).match(/email|phone|userId/i) === null);
  check('scope согласия указан в ответе', json?.consentScope === 'top100_public');
}
{
  const { response } = await api(`/v1/integration/projects/${graduate}/passport`, showToken);
  check(
    'клиент медиаконтура не читает паспорт',
    response.status === 403,
    `HTTP ${response.status}`,
  );
}
{
  await sql('UPDATE identity.publication_consents SET revoked_at = now() WHERE id = $1', [
    consentId,
  ]);
  const { response } = await api(`/v1/integration/projects/${graduate}/public-profile`, showToken);
  check(
    'отзыв согласия убирает проекцию немедленно, тем же токеном',
    response.status === 404,
    `HTTP ${response.status}`,
  );
}

// -------------------------------------------------------------------- ротация
console.warn('\n[6] Ротация секрета');
{
  const { response, json } = await admin.client.call(
    `/v1/admin/service-accounts/${accountId}/rotation`,
    {
      method: 'POST',
    },
  );
  check(
    'секрет ротирован',
    response.status < 400 && json?.clientSecret !== clientSecret,
    `HTTP ${response.status}`,
  );
  const rotated = json?.clientSecret;

  const old = await raw('/v1/integration/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  check(
    'старый секрет больше не выдаёт токен',
    old.response.status === 401,
    `HTTP ${old.response.status}`,
  );

  const fresh = await raw('/v1/integration/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret: rotated }),
  });
  check('новый секрет работает', fresh.response.status < 400, `HTTP ${fresh.response.status}`);
}

// -------------------------------------------------------------------- аудит
console.warn('\n[7] Журнал');
{
  const [row] = await sql(
    `SELECT count(*)::int AS n FROM audit.events
      WHERE verb = 'integration.service_account.created' AND subject_id = $1`,
    [accountId],
  );
  check('создание аккаунта записано в журнал', row.n === 1, `строк: ${row.n}`);
  const [listing] = await sql(
    `SELECT count(*)::int AS n FROM audit.events
      WHERE verb = 'integration.listing.created' AND subject_id = $1`,
    [graduate],
  );
  check('регистрация внешнего листинга записана', listing.n >= 1, `строк: ${listing.n}`);
  const [tokens] = await sql(
    `SELECT count(*)::int AS n FROM audit.events WHERE verb = 'integration.token.issued'`,
  );
  check('выдача токенов записана', tokens.n >= 2, `строк: ${tokens.n}`);
  const [leak] = await sql(
    `SELECT count(*)::int AS n FROM audit.events
      WHERE verb LIKE 'integration.%' AND context_jsonb::text ~* 'secret|password|token'`,
  );
  check('в журнале нет секретов', leak.n === 0, `подозрительных записей: ${leak.n}`);
}

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
await pool.end();
process.exit(failed > 0 ? 1 : 0);
