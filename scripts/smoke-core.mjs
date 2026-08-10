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
const apiIndex = process.argv.indexOf('--api');
const BASE = apiIndex >= 0 ? process.argv[apiIndex + 1] : 'http://127.0.0.1:4300';

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
  const allowed = 'http://localhost:5173';
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
  const session = cookies.find((c) => c.startsWith('__Host-ul_session=')) ?? null;
  const csrf = cookies.find((c) => c.startsWith('__Host-ul_csrf=')) ?? null;
  check('сессия выдана в cookie', Boolean(session));
  check('сессионная cookie httpOnly', Boolean(session && /HttpOnly/i.test(session)));
  check('сессионная cookie SameSite=Strict', Boolean(session && /SameSite=Strict/i.test(session)));
  check('CSRF-cookie доступна скрипту (double-submit)', Boolean(csrf && !/HttpOnly/i.test(csrf)));
  check('токен НЕ возвращается в теле ответа', !JSON.stringify(json ?? {}).includes('__Host'));

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

// --------------------------------------------------- ограничение частоты
{
  const results = [];
  // Лимит класса auth берётся из конфигурации; проверяем факт срабатывания,
  // а не конкретное число.
  const authLimit = Number(process.env.RATE_LIMIT_AUTH_PER_MIN ?? 30);
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
