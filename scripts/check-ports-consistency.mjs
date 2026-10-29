#!/usr/bin/env node
/**
 * Гейт согласованности портов стенда.
 *
 * Порт живёт в `.env` дважды: как отдельная переменная (`POSTGRES_PORT`) и
 * внутри строк подключения (`DATABASE_URL=postgres://…:5433/…`). Это не
 * дублирование по недосмотру: строку подключения потребляют драйверы, которым
 * нужен готовый URL, а число — compose и конфиги фронтендов. Но раз значение
 * записано в двух видах, они расходятся — и расхождение не сообщает о себе:
 * compose публикует один порт, приложение стучится в другой, а выглядит это как
 * «база не отвечает» на исправной базе.
 *
 * Здесь проверяется, что оба вида говорят одно и то же.
 *
 * Запуск: node scripts/check-ports-consistency.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PORTS } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');

let failed = 0;

function fail(message) {
  failed += 1;
  console.warn(`  FAIL  ${message}`);
}

function ok(message) {
  console.warn(`  OK    ${message}`);
}

if (!existsSync(ENV_PATH)) {
  console.warn('check-ports: .env отсутствует — сверять нечего (свежий клон).');
  process.exit(0);
}

/** Значения читаются из файла, а не из `process.env`: там уже могут быть чужие. */
const env = new Map();
for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq <= 0) continue;
  env.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
}

console.warn('\n=== СОГЛАСОВАННОСТЬ ПОРТОВ ===\n');

/** Порт из URL. `null`, если порт не указан явно — это отдельный случай. */
function portOf(value) {
  try {
    const parsed = new URL(value);
    return parsed.port === '' ? null : Number(parsed.port);
  } catch {
    return undefined;
  }
}

/** Строки подключения к БД: все обязаны указывать на POSTGRES_PORT. */
const dbKeys = [...env.keys()].filter((k) => k.startsWith('DATABASE_URL'));
if (dbKeys.length === 0) fail('в .env нет ни одной строки DATABASE_URL*');
for (const key of dbKeys) {
  const port = portOf(env.get(key));
  if (port === undefined) {
    fail(`${key} — не разбирается как URL`);
  } else if (port === null) {
    fail(`${key} — порт не указан явно, подставится 5432 вместо ${PORTS.postgres}`);
  } else if (port !== PORTS.postgres) {
    fail(`${key} указывает порт ${port}, а POSTGRES_PORT=${PORTS.postgres}`);
  }
}
if (failed === 0) ok(`${dbKeys.length} строк DATABASE_URL* → порт ${PORTS.postgres}`);

/** Redis. */
{
  const raw = env.get('REDIS_URL');
  const port = raw === undefined ? undefined : portOf(raw);
  if (port === undefined) fail('REDIS_URL отсутствует или не разбирается');
  else if (port !== PORTS.redis) fail(`REDIS_URL указывает ${port}, а REDIS_PORT=${PORTS.redis}`);
  else ok(`REDIS_URL → порт ${PORTS.redis}`);
}

/** Адрес ядра, который получают фронтенды. */
{
  const raw = env.get('VITE_API_BASE_URL');
  const port = raw === undefined ? undefined : portOf(raw);
  if (port === undefined) fail('VITE_API_BASE_URL отсутствует или не разбирается');
  else if (port !== PORTS.core)
    fail(`VITE_API_BASE_URL указывает ${port}, а CORE_PORT=${PORTS.core}`);
  else ok(`VITE_API_BASE_URL → порт ${PORTS.core}`);
}

/**
 * CORS: каждый фронтенд обязан быть в списке разрешённых origin.
 *
 * Пропуск здесь особенно неприятен: страница открывается, рисуется, и только
 * первый запрос к API падает — в браузере это выглядит как «данные не
 * грузятся», а причина в списке на стороне сервера.
 */
{
  const raw = env.get('CORS_ALLOWED_ORIGINS') ?? '';
  const origins = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const frontends = [
    ['витрина', PORTS.webPublic],
    ['админка', PORTS.admin],
    ['кабинет основателя', PORTS.lab],
    ['кабинет инвестора', PORTS.investor],
    ['консоль', PORTS.console],
    ['вход и регистрация', PORTS.auth],
  ];
  let missing = 0;
  for (const [name, port] of frontends) {
    // Для браузера localhost и 127.0.0.1 — разные origin: нужен хотя бы один,
    // но отсутствие обоих означает, что кабинет не сможет обратиться к API.
    const present =
      origins.has(`http://localhost:${port}`) || origins.has(`http://127.0.0.1:${port}`);
    if (!present) {
      fail(`${name} (порт ${port}) отсутствует в CORS_ALLOWED_ORIGINS`);
      missing += 1;
    }
  }
  if (missing === 0) ok(`все ${frontends.length} фронтендов разрешены в CORS`);

  // Единая точка входа: за прокси порта в origin нет вовсе. Забыть этот адрес
  // особенно легко — локально всё работает по портам, а через прокси страница
  // открывается и молча не получает данных.
  const proxyOrigin = PORTS.web === 80 ? 'http://127.0.0.1' : `http://127.0.0.1:${PORTS.web}`;
  const proxyOriginAlt = PORTS.web === 80 ? 'http://localhost' : `http://localhost:${PORTS.web}`;
  if (origins.has(proxyOrigin) || origins.has(proxyOriginAlt)) {
    ok(`адрес единой точки входа разрешён в CORS (${proxyOrigin})`);
  } else {
    fail(`адрес единой точки входа ${proxyOrigin} отсутствует в CORS_ALLOWED_ORIGINS`);
  }
}

console.warn('');
if (failed > 0) {
  console.warn(`Несогласованных значений: ${failed}. Стенд поднимется наполовину.\n`);
  process.exit(1);
}
console.warn('Порты согласованы.\n');
