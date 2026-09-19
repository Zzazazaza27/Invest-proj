#!/usr/bin/env node
/**
 * Живой прогон «пакеты запуска раунда» (этап 5.9.1).
 *
 * Проверяется фактическое поведение запущенного core: каталог услуг, отказ
 * продавать нереализованную услугу, публикация версии пакета, запрет
 * пересечения диапазонов и переписывания действующей версии, снятие с
 * продажи, цены докупки и закрытость контура для чужих ролей.
 *
 * Продажи этим прогоном не включаются: покупок здесь нет, деньги не
 * списываются. Напрямую в БД создаётся только роль администратора — для неё
 * нет API; всё остальное идёт через HTTP.
 *
 * Запуск: node scripts/smoke-round-packages.mjs [--api http://127.0.0.1:4300]
 */
import pg from 'pg';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const apiIndex = process.argv.indexOf('--api');
const BASE = apiIndex >= 0 ? process.argv[apiIndex + 1] : CORE_URL;

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

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'ul_csrf';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL_OWNER,
  max: 4,
  application_name: 'unicorn-smoke-round-packages',
});

async function sql(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows;
}

async function raw(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* не JSON */
  }
  return { response, json, text };
}

function makeClient() {
  const state = { session: null, csrf: null };
  async function call(path, { method = 'GET', body } = {}) {
    const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) {
      headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
    }
    const result = await raw(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of result.response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(';')[0];
      if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
      if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
    }
    return result;
  }
  return { call };
}

const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

const suffix = `${Date.now() % 1e9}`;

async function findUserIdByEmail(email) {
  const index = createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
  const [row] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [index]);
  return row?.id ?? null;
}

async function register(role, tag) {
  const client = makeClient();
  const email = `pkg-${tag}-${suffix}@test.local`;
  const password = `Pw-${crypto.randomUUID()}`;
  const { response, json } = await client.call('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: `Тест ${tag}`,
      role,
      locale: 'ru-RU',
      consents: CONSENTS,
    },
  });
  if (response.status >= 400) {
    throw new Error(`регистрация ${tag}: ${response.status} ${JSON.stringify(json)}`);
  }
  return { client, email, password, userId: await findUserIdByEmail(email) };
}

async function makeAdmin(user) {
  await sql(
    `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
    [user.userId],
  );
  const client = makeClient();
  await client.call('/v1/auth/login', {
    method: 'POST',
    body: { email: user.email, password: user.password },
  });
  return client;
}

console.warn('\n=== ЖИВОЙ ПРОГОН: ПАКЕТЫ ЗАПУСКА РАУНДА ===\n');

const outsider = await register('investor', 'o');
const admin = await makeAdmin(await register('founder', 'a'));

// Коды прогона несут суффикс: сетка — настройка, и прогон не должен
// конфликтовать с уже настроенными пакетами.
const SERVICE_A = `smk_a_${suffix}`;
const SERVICE_B = `smk_b_${suffix}`;
const PACKAGE = `smk_pkg_${suffix}`;

// Предусловие: оборвавшийся прошлый прогон мог оставить действующую версию,
// и тогда сценарий проверял бы не сетку, а конфликт с собственным мусором.
// Версии не удаляются (история цены — факт), поэтому просто закрываются.
await sql(
  `UPDATE billing.round_packages
      SET valid_to = GREATEST(now(), valid_from + interval '1 millisecond')
    WHERE starts_with(code, 'smk_') AND (valid_to IS NULL OR valid_to > now())`,
);

// --------------------------------------------------------- закрытость контура
{
  const { response } = await raw('/v1/admin/round-packages');
  check('контур закрыт без токена', response.status === 401, `статус ${response.status}`);
}
{
  const { response } = await outsider.client.call('/v1/admin/round-services');
  check(
    'инвестор не видит настройку пакетов',
    response.status === 403,
    `статус ${response.status}`,
  );
}
{
  const { response } = await outsider.client.call('/v1/admin/round-packages', {
    method: 'POST',
    body: {
      code: PACKAGE,
      countryCode: 'ru',
      name: 'Чужой',
      price: '1000.00',
      currency: 'RUB',
      minTarget: '0.00',
      reason: 'попытка постороннего',
    },
  });
  check('инвестор не публикует версию', response.status === 403, `статус ${response.status}`);
}

// ------------------------------------------------------------------- услуги
{
  const { response, json } = await admin.call('/v1/admin/round-services', {
    method: 'POST',
    body: { code: SERVICE_A, name: 'Проверка документов (прогон)' },
  });
  check('услуга заводится', response.status < 400, `статус ${response.status}`);
  check('новая услуга не реализована', json?.isImplemented === false, `${json?.isImplemented}`);
}
{
  const { response, json } = await admin.call('/v1/admin/round-services', {
    method: 'POST',
    body: { code: SERVICE_B, name: 'Разбор с экспертом (прогон)' },
  });
  check('вторая услуга заведена', response.status < 400, `статус ${response.status}`);
  check('код совпадает', json?.code === SERVICE_B, `${json?.code}`);
}
{
  const { response } = await admin.call('/v1/admin/round-services', {
    method: 'POST',
    body: { code: SERVICE_A, name: 'Дубль' },
  });
  check(
    'повторный код отклонён как конфликт',
    response.status === 409,
    `статус ${response.status}`,
  );
}

// Нереализованная услуга не продаётся: настройка не создаёт обещание.
{
  const { response, json } = await admin.call('/v1/admin/round-packages', {
    method: 'POST',
    body: {
      code: PACKAGE,
      countryCode: 'ru',
      name: 'Базовый (прогон)',
      price: '15000.00',
      currency: 'RUB',
      minTarget: '0.00',
      maxTarget: '5000000.00',
      serviceCodes: [SERVICE_A],
      reason: 'прогон: нереализованная услуга в составе',
    },
  });
  check(
    'нереализованная услуга не попадает в пакет',
    response.status === 400,
    `статус ${response.status} ${json?.detail ?? ''}`,
  );
}
{
  const { response, json } = await admin.call('/v1/admin/round-service-offers', {
    method: 'POST',
    body: {
      serviceCode: SERVICE_A,
      countryCode: 'ru',
      price: '4000.00',
      currency: 'RUB',
      reason: 'прогон: цена нереализованной услуги',
    },
  });
  check(
    'нереализованную услугу нельзя докупить',
    response.status === 400,
    `статус ${response.status} ${json?.detail ?? ''}`,
  );
}

const services = await admin.call('/v1/admin/round-services');
const serviceA = services.json.items.find((s) => s.code === SERVICE_A);
const serviceB = services.json.items.find((s) => s.code === SERVICE_B);
check('список услуг содержит заведённые', Boolean(serviceA && serviceB));

for (const service of [serviceA, serviceB]) {
  const { response } = await admin.call(`/v1/admin/round-services/${service.id}`, {
    method: 'PATCH',
    body: { isImplemented: true, reason: 'прогон: услуга реализована' },
  });
  check(
    `услуга ${service.code} помечена реализованной`,
    response.status < 400,
    `статус ${response.status}`,
  );
}
{
  const { response } = await admin.call(`/v1/admin/round-services/${serviceA.id}`, {
    method: 'PATCH',
    body: { isImplemented: true },
  });
  check('правка без основания отклонена', response.status === 400, `статус ${response.status}`);
}

// ------------------------------------------------------------------- пакеты
let firstPackage = null;
{
  const { response, json } = await admin.call('/v1/admin/round-packages', {
    method: 'POST',
    body: {
      code: PACKAGE,
      countryCode: 'ru',
      name: 'Базовый (прогон)',
      price: '15000.00',
      currency: 'RUB',
      minTarget: '0.00',
      maxTarget: '5000000.00',
      serviceCodes: [SERVICE_A],
      reason: 'прогон: первая версия сетки',
    },
  });
  check(
    'версия пакета публикуется',
    response.status < 400,
    `статус ${response.status} ${json?.detail ?? ''}`,
  );
  check('версия первая', json?.version === 1, `версия ${json?.version}`);
  check('состав сохранён', json?.services?.length === 1, `услуг ${json?.services?.length}`);
  check('версия действует', json?.isActive === true, `${json?.isActive}`);
  firstPackage = json;
}
{
  const { response, json } = await admin.call('/v1/admin/round-packages', {
    method: 'POST',
    body: {
      code: `${PACKAGE}_x`,
      countryCode: 'ru',
      name: 'Пересекающийся (прогон)',
      price: '20000.00',
      currency: 'RUB',
      minTarget: '1000000.00',
      maxTarget: '9000000.00',
      serviceCodes: [],
      reason: 'прогон: пересечение диапазонов',
    },
  });
  check(
    'диапазоны в стране не пересекаются',
    response.status >= 400,
    `статус ${response.status} ${json?.detail ?? ''}`,
  );
}
{
  const { response, json } = await admin.call('/v1/admin/round-packages', {
    method: 'POST',
    body: {
      code: PACKAGE,
      countryCode: 'ru',
      name: 'Базовый (прогон, новая цена)',
      price: '18000.00',
      currency: 'RUB',
      minTarget: '0.00',
      maxTarget: '5000000.00',
      serviceCodes: [SERVICE_A, SERVICE_B],
      reason: 'прогон: цена изменена новой версией',
    },
  });
  check('изменение цены — новая версия', json?.version === 2, `версия ${json?.version}`);
  check(
    'состав новой версии расширен',
    json?.services?.length === 2,
    `услуг ${json?.services?.length}`,
  );
  check('публикация прошла', response.status < 400, `статус ${response.status}`);
}
{
  const list = await admin.call('/v1/admin/round-packages');
  const previous = list.json.items.find((p) => p.id === firstPackage.id);
  check(
    'прежняя версия закрыта, а не переписана',
    previous?.validTo !== null,
    `до ${previous?.validTo}`,
  );
  check('цена прежней версии не изменилась', previous?.price === '15000.00', `${previous?.price}`);
  const current = list.json.items.find((p) => p.code === PACKAGE && p.isActive);
  check(
    'действует ровно одна версия кода',
    Boolean(current) && current.version === 2,
    `версия ${current?.version}`,
  );
}
{
  const { response, json } = await admin.call('/v1/admin/round-packages', {
    method: 'POST',
    body: {
      code: `${PACKAGE}_usd`,
      countryCode: 'ru',
      name: 'Валюта не по условиям (прогон)',
      price: '200.00',
      currency: 'USD',
      minTarget: '9000000.00',
      reason: 'прогон: валюта вне условий страны',
    },
  });
  check(
    'валюта вне условий страны отклонена',
    response.status === 400,
    `статус ${response.status} ${json?.detail ?? ''}`,
  );
}

// -------------------------------------------------------------- цены докупки
{
  const { response, json } = await admin.call('/v1/admin/round-service-offers', {
    method: 'POST',
    body: {
      serviceCode: SERVICE_B,
      countryCode: 'ru',
      price: '7000.00',
      currency: 'RUB',
      reason: 'прогон: цена докупки',
    },
  });
  check(
    'цена докупки публикуется',
    response.status < 400,
    `статус ${response.status} ${json?.detail ?? ''}`,
  );
  check('цена действует', json?.isActive === true, `${json?.isActive}`);
}
{
  const { response, json } = await admin.call('/v1/admin/round-service-offers', {
    method: 'POST',
    body: {
      serviceCode: SERVICE_B,
      countryCode: 'ru',
      price: '7500.00',
      currency: 'RUB',
      reason: 'прогон: новая цена докупки',
    },
  });
  check('изменение цены докупки — новая версия', json?.version === 2, `версия ${json?.version}`);
  check('публикация цены прошла', response.status < 400, `статус ${response.status}`);
  const list = await admin.call('/v1/admin/round-service-offers');
  const active = list.json.items.filter((o) => o.serviceCode === SERVICE_B && o.isActive);
  check('действует одна цена услуги', active.length === 1, `действующих ${active.length}`);
}

// ------------------------------------------------------------ снятие с продажи
{
  const list = await admin.call('/v1/admin/round-packages');
  const current = list.json.items.find((p) => p.code === PACKAGE && p.isActive);
  const { response, json } = await admin.call(`/v1/admin/round-packages/${current.id}/close`, {
    method: 'POST',
    body: { reason: 'прогон: сетка возвращается в исходное состояние' },
  });
  check('версия снимается с продажи', response.status < 400, `статус ${response.status}`);
  check('после снятия версия не действует', json?.isActive === false, `${json?.isActive}`);
}
{
  const list = await admin.call('/v1/admin/round-packages');
  const stillActive = list.json.items.filter((p) => p.code === PACKAGE && p.isActive);
  check(
    'действующих версий прогона не осталось',
    stillActive.length === 0,
    `${stillActive.length}`,
  );
}

// --------------------------------------------------------------------- аудит
{
  const rows = await sql(
    `SELECT verb FROM audit.events
      WHERE verb LIKE 'billing.round_%' AND ts > now() - interval '10 minutes'`,
  );
  const verbs = new Set(rows.map((r) => r.verb));
  check('заведение услуги в аудите', verbs.has('billing.round_service.created'));
  check('отметка реализации в аудите', verbs.has('billing.round_service.updated'));
  check('публикация версии в аудите', verbs.has('billing.round_package.published'));
  check('снятие с продажи в аудите', verbs.has('billing.round_package.closed'));
  check('публикация цены докупки в аудите', verbs.has('billing.round_service_offer.published'));
}

// ------------------------------------------------------------------ продажи
{
  const { response } = await raw('/v1/round-packages');
  check(
    'публичной витрины пакетов нет — продажи выключены',
    response.status === 404,
    `статус ${response.status}`,
  );
}

console.warn(`\n  Итог: ${passed} OK, ${failed} FAIL\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);
