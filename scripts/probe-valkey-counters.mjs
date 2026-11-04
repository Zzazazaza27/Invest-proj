#!/usr/bin/env node
/**
 * Общие счётчики ограничений на Valkey (4.8, D-008) — проверка фактом.
 *
 * Что проверяется и почему здесь, а не в юнит-тестах: всё ниже зависит от
 * поведения настоящего сервера и клиента при обрыве.
 *
 *  1. ОКНО. Фиксированное: повторный счёт не продлевает срок; по истечении
 *     окна счёт начинается заново с единицы. Сброс обнуляет.
 *  2. ОБРЫВ СОЕДИНЕНИЯ. Счёт во время обрыва — отказ за ограниченное время,
 *     без накопления и повторной отправки; после переподключения счёт снова
 *     работает.
 *  3. НЕИЗВЕСТНЫЙ РЕЗУЛЬТАТ. Сервер приостановлен (`CLIENT PAUSE`): клиент
 *     получает отказ по таймауту команды, хотя команда уже ушла. После паузы
 *     сервер её выполняет — счёт увеличен ровно на один, а не на два: клиент
 *     её не переотправил.
 *  4. ОТКАЗ БЕЗ ОБХОДА. Контейнер Valkey остановлен: ядро отвечает 503 и на
 *     обычный запрос, и на вход, а не пропускает их мимо ограничений. После
 *     запуска контейнера — снова 200.
 *
 * Нужны: собранный core, поднятый стенд (ядро на CORE_URL), контейнер
 * `fifth-valkey`. Прогон останавливает Valkey на несколько секунд и
 * поднимает обратно при любом исходе; ключи прогона убирает.
 *
 * Запуск: node scripts/probe-valkey-counters.mjs
 */
import Redis from 'ioredis';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { CORE_URL as DEFAULT_CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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

const DIST = join(ROOT, 'apps/core/dist/cache');
if (!existsSync(join(DIST, 'counters.js'))) {
  console.error('нет apps/core/dist/cache/counters.js — сначала npm run build -w apps/core');
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { Counters } = require(join(DIST, 'counters.js'));
const { createRateLimitRedis } = require(join(DIST, 'redis.client.js'));

const BASE = process.env.CORE_URL ?? DEFAULT_CORE_URL;
const PREFIX = `probe-valkey:${randomUUID()}`;
const admin = new Redis(process.env.REDIS_URL, {
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 1,
});
// Пока Valkey намеренно остановлен, служебный клиент переподключается молча.
admin.on('error', () => undefined);
// Клиент с настройками приложения: таймаут команды, без очереди и повторов.
const appRedis = createRateLimitRedis();
const counters = new Counters(appRedis);
// Без очереди команд счёт до установки соединения — отказ (так и в ядре до
// готовности, 4.9). Прогон проверяет работу, поэтому ждёт подключения.
await new Promise((resolve) => appRedis.once('ready', resolve));
const COMMAND_TIMEOUT = Number(process.env.REDIS_COMMAND_TIMEOUT_MS || 1_000);

try {
  await windowScenarios();
  await reconnectScenarios();
  await unknownResultScenario();
  await outageScenario();
} catch (error) {
  check('прогон выполнен', false, error instanceof Error ? error.stack : String(error));
} finally {
  docker(['start', 'fifth-valkey'], true);
  await waitValkey();
  const keys = await admin.keys(`${PREFIX}*`).catch(() => []);
  if (keys.length > 0) await admin.del(...keys).catch(() => undefined);
  await counters.close().catch(() => undefined);
  await admin.quit().catch(() => undefined);
}

console.warn(`\nпройдено: ${passed}, отказов: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);

async function windowScenarios() {
  console.warn('\n▸ Фиксированное окно');
  const key = `${PREFIX}:window`;
  const first = await counters.hit(key, 1_500);
  check(
    'первый счёт — 1, срок поставлен',
    first.used === 1 && first.ttlMs > 0,
    `ttl ${first.ttlMs} мс`,
  );
  await sleep(500);
  const second = await counters.hit(key, 1_500);
  check(
    'повторный счёт не продлевает окно',
    second.used === 2 && second.ttlMs < first.ttlMs && second.ttlMs <= 1_100,
    `ttl ${second.ttlMs} мс`,
  );
  await sleep(1_200);
  const fresh = await counters.hit(key, 1_500);
  check('после истечения окна счёт начинается с 1', fresh.used === 1, `счёт ${fresh.used}`);
  check('чтение видит текущее значение', (await counters.read(key)) === 1);
  await counters.reset(key);
  check('сброс обнуляет счётчик', (await counters.read(key)) === 0);

  const orphan = `${PREFIX}:orphan`;
  await admin.set(orphan, '7');
  const healed = await counters.hit(orphan, 60_000);
  check(
    'ключ без срока получает срок при следующем счёте',
    healed.used === 8 && (await admin.pttl(orphan)) > 0,
  );
}

async function reconnectScenarios() {
  console.warn('\n▸ Обрыв соединения');
  const key = `${PREFIX}:reconnect`;
  await counters.hit(key, 60_000);
  // Рвём ВСЕ обычные соединения, кроме своего служебного, — в том числе
  // соединение счётчиков этого прогона.
  await admin.client('KILL', 'TYPE', 'normal', 'SKIPME', 'yes');
  const started = Date.now();
  let error = null;
  try {
    await counters.hit(key, 60_000);
  } catch (caught) {
    error = caught;
  }
  const waited = Date.now() - started;
  check(
    'счёт во время обрыва — отказ за ограниченное время',
    error !== null && waited <= COMMAND_TIMEOUT + 500,
    `${error ? error.message : 'ошибки нет'}; ${waited} мс`,
  );
  await sleep(1_500);
  const value = Number(await admin.get(key));
  check('отказанный счёт не применён позже повторной отправкой', value === 1, `значение ${value}`);
  let after = null;
  for (let attempt = 0; attempt < 10 && after === null; attempt += 1) {
    after = await counters.hit(key, 60_000).catch(() => null);
    if (after === null) await sleep(300);
  }
  check('после переподключения счёт снова работает', after?.used === 2, `счёт ${after?.used}`);
}

async function unknownResultScenario() {
  console.warn('\n▸ Неизвестный результат');
  const key = `${PREFIX}:unknown`;
  await counters.hit(key, 60_000);
  await admin.client('PAUSE', String(COMMAND_TIMEOUT + 1_500), 'WRITE');
  const started = Date.now();
  let error = null;
  try {
    await counters.hit(key, 60_000);
  } catch (caught) {
    error = caught;
  }
  const waited = Date.now() - started;
  check(
    'ответа нет — отказ по таймауту команды',
    error !== null && waited >= COMMAND_TIMEOUT - 50 && waited <= COMMAND_TIMEOUT + 500,
    `${error ? error.message : 'ошибки нет'}; ${waited} мс`,
  );
  await sleep(2_500);
  const value = Number(await admin.get(key));
  check(
    'после паузы команда выполнена один раз, повторной отправки нет',
    value === 2,
    `значение ${value} (ожидалось 2: первый счёт + ушедший до паузы)`,
  );
}

async function outageScenario() {
  console.warn('\n▸ Отказ Valkey на живом ядре');
  const before = await status(`${BASE}/v1/catalog`);
  check('до отказа ядро отвечает', before !== 0 && before < 500, `HTTP ${before}`);
  docker(['stop', 'fifth-valkey']);
  await sleep(1_000);
  const plain = await status(`${BASE}/v1/catalog`);
  check('обычный запрос при отказе — 503, не обход', plain === 503, `HTTP ${plain}`);
  const login = await status(`${BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'probe@example.invalid', password: 'x'.repeat(12) }),
  });
  check('вход при отказе — 503, не обход', login === 503, `HTTP ${login}`);
  docker(['start', 'fifth-valkey']);
  await waitValkey();
  let back = 0;
  for (let attempt = 0; attempt < 20 && (back === 0 || back >= 500); attempt += 1) {
    await sleep(500);
    back = await status(`${BASE}/v1/catalog`);
  }
  check('после возврата Valkey ядро снова отвечает', back !== 0 && back < 500, `HTTP ${back}`);
}

async function status(url, init = {}) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
    return response.status;
  } catch {
    return 0;
  }
}

function docker(args, allowFail = false) {
  try {
    execFileSync('docker', args, { stdio: 'ignore' });
  } catch (error) {
    if (!allowFail) throw error;
  }
}

async function waitValkey() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await admin.ping().catch(() => null)) === 'PONG') return;
    await sleep(500);
  }
}
