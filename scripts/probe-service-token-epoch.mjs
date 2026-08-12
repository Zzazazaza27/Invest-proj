#!/usr/bin/env node
/**
 * Проверка немедленного отзыва токенов сервисного аккаунта (M042).
 *
 * Находка внешнего аудита SEC-08. Приостановка аккаунта и ротация секрета
 * закрывали только ВЫДАЧУ новых токенов. Уже выданный токен самодостаточен и
 * действовал до `exp` — по конфигурации до часа. То есть на украденный токен
 * администратор фактически не мог отреагировать: он нажимал «приостановить», а
 * чужая система работала дальше.
 *
 * Прогон проверяет фактом, а не чтением кода:
 *   1. выданный токен работает;
 *   2. ПРИОСТАНОВКА аккаунта — тот же токен немедленно перестаёт проходить;
 *   3. ВОЗОБНОВЛЕНИЕ не воскрешает старый токен: рубеж уже другой;
 *   4. новый токен после возобновления работает;
 *   5. РОТАЦИЯ секрета обесценивает токен, выданный до неё;
 *   6. рубеж в БД растёт на каждом из этих действий.
 *
 * Прогон работает напрямую с БД и HTTP, без правки кода приложения.
 *
 * Запуск: node scripts/probe-service-token-epoch.mjs (нужен поднятый core)
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Молчаливая смерть прогона неотличима от «ничего не проверено».
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

/**
 * Задержка распространения снимка состояния аккаунтов.
 *
 * Свой экземпляр обновляет снимок сразу после фиксации, но прогон меняет БД
 * НАПРЯМУЮ, минуя приложение, — значит ждать надо полное время жизни снимка.
 * Так проверяется худший случай (изменение пришло с другого экземпляра), а не
 * удобный.
 */
const SNAPSHOT_TTL_MS = 5000;
const settle = () => new Promise((resolve) => setTimeout(resolve, SNAPSHOT_TTL_MS + 500));

async function issueToken(clientId, secret) {
  const response = await fetch(`${BASE}/v1/integration/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret: secret }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (response.status !== 200 && response.status !== 201) {
    // Причина отказа печатается: «токен не выдан» без причины неотличимо от
    // «прогон сломан», и разбирать это потом дороже, чем напечатать сейчас.
    console.warn(`        выдача отклонена: HTTP ${response.status} ${text.slice(0, 200)}`);
    return null;
  }
  try {
    return JSON.parse(text).accessToken ?? null;
  } catch {
    return null;
  }
}

async function callWithToken(token) {
  const response = await fetch(`${BASE}/v1/integration/graduates?limit=1`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  return response.status;
}

const epochOf = async (id) =>
  Number(
    (await sql('SELECT token_epoch FROM integration.service_accounts WHERE id = $1', [id]))[0]
      ?.token_epoch,
  );

console.warn('\n=== ПРОВЕРКА: РУБЕЖ ТОКЕНОВ СЕРВИСНОГО АККАУНТА ===\n');

// Аккаунт заводится напрямую в БД: прогон проверяет отзыв, а не создание, и не
// должен зависеть от наличия администратора со свежей сессией.
const accountId = randomUUID();
const clientId = `probe-epoch-${Date.now() % 1e9}`;
const secret = `s-${randomUUID()}${randomUUID()}`.replace(/-/g, '');
const argon2 = (await import('argon2')).default;

// Поле `created_by` ссылается на пользователя. Кто именно — прогону безразлично:
// проверяется отзыв токена, а не авторство записи.
const [owner] = await sql('SELECT id FROM identity.users LIMIT 1');
if (!owner?.id) {
  console.error('ПРОГОН НЕВОЗМОЖЕН: в базе нет ни одного пользователя для поля created_by');
  process.exit(1);
}

await sql(
  `INSERT INTO integration.service_accounts
     (id, client_id, name, client_secret_hash, mtls_cert_fingerprint, scopes, created_by)
   VALUES ($1, $2, $3, $4, '', ARRAY['graduates:read'], $5)`,
  [accountId, clientId, 'прогон рубежа', await argon2.hash(secret), owner.id],
);
check('аккаунт создан', (await epochOf(accountId)) === 1, 'рубеж 1');

// 1. Токен выдан и работает.
const first = await issueToken(clientId, secret);
check('токен выдан', Boolean(first));
const beforeStatus = first ? await callWithToken(first) : 0;
check('выданный токен работает', beforeStatus === 200, `HTTP ${beforeStatus}`);

// 2. Приостановка — тот же токен обязан перестать работать.
await sql(
  "UPDATE integration.service_accounts SET status = 'suspended', token_epoch = token_epoch + 1 WHERE id = $1",
  [accountId],
);
await settle();
const afterSuspend = first ? await callWithToken(first) : 0;
check(
  'после приостановки выданный ранее токен не проходит',
  afterSuspend === 401,
  `HTTP ${afterSuspend}`,
);
check('рубеж вырос при приостановке', (await epochOf(accountId)) === 2);

// 3. Возобновление не воскрешает старый токен.
await sql(
  "UPDATE integration.service_accounts SET status = 'active', token_epoch = token_epoch + 1 WHERE id = $1",
  [accountId],
);
await settle();
const afterResume = first ? await callWithToken(first) : 0;
check(
  'возобновление НЕ воскрешает токен, выданный до приостановки',
  afterResume === 401,
  `HTTP ${afterResume}`,
);

// 4. Новый токен после возобновления работает — иначе это не отзыв, а поломка.
const second = await issueToken(clientId, secret);
const secondStatus = second ? await callWithToken(second) : 0;
check('новый токен после возобновления работает', secondStatus === 200, `HTTP ${secondStatus}`);

// 5. Ротация секрета обесценивает токен, выданный до неё.
await sql(
  'UPDATE integration.service_accounts SET client_secret_hash = $2, token_epoch = token_epoch + 1 WHERE id = $1',
  [accountId, await argon2.hash(`other-${randomUUID()}`)],
);
await settle();
const afterRotate = second ? await callWithToken(second) : 0;
check(
  'после ротации секрета прежний токен не проходит',
  afterRotate === 401,
  `HTTP ${afterRotate}`,
);
check('рубеж вырос при ротации', (await epochOf(accountId)) === 4);

await sql('DELETE FROM integration.service_accounts WHERE id = $1', [accountId]);
await pool.end();

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exitCode = failed > 0 ? 1 : 0;
