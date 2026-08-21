#!/usr/bin/env node
/**
 * Живой прогон восстановления пароля и подтверждения адреса (Ф51).
 *
 * Проверяется не «маршрут отвечает 200», а свойства, ради которых он написан:
 *
 *   * ответ одинаков для существующего и несуществующего адреса — иначе форма
 *     «забыли пароль» перечисляет пользователей;
 *   * ссылка срабатывает ОДИН раз;
 *   * после смены пароля старая сессия мертва, старый пароль не подходит;
 *   * токен из письма не встречается в базе — там только его SHA-256;
 *   * счётчик писем на контакт ограничивает рассылку, не выдавая этого ответом.
 *
 * Требуется: core запущен, MAIL_TRANSPORT=file (иначе письмо неоткуда взять —
 * прогон скажет об этом и остановится, а не сделает вид, что всё хорошо).
 *
 * Запуск: node scripts/smoke-auth-recovery.mjs [--api http://127.0.0.1:4300]
 */
import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const apiIndex = process.argv.indexOf('--api');
const BASE = apiIndex >= 0 ? process.argv[apiIndex + 1] : CORE_URL;

const env = loadDotEnv();
const SESSION_COOKIE = env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = env.CSRF_COOKIE_NAME ?? 'ul_csrf';
const MAIL_DIR = isAbsolute(env.MAIL_OUTBOX_DIR ?? 'var/mail')
  ? env.MAIL_OUTBOX_DIR
  : join(ROOT, env.MAIL_OUTBOX_DIR ?? 'var/mail');

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
  const result = {};
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return result;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return result;
}

const pool = new pg.Pool({ connectionString: env.DATABASE_URL_OWNER, max: 2 });
async function sql(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows;
}

async function req(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* тело не JSON — так тоже бывает */
  }
  return { response, json, text };
}

/** Письма, появившиеся в папке после отметки времени. */
function mailsSince(mark) {
  if (!existsSync(MAIL_DIR)) return [];
  return readdirSync(MAIL_DIR)
    .filter((name) => name > mark)
    .sort();
}

/** Токен из последнего письма получателю. Null — письма нет. */
function tokenFor(to, kind, mark) {
  const safe = to.replace(/[^a-zA-Z0-9._@-]/g, '_').slice(0, 64);
  const files = mailsSince(mark).filter((name) => name.includes(safe));
  const last = files.at(-1);
  if (!last) return null;
  const body = readFileSync(join(MAIL_DIR, last), 'utf8');
  const match = new RegExp(`#${kind}=([A-Za-z0-9_-]+)`).exec(body);
  return match?.[1] ?? null;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

console.warn('\n=== ВОССТАНОВЛЕНИЕ ПАРОЛЯ И ПОДТВЕРЖДЕНИЕ ПОЧТЫ ===\n');

if (env.MAIL_TRANSPORT !== 'file') {
  console.warn(
    `MAIL_TRANSPORT=${env.MAIL_TRANSPORT ?? 'none'} — письма взять неоткуда.\n` +
      'Прогон требует file-транспорта: поставь MAIL_TRANSPORT=file и перезапусти core.\n',
  );
  await pool.end();
  process.exit(1);
}
mkdirSync(MAIL_DIR, { recursive: true });

// ------------------------------------------------------------- подготовка
const suffix = `${Date.now() % 1e9}`;
const EMAIL = `recovery-${suffix}@test.local`;
// Пароли учётной записи, которую прогон создаёт сам и бросает через минуту.
// Правило SAST срабатывает на имя переменной; здесь нет ни чужого пароля, ни
// значения, действующего где-то ещё, — сценарий требует ИМЕННО пары «старый и
// новый», иначе проверять «старый больше не подходит» было бы нечем.
// nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
const OLD_PASSWORD = 'Recovery-old-passw0rd!';
// nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_password
const NEW_PASSWORD = 'Recovery-new-passw0rd!';

const consents = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

// Сессия — это ДВЕ cookie: сессионная и CSRF. Небезопасный запрос без
// заголовка X-CSRF-Token отвергается (double-submit), и прогон обязан вести
// себя как настоящий клиент, иначе он проверяет не то, что делает браузер.
let sessionCookie = null;
let csrfCookie = null;

function authHeaders(method = 'GET') {
  const headers = { Cookie: [sessionCookie, csrfCookie].filter(Boolean).join('; ') };
  if (method !== 'GET' && csrfCookie) {
    headers['X-CSRF-Token'] = csrfCookie.split('=').slice(1).join('=');
  }
  return headers;
}

function captureSession(response) {
  for (const cookie of response.headers.getSetCookie?.() ?? []) {
    const pair = cookie.split(';')[0];
    if (cookie.startsWith(`${SESSION_COOKIE}=`)) sessionCookie = pair;
    if (cookie.startsWith(`${CSRF_COOKIE}=`)) csrfCookie = pair;
  }
}

const markRegister = stamp();
{
  const { response, json } = await req('/v1/auth/register', {
    method: 'POST',
    body: {
      email: EMAIL,
      password: OLD_PASSWORD,
      displayName: `Восстановление ${suffix}`,
      role: 'founder',
      locale: 'ru-RU',
      consents,
    },
  });
  check('учётная запись создана', response.status === 201, `статус ${response.status}`);
  captureSession(response);
  check('сессия открыта регистрацией', Boolean(sessionCookie && csrfCookie), json?.status ?? '');
  // Письмо с подтверждением адреса уходит САМО при регистрации. Иначе
  // подтверждение — функция для тех, кто её искал.
  check(
    'письмо подтверждения отправлено при регистрации',
    Boolean(tokenFor(EMAIL, 'verify', markRegister)),
  );
}

// -------------------------------------------------- 1. анти-перечисление
console.warn('\n[1] Ответ не выдаёт, есть ли такой адрес');
const markUnknown = stamp();
{
  const known = await req('/v1/auth/password/forgot', { method: 'POST', body: { email: EMAIL } });
  const unknown = await req('/v1/auth/password/forgot', {
    method: 'POST',
    body: { email: `no-such-${suffix}@test.local` },
  });
  check(
    'существующий и несуществующий адрес отвечают одинаково',
    known.response.status === unknown.response.status && known.text === unknown.text,
    `${known.response.status} «${known.text}» против ${unknown.response.status} «${unknown.text}»`,
  );
  check('ответ — 202 accepted', known.response.status === 202, `статус ${known.response.status}`);
  check(
    'письмо ушло только на существующий адрес',
    Boolean(tokenFor(EMAIL, 'reset', markUnknown)) &&
      tokenFor(`no-such-${suffix}@test.local`, 'reset', markUnknown) === null,
  );
}

// ------------------------------------------------- 2. токена нет в базе
console.warn('\n[2] В базе только отпечаток токена');
const resetToken = tokenFor(EMAIL, 'reset', markUnknown);
{
  check('токен получен из письма', Boolean(resetToken), `${String(resetToken).slice(0, 8)}…`);
  const digest = createHash('sha256').update(resetToken ?? '', 'utf8').digest();
  const rows = await sql(
    `SELECT purpose, expires_at > now() AS live, used_at
       FROM identity.verification_tokens WHERE token_sha256 = $1`,
    [digest],
  );
  check('строка находится по SHA-256 токена', rows.length === 1, `строк ${rows.length}`);
  check('токен ещё не использован и жив', rows[0]?.used_at === null && rows[0]?.live === true);
  const literal = await sql(
    `SELECT count(*)::int AS n FROM identity.verification_tokens
      WHERE encode(token_sha256, 'escape') LIKE '%' || $1 || '%'`,
    [(resetToken ?? '').slice(0, 16)],
  );
  // Позитивная сторона проверки выше: по самому значению токена строка НЕ
  // находится — в колонке лежит хеш, а не токен.
  check('сам токен в базе не хранится', literal[0]?.n === 0, `совпадений ${literal[0]?.n}`);
}

// ------------------------------------------------------ 3. смена пароля
console.warn('\n[3] Смена пароля по ссылке');
{
  const short = await req('/v1/auth/password/reset', {
    method: 'POST',
    body: { token: resetToken, password: 'short' },
  });
  check('короткий пароль отвергнут', short.response.status === 400, `статус ${short.response.status}`);

  const wrong = await req('/v1/auth/password/reset', {
    method: 'POST',
    body: { token: 'x'.repeat(43), password: NEW_PASSWORD },
  });
  check('чужой токен отвергнут', wrong.response.status === 400, `статус ${wrong.response.status}`);

  const ok = await req('/v1/auth/password/reset', {
    method: 'POST',
    body: { token: resetToken, password: NEW_PASSWORD },
  });
  check('пароль изменён', ok.response.status === 200, `статус ${ok.response.status}`);
  check(
    'сессия по ссылке из письма НЕ открывается',
    (ok.response.headers.getSetCookie?.() ?? []).every((c) => !c.startsWith(`${SESSION_COOKIE}=`)),
  );

  const again = await req('/v1/auth/password/reset', {
    method: 'POST',
    body: { token: resetToken, password: 'Another-passw0rd-here!' },
  });
  check('ссылка срабатывает один раз', again.response.status === 400, `статус ${again.response.status}`);
}

// ------------------------------------------- 4. последствия смены пароля
console.warn('\n[4] Последствия смены пароля');
{
  const old = await req('/v1/auth/login', {
    method: 'POST',
    body: { email: EMAIL, password: OLD_PASSWORD },
  });
  check('старый пароль больше не подходит', old.response.status === 401, `статус ${old.response.status}`);

  // Пауза здесь не «чтобы прошло»: рубеж сессий ставится на НАЧАЛО СЛЕДУЮЩЕЙ
  // секунды (иначе токен, выпущенный в ту же секунду, что и смена пароля,
  // пережил бы её). Плата известна и названа в SessionEpochService: вход в ту
  // же секунду тоже отклоняется. Человек столько печатает пароль; прогон — нет.
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const fresh = await req('/v1/auth/login', {
    method: 'POST',
    body: { email: EMAIL, password: NEW_PASSWORD },
  });
  check('новый пароль работает', fresh.response.status === 201, `статус ${fresh.response.status}`);
  const stale = await req('/v1/auth/me', { headers: { Cookie: sessionCookie ?? '' } });
  // Сессия, открытая ДО смены пароля, обязана умереть: восстановление доступа,
  // после которого чужая вкладка ещё жива, доступ не восстанавливает.
  check('сессия, открытая до смены пароля, мертва', stale.response.status === 401, `статус ${stale.response.status}`);
  captureSession(fresh.response);

  const rows = await sql(
    `SELECT verb FROM audit.events
      WHERE verb IN ('identity.password.reset_requested','identity.password.reset_completed')
        AND ts > now() - interval '5 minutes'`,
  );
  check(
    'запрос и смена пароля попали в журнал',
    rows.some((r) => r.verb === 'identity.password.reset_requested') &&
      rows.some((r) => r.verb === 'identity.password.reset_completed'),
    `событий ${rows.length}`,
  );
}

// -------------------------------------------------- 5. подтверждение почты
console.warn('\n[5] Подтверждение адреса');
{
  const before = await req('/v1/auth/email/verify/status', { headers: authHeaders() });
  check('состояние подтверждения доступно', before.response.status === 200, `статус ${before.response.status}`);
  check('адрес пока не подтверждён', before.json?.verified === false);
  check('канал отправки объявлен доступным', before.json?.mailAvailable === true);

  const anon = await req('/v1/auth/email/verify/request', { method: 'POST' });
  check('запрос подтверждения без сессии отклонён', anon.response.status === 401, `статус ${anon.response.status}`);

  const mark = stamp();
  const sent = await req('/v1/auth/email/verify/request', {
    method: 'POST',
    headers: authHeaders('POST'),
  });
  check('письмо подтверждения запрошено', sent.response.status === 202, `статус ${sent.response.status}`);
  check('назван срок действия ссылки', typeof sent.json?.expiresAt === 'string', sent.json?.expiresAt ?? '');

  const verifyToken = tokenFor(EMAIL, 'verify', mark);
  check('токен подтверждения получен из письма', Boolean(verifyToken));

  const crossed = await req('/v1/auth/password/reset', {
    method: 'POST',
    body: { token: verifyToken, password: 'Cross-purpose-passw0rd!' },
  });
  // Токен подтверждения почты не должен работать как ссылка смены пароля:
  // иначе цель токена — украшение, а не граница.
  check('токен подтверждения не годится для смены пароля', crossed.response.status === 400, `статус ${crossed.response.status}`);

  const confirmed = await req('/v1/auth/email/verify/confirm', {
    method: 'POST',
    body: { token: verifyToken },
  });
  check('адрес подтверждён без сессии', confirmed.response.status === 200, `статус ${confirmed.response.status}`);

  const after = await req('/v1/auth/email/verify/status', { headers: authHeaders() });
  check('состояние стало «подтверждён»', after.json?.verified === true);
  check('живой ссылки больше нет', after.json?.pendingUntil === null, String(after.json?.pendingUntil));

  const identities = await sql(
    `SELECT provider, provider_uid, verified_at IS NOT NULL AS verified
       FROM identity.auth_identities
      WHERE provider = 'email' AND user_id = (
        SELECT user_id FROM identity.verification_tokens
         WHERE token_sha256 = $1)`,
    [createHash('sha256').update(verifyToken ?? '', 'utf8').digest()],
  );
  check('факт подтверждения записан', identities[0]?.verified === true);
  check(
    'в записи не адрес, а blind-индекс',
    !String(identities[0]?.provider_uid ?? '').includes('@'),
    String(identities[0]?.provider_uid ?? '').slice(0, 16),
  );
}

// ------------------------------------------------------ 6. счётчик писем
console.warn('\n[6] Счётчик писем на контакт');
{
  const limit = Number(env.RATE_LIMIT_VERIFY_MAIL_PER_CONTACT ?? 5);
  const target = `flood-${suffix}@test.local`;
  const mark = stamp();
  const statuses = [];
  for (let i = 0; i < limit + 3; i += 1) {
    const { response } = await req('/v1/auth/password/forgot', {
      method: 'POST',
      body: { email: target },
    });
    statuses.push(response.status);
  }
  check(
    'превышение счётчика не меняет ответ',
    statuses.every((s) => s === 202),
    `статусы ${[...new Set(statuses)].join(',')}`,
  );
  // Адрес не зарегистрирован — писем быть не должно вовсе. Это и проверка
  // счётчика, и повторная проверка анти-перечисления: одинаковый ответ на
  // восемь запросов при нулевой отправке.
  const files = mailsSince(mark).filter((name) => name.includes(`flood-${suffix}`));
  check('писем на незарегистрированный адрес не отправлено', files.length === 0, `файлов ${files.length}`);
}

// --------------------------------------------------------------- уборка
{
  // Прогон оставляет после себя письма с рабочими токенами. Токены уже
  // погашены, но файл с ссылкой на смену пароля — не то, что стоит копить на
  // диске.
  for (const name of readdirSync(existsSync(MAIL_DIR) ? MAIL_DIR : ROOT)) {
    if (name.includes(String(suffix)) && name.endsWith('.eml')) {
      rmSync(join(MAIL_DIR, name), { force: true });
    }
  }
}

console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено.\n`);
await pool.end();
if (failed > 0) process.exitCode = 1;
