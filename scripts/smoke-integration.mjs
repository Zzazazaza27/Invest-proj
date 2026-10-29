#!/usr/bin/env node
/**
 * Живой прогон Ф9: Integration API.
 *
 * С 2.1-W05 в Integration API остался общий механизм: токен сервисного клиента
 * и подписки на события. Проверяется главное: скоуп вне allowlist не выдаётся;
 * токен не получить без верного секрета и при приостановленном аккаунте;
 * удалённых выдач нет; адрес вебхука во внутренней сети и подписка без права
 * на событие отклоняются; чужую подписку не видно и не отключить; секрет
 * клиента возвращается ровно один раз и перестаёт работать после ротации.
 *
 * Запуск: node scripts/smoke-integration.mjs (нужны поднятая БД и core на 4300)
 */
import pg from 'pg';
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
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

/**
 * Секрет подписи вебхука так, как его кладёт ядро (`sealDirect` домена
 * webhook_secrets): AES-256-GCM на KEK, IV(12) + TAG(16) + шифртекст, AAD
 * `webhook:signing`. Подписка заводится прямо в БД, но строка обязана быть
 * настоящей: заглушка вместо шифртекста роняла бы ротацию ключа
 * (`rotate-kek --domain webhook_secrets`) и доставку, которая секрет открывает.
 */
function sealWebhookSecret(secret) {
  // Правило SAST срабатывает на ИМЯ переменной: `secret` — параметр, значение
  // генерирует прогон, литерала в исходниках нет.
  // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
  const kek = Buffer.from(process.env.KEK_WEBHOOK_SECRETS ?? '', 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from('webhook:signing', 'utf8'));
  // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return {
    ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]),
    // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
    fingerprint: createHash('sha256').update(secret, 'utf8').digest(),
  };
}

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

/** Сервисный аккаунт через админку; возвращает id и одноразовый секрет. */
async function createAccount(name, id, fingerprintChar) {
  const { response, json } = await admin.client.call('/v1/admin/service-accounts', {
    method: 'POST',
    body: {
      name,
      clientId: id,
      scopes: ['webhooks:manage'],
      mtlsCertFingerprint: fingerprintChar.repeat(64),
    },
  });
  return { response, accountId: json?.id, secret: json?.clientSecret };
}

async function issueToken(id, secret) {
  return raw('/v1/integration/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: id, clientSecret: secret }),
  });
}

// ---------------------------------------------------------- сервисный аккаунт
console.warn('\n[1] Сервисный аккаунт и токен');
const clientId = `capital-${suffix}`;
let clientSecret;
let accountId;
{
  const { response } = await founder.client.call('/v1/admin/service-accounts', {
    method: 'POST',
    body: {
      name: 'Чужой',
      clientId: `evil-${suffix}`,
      scopes: ['webhooks:manage'],
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
      scopes: ['webhooks:manage'],
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
  // Скоупы удалённых выдач (выпускники, паспорт, сделки, сезон) — вне
  // allowlist: аккаунт с ними не заводится, а не заводится «с частью прав».
  const { response } = await admin.client.call('/v1/admin/service-accounts', {
    method: 'POST',
    body: {
      name: 'Capital',
      clientId,
      scopes: ['webhooks:manage', 'graduates:read'],
      mtlsCertFingerprint: 'b'.repeat(64),
    },
  });
  check('скоуп вне allowlist отклоняется', response.status === 400, `HTTP ${response.status}`);
}
{
  const created = await createAccount('Capital', clientId, 'b');
  check(
    'админ заводит сервисный аккаунт',
    created.response.status < 400,
    `HTTP ${created.response.status}`,
  );
  clientSecret = created.secret;
  accountId = created.accountId;
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
  const { response } = await issueToken(clientId, 'x'.repeat(48));
  check('неверный секрет — отказ', response.status === 401, `HTTP ${response.status}`);
}
{
  const { response } = await issueToken(`нет-такого-${suffix}`, 'x'.repeat(48));
  check(
    'неизвестный клиент отвечает так же, как неверный секрет',
    response.status === 401,
    `HTTP ${response.status}`,
  );
}

// Приостановка закрывает выдачу токенов. Проверяется фактом: прежде статус
// аккаунта в выборке не участвовал, и приостановленный клиент продолжал
// получать токены — отзыв доступа не работал (SEC-07).
{
  const { response } = await admin.client.call(`/v1/admin/service-accounts/${accountId}/status`, {
    method: 'POST',
    body: { status: 'suspended' },
  });
  check(
    'аккаунт приостановлен админом',
    response.status === 200 || response.status === 201,
    `HTTP ${response.status}`,
  );
}
{
  const { response } = await issueToken(clientId, clientSecret);
  check(
    'приостановленный аккаунт токен НЕ получает',
    response.status === 401,
    `HTTP ${response.status}`,
  );
}
{
  const { response } = await admin.client.call(`/v1/admin/service-accounts/${accountId}/status`, {
    method: 'POST',
    body: { status: 'active' },
  });
  check(
    'аккаунт возобновлён',
    response.status === 200 || response.status === 201,
    `HTTP ${response.status}`,
  );
}

let token;
{
  const { response, json } = await issueToken(clientId, clientSecret);
  check('токен выдан по client_credentials', response.status < 400, `HTTP ${response.status}`);
  token = json?.accessToken;
  check(
    'токен ограничен по времени жизни',
    typeof json?.expiresIn === 'number' && json.expiresIn <= 3600,
    `expiresIn=${json?.expiresIn}`,
  );
  check(
    'скоупы возвращены клиенту',
    Array.isArray(json?.scopes) && json.scopes.length === 1 && json.scopes[0] === 'webhooks:manage',
    JSON.stringify(json?.scopes),
  );
}

// -------------------------------------------------------------------- доступ
console.warn('\n[2] Границы доступа');
{
  const { response } = await api('/v1/integration/webhooks', null);
  check('без токена доступа нет', response.status === 401, `HTTP ${response.status}`);
}
{
  const { response } = await api('/v1/integration/webhooks', `${token}x`);
  check('подделанная подпись токена отклонена', response.status === 401, `HTTP ${response.status}`);
}
{
  // Пользовательская сессия — не пропуск в интеграционный контур: у него свой
  // субъект и свой формат токена.
  const { response } = await admin.client.call('/v1/integration/webhooks');
  check(
    'сессия администратора не открывает Integration API',
    response.status === 401,
    `HTTP ${response.status}`,
  );
}
{
  // Выдачи удалены вместе с процессами (2.1-W05): маршрутов нет вовсе, а не
  // «есть, но без скоупа». 404 — и с валидным токеном.
  for (const path of [
    '/v1/integration/graduates',
    '/v1/integration/deals',
    '/v1/integration/seasons/current',
  ]) {
    const { response } = await api(path, token);
    check(`удалённой выдачи ${path} нет`, response.status === 404, `HTTP ${response.status}`);
  }
}

// ------------------------------------------------------------------ вебхуки
console.warn('\n[3] Подписки на события');
{
  const { response, json } = await api('/v1/integration/webhooks', token);
  check(
    'список подписок отдаётся',
    response.status === 200 && Array.isArray(json?.items),
    `HTTP ${response.status}`,
  );
}
{
  const { response } = await api('/v1/integration/webhooks', token, {
    method: 'POST',
    body: { url: 'https://127.0.0.1/hook', subscribedVerbs: ['lab.listing.published'] },
  });
  check(
    'адрес во внутренней сети не регистрируется',
    response.status === 400,
    `HTTP ${response.status}`,
  );
}
{
  const { response } = await api('/v1/integration/webhooks', token, {
    method: 'POST',
    body: { url: 'https://93.184.215.14/hook', subscribedVerbs: ['lab.project.graduated'] },
  });
  check(
    'подписка на несуществующее событие отклоняется',
    response.status === 400,
    `HTTP ${response.status}`,
  );
}
{
  // `webhooks:manage` даёт право управлять подписками, а не читать данные;
  // скоупов, открывающих события, сейчас нет — подписаться не на что.
  const { response } = await api('/v1/integration/webhooks', token, {
    method: 'POST',
    body: { url: 'https://93.184.215.14/hook', subscribedVerbs: ['lab.listing.published'] },
  });
  check(
    'без скоупа данных подписка на событие запрещена',
    response.status === 403,
    `HTTP ${response.status}`,
  );
}

// Своя подписка и чужая: вторую заводим напрямую в БД, раз через API
// подписаться сейчас не на что. Важна граница владельца, а не способ создания.
const other = await createAccount('Чужой клиент', `other-${suffix}`, 'd');
const otherToken = (await issueToken(`other-${suffix}`, other.secret)).json?.accessToken;
check('второй клиент получил токен', typeof otherToken === 'string');
const sealed = sealWebhookSecret(randomBytes(32).toString('base64url'));
const [endpoint] = await sql(
  `INSERT INTO integration.webhook_endpoints
     (id, service_account_id, url, subscribed_verbs, secret_ciphertext, secret_kms_key_id,
      secret_fingerprint)
   VALUES (public.uuid_generate_v7(), $1, 'https://93.184.215.14/hook', ARRAY['lab.listing.published'],
           $2, 'local/webhook_secrets/v1', $3)
   RETURNING id`,
  [accountId, sealed.ciphertext, sealed.fingerprint],
);
{
  const { json } = await api('/v1/integration/webhooks', token);
  check(
    'своя подписка видна владельцу',
    (json?.items ?? []).some((item) => item.id === endpoint.id),
  );
  const leaked = JSON.stringify(json ?? {}).match(/secret/i);
  check('в списке подписок нет секрета', leaked === null, `найдено: ${leaked?.[0] ?? 'нет'}`);
}
{
  const { json } = await api('/v1/integration/webhooks', otherToken);
  check(
    'чужой клиент подписку не видит',
    !(json?.items ?? []).some((item) => item.id === endpoint.id),
  );
  const { response } = await api(`/v1/integration/webhooks/${endpoint.id}`, otherToken, {
    method: 'DELETE',
  });
  check('чужой клиент подписку не отключает', response.status === 404, `HTTP ${response.status}`);
}
{
  const { response } = await api(`/v1/integration/webhooks/${endpoint.id}`, token, {
    method: 'DELETE',
  });
  check('владелец отключает подписку', response.status === 200, `HTTP ${response.status}`);
  const [row] = await sql('SELECT status FROM integration.webhook_endpoints WHERE id = $1', [
    endpoint.id,
  ]);
  check('строка подписки осталась, статус disabled', row?.status === 'disabled', row?.status);
}

// -------------------------------------------------------------------- ротация
console.warn('\n[4] Ротация секрета');
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

  const old = await issueToken(clientId, clientSecret);
  check(
    'старый секрет больше не выдаёт токен',
    old.response.status === 401,
    `HTTP ${old.response.status}`,
  );

  const fresh = await issueToken(clientId, rotated);
  check('новый секрет работает', fresh.response.status < 400, `HTTP ${fresh.response.status}`);
}

// -------------------------------------------------------------------- аудит
console.warn('\n[5] Журнал');
{
  const [row] = await sql(
    `SELECT count(*)::int AS n FROM audit.events
      WHERE verb = 'integration.service_account.created' AND subject_id = $1`,
    [accountId],
  );
  check('создание аккаунта записано в журнал', row.n === 1, `строк: ${row.n}`);
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
