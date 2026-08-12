#!/usr/bin/env node
/**
 * Проверка того, что потолок частоты по адресу не может «залипнуть» навсегда.
 *
 * Находка внешнего аудита SEC-11. Счёт делался двумя обращениями — `INCR`, затем
 * `EXPIRE`. Между ними есть окно: обрыв соединения или перезапуск процесса
 * после первого и до второго оставляют ключ БЕЗ СРОКА. Такой ключ не истекает
 * никогда, счётчик растёт бесконечно, и живой пользователь получает 429
 * бессрочно — промах в служебном коде превращается в вечную блокировку.
 *
 * Прогон проверяет фактом:
 *   1. первый же счёт ставит срок (ключ не остаётся вечным);
 *   2. срок НЕ продлевается следующими запросами — иначе окно не кончается,
 *      пока клиент не замолчит;
 *   3. ключ, уже осиротевший БЕЗ срока (ровно то состояние, которое создавала
 *      прежняя схема), получает срок при следующем запросе и перестаёт быть
 *      вечным;
 *   4. счёт и установка срока происходят одной атомарной операцией: при сотне
 *      одновременных запросов ни один не оставляет ключ без срока.
 *
 * Запуск: node scripts/probe-ip-ceiling-ttl.mjs (нужен поднятый Redis)
 */
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

// Тот же скрипт, что выполняет приложение. Он читается из исходника, а не
// копируется сюда: копия рано или поздно разойдётся с оригиналом, и прогон
// начнёт проверять текст, которого в приложении уже нет.
const source = readFileSync(join(ROOT, 'apps/core/src/cache/ip-ceiling.ts'), 'utf8');
const match = source.match(/const CEILING_SCRIPT = `([\s\S]*?)`;/);
if (!match) {
  console.error('ПРОГОН НЕВОЗМОЖЕН: в ip-ceiling.ts не найден CEILING_SCRIPT');
  process.exit(1);
}
const SCRIPT = match[1];

const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 1,
});

const WINDOW = 60;
const key = `probe-ip-ceiling:${randomUUID()}`;
const bump = () => redis.eval(SCRIPT, 1, key, String(WINDOW));

console.warn('\n=== ПРОВЕРКА: ПОТОЛОК ЧАСТОТЫ ПО АДРЕСУ НЕ ЗАЛИПАЕТ ===\n');

// 1. Первый счёт ставит срок.
const [firstUsed, firstTtl] = await bump();
check('первый запрос считается', Number(firstUsed) === 1, `счёт ${firstUsed}`);
const ttlAfterFirst = await redis.ttl(key);
check(
  'после первого же запроса у ключа есть срок',
  ttlAfterFirst > 0 && ttlAfterFirst <= WINDOW,
  `TTL ${ttlAfterFirst}, скрипт вернул ${firstTtl}`,
);

// 2. Срок не продлевается следующими запросами.
await new Promise((resolve) => setTimeout(resolve, 1200));
await bump();
const ttlAfterSecond = await redis.ttl(key);
check(
  'следующий запрос НЕ продлевает окно',
  ttlAfterSecond < ttlAfterFirst,
  `было ${ttlAfterFirst}, стало ${ttlAfterSecond}`,
);

// 3. Осиротевший ключ без срока лечится. Именно это состояние и оставляла
//    прежняя схема при обрыве между INCR и EXPIRE — воспроизводим его точно.
await redis.persist(key);
check('ключ доведён до состояния «без срока»', (await redis.ttl(key)) === -1);
const [, healedTtl] = await bump();
const ttlAfterHeal = await redis.ttl(key);
check(
  'запрос по ключу без срока возвращает ему срок',
  ttlAfterHeal > 0,
  `TTL ${ttlAfterHeal}, скрипт вернул ${healedTtl}`,
);

// 4. Сотня одновременных запросов не оставляет ключ без срока.
const stormKey = `probe-ip-ceiling:${randomUUID()}`;
const storm = await Promise.all(
  Array.from({ length: 100 }, () => redis.eval(SCRIPT, 1, stormKey, String(WINDOW))),
);
const counts = storm.map(([used]) => Number(used)).sort((a, b) => a - b);
const stormTtl = await redis.ttl(stormKey);
check(
  'при ста одновременных запросах счёт не теряется',
  counts[0] === 1 && counts[99] === 100 && new Set(counts).size === 100,
  `минимум ${counts[0]}, максимум ${counts[99]}, различных ${new Set(counts).size}`,
);
check('после шторма у ключа есть срок', stormTtl > 0, `TTL ${stormTtl}`);
check(
  'ни один одновременный запрос не увидел ключ без срока',
  storm.every(([, ttl]) => Number(ttl) > 0),
  `минимальный возвращённый TTL ${Math.min(...storm.map(([, t]) => Number(t)))}`,
);

await redis.del(key, stormKey);
await redis.quit();

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exitCode = failed > 0 ? 1 : 0;
