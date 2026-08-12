#!/usr/bin/env node
/**
 * Проверка точечного отзыва токена (M038).
 *
 * Остаток находки внешнего аудита (SEC-07/08). Рубеж сессий обесценивает ВСЕ
 * токены пользователя разом; выход при этом лишь удалял cookie у клиента — сам
 * токен оставался действительным до `exp`, и скопированное значение работало
 * час.
 *
 * Прогон проверяет фактом, а не чтением кода:
 *   1. два независимых входа одного пользователя дают РАЗНЫЕ идентификаторы;
 *   2. выход отзывает предъявленный токен: тот же токен больше не проходит;
 *   3. вторая сессия ПРОДОЛЖАЕТ работать — иначе это не точечный отзыв,
 *      а тот же рубеж под другим именем;
 *   4. запись в реестре появилась ровно одна, с причиной `logout`;
 *   5. уборка не трогает записи о действующих токенах и убирает истёкшие.
 *
 * Запуск: node scripts/probe-token-revocation.mjs (нужен поднятый core)
 */
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Молчаливая смерть прогона неотличима от «ничего не проверено»: в глобальном
// аудите этот скрипт однажды упал, не напечатав ни строки причины. Любая
// необработанная ошибка обязана назвать себя.
process.on('unhandledRejection', (reason) => {
  console.error('ПРОГОН ОБОРВАН (unhandledRejection):', reason);
  process.exit(1);
});
process.on('uncaughtException', (error) => {
  console.error('ПРОГОН ОБОРВАН (uncaughtException):', error);
  process.exit(1);
});

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

const BASE = process.env.CORE_URL ?? 'http://127.0.0.1:4300';
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
    get session() {
      return state.session;
    },
    get csrf() {
      return state.csrf;
    },
    async call(path, { method = 'GET', body, cookies } = {}) {
      const jar = cookies ?? [state.session, state.csrf].filter(Boolean).join('; ');
      const headers = { Cookie: jar };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const csrf = (cookies ?? '').includes(`${CSRF_COOKIE}=`)
        ? cookies.split(`${CSRF_COOKIE}=`)[1].split(';')[0]
        : state.csrf?.split('=').slice(1).join('=');
      if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
      const response = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      for (const cookie of response.headers.getSetCookie?.() ?? []) {
        const pair = cookie.split(';')[0];
        // Удаление cookie приходит пустым значением: сохранять его как сессию
        // нельзя, иначе клиент «помнит» пустую строку вместо токена.
        if (cookie.startsWith(`${SESSION_COOKIE}=`)) {
          state.session = pair.endsWith('=') ? null : pair;
        }
        if (cookie.startsWith(`${CSRF_COOKIE}=`)) {
          state.csrf = pair.endsWith('=') ? null : pair;
        }
      }
      return response;
    },
  };
}

/** Полезная нагрузка локального токена: идентификатор нужен для сверки с реестром. */
function tokenPayload(cookiePair) {
  const value = cookiePair.split('=').slice(1).join('=');
  const [body] = value.split('.');
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}

const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

console.warn('\n=== ПРОВЕРКА ТОЧЕЧНОГО ОТЗЫВА ТОКЕНА ===\n');

const suffix = `${Date.now() % 1e9}`;
const email = `revoke-token-${suffix}@test.local`;
const password = `Pw-${randomUUID()}`;

const first = makeClient();
const second = makeClient();

await first.call('/v1/auth/register', {
  method: 'POST',
  body: {
    email,
    password,
    displayName: 'Отзыв токена',
    role: 'founder',
    locale: 'ru-RU',
    consents: CONSENTS,
  },
});
const [user] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
  blindIndex(email),
]);
check('пользователь создан', Boolean(user?.id));

// Второй вход — независимая сессия того же человека («другое устройство»).
await second.call('/v1/auth/login', { method: 'POST', body: { email, password } });

const firstJti = tokenPayload(first.session).jti;
const secondJti = tokenPayload(second.session).jti;
check('у токена есть идентификатор', Boolean(firstJti), `jti=${String(firstJti).slice(0, 8)}…`);
check('идентификаторы двух сессий различаются', firstJti !== secondJti);

const beforeFirst = await first.call('/v1/auth/me');
const beforeSecond = await second.call('/v1/auth/me');
check(
  'обе сессии работают до выхода',
  beforeFirst.status === 200 && beforeSecond.status === 200,
  `HTTP ${beforeFirst.status}/${beforeSecond.status}`,
);

// Значение cookie сохраняется ДО выхода: именно его предъявит тот, кто успел
// скопировать сессию. Удаление cookie на клиенте такому предъявлению не мешает.
const stolen = [first.session, first.csrf].filter(Boolean).join('; ');

const logout = await first.call('/v1/auth/logout', { method: 'POST' });
const logoutBody = await logout.json().catch(() => ({}));
check('выход выполнен', logout.status === 200 || logout.status === 201, `HTTP ${logout.status}`);
check(
  'ответ сообщает об отзыве токена',
  logoutBody.tokenRevoked === true,
  JSON.stringify(logoutBody),
);

const replay = await first.call('/v1/auth/me', { cookies: stolen });
check(
  'скопированный токен после выхода не проходит',
  replay.status === 401,
  `HTTP ${replay.status}`,
);

const otherSession = await second.call('/v1/auth/me');
check(
  'вторая сессия продолжает работать (отзыв точечный, а не общий)',
  otherSession.status === 200,
  `HTTP ${otherSession.status}`,
);

const registry = await sql(
  `SELECT jti, reason, user_id, revoked_by, expires_at > now() AS active
     FROM identity.revoked_tokens WHERE user_id = $1`,
  [user.id],
);
check('в реестре ровно одна запись', registry.length === 1, `записей: ${registry.length}`);
check('записан отозванный идентификатор', registry[0]?.jti === firstJti);
check('причина — выход', registry[0]?.reason === 'logout');
check('инициатор — сам пользователь', registry[0]?.revoked_by === user.id);
check('запись действует до истечения токена', registry[0]?.active === true);

// Журнал: факт отзыва наблюдаем, а идентификатор токена в него НЕ попадает.
const [event] = await sql(
  `SELECT context_jsonb AS context FROM audit.events
    WHERE verb = 'identity.token.revoked' AND subject_id = $1
    ORDER BY ts DESC LIMIT 1`,
  [user.id],
);
check('событие отзыва записано в журнал', Boolean(event));
check(
  'идентификатор токена в журнал не попал',
  event ? !JSON.stringify(event.context).includes(firstJti) : false,
);

// ---- Уборка -------------------------------------------------------------
// Правило простое: запись о ДЕЙСТВУЮЩЕМ токене снять нельзя, запись об
// истёкшем — можно, и только сервисной ролью уборки. Роль приложения права
// удалять не имеет вовсе.
//
// Уборка идёт БЕЗ пользовательского контекста — так её выполняет core. Именно
// в этом месте первая версия молча удаляла ноль строк: DELETE читает строку, и
// к нему применяется SELECT-политика роли.
const app = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
// Уборку выполняет роль обслуживания (M039), а не доставка уведомлений: та
// лишь читает реестр на входе. Прогон, оставшийся на старой роли, падал с
// permission denied — право переехало, а проверка нет.
const janitor = new pg.Pool({
  connectionString: process.env.DATABASE_URL_APP_MAINTENANCE,
  max: 1,
});
const expiredJti = `expired-${randomUUID()}`;
await sql(
  `INSERT INTO identity.revoked_tokens (jti, user_id, expires_at, reason)
        VALUES ($1, $2, now() - interval '1 hour', 'logout')`,
  [expiredJti, user.id],
);

const appClient = await app.connect();
try {
  await appClient.query('BEGIN');
  await appClient.query(`SELECT set_config('app.current_user_id', $1, true)`, [user.id]);
  await appClient.query(`SELECT set_config('app.current_roles', 'founder', true)`);
  let denied = false;
  try {
    await appClient.query('DELETE FROM identity.revoked_tokens WHERE jti = $1', [firstJti]);
  } catch {
    denied = true;
  }
  check('роль приложения удалять из реестра не может', denied);
  await appClient.query('ROLLBACK');
} finally {
  appClient.release();
  await app.end();
}

const janitorClient = await janitor.connect();
try {
  await janitorClient.query('BEGIN');
  await janitorClient.query(`SET LOCAL ROLE app_maintenance`);
  await janitorClient.query(`SELECT set_config('app.current_user_id', '', true)`);
  await janitorClient.query(`SELECT set_config('app.current_roles', 'system', true)`);
  const dead = await janitorClient.query(
    'DELETE FROM identity.revoked_tokens WHERE expires_at < now() RETURNING jti',
  );
  check(
    'уборка без пользовательского контекста убирает истёкшую запись',
    dead.rows.some((r) => r.jti === expiredJti),
    `удалено: ${dead.rowCount}`,
  );
  const stillThere = await janitorClient.query(
    'SELECT 1 FROM identity.revoked_tokens WHERE jti = $1',
    [firstJti],
  );
  check('запись о действующем токене уборкой не тронута', stillThere.rowCount === 1);
  await janitorClient.query('COMMIT');
} finally {
  janitorClient.release();
  await janitor.end();
}

await pool.end();
console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exitCode = failed > 0 ? 1 : 0;
