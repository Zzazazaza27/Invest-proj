#!/usr/bin/env node
/**
 * Проверка: обходится ли ограничение частоты подделкой cookie сессии.
 *
 * Ведро лимита строится как «адрес + идентификатор сессии», причём
 * идентификатор берётся из cookie ДО проверки подписи. Вопрос, на который
 * отвечает прогон: даёт ли произвольный `sub` в подделанной cookie НОВОЕ ведро.
 * Если даёт — лимит на подбор пароля обходится полностью.
 *
 * Прогон безопасен: он бьётся в несуществующую учётную запись заведомо
 * неверным паролем и ничего не меняет.
 *
 * ВНИМАНИЕ: прогон намеренно исчерпывает окно лимита класса auth. Следующий
 * прогон, который заводит учётные записи, упрётся в 429 — это не его дефект.
 * Между ними нужна пауза в минуту (так и сделано в глобальном аудите).
 *
 * Запуск: node scripts/probe-rate-limit.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) process.env[trimmed.slice(0, eq).trim()] ??= trimmed.slice(eq + 1).trim();
  }
}

const BASE = process.env.CORE_URL ?? 'http://127.0.0.1:4300';
// Число попыток берётся из фактического лимита, а не из числа «45»: при
// поднятом для разработки лимите фиксированные 45 попыток не дошли бы до
// границы, и проверка зеленела бы, ничего не проверив.
const LIMIT = Number(process.env.RATE_LIMIT_AUTH_PER_MIN ?? 30);
const ATTEMPTS = Number(process.env.ATTEMPTS ?? LIMIT + 15);

async function attempt(cookie) {
  const response = await fetch(`${BASE}/v1/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({
      email: `probe-${Date.now()}@test.local`,
      password: 'заведомо-неверный-пароль',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  return response.status;
}

/** Подделанная cookie сессии: правдоподобная форма, произвольный sub. */
function forged(index) {
  const payload = Buffer.from(JSON.stringify({ sub: `forged-${index}` }), 'utf8').toString(
    'base64url',
  );
  return `ul_session=${payload}.${'a'.repeat(43)}`;
}

console.warn('\n=== ПРОВЕРКА ОБХОДА ЛИМИТА ЧАСТОТЫ ===\n');

let limited = 0;
let statuses = [];
for (let i = 0; i < ATTEMPTS; i += 1) {
  const status = await attempt(forged(i));
  statuses.push(status);
  if (status === 429) limited += 1;
}
console.warn(`С РАЗНЫМИ поддельными cookie: попыток ${ATTEMPTS}, отказов 429 — ${limited}`);

// Контроль: те же запросы без cookie обязаны упереться в лимит.
let limitedPlain = 0;
for (let i = 0; i < ATTEMPTS; i += 1) {
  const status = await attempt(null);
  if (status === 429) limitedPlain += 1;
}
console.warn(`БЕЗ cookie:                  попыток ${ATTEMPTS}, отказов 429 — ${limitedPlain}`);

const bypassed = limited === 0 && limitedPlain > 0;
console.warn(
  `\nВЫВОД: ${
    bypassed
      ? 'лимит ОБХОДИТСЯ подделкой cookie — уязвимость подтверждена'
      : limited > 0
        ? 'лимит срабатывает и при подделке cookie'
        : 'лимит не сработал ни в одном режиме — проверка не даёт вывода'
  }\n`,
);
process.exitCode = bypassed ? 1 : 0;
