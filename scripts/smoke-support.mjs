#!/usr/bin/env node
/**
 * Живой прогон: поддержка пользователей и сообщения об ошибках (M062).
 *
 * Одна сущность закрывает две задачи — их различает `kind`. Проверяется
 * фактом, а не чтением кода:
 *
 *   1. обращение создаётся и сразу видно автору с его первым сообщением;
 *   2. чужое обращение не читается ни списком, ни по идентификатору;
 *   3. подмена автора и статуса в теле запроса отвергается;
 *   4. технический контекст баг-репорта собирает СЕРВЕР: момент, роли,
 *      trace_id и user agent приходят из контекста запроса, а не из тела;
 *   5. секрет, засунутый в контекст клиентом, не сохраняется — строгая
 *      проверка на границе отвергает неизвестное поле;
 *   6. сотрудник поддержки видит чужое обращение, берёт в работу, отвечает —
 *      и его ответ помечен как ответ поддержки, а не пользователя;
 *   7. пользователь не может выдать себя за поддержку;
 *   8. в закрытое обращение писать нельзя, автор закрыть его не может;
 *   9. копия ушла на служебный ящик — проверяется ФАЙЛОМ письма, а не
 *      намерением отправить.
 *
 * Запуск: node scripts/smoke-support.mjs (нужны БД и core на 4300)
 */
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
  async function call(path, { method = 'GET', body, headers: extra = {} } = {}) {
    const headers = {
      ...extra,
      Cookie: [state.session, state.csrf].filter(Boolean).join('; '),
    };
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
  const email = `sup-${tag}-${suffix}@test.local`;
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

/**
 * Письма, записанные транспортом `file`, за время прогона.
 *
 * Проверять факт отправки логом было бы проверкой намерения: строка «письмо
 * отправлено» пишется до того, как что-либо записано. Файл — результат.
 */
function mailSince(startedAt) {
  const dir = join(ROOT, process.env.MAIL_OUTBOX_DIR ?? 'var/mail');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.eml'))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).mtimeMs >= startedAt)
    .map((path) => readFileSync(path, 'utf8'));
}

console.warn('\n=== ЖИВОЙ ПРОГОН: ПОДДЕРЖКА И СООБЩЕНИЯ ОБ ОШИБКАХ ===\n');

const author = await register('author');
const outsider = await register('outsider');
const staff = await register('staff', 'admin');

const mailConfigured =
  (process.env.MAIL_TRANSPORT ?? 'none') === 'file' && Boolean(process.env.SUPPORT_INBOX_EMAIL);

// 1. Обращение создаётся вместе с первым сообщением.
console.warn('[1] Обращение в поддержку');
let ticketId = null;
{
  const mailStart = Date.now();
  const { response, json } = await author.client.call('/v1/support/tickets', {
    method: 'POST',
    body: {
      kind: 'support',
      subject: 'Не приходит письмо о смене пароля',
      body: 'Запросил ссылку дважды, письмо не пришло ни разу. Почта на Яндексе.',
    },
  });
  check('обращение принято', response.status === 201, `HTTP ${response.status}`);
  ticketId = json?.id ?? null;
  check('статус новый', json?.status === 'new', String(json?.status));
  check('первое сообщение внутри обращения', json?.messages?.length === 1);
  check('автором первого сообщения значится пользователь', json?.messages?.[0]?.authorKind === 'user');
  check('счётчик сообщений сходится', json?.messageCount === 1, String(json?.messageCount));
  check('обращение не назначено', json?.assigned === false);

  if (mailConfigured) {
    const letters = mailSince(mailStart);
    check(
      'копия ушла на служебный ящик',
      letters.some((text) => text.includes(ticketId ?? ' ')),
      `писем за прогон: ${letters.length}`,
    );
    check(
      'в письме есть текст обращения',
      letters.some((text) => text.includes('письмо не пришло ни разу')),
    );
  } else {
    console.warn(
      '  ---   копия на служебный ящик НЕ проверялась: MAIL_TRANSPORT/SUPPORT_INBOX_EMAIL не настроены',
    );
  }
}

// 2. Чужое обращение недоступно.
console.warn('\n[2] Границы доступа');
{
  const list = await outsider.client.call('/v1/support/tickets');
  check(
    'постороннего нет чужих обращений в списке',
    (list.json?.items ?? []).every((item) => item.id !== ticketId),
    `в списке: ${(list.json?.items ?? []).length}`,
  );

  const direct = await outsider.client.call(`/v1/support/tickets/${ticketId}`);
  // Именно 404, а не 403: 403 подтверждал бы существование чужого обращения.
  check('чужое обращение по ссылке — 404', direct.response.status === 404, `HTTP ${direct.response.status}`);

  const reply = await outsider.client.call(`/v1/support/tickets/${ticketId}/messages`, {
    method: 'POST',
    body: { body: 'Допишу в чужое обращение' },
  });
  check('в чужое обращение не написать', reply.response.status === 404, `HTTP ${reply.response.status}`);

  const anon = await raw('/v1/support/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'support', subject: 'Аноним', body: 'Без входа' }),
  });
  check('анонимный приём закрыт', anon.response.status === 401, `HTTP ${anon.response.status}`);
}

// 3. Подмена полей на границе.
console.warn('\n[3] Строгая граница входа');
{
  const spoof = await author.client.call('/v1/support/tickets', {
    method: 'POST',
    body: {
      kind: 'support',
      subject: 'Попытка завести обращение за другого',
      body: 'Тело',
      userId: outsider.userId,
      status: 'closed',
    },
  });
  check(
    'неизвестные поля отвергаются, а не игнорируются',
    spoof.response.status === 400,
    `HTTP ${spoof.response.status}`,
  );

  const badKind = await author.client.call('/v1/support/tickets', {
    method: 'POST',
    body: { kind: 'incident', subject: 'Неизвестный вид', body: 'Тело' },
  });
  check('неизвестный вид обращения отвергнут', badKind.response.status === 400);

  const shortSubject = await author.client.call('/v1/support/tickets', {
    method: 'POST',
    body: { kind: 'support', subject: 'ой', body: 'Тело' },
  });
  check('слишком короткая тема отвергнута', shortSubject.response.status === 400);
}

// 4. Баг-репорт: контекст собирает сервер.
console.warn('\n[4] Сообщение об ошибке и технический контекст');
let bugId;
{
  const { response, json } = await author.client.call('/v1/support/tickets', {
    method: 'POST',
    // Заголовок только из ASCII: HTTP-заголовок — ByteString, и кириллица в
    // нём не отправляется вовсе (первый прогон падал на этом до сервера).
    headers: { 'User-Agent': 'SmokeSupport/1.0 (context collection check)' },
    body: {
      kind: 'bug_report',
      subject: 'Карточка проекта не открывается',
      body: 'Нажимаю на карточку в каталоге — белый экран.',
      context: {
        url: 'https://example.test/investor/catalog',
        appVersion: 'abc1234',
        viewport: '1440x900',
        locale: 'ru-RU',
      },
    },
  });
  check('баг-репорт принят', response.status === 201, `HTTP ${response.status}`);
  bugId = json?.id ?? null;
  const ctx = json?.context ?? {};
  check('адрес страницы сохранён', ctx.url === 'https://example.test/investor/catalog');
  check('версия приложения сохранена', ctx.appVersion === 'abc1234');
  check('размер окна сохранён', ctx.viewport === '1440x900');
  check('момент проставил сервер', typeof ctx.occurredAt === 'string' && !Number.isNaN(Date.parse(ctx.occurredAt)));
  check('роли взяты из контекста запроса', Array.isArray(ctx.roles) && ctx.roles.includes('founder'));
  check(
    'user agent взят из заголовка, а не из тела',
    typeof ctx.userAgent === 'string' && ctx.userAgent.startsWith('SmokeSupport/1.0'),
    String(ctx.userAgent).slice(0, 40),
  );
  check('сквозной идентификатор запроса приложен', typeof ctx.traceId === 'string' && ctx.traceId.length > 0);

  const serialized = JSON.stringify(ctx);
  check(
    'в контексте нет ни пароля, ни токена, ни cookie',
    !/password|token|cookie|secret/i.test(serialized),
    serialized.slice(0, 120),
  );
}

// 5. Секрет, присланный клиентом, не сохраняется.
console.warn('\n[5] Клиент не может дослать секрет');
{
  const { response } = await author.client.call('/v1/support/tickets', {
    method: 'POST',
    body: {
      kind: 'bug_report',
      subject: 'Пробую переслать лишнее',
      body: 'Тело',
      context: {
        url: 'https://example.test/lab',
        cookie: 'ul_session=подсмотренное-значение',
      },
    },
  });
  check(
    'неизвестное поле контекста отвергнуто на границе',
    response.status === 400,
    `HTTP ${response.status}`,
  );

  const [row] = await sql(
    `SELECT count(*)::int AS n FROM comms.support_tickets
      WHERE context_jsonb::text ILIKE '%подсмотренное-значение%'`,
  );
  // Позитивный контроль хранилища: даже если бы маршрут пропустил, строки нет.
  check('в базе такого контекста нет', row.n === 0, `строк: ${row.n}`);
}

// 6. Работа сотрудника поддержки.
console.warn('\n[6] Сотрудник поддержки');
{
  const list = await staff.client.call('/v1/support/tickets');
  check(
    'сотрудник видит чужое обращение',
    (list.json?.items ?? []).some((item) => item.id === ticketId),
    `в списке: ${(list.json?.items ?? []).length}`,
  );

  const taken = await staff.client.call(`/v1/support/tickets/${ticketId}`, {
    method: 'PATCH',
    body: { status: 'in_progress', assignToMe: true },
  });
  check('взято в работу', taken.json?.status === 'in_progress', String(taken.json?.status));
  check('назначение зафиксировано', taken.json?.assigned === true);

  const answered = await staff.client.call(`/v1/support/tickets/${ticketId}/messages`, {
    method: 'POST',
    body: { body: 'Проверили: письма уходят, посмотрите папку «Спам».' },
  });
  check('ответ сотрудника принят', answered.response.status === 201, `HTTP ${answered.response.status}`);
  check(
    'ответ помечен как ответ поддержки',
    answered.json?.authorKind === 'staff',
    String(answered.json?.authorKind),
  );

  const seen = await author.client.call(`/v1/support/tickets/${ticketId}`);
  check('автор видит ответ в своей переписке', (seen.json?.messages ?? []).length === 2);
  check(
    'момент последней активности обновился',
    seen.json?.lastMessageAt !== null && seen.json?.lastMessageAt > seen.json?.createdAt,
    String(seen.json?.lastMessageAt),
  );
}

// 7. Пользователь не может выдать себя за поддержку и закрыть обращение.
console.warn('\n[7] Пользователь не подменяет сторону разговора');
{
  const mine = await author.client.call(`/v1/support/tickets/${ticketId}/messages`, {
    method: 'POST',
    body: { body: 'Спасибо, проверю.' },
  });
  check('сообщение автора принято', mine.response.status === 201, `HTTP ${mine.response.status}`);
  check(
    'сообщение автора помечено как пользовательское',
    mine.json?.authorKind === 'user',
    String(mine.json?.authorKind),
  );

  const close = await author.client.call(`/v1/support/tickets/${ticketId}`, {
    method: 'PATCH',
    body: { status: 'closed' },
  });
  // Политика БД не отдаёт строку на UPDATE — снаружи это 404, как и «нет такого».
  check('автор не закрывает своё обращение', close.response.status === 404, `HTTP ${close.response.status}`);
}

// 8. Закрытие и запрет писать в закрытое.
console.warn('\n[8] Закрытие обращения');
{
  const closed = await staff.client.call(`/v1/support/tickets/${ticketId}`, {
    method: 'PATCH',
    body: { status: 'closed' },
  });
  check('сотрудник закрыл обращение', closed.json?.status === 'closed', String(closed.json?.status));
  check('момент закрытия проставлен', typeof closed.json?.closedAt === 'string', String(closed.json?.closedAt));

  const late = await author.client.call(`/v1/support/tickets/${ticketId}/messages`, {
    method: 'POST',
    body: { body: 'Ещё одно дополнение' },
  });
  check(
    'в закрытое обращение писать нельзя',
    late.response.status === 409 || late.response.status === 422,
    `HTTP ${late.response.status}`,
  );

  const reopened = await staff.client.call(`/v1/support/tickets/${ticketId}`, {
    method: 'PATCH',
    body: { status: 'in_progress' },
  });
  check('обращение можно вернуть в работу', reopened.json?.status === 'in_progress');
  check('момент закрытия снят', reopened.json?.closedAt === null, String(reopened.json?.closedAt));
}

// 9. Баг-репорт остался отдельным обращением того же автора.
console.warn('\n[9] Список автора');
{
  const list = await author.client.call('/v1/support/tickets');
  const ids = (list.json?.items ?? []).map((item) => item.id);
  check('оба обращения на месте', ids.includes(ticketId) && ids.includes(bugId), `всего: ${ids.length}`);
  check(
    'виды обращений различаются',
    new Set((list.json?.items ?? []).map((item) => item.kind)).size === 2,
  );
}

console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено.\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);
