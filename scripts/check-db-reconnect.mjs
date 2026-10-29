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
 * ДВЕ ЧАСТИ, И ОБЕ НУЖНЫ.
 *
 * 1. ПОВЕДЕНИЕ. Прогон рвёт все соединения приложения командой
 *    администратора и смотрит, что ядро отвечает дальше и снова ходит в
 *    базу. Со снятой починкой эта часть краснеет — проверено: ядро умирает
 *    посреди серии. Но ловит она дефект НЕ ВСЕГДА: падение случается,
 *    только если обрыв пришёлся на открытую транзакцию фонового прохода, а
 *    это гонка по времени. Одиночный обрыв её не воспроизводил вовсе.
 *
 * 2. УСТРОЙСТВО. Поэтому рядом стоит проверка кода. Процесс стоило
 *    `void this.runFanOutOnce()` без `.catch()` в таймере службы. С блока 1
 *    таймеры заводит только общая оболочка фона, которая перехватывает отказ
 *    прохода; проверка ловит службу, снова заведшую свой таймер.
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

  /**
   * Рвём СЕРИЕЙ, а не один раз.
   *
   * Падение случается, когда соединение умирает внутри уже открытой
   * транзакции фонового прохода. Одиночный обрыв в это окно попадает не
   * всегда: проход занимает миллисекунды, а идёт раз в секунду. Первая
   * версия проверки была зелёной и со снятой починкой — то есть не
   * проверяла ничего. Серия обрывов делает попадание неизбежным и заодно
   * повторяет то, что делает гибернация: рвёт всё и надолго.
   */
  let terminated = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { rowCount } = await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database],
    );
    terminated += rowCount ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  check('соединения оборваны', terminated > 0, `оборвано за серию: ${terminated}`);

  // Дать фоновым проходам отработать уже после серии.
  await new Promise((resolve) => setTimeout(resolve, 5_000));

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

  // И ещё серия, чтобы поймать случай «первый запрос поднял соединение и умер».
  let second = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { rowCount } = await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database],
    );
    second += rowCount ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const third = await health();
  check('повторный обрыв тоже пережит', third === 200, `оборвано ${second}, HTTP ${third}`);
  // ---------------------------------------------------- устройство фоновых задач
  //
  // С блока 1 фоновые проходы запускает только общая оболочка
  // (`background/background-jobs.service.ts`): она перехватывает отказ прохода
  // и записывает его в состояние задачи — это проверено юнит-тестом
  // `apps/core/tests/background.test.ts`. Здесь детерминированно ловится
  // возврат дефекта: служба снова завела собственный таймер мимо оболочки.
  const serviceFiles = [
    'apps/core/src/events/publisher.service.ts',
    'apps/core/src/events/webhook-delivery.service.ts',
    'apps/core/src/maintenance/partitions.service.ts',
    'apps/core/src/maintenance/storage-janitor.service.ts',
  ];
  const ownTimers = serviceFiles.filter((file) =>
    /\bset(Interval|Timeout)\(/.test(readFileSync(join(ROOT, file), 'utf8')),
  );
  check(
    'фоновые службы не заводят таймеров мимо общей оболочки',
    ownTimers.length === 0,
    ownTimers.length === 0 ? `${serviceFiles.length} службы` : ownTimers.join(' | '),
  );
} catch (error) {
  check('прогон выполнен', false, error instanceof Error ? error.message : String(error));
} finally {
  await client.end();
}

console.warn(`\nпройдено: ${passed}, дефектов: ${defects.length}\n`);
process.exit(defects.length === 0 ? 0 : 1);
