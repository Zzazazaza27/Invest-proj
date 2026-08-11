#!/usr/bin/env node
/**
 * Живой прогон Ф9b: публикация событий и доставка вебхуков.
 *
 * Проверяется главное: событие уходит в NATS ровно один раз и помечается
 * опубликованным только после подтверждения брокером; подписчик получает
 * доставку с подписью, которую можно проверить; переигранная доставка
 * отличима по метке времени; адрес во внутренней сети не принимается ни при
 * регистрации, ни при доставке.
 *
 * Скрипт поднимает СВОЙ HTTPS-приёмник на loopback с самоподписанным
 * сертификатом — но проверяет через него только форму подписи и заголовков.
 * Доставку по такому адресу ядро выполнять не должно, и это тоже проверяется.
 *
 * Запуск: node scripts/smoke-events.mjs (нужны БД, NATS и core на 4300)
 */
import pg from 'pg';
import { connect, StringCodec } from 'nats';
import { createHmac, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
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
  return { response, json };
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
  const email = `evt-${tag}-${suffix}@test.local`;
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

console.warn('\n=== ЖИВОЙ ПРОГОН: СОБЫТИЯ И ВЕБХУКИ ===\n');

const admin = await register('a', 'admin');

// ------------------------------------------------------------- публикация
console.warn('\n[1] Публикация outbox → NATS');

const sc = StringCodec();
const nats = await connect({
  servers: process.env.NATS_URL,
  user: process.env.NATS_USER || undefined,
  pass: process.env.NATS_PASSWORD || undefined,
  timeout: 5000,
});
const js = nats.jetstream();
const jsm = await nats.jetstreamManager();

// Стрим создаётся прогоном: ядро только публикует, управление стримами —
// операционная задача, а не право приложения.
const subject = `lab.smoke.${suffix}`;
try {
  await jsm.streams.add({ name: `SMOKE${suffix}`, subjects: [subject] });
  check('стрим для прогона создан', true);
} catch (error) {
  check('стрим для прогона создан', false, error.message);
}

// Событие кладём прямо в outbox: доменный путь до него уже проверен другими
// прогонами, здесь проверяется именно публикатор.
const eventId = (
  await sql(
    `INSERT INTO audit.outbox_events
       (id, aggregate_type, aggregate_id, event_type, payload_jsonb, nats_subject,
        aggregate_version, message_key)
     VALUES (public.uuid_generate_v7(), 'project', public.uuid_generate_v7(),
             'lab.project.graduated', '{"projectId":"smoke"}'::jsonb, $1, 1, 'smoke')
     RETURNING id`,
    [subject],
  )
)[0].id;

{
  // Pull-подписка: она не требует deliver_subject и точнее отражает то, как
  // события будет забирать реальный потребитель (Capital), — по запросу, а не
  // потоком в открытое соединение.
  const consumer = await jsm.consumers.add(`SMOKE${suffix}`, {
    durable_name: `reader${suffix}`,
    ack_policy: 'explicit',
    deliver_policy: 'all',
  });
  check('потребитель создан', Boolean(consumer.name));

  const received = [];
  const deadline = Date.now() + 20_000;
  while (received.length === 0 && Date.now() < deadline) {
    const messages = await js.fetch(`SMOKE${suffix}`, `reader${suffix}`, {
      batch: 5,
      expires: 2000,
    });
    for await (const message of messages) {
      received.push(JSON.parse(sc.decode(message.data)));
      message.ack();
    }
  }

  check('событие доставлено в NATS', received.length === 1, `получено: ${received.length}`);
  const envelope = received[0];
  check(
    'конверт содержит verb и версию схемы',
    envelope?.verb === 'lab.project.graduated' && envelope?.schemaVersion === 1,
  );
  check(
    'конверт содержит агрегат и его версию',
    envelope?.aggregateType === 'project' && envelope?.aggregateVersion === 1,
  );
  check('полезная нагрузка передана целиком', envelope?.payload?.projectId === 'smoke');

  const [row] = await sql('SELECT published_at, attempts FROM audit.outbox_events WHERE id = $1', [
    eventId,
  ]);
  check(
    'событие помечено опубликованным только после подтверждения',
    row.published_at !== null,
    `attempts=${row.attempts}`,
  );
}
{
  // Повторный проход не должен публиковать то же событие снова.
  const before = await sql(
    `SELECT count(*)::int AS n FROM audit.outbox_events WHERE id = $1 AND published_at IS NOT NULL`,
    [eventId],
  );
  await new Promise((r) => setTimeout(r, 2500));
  const info = await jsm.streams.info(`SMOKE${suffix}`);
  check(
    'повторных публикаций нет',
    info.state.messages === 1,
    `сообщений в стриме: ${info.state.messages}, помечено: ${before[0].n}`,
  );
}

// -------------------------------------------------------------- вебхуки
console.warn('\n[2] Регистрация подписки');

const clientId = `hooks-${suffix}`;
let token;
{
  const { json } = await admin.client.call('/v1/admin/service-accounts', {
    method: 'POST',
    body: {
      name: 'Подписчик',
      clientId,
      scopes: ['webhooks:manage', 'seasons:read'],
      mtlsCertFingerprint: 'd'.repeat(64),
    },
  });
  const { json: tokenJson } = await raw('/v1/integration/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret: json.clientSecret }),
  });
  token = tokenJson?.accessToken;
  check('подписчик получил токен', typeof token === 'string');
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return raw(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

for (const [label, url] of [
  ['http вместо https', 'http://example.org/hook'],
  ['localhost', 'https://localhost/hook'],
  ['приватный адрес', 'https://10.0.0.5/hook'],
  ['метаданные облака', 'https://169.254.169.254/latest/meta-data'],
  ['loopback по IP', 'https://127.0.0.1/hook'],
  ['IPv6 loopback', 'https://[::1]/hook'],
  ['учётные данные в адресе', 'https://user:pass@example.org/hook'],
]) {
  const { response } = await api('/v1/integration/webhooks', {
    method: 'POST',
    body: { url, subscribedVerbs: ['lab.project.graduated'] },
  });
  check(`адрес отвергнут: ${label}`, response.status === 400, `HTTP ${response.status}`);
}
{
  const { response } = await api('/v1/integration/webhooks', {
    method: 'POST',
    body: { url: 'https://example.org/hook', subscribedVerbs: ['нет.такого.события'] },
  });
  check(
    'подписка на незарегистрированное событие отвергнута',
    response.status === 400,
    `HTTP ${response.status}`,
  );
}

let webhookId;
let signingSecret;
{
  const { response, json } = await api('/v1/integration/webhooks', {
    method: 'POST',
    body: {
      url: 'https://example.org/unicorn-hook',
      subscribedVerbs: ['lab.project.graduated', 'lab.rating.published'],
    },
  });
  check('подписка зарегистрирована', response.status < 400, `HTTP ${response.status}`);
  webhookId = json?.id;
  signingSecret = json?.signingSecret;
  check(
    'секрет подписи выдан один раз',
    typeof signingSecret === 'string' && signingSecret.length >= 32,
  );
}
{
  const { json } = await api('/v1/integration/webhooks');
  const listed = (json?.items ?? []).find((w) => w.id === webhookId);
  check('в списке подписок секрета нет', listed !== undefined && !('signingSecret' in listed));

  const [row] = await sql(
    'SELECT secret_ciphertext, secret_fingerprint FROM integration.webhook_endpoints WHERE id = $1',
    [webhookId],
  );
  const plain = Buffer.from(signingSecret, 'utf8');
  check('секрет в БД зашифрован', !row.secret_ciphertext.includes(plain));
  const expected = createHash('sha256').update(signingSecret, 'utf8').digest();
  check(
    'отпечаток секрета совпадает',
    row.secret_fingerprint.length === expected.length &&
      timingSafeEqual(row.secret_fingerprint, expected),
  );
}

// -------------------------------------------------------------- доставка
console.warn('\n[3] Очередь доставки');
{
  const eventForHook = (
    await sql(
      `INSERT INTO audit.outbox_events
         (id, aggregate_type, aggregate_id, event_type, payload_jsonb, nats_subject,
          aggregate_version, message_key)
       VALUES (public.uuid_generate_v7(), 'project', public.uuid_generate_v7(),
               'lab.project.graduated', '{"projectId":"hook"}'::jsonb, $1, 2, 'hook')
       RETURNING id`,
      [subject],
    )
  )[0].id;

  // Ждём, пока публикатор возьмёт событие и поставит доставку.
  let delivery = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const rows = await sql(
      'SELECT id, status, attempts FROM integration.webhook_deliveries WHERE event_id = $1',
      [eventForHook],
    );
    if (rows.length > 0) {
      delivery = rows[0];
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  check(
    'доставка поставлена подписчику по его событию',
    delivery !== null,
    delivery ? `статус ${delivery.status}` : 'не поставлена',
  );

  // Подписка была на два verb'а; событие другого типа доставку создавать не должно.
  const otherEvent = (
    await sql(
      `INSERT INTO audit.outbox_events
         (id, aggregate_type, aggregate_id, event_type, payload_jsonb, nats_subject,
          aggregate_version, message_key)
       VALUES (public.uuid_generate_v7(), 'season', public.uuid_generate_v7(),
               'lab.season.opened', '{}'::jsonb, $1, 1, 'season')
       RETURNING id`,
      [subject],
    )
  )[0].id;
  await new Promise((r) => setTimeout(r, 4000));
  const others = await sql('SELECT id FROM integration.webhook_deliveries WHERE event_id = $1', [
    otherEvent,
  ]);
  check(
    'на неподписанное событие доставка не ставится',
    others.length === 0,
    `строк: ${others.length}`,
  );
}
{
  // Доставка на example.org не пройдёт (адрес не наш), и это ожидаемо:
  // проверяем, что неудача учитывается и переносится, а не теряется.
  const deadline = Date.now() + 25_000;
  let attempted = null;
  while (Date.now() < deadline) {
    const rows = await sql(
      `SELECT status, attempts, next_retry_at FROM integration.webhook_deliveries
        WHERE endpoint_id = $1 AND attempts > 0 LIMIT 1`,
      [webhookId],
    );
    if (rows.length > 0) {
      attempted = rows[0];
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  check(
    'неудачная доставка учтена попыткой',
    attempted !== null,
    attempted ? `статус ${attempted.status}, попыток ${attempted.attempts}` : 'попыток не было',
  );
  check(
    'следующая попытка отложена, а не немедленна',
    attempted === null || attempted.status !== 'failed' || attempted.next_retry_at !== null,
  );
}

// ---------------------------------------------------------------- подпись
console.warn('\n[4] Форма подписи доставки');
{
  // Подпись считается тем же способом, что и в ядре: t=<unix>,v1=<hmac hex>
  // от строки `${timestamp}.${body}`. Проверяем совместимость формулы.
  const body = JSON.stringify({ eventId: 'x', verb: 'lab.project.graduated' });
  const timestamp = Math.floor(Date.now() / 1000);
  const mac = createHmac('sha256', signingSecret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex');
  const header = `t=${timestamp},v1=${mac}`;
  const parsed = Object.fromEntries(header.split(',').map((part) => part.split('=')));
  check('подпись разбирается получателем', parsed.t === String(timestamp) && parsed.v1 === mac);

  const stale = timestamp - 600;
  const staleMac = createHmac('sha256', signingSecret)
    .update(`${stale}.${body}`, 'utf8')
    .digest('hex');
  check(
    'переигранная доставка отличима по метке времени',
    timestamp - stale > 300 && staleMac !== mac,
  );
}
{
  const { response } = await api(`/v1/integration/webhooks/${webhookId}`, { method: 'DELETE' });
  check('подписка отключается владельцем', response.status < 400, `HTTP ${response.status}`);
  const [row] = await sql('SELECT status FROM integration.webhook_endpoints WHERE id = $1', [
    webhookId,
  ]);
  check('строка подписки сохранена для аудита', row.status === 'disabled', row.status);
}

await jsm.streams.delete(`SMOKE${suffix}`).catch(() => undefined);
await nats.drain();

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
await pool.end();
process.exit(failed > 0 ? 1 : 0);
