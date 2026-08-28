#!/usr/bin/env node
/**
 * Проверка входа под всеми учётными записями стенда.
 *
 * Зачем: «пароль у всех один» — утверждение, которое проверяется только
 * попыткой входа. Сиды заводят учётки тремя разными скриптами
 * (`dev-seed-test-user`, `dev-stand`, `seed-demo`), и ротация пароля в `.env`
 * не переписывает хеши тех, чей скрипт не перезапускали: ровно так учётки
 * `stand-*` разошлись с `.env` и отвечали 401 при верном пароле.
 *
 * ПАРОЛЬ НЕ ПЕРЕДАЁТСЯ АРГУМЕНТОМ и не печатается: берётся из
 * `DEV_TEST_USER_PASSWORD` в `.env` стенда. Аргументы видны в списке процессов
 * любому пользователю машины.
 *
 * Лимит частоты. У маршрута входа свой класс ограничения, и 80 попыток подряд
 * упрутся в 429. Скрипт идёт последовательно, а на 429 ждёт и повторяет —
 * обходить ограничение сбросом ведра нельзя: оно защищает форму входа от
 * перебора и на стенде работает ровно так же, как в бою.
 *
 * Запуск (на стенде):
 *   node scripts/check-stand-logins.mjs
 *   node scripts/check-stand-logins.mjs --only stand      только stand-*
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const argv = process.argv.slice(2);
const only = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 ? argv[i + 1] : null;
})();

const PASSWORD = process.env.DEV_TEST_USER_PASSWORD ?? '';
if (!PASSWORD) {
  console.error('Не задан DEV_TEST_USER_PASSWORD в .env — проверять нечем.');
  process.exit(2);
}

function loadDotEnv() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Один вход. Возвращает код ответа; на 429 ждёт и повторяет до трёх раз. */
async function tryLogin(email) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(`${CORE_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    if (res.status !== 429) return res.status;
    // Retry-After в секундах, если сервер его прислал.
    const wait = Number(res.headers.get('retry-after') ?? 0) * 1000 || 5000;
    await sleep(wait);
  }
  return 429;
}

function catalogLogins() {
  const file = join(ROOT, 'fixtures/catalog/people.json');
  if (!existsSync(file)) return [];
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      if (typeof node.login === 'string') found.push(node.login);
      Object.values(node).forEach(walk);
    }
  };
  walk(JSON.parse(readFileSync(file, 'utf8')));
  return [...new Set(found)];
}

const STAND = [
  'ssurgut',
  'stand-admin',
  'stand-founder',
  'stand-investor',
  'stand-expert',
  'stand-organizer',
];

let logins = only === 'stand' ? STAND : [...STAND, ...catalogLogins()];
logins = [...new Set(logins)];

console.log(`\n=== ВХОД НА СТЕНД: ${logins.length} учётных записей ===`);
console.log(`   адрес ядра: ${CORE_URL}\n`);

const ok = [];
const failed = [];
for (const login of logins) {
  const email = login.includes('@') ? login : `${login}@unicorn.local`;
  const status = await tryLogin(email);
  if (status === 201 || status === 200) {
    ok.push(login);
  } else {
    failed.push({ login, status });
    console.log(`  ОТКАЗ  ${login.padEnd(18)} HTTP ${status}`);
  }
  // Пауза между попытками: маршрут входа намеренно ограничен по частоте.
  await sleep(300);
}

console.log(`\n=== ИТОГ ===`);
console.log(`  вошли:    ${ok.length}/${logins.length}`);
console.log(`  отказано: ${failed.length}`);
if (failed.length > 0) {
  const byStatus = failed.reduce((acc, f) => {
    acc[f.status] = (acc[f.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`  коды:     ${JSON.stringify(byStatus)}`);
  console.log(`  список:   ${failed.map((f) => f.login).join(', ')}`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
