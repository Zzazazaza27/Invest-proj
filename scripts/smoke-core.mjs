#!/usr/bin/env node
/**
 * Дымовая проверка живого core.
 *
 * Проверяется ФАКТИЧЕСКОЕ поведение периметра и сквозной сценарий регистрации,
 * а не наличие кода. Это доказательство фазы: без вывода этого скрипта
 * «работает» говорить нельзя (RULES.md §2).
 *
 * Запуск: node scripts/smoke-core.mjs [--api http://127.0.0.1:4300]
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL, PORTS } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const apiIndex = process.argv.indexOf('--api');
const BASE = apiIndex >= 0 ? process.argv[apiIndex + 1] : CORE_URL;

/**
 * Значение из `.env`: прогон не поднимает приложение и своей конфигурации не
 * имеет, поэтому спрашивать её надо там же, откуда её берёт сервер. Умолчание
 * в коде прогона означало бы проверку выдуманного порога, а не настроенного.
 */
function readEnvValue(key) {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return null;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0 && trimmed.slice(0, eq).trim() === key) return trimmed.slice(eq + 1).trim();
  }
  return null;
}

// Имена cookie берутся из окружения: в dev они без префикса __Host-,
// иначе браузер отбросил бы их при работе по http.
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

async function req(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* тело не JSON — так тоже бывает */
  }
  return { response, json, text };
}

console.warn('\n=== ДЫМОВАЯ ПРОВЕРКА CORE ===\n');

// ------------------------------------------------------------------ health
{
  const { response, json } = await req('/v1/health');
  check('health отвечает 200', response.status === 200);
  check('сигнатура сервиса присутствует', json?.service === 'unicorn-launch-core');
  check('база данных доступна', json?.checks?.database === 'ok');

  const required = {
    'content-security-policy': /default-src 'none'/,
    'x-content-type-options': /nosniff/,
    'referrer-policy': /no-referrer/,
    'x-frame-options': /DENY/i,
    'cross-origin-opener-policy': /same-origin/,
    'cache-control': /no-store/,
  };
  for (const [header, re] of Object.entries(required)) {
    const value = response.headers.get(header);
    check(`заголовок ${header}`, Boolean(value) && re.test(value), value ?? 'отсутствует');
  }
  check('стек не раскрывается', !response.headers.get('x-powered-by'));
}

// ----------------------------------------------------------------- pricing
{
  const { response, json } = await req('/v1/pricing');
  check('тарифы доступны без авторизации', response.status === 200);
  check('шесть тарифов', json?.plans?.length === 6, `получено ${json?.plans?.length}`);
  check(
    'вознаграждение 10%/5%',
    json?.feeSchedule?.investorFeePct === '10.00' && json?.feeSchedule?.issuerFeePct === '5.00',
  );
  check(
    'раскрыто: база — полная сумма договора',
    json?.feeDisclosure?.baseIsFullContractAmount === true,
  );
  check('раскрыто: начисление однократное', json?.feeDisclosure?.accrualIsOneTime === true);
}

// ------------------------------------------------------- deny by default
{
  const { response, json } = await req('/v1/auth/me');
  check(
    'защищённый маршрут без токена → 401',
    response.status === 401,
    `получено ${response.status}`,
  );
  check('ошибка в формате problem+json', json?.code === 'unauthenticated');
  check('ответ несёт traceId', typeof json?.traceId === 'string');
}

// -------------------------------------------- деньги закрыты по умолчанию
{
  // Маршрут появился в Ф52: прежде клиент звал его и получал 404, то есть
  // «оплата не удалась» вместо «сервер о такой операции не знает».
  const { response, json } = await req('/v1/billing/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  check('оплата счёта закрыта без токена', response.status === 401, `получено ${response.status}`);
  check('отказ оплаты в формате problem+json', json?.code === 'unauthenticated');
}

// ------------------------------------------------------------------- CORS
{
  const { response } = await req('/v1/health', { headers: { Origin: 'https://evil.example' } });
  const allow = response.headers.get('access-control-allow-origin');
  check(
    'чужой Origin не получает разрешения CORS',
    allow === null,
    allow ?? 'заголовок отсутствует',
  );
}
{
  const allowed = `http://localhost:${PORTS.webPublic}`;
  const { response } = await req('/v1/health', { headers: { Origin: allowed } });
  check(
    'разрешённый Origin получает разрешение',
    response.headers.get('access-control-allow-origin') === allowed,
  );
}

// ------------------------------------------- регистрация и акцепт условий
const suffix = Math.floor(Date.now() % 1e9);
const email = `smoke-${suffix}@test.local`;
// Пароль генерируется на каждый прогон: фиксированный литерал в репозитории
// и выглядит как утёкший секрет, и делает прогон предсказуемым.
const password = `Pw-${crypto.randomUUID()}`;
const consentBase = { version: 'v1', locale: 'ru-RU' };

{
  // Без акцепта условий вознаграждения регистрация не проходит.
  const { response, json } = await req('/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `nope-${suffix}@test.local`,
      password,
      displayName: 'Без акцепта',
      role: 'founder',
      locale: 'ru-RU',
      consents: [
        { kind: 'platform_rules', ...consentBase },
        { kind: 'tos', ...consentBase },
        { kind: 'pdn', ...consentBase },
      ],
    }),
  });
  check(
    'регистрация без акцепта тарифов отвергнута',
    response.status === 400 && json?.code === 'validation_failed',
    `статус ${response.status}`,
  );
}

let sessionCookie;
let csrfCookie;
{
  const { response, json } = await req('/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      displayName: 'Дымовой основатель',
      role: 'founder',
      locale: 'ru-RU',
      consents: [
        { kind: 'platform_rules', ...consentBase },
        { kind: 'tos', ...consentBase },
        { kind: 'pdn', ...consentBase },
        { kind: 'commission_terms', ...consentBase },
      ],
    }),
  });
  check(
    'регистрация с полным набором акцептов прошла',
    response.status === 201 || response.status === 200,
    `статус ${response.status}`,
  );
  check('аккаунт активирован', json?.status === 'active', json?.status ?? 'нет статуса');
  check('ре-акцепт не требуется', json?.reacceptRequired === false);
  check('CSRF-токен выдан', typeof json?.csrfToken === 'string' && json.csrfToken.length >= 32);

  const cookies = response.headers.getSetCookie?.() ?? [];
  const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? null;
  const csrf = cookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`)) ?? null;
  check('сессия выдана в cookie', Boolean(session));
  check('сессионная cookie httpOnly', Boolean(session && /HttpOnly/i.test(session)));
  check('сессионная cookie SameSite=Strict', Boolean(session && /SameSite=Strict/i.test(session)));
  check('CSRF-cookie доступна скрипту (double-submit)', Boolean(csrf && !/HttpOnly/i.test(csrf)));
  // Значение сессионной cookie не должно встречаться в теле ответа: токен
  // живёт только в httpOnly-cookie и до JavaScript не доходит.
  const sessionValue = session?.split(';')[0]?.split('=').slice(1).join('=') ?? '';
  check(
    'токен НЕ возвращается в теле ответа',
    sessionValue.length > 0 && !JSON.stringify(json ?? {}).includes(sessionValue),
  );

  sessionCookie = session?.split(';')[0] ?? null;
  csrfCookie = csrf?.split(';')[0] ?? null;
}

// ------------------------------------------------------ сессия и CSRF
{
  const { response, json } = await req('/v1/auth/me', {
    headers: { Cookie: sessionCookie ?? '' },
  });
  check('профиль доступен по сессии', response.status === 200, `статус ${response.status}`);
  check(
    'email маскируется',
    typeof json?.emailMasked === 'string' && json.emailMasked.includes('*'),
  );
  check(
    'пароль наружу не отдаётся',
    !JSON.stringify(json ?? {})
      .toLowerCase()
      .includes('password'),
  );
}
{
  // Небезопасный метод без CSRF-заголовка должен быть отвергнут.
  const { response, json } = await req('/v1/auth/consents', {
    method: 'POST',
    headers: { Cookie: `${sessionCookie}; ${csrfCookie}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ consents: [{ kind: 'marketing_communications', ...consentBase }] }),
  });
  check('POST без X-CSRF-Token отвергнут', response.status === 403, `статус ${response.status}`);
  check('код ошибки forbidden', json?.code === 'forbidden');
}
{
  const csrfValue = csrfCookie?.split('=')[1] ?? '';
  const { response } = await req('/v1/auth/consents', {
    method: 'POST',
    headers: {
      Cookie: `${sessionCookie}; ${csrfCookie}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfValue,
    },
    body: JSON.stringify({ consents: [{ kind: 'marketing_communications', ...consentBase }] }),
  });
  check(
    'POST с корректным CSRF-токеном принят',
    response.status === 200 || response.status === 201,
    `статус ${response.status}`,
  );
}
{
  const { response } = await req('/v1/auth/consents', {
    method: 'POST',
    headers: {
      Cookie: `${sessionCookie}; ${csrfCookie}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'forged-token-value-0123456789',
    },
    body: JSON.stringify({ consents: [{ kind: 'marketing_communications', ...consentBase }] }),
  });
  check('подделанный CSRF-токен отвергнут', response.status === 403, `статус ${response.status}`);
}

// ------------------------------------------------------------- вход
{
  const { response, json } = await req('/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  check(
    'вход с верным паролем',
    response.status === 200 || response.status === 201,
    `статус ${response.status}`,
  );
  check('роли возвращены', Array.isArray(json?.roles) && json.roles.includes('founder'));
}
{
  const { response, json } = await req('/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'неверный-пароль-совсем' }),
  });
  check('вход с неверным паролем отвергнут', response.status === 401);
  check(
    'ответ не раскрывает существование аккаунта',
    json?.detail === 'Требуется вход',
    json?.detail ?? '',
  );
}
{
  const { json } = await req('/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `missing-${suffix}@test.local`, password }),
  });
  check(
    'несуществующий аккаунт даёт тот же ответ, что и неверный пароль',
    json?.code === 'unauthenticated',
  );
}

// ------------------------------------------------------- размер и формат
{
  const { response } = await req('/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'x'.repeat(2 * 1024 * 1024),
  });
  check(
    'тело больше 1 МБ отвергнуто',
    response.status === 413 || response.status === 400,
    `статус ${response.status}`,
  );
}

// ------------------------------------------- гонка регистрации одного адреса
// Проверка занятости контакта и вставка — разные моменты времени. Гонку
// закрывает UNIQUE-индекс, но до исправления наружу уходила «внутренняя
// ошибка»: пользователь, дважды нажавший «Зарегистрироваться», получал 500.
// Найдено случайно — четырьмя одновременными прогонами кабинета, стартовавшими
// в одну миллисекунду. Здесь оно становится постоянной проверкой.
{
  const raceEmail = `race-${Date.now() % 1e9}@test.local`;
  const raceBody = JSON.stringify({
    email: raceEmail,
    password: `Pw-${crypto.randomUUID()}`,
    displayName: 'Гонка регистрации',
    role: 'founder',
    locale: 'ru-RU',
    consents: ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
      kind,
      version: 'v1',
      locale: 'ru-RU',
    })),
  });
  const attempts = await Promise.all(
    Array.from({ length: 5 }, () =>
      req('/v1/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: raceBody,
      }),
    ),
  );
  const statuses = attempts.map((a) => a.response.status);
  check(
    'гонка регистрации не даёт внутренней ошибки',
    statuses.every((s) => s < 500),
    `статусы: ${[...new Set(statuses)].join(',')}`,
  );
  check(
    'из одновременных регистраций проходит ровно одна',
    statuses.filter((s) => s === 201).length === 1,
    `создано: ${statuses.filter((s) => s === 201).length}`,
  );
}

// --------------------------------------------------- ограничение частоты
{
  const results = [];
  // Лимит класса auth берётся из конфигурации; проверяем факт срабатывания,
  // а не конкретное число.
  // Лимит читается из .env, а не из умолчания: значение для разработки поднято
  // (ведро класса auth считается по адресу, и прогоны делят одно ведро). Число
  // «30» здесь означало бы ожидание отказа там, где сервер его не даёт, —
  // проверка краснела бы при исправной защите.
  const authLimit = Number(readEnvValue('RATE_LIMIT_AUTH_PER_MIN') ?? 30);
  for (let i = 0; i < authLimit + 5; i += 1) {
    const { response } = await req('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'wrong' }),
    });
    results.push(response.status);
  }
  check(
    `класс auth упирается в лимит ${authLimit}/мин`,
    results.includes(429),
    `статусы: ${[...new Set(results)].join(',')}`,
  );
}

console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено.\n`);
if (failed > 0) process.exitCode = 1;
