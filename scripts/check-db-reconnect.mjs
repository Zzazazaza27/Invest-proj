#!/usr/bin/env node
/**
 * Обрыв соединений с базой не роняет ядро.
 *
 * ОТКУДА ПРОВЕРКА. 2026-09-22 машина ушла в гибернацию; соединения с
 * Postgres разорвались, фоновый проход публикатора отклонился без перехвата,
 * и Node уронил ВЕСЬ процесс ядра. Утром это выглядело как «Сервер временно
 * недоступен, код 502» — при живых контейнерах и целой базе.
 *
 * Свойство, которое здесь проверяется, шире гибернации: перезапуск СУБД,
 * сетевой сбой, переключение на резерв — всё это обрыв соединений, и ядро
 * обязано его пережить. Одного `try/catch` в коде мало: проверять надо
 * поведение процесса, а не наличие перехвата.
 *
 * Как устроено: прогон обрывает ВСЕ соединения приложения к базе командой
 * администратора и смотрит, что ядро отвечает дальше и обслуживает запросы.
 *
 * Запуск: node scripts/check-db-reconnect.mjs (нужны БД и ядро)
 */
import pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL as DEFAULT_CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const BASE = process.env.CORE_URL ?? DEFAULT_CORE_URL;

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

let passed = 0;
const defects = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.warn(`  ok    ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    defects.push(name);
    console.error(`  ДЕФЕКТ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function health() {
  try {
    const response = await fetch(`${BASE}/v1/health`, { signal: AbortSignal.timeout(5_000) });
    return response.status;
  } catch {
    return 0;
  }
}

const database = new URL(process.env.DATABASE_URL_OWNER ?? '').pathname.replace(/^\//, '');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
await client.connect();

console.warn('\n=== ОБРЫВ СОЕДИНЕНИЙ С БАЗОЙ ===\n');

try {
  const before = await health();
  check('до обрыва ядро отвечает', before === 200, `HTTP ${before}`);
  if (before !== 200) throw new Error('проверять нечего: ядро не работает и до обрыва');

  const { rowCount } = await client.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [database],
  );
  check('соединения оборваны', (rowCount ?? 0) > 0, `оборвано: ${rowCount}`);

  // Фоновые проходы идут раз в секунду-две: дать им наткнуться на обрыв.
  await new Promise((resolve) => setTimeout(resolve, 6_000));

  const after = await health();
  check('ядро пережило обрыв', after === 200, `HTTP ${after}`);

  // Мало выжить — надо обслуживать: пул обязан поднять новые соединения.
  const catalog = await fetch(`${BASE}/v1/catalog?limit=1`, {
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  check(
    'запросы к базе снова проходят',
    catalog?.status === 200,
    `HTTP ${catalog?.status ?? 'нет ответа'}`,
  );

  // И ещё раз, чтобы поймать случай «первый запрос поднял соединение и умер».
  const { rowCount: second } = await client.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [database],
  );
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  const third = await health();
  check('повторный обрыв тоже пережит', third === 200, `оборвано ${second}, HTTP ${third}`);
} catch (error) {
  check('прогон выполнен', false, error instanceof Error ? error.message : String(error));
} finally {
  await client.end();
}

console.warn(`\nпройдено: ${passed}, дефектов: ${defects.length}\n`);
process.exit(defects.length === 0 ? 0 : 1);
