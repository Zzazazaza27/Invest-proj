#!/usr/bin/env node
/**
 * Проверка привязки CSRF-токена к сессии.
 *
 * Находка внешнего аудита (SEC-12): проверка сравнивала значение из cookie со
 * значением из заголовка и больше ничего. Обе части подконтрольны тому, кто
 * смог поставить жертве свою cookie — например, с перехваченного поддомена, —
 * поэтому согласованная пара «своя cookie + свой заголовок» проходила.
 *
 * Здесь это воспроизводится: берётся ДЕЙСТВУЮЩАЯ сессия одного пользователя и
 * подставляется CSRF-токен, изготовленный для другого. Ожидание: отказ.
 *
 * Запуск: node scripts/probe-csrf-binding.mjs
 */
import { createHmac, randomUUID } from 'node:crypto';
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

const BASE = process.env.CORE_URL ?? 'http://127.0.0.1:4300';
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'ul_csrf';

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

const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

/** Регистрация с сохранением cookie: нужны и сессия, и CSRF-токен. */
async function register(tag) {
  const email = `csrf-${tag}-${Date.now() % 1e9}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const response = await fetch(`${BASE}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      displayName: `CSRF ${tag}`,
      role: 'founder',
      locale: 'ru-RU',
      consents: CONSENTS,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`регистрация ${tag}: HTTP ${response.status}`);
  const cookies = response.headers.getSetCookie?.() ?? [];
  const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0];
  const csrf = cookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`))?.split(';')[0];
  return { session, csrf, csrfValue: csrf?.split('=').slice(1).join('=') };
}

console.warn('\n=== ПРОВЕРКА ПРИВЯЗКИ CSRF К СЕССИИ ===\n');

// Настоящее направление из справочника: с выдуманным идентификатором запрос
// падал бы по другой причине, и «своя пара проходит» ничего бы не значило.
const taxonomy = await fetch(`${BASE}/v1/taxonomy`, { signal: AbortSignal.timeout(10_000) })
  .then((response) => response.json())
  .then((body) => body.items?.[0]?.id ?? null);

const alice = await register('a');
const mallory = await register('m');
check('две сессии получены', Boolean(alice.session && mallory.session));

/** Небезопасный запрос: он и требует CSRF-проверки. */
async function post(sessionCookie, csrfCookie, csrfHeader) {
  return fetch(`${BASE}/v1/projects`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: [sessionCookie, csrfCookie].filter(Boolean).join('; '),
      'X-CSRF-Token': csrfHeader,
    },
    body: JSON.stringify({
      title: 'Проверка CSRF',
      stage: 'mvp',
      taxonomyId: taxonomy,
      investmentAsk: '1000000.00',
      askCurrency: 'RUB',
    }),
    signal: AbortSignal.timeout(15_000),
  });
}

// Своя пара cookie+заголовок обязана проходить проверку CSRF: отказ может быть
// только по другим причинам (например, несуществующее направление).
{
  const response = await post(alice.session, alice.csrf, alice.csrfValue);
  check(
    'своя пара cookie+заголовок проходит проверку CSRF',
    response.status !== 403,
    `HTTP ${response.status}`,
  );
}

// Согласованная ЧУЖАЯ пара — ровно тот сценарий, который проходил раньше.
{
  const response = await post(alice.session, mallory.csrf, mallory.csrfValue);
  check(
    'подставленный чужой CSRF-токен отвергнут',
    response.status === 403,
    `HTTP ${response.status}`,
  );
}

// Самодельный токен произвольной формы — тоже отказ.
{
  const forged = `${'a'.repeat(22)}.${'b'.repeat(43)}`;
  const response = await post(alice.session, `${CSRF_COOKIE}=${forged}`, forged);
  check('самодельный токен отвергнут', response.status === 403, `HTTP ${response.status}`);
}

// Контроль: подпись зависит от владельца, а не от совпадения строк.
{
  const signature = createHmac('sha256', process.env.CSRF_SIGNING_KEY ?? '')
    .update('unicorn-csrf.v1.не-тот-пользователь.nonce')
    .digest('base64url');
  const token = `nonce.${signature}`;
  const response = await post(alice.session, `${CSRF_COOKIE}=${token}`, token);
  check(
    'подпись под чужого владельца не подходит',
    response.status === 403,
    `HTTP ${response.status}`,
  );
}

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exitCode = failed > 0 ? 1 : 0;
