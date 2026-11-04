#!/usr/bin/env node
/**
 * Запуск прогона на временном контуре.
 *
 * ЗАЧЕМ ОБЁРТКА. Контур — это три вещи сразу: своя база, своё ядро и своя
 * точка входа. Браузерные проходы ходят во все три: страницу открывают через
 * вход, API дёргают по тому же origin, а предусловия готовят прямым запросом
 * к базе. Забыть одну переменную — значит получить прогон, который
 * регистрирует человека во временной базе, а ищет его в рабочей: именно так
 * первая попытка и упала.
 *
 * Поэтому переменные подставляются здесь, все сразу, и помнить их не нужно.
 *
 * Запуск:
 *   node scripts/temp-run.mjs scripts/render-check-admin-countries.mjs
 *   npm run temp:run -- scripts/render-check-admin-countries.mjs
 */
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const DB_NAME = 'fifth_element_temp_stand';
const CORE_PORT = '4302';
const WEB_PORT = '8081';

const target = process.argv[2];
if (!target) {
  console.error('нужен путь к прогону: node scripts/temp-run.mjs scripts/render-check-….mjs');
  process.exit(2);
}

const dbUrl = (() => {
  const url = new URL(process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL);
  url.pathname = `/${DB_NAME}`;
  return url.href;
})();

/*
 * Меняется ИМЯ БАЗЫ, а не роль.
 *
 * Прогон, которому подставили владельца базы вместо рабочей роли, теряет
 * RLS: построчные политики владельца не касаются. `smoke-lab` на таком
 * контуре дал девять ложных отказов «чужой проект читается». Роль в каждом
 * адресе остаётся своя, меняется только база.
 */
function databaseUrlsForTemp() {
  const out = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^DATABASE_URL(_|$)/.test(key) || !value) continue;
    try {
      const url = new URL(value);
      url.pathname = `/${DB_NAME}`;
      out[key] = url.href;
    } catch {
      /* не адрес — не трогаем */
    }
  }
  return out;
}

/*
 * Контур обязан быть поднят. Молча уйти в рабочую базу нельзя: прогон
 * создаёт там неудаляемые записи, ради чего контур и появился.
 */
const client = new pg.Client({ connectionString: dbUrl });
try {
  await client.connect();
  await client.end();
} catch {
  console.error(
    `Временный контур не поднят: базы ${DB_NAME} нет.\n` + '  Поднять: npm run temp:up',
  );
  process.exit(2);
}

// Адрес намеренно по http: это точка входа временного контура на петлевом
// интерфейсе, поднятая этой же машиной на время прогона. TLS к собственному
// процессу на 127.0.0.1 ничего не защищает, а правило смотрит на схему.
// nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
const health = await fetch(`http://127.0.0.1:${WEB_PORT}/v1/health`, {
  signal: AbortSignal.timeout(5000),
}).catch(() => null);
if (health?.status !== 200) {
  console.error(
    `Точка входа временного контура (${WEB_PORT}) не отвечает.\n` + '  Поднять: npm run temp:up',
  );
  process.exit(2);
}

console.warn(`\n  контур: база ${DB_NAME}, ядро ${CORE_PORT}, вход ${WEB_PORT}\n`);

const result = spawnSync(process.execPath, [target, ...process.argv.slice(3)], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    FIFTH_ENTRY: 'web',
    WEB_PORT,
    CORE_PORT,
    // И прямой доступ к базе тоже во временную: предусловия прогонов пишутся
    // мимо API. Роль у каждого адреса своя, меняется только имя базы.
    ...databaseUrlsForTemp(),
    DATABASE_URL_OWNER: dbUrl,
  },
});
process.exit(result.status ?? 1);
