#!/usr/bin/env node
/**
 * Проверка ОБЩЕГО счётчика ограничения частоты (SEC-11).
 *
 * Находка: счётчики жили в памяти процесса. Это не ограничение частоты, а его
 * видимость — два экземпляра ядра считают свои запросы независимо, поэтому
 * фактически разрешённая частота умножается на их число, а перезапуск обнуляет
 * счётчики целиком.
 *
 * Прогон поднимает ВТОРОЙ экземпляр ядра на соседнем порту и проверяет фактом:
 *   1. запрос к экземпляру A и запрос к экземпляру B увеличивают ОДНО ведро;
 *   2. лимит, исчерпанный на A, действует на B — то есть частота общая, а не
 *      удвоенная;
 *   3. перезапуск экземпляра не обнуляет счётчик.
 *
 * Запуск: node scripts/probe-shared-rate-limit.mjs (нужен поднятый core и Valkey)
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Redis from 'ioredis';

import { CORE_URL } from './lib/ports.mjs';

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

const PRIMARY = process.env.CORE_URL ?? CORE_URL;
const SECOND_PORT = Number(process.env.CORE_SECOND_PORT ?? 4301);
const SECOND = `http://127.0.0.1:${SECOND_PORT}`;
const AUTH_LIMIT = Number(ENV.RATE_LIMIT_AUTH_PER_MIN ?? 30);

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

if (!ENV.REDIS_URL) {
  console.error('REDIS_URL не задан: проверять общий счётчик нечем.');
  process.exit(1);
}

const redis = new Redis(ENV.REDIS_URL, {
  password: ENV.REDIS_PASSWORD || undefined,
  commandTimeout: 2000,
});

/** Поднять второй экземпляр ядра на своём порту. */
function startSecondInstance() {
  const entry = join(ROOT, 'apps', 'core', 'dist', 'main.js');
  if (!existsSync(entry)) {
    console.error('Сначала собери ядро: npm run build -w apps/core');
    process.exit(1);
  }
  const child = spawn(process.execPath, [entry], {
    env: { ...ENV, CORE_PORT: String(SECOND_PORT) },
    stdio: 'ignore',
    windowsHide: true,
  });
  // Смерть поднятого экземпляра обязана быть заметной: иначе прогон дождётся
  // здоровья порта от ЧУЖОГО процесса и объявит проверку пройденной, ничего не
  // проверив.
  child.on('error', (error) => {
    console.error(`ВТОРОЙ ЭКЗЕМПЛЯР НЕ ЗАПУСТИЛСЯ: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (!child.killedByProbe) {
      console.error(
        `ВТОРОЙ ЭКЗЕМПЛЯР ЗАВЕРШИЛСЯ САМ: code=${code ?? '—'} signal=${signal ?? '—'} ` +
          `(порт ${SECOND_PORT} мог быть занят другим процессом)`,
      );
      process.exit(1);
    }
  });
  return child;
}

async function waitHealthy(base, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* ещё не поднялся */
    }
  }
  return false;
}

/** Значение ведра класса auth. Ключ — префикс общего модуля `rl:` + ключ запроса плагина. */
async function bucketValue() {
  const keys = await redis.keys('rl:*');
  if (keys.length === 0) return { key: null, value: 0 };
  // Ведро класса auth считается по адресу: ключ без подсказки сессии.
  const key = keys.find((k) => k.endsWith('127.0.0.1')) ?? keys[0];
  const value = Number(await redis.get(key));
  return { key, value: Number.isFinite(value) ? value : 0 };
}

console.warn('\n=== ПРОВЕРКА ОБЩЕГО СЧЁТЧИКА ОГРАНИЧЕНИЯ ЧАСТОТЫ ===\n');

check('первый экземпляр отвечает', await waitHealthy(PRIMARY, 5_000));

let second = startSecondInstance();
check('второй экземпляр поднялся', await waitHealthy(SECOND), SECOND);

// Ведро класса auth считается по адресу — обнуляем его перед замером, чтобы
// прогон не зависел от того, что происходило до него.
await redis.del(...(await redis.keys('rl:*')).concat(['__probe_noop__']));

async function hitAuth(base) {
  return fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody-probe@test.local', password: 'wrong-password-000' }),
    signal: AbortSignal.timeout(15_000),
  });
}

// ---- 1. Одно ведро на два экземпляра ------------------------------------
await hitAuth(PRIMARY);
const afterFirst = await bucketValue();
await hitAuth(SECOND);
const afterSecond = await bucketValue();

check('ведро создано в общем счётчике', afterFirst.key !== null, afterFirst.key ?? '—');
check(
  'запросы к разным экземплярам считаются в ОДНО ведро',
  afterSecond.value === afterFirst.value + 1,
  `${afterFirst.value} → ${afterSecond.value}`,
);

// ---- 2. Лимит, исчерпанный на A, действует на B --------------------------
// Добираем ведро до предела запросами к ПЕРВОМУ экземпляру.
let lastPrimary = 0;
for (let i = afterSecond.value; i < AUTH_LIMIT + 1; i += 1) {
  const r = await hitAuth(PRIMARY);
  lastPrimary = r.status;
  if (r.status === 429) break;
}
check('на первом экземпляре лимит сработал', lastPrimary === 429, `HTTP ${lastPrimary}`);

const crossed = await hitAuth(SECOND);
check(
  'ВТОРОЙ экземпляр тоже отвечает 429 (частота общая, а не удвоенная)',
  crossed.status === 429,
  `HTTP ${crossed.status}`,
);

// ---- 3. Перезапуск не обнуляет счётчик -----------------------------------
const beforeRestart = await bucketValue();
second.killedByProbe = true;
second.kill();
await new Promise((resolve) => setTimeout(resolve, 1500));
second = startSecondInstance();
check('второй экземпляр перезапущен', await waitHealthy(SECOND));

const afterRestart = await bucketValue();
check(
  'перезапуск не обнулил счётчик',
  afterRestart.value >= beforeRestart.value,
  `${beforeRestart.value} → ${afterRestart.value}`,
);
const afterRestartCall = await hitAuth(SECOND);
check(
  'после перезапуска лимит по-прежнему действует',
  afterRestartCall.status === 429,
  `HTTP ${afterRestartCall.status}`,
);

second.killedByProbe = true;
second.kill();
await redis.quit();
console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exitCode = failed > 0 ? 1 : 0;
