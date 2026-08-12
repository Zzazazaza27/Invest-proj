#!/usr/bin/env node
/**
 * Нагрузочный прогон под ПАРАЛЛЕЛЬНОЙ нагрузкой.
 *
 * Что он закрывает: замеры Ф-ТД снимались по одному запросу за раз
 * (`perf-measure.mjs`) и говорили о стоимости запроса, но ничего — о поведении
 * под конкуренцией. Здесь измеряется именно оно: несколько десятков
 * одновременных клиентов на публичных маршрутах каталога.
 *
 * Чего он НЕ заменяет: это прогон на одной машине разработчика, где клиент,
 * сервер и БД делят процессор. Полученные числа — нижняя граница и повод
 * увидеть регрессию, а НЕ подтверждение SLO. Заявлять SLO по этим числам
 * нельзя, и отчёт об этом говорит прямо.
 *
 * Ограничение частоты для прогона поднимается намеренно: измеряется приложение,
 * а не счётчик лимита. Экземпляр для нагрузки поднимается отдельный, на своём
 * порту, и глушится в конце.
 *
 * Запуск: node scripts/load-test.mjs [--concurrency 32] [--seconds 15]
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV = loadDotEnv();

function loadDotEnv() {
  const env = { ...process.env };
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return env;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) env[trimmed.slice(0, eq).trim()] ??= trimmed.slice(eq + 1).trim();
  }
  return env;
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? Number(process.argv[index + 1]) : fallback;
}

const CONCURRENCY = arg('concurrency', 32);
const SECONDS = arg('seconds', 15);
const PORT = arg('port', 4305);
const BASE = `http://127.0.0.1:${PORT}`;

/** Маршруты замера: публичные, только чтение, разной стоимости. */
const TARGETS = [
  { name: 'health', path: '/v1/health' },
  { name: 'каталог (первая страница)', path: '/v1/catalog?limit=20' },
  { name: 'каталог (поиск)', path: '/v1/catalog?limit=20&q=платформа' },
  { name: 'тарифы', path: '/v1/pricing' },
];

function startInstance() {
  const entry = join(ROOT, 'apps', 'core', 'dist', 'main.js');
  if (!existsSync(entry)) {
    console.error('Сначала собери ядро: npm run build -w apps/core');
    process.exit(1);
  }
  return spawn(process.execPath, [entry], {
    env: {
      ...ENV,
      CORE_PORT: String(PORT),
      // Измеряется приложение, а не счётчик лимита частоты.
      RATE_LIMIT_DEFAULT_PER_MIN: '10000000',
      RATE_LIMIT_AUTH_PER_MIN: '10000000',
      RATE_LIMIT_ADMIN_PER_MIN: '10000000',
      RATE_LIMIT_MONEY_PER_MIN: '10000000',
      RATE_LIMIT_IP_CEILING_PER_MIN: '100000000',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
}

async function waitHealthy(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/v1/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* ещё не поднялся */
    }
  }
  return false;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

async function measure(target) {
  const latencies = [];
  let errors = 0;
  let requests = 0;
  const deadline = Date.now() + SECONDS * 1000;

  async function worker() {
    while (Date.now() < deadline) {
      const started = performance.now();
      try {
        const response = await fetch(`${BASE}${target.path}`, {
          signal: AbortSignal.timeout(20_000),
        });
        // Тело обязательно вычитывается: без этого измеряется время до
        // заголовков, а не время ответа, и соединение остаётся занятым.
        await response.arrayBuffer();
        if (!response.ok) errors += 1;
      } catch {
        errors += 1;
      }
      latencies.push(performance.now() - started);
      requests += 1;
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  latencies.sort((a, b) => a - b);
  return {
    name: target.name,
    requests,
    errors,
    rps: Math.round(requests / SECONDS),
    p50: Math.round(percentile(latencies, 50)),
    p95: Math.round(percentile(latencies, 95)),
    p99: Math.round(percentile(latencies, 99)),
    max: Math.round(latencies[latencies.length - 1] ?? 0),
  };
}

console.warn('\n=== НАГРУЗОЧНЫЙ ПРОГОН ===\n');
console.warn(`параллельных клиентов: ${CONCURRENCY}, длительность на маршрут: ${SECONDS} с`);
console.warn('машина разработчика: клиент, сервер и БД делят процессор\n');

const instance = startInstance();
if (!(await waitHealthy())) {
  console.error('Экземпляр для нагрузки не поднялся.');
  instance.kill();
  process.exit(1);
}

const results = [];
for (const target of TARGETS) {
  results.push(await measure(target));
}
instance.kill();

const width = Math.max(...results.map((r) => r.name.length));
console.warn(
  `${'маршрут'.padEnd(width)}  ${'запросов'.padStart(9)} ${'rps'.padStart(6)} ` +
    `${'p50'.padStart(6)} ${'p95'.padStart(6)} ${'p99'.padStart(6)} ${'max'.padStart(6)} ` +
    `${'ошибок'.padStart(7)}`,
);
for (const r of results) {
  console.warn(
    `${r.name.padEnd(width)}  ${String(r.requests).padStart(9)} ${String(r.rps).padStart(6)} ` +
      `${String(r.p50).padStart(6)} ${String(r.p95).padStart(6)} ${String(r.p99).padStart(6)} ` +
      `${String(r.max).padStart(6)} ${String(r.errors).padStart(7)}`,
  );
}

const failed = results.filter((r) => r.errors > 0);
console.warn(
  `\nОшибок всего: ${results.reduce((sum, r) => sum + r.errors, 0)}` +
    (failed.length ? ` (маршруты: ${failed.map((r) => r.name).join(', ')})` : ''),
);
console.warn(
  'Числа получены на одной машине и являются нижней границей. ' +
    'Заявлять по ним SLO нельзя — для этого нужен отдельный стенд.\n',
);
// Прогон измеряет, а не выносит вердикт. Красным он становится только если
// сервис отвечал ошибками: это уже не «медленно», а «не работает».
process.exitCode = results.some((r) => r.errors > 0) ? 1 : 0;
