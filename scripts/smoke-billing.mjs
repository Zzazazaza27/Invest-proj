#!/usr/bin/env node
/**
 * Живой прогон фазы «биллинг и админский кабинет».
 *
 * Проверяется фактическое поведение запущенного core: публикация новой версии
 * тарифа с будущей датой, неизменяемость действующей версии, отмена
 * объявления, оформление и активация подписки, персональные цены по правилу
 * четырёх глаз, фичефлаги и закрытость админского контура для чужих ролей.
 *
 * Как и в прочих живых прогонах, напрямую в БД создаётся только то, для чего
 * нет API: роль администратора. Остальное идёт через HTTP.
 *
 * Запуск: node scripts/smoke-billing.mjs [--api http://127.0.0.1:4300]
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
  application_name: 'unicorn-smoke-billing',
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
  const email = `bil-${tag}-${suffix}@test.local`;
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
  const userId = await findUserIdByEmail(email);
  return { client, email, password, userId };
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

console.warn('\n=== ЖИВОЙ ПРОГОН: БИЛЛИНГ И АДМИНСКИЙ КАБИНЕТ ===\n');

// Тестовый тариф отдельным кодом не завести — коды ограничены CHECK. Поэтому
// прогон идёт по founder_t1 и возвращает сетку в исходное состояние в конце.
const PLAN_CODE = 'founder_t1';

// Предусловие: сетка возвращается в исходное состояние. Незавершённый прошлый
// прогон мог оставить объявление о будущей цене, и тогда сценарий проверял бы
// не то, что заявлено, а конфликт с собственным мусором.
await sql(`DELETE FROM billing.subscription_plans WHERE valid_from > now()`);
await sql(
  `UPDATE billing.subscription_plans SET valid_to = NULL
    WHERE valid_to IS NOT NULL AND valid_to > now()`,
);

const founder = await register('founder', 'f');
const outsider = await register('investor', 'o');
const adminA = await register('founder', 'a1');
const adminB = await register('founder', 'a2');
const admin = await makeAdmin(adminA);
const admin2 = await makeAdmin(adminB);

// --------------------------------------------------------- закрытость контура
{
  const { response } = await raw('/v1/admin/plans');
  check('админский контур закрыт без токена', response.status === 401, `статус ${response.status}`);
}
{
  const { response, json } = await outsider.client.call('/v1/admin/plans');
  check(
    'обычный пользователь не видит админский контур',
    response.status === 403,
    `статус ${response.status} ${json?.code ?? ''}`,
  );
}
{
  const { response, json } = await admin.call('/v1/admin/plans');
  check('администратор видит тарифы', response.status === 200, `статус ${response.status}`);
  check('версии тарифов пришли', (json?.items?.length ?? 0) >= 6, `версий ${json?.items?.length}`);
  const current = (json?.items ?? []).find((p) => p.code === PLAN_CODE && p.isActive);
  check('действующая версия помечена запертой', current?.isLocked === true);
}

// ------------------------------------------------- объявление новой цены
const priceBefore = (
  await sql(
    `SELECT price::text AS price FROM billing.subscription_plans
      WHERE code = $1 AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())`,
    [PLAN_CODE],
  )
)[0]?.price;

const nextMonth = new Date();
nextMonth.setMonth(nextMonth.getMonth() + 1, 1);
nextMonth.setHours(0, 0, 0, 0);

let scheduledId;
{
  const { response, json } = await admin.call('/v1/admin/plans', {
    method: 'POST',
    body: {
      code: PLAN_CODE,
      audience: 'founder',
      name: 'Старт — новая цена с будущего месяца',
      price: '5990.00',
      askLimit: '1000000.00',
      individualPricing: false,
      billingPeriod: 'monthly',
      features: { included: ['публикация одного проекта', 'базовая аналитика'], maxProjects: 1 },
      validFrom: nextMonth.toISOString(),
    },
  });
  scheduledId = json?.id;
  check(
    'новая цена объявлена на будущую дату',
    response.status === 201 || response.status === 200,
    `статус ${response.status} ${json?.code ?? ''}`,
  );
  check('объявленная версия ещё не заперта', json?.isLocked === false);
  check('объявленная версия ещё не действует', json?.isActive === false);
}
{
  const { json } = await raw('/v1/pricing');
  const plan = (json?.plans ?? []).find((p) => p.code === PLAN_CODE);
  check(
    'публичная витрина показывает ПРЕЖНЮЮ цену до даты вступления',
    plan?.price === priceBefore,
    `витрина: ${plan?.price}, было: ${priceBefore}`,
  );
}
{
  const { response, json } = await admin.call('/v1/admin/plans', {
    method: 'POST',
    body: {
      code: PLAN_CODE,
      audience: 'founder',
      name: 'Второе объявление',
      price: '7777.00',
      individualPricing: false,
      billingPeriod: 'monthly',
      features: {},
      validFrom: nextMonth.toISOString(),
    },
  });
  check(
    'второе объявление по тому же тарифу отклонено',
    response.status === 409,
    `статус ${response.status} ${json?.code ?? ''}`,
  );
}
{
  const { response, json } = await admin.call(`/v1/admin/plans/${scheduledId}`, {
    method: 'PATCH',
    body: { price: '6490.00' },
  });
  check(
    'объявление можно поправить до вступления в силу',
    response.status === 200 && json?.price === '6490.00',
    `цена ${json?.price}`,
  );
}
{
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const { response, json } = await admin.call('/v1/admin/plans', {
    method: 'POST',
    body: {
      code: 'founder_t3',
      audience: 'founder',
      name: 'Задним числом',
      price: '1.00',
      individualPricing: false,
      billingPeriod: 'monthly',
      features: {},
      validFrom: past,
    },
  });
  check(
    'публикация задним числом отклонена',
    response.status === 400,
    `статус ${response.status} ${json?.code ?? ''}`,
  );
}
{
  // База обязана запрещать переписывание действующей версии независимо от API.
  const [active] = await sql(
    `SELECT id FROM billing.subscription_plans
      WHERE code = $1 AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())`,
    [PLAN_CODE],
  );
  const failure = await pool
    .query('UPDATE billing.subscription_plans SET price = 1 WHERE id = $1', [active.id])
    .then(() => null)
    .catch((error) => error);
  check(
    'действующую версию нельзя переписать даже напрямую в БД',
    failure !== null,
    failure?.message?.slice(0, 60) ?? '',
  );
}
{
  const { response } = await admin.call(`/v1/admin/plans/${scheduledId}`, { method: 'DELETE' });
  check('объявление отменено', response.status === 200, `статус ${response.status}`);

  const [row] = await sql(
    `SELECT valid_to FROM billing.subscription_plans
      WHERE code = $1 AND valid_from <= now() ORDER BY version DESC LIMIT 1`,
    [PLAN_CODE],
  );
  check('прежняя версия снова бессрочна', row?.valid_to === null, String(row?.valid_to));

  const { json } = await raw('/v1/pricing');
  const plan = (json?.plans ?? []).find((p) => p.code === PLAN_CODE);
  check('витрина вернулась к прежней цене', plan?.price === priceBefore, `цена ${plan?.price}`);
}

// ----------------------------------------------- подписка основателя
let projectId;
{
  const taxonomy = (await sql(`SELECT id FROM lab.project_taxonomy WHERE slug = 'saas'`))[0].id;
  const { json } = await founder.client.call('/v1/projects', {
    method: 'POST',
    body: {
      title: 'Проект для проверки биллинга',
      stage: 'mvp',
      taxonomyId: taxonomy,
      investmentAsk: '900000.00',
      askCurrency: 'RUB',
    },
  });
  projectId = json?.id;
  check('проект основателя создан', Boolean(projectId));
}
let subscriptionId;
{
  const { response, json } = await founder.client.call('/v1/billing/subscriptions', {
    method: 'POST',
    body: {
      audience: 'founder',
      projectId,
      idempotencyKey: `sub-${suffix}-${crypto.randomUUID()}`,
    },
  });
  subscriptionId = json?.id;
  check(
    'подписка оформлена',
    response.status === 201 || response.status === 200,
    `статус ${response.status} ${json?.code ?? ''}`,
  );
  check('подписка ждёт оплаты', json?.status === 'pending_payment', json?.status ?? '');
  check(
    'цена зафиксирована снапшотом по действующему тарифу',
    json?.priceSnapshot === priceBefore,
    `снапшот ${json?.priceSnapshot}`,
  );
}
{
  const { json } = await founder.client.call('/v1/billing/subscriptions', {
    method: 'POST',
    body: {
      audience: 'founder',
      projectId,
      idempotencyKey: `sub-${suffix}-${crypto.randomUUID()}`,
    },
  });
  check('повторное оформление не плодит подписки', json?.id === subscriptionId);
}
{
  const { response, json } = await founder.client.call(`/v1/projects/${projectId}/listing`, {
    method: 'POST',
  });
  check(
    'публикация с неоплаченной подпиской отклонена',
    response.status === 403,
    `статус ${response.status} ${json?.code ?? ''}`,
  );
}
{
  const { response, json } = await outsider.client.call(
    `/v1/admin/subscriptions/${subscriptionId}/activate`,
    { method: 'POST', body: { reason: 'сам себе активирую' } },
  );
  check(
    'посторонний не может активировать подписку',
    response.status === 403,
    `статус ${response.status} ${json?.code ?? ''}`,
  );
}
{
  const { response, json } = await admin.call(
    `/v1/admin/subscriptions/${subscriptionId}/activate`,
    { method: 'POST', body: { reason: 'платёжное поручение №42' } },
  );
  check(
    'администратор активировал подписку',
    (response.status === 200 || response.status === 201) && json?.status === 'active',
    `статус ${response.status} ${json?.status ?? ''}`,
  );
}
{
  const [row] = await sql(
    `SELECT context_jsonb->>'reason' AS reason FROM audit.events
      WHERE verb = 'lab.subscription.activated' AND subject_id = $1`,
    [subscriptionId],
  );
  check('основание активации записано в журнал', row?.reason === 'платёжное поручение №42');
}

// ------------------------------------------------- персональная цена (4 eyes)
{
  const { response, json } = await admin.call(
    `/v1/admin/subscriptions/${subscriptionId}/custom-price`,
    { method: 'POST', body: { price: '3990.00', reason: 'пилотный клиент' } },
  );
  check(
    'персональная цена назначена',
    response.status === 200 || response.status === 201,
    `статус ${response.status} ${json?.code ?? ''}`,
  );
  check('цена ждёт утверждения', json?.customPriceApprovedBy === null);
}
{
  const { response, json } = await admin.call(
    `/v1/admin/subscriptions/${subscriptionId}/custom-price/approve`,
    { method: 'POST' },
  );
  check(
    'назначивший цену не может утвердить её сам',
    response.status === 403,
    `статус ${response.status} ${json?.code ?? ''}`,
  );
}
{
  const { response, json } = await admin2.call(
    `/v1/admin/subscriptions/${subscriptionId}/custom-price/approve`,
    { method: 'POST' },
  );
  check(
    'второй администратор утвердил цену',
    response.status === 200 || response.status === 201,
    `статус ${response.status} ${json?.code ?? ''}`,
  );
  check('цена подписки стала персональной', json?.priceSnapshot === '3990.00', json?.priceSnapshot);
}

// ------------------------------- гонка утверждения персональной цены (4 eyes)
// Утверждение читает предложение и меняет подписку. Между чтением и записью
// проходит время: два одновременных утверждения могли записать в журнал ДВА
// согласования одного предложения — а для контроля «четыре глаза» целостность
// следа и есть весь смысл.
{
  await admin.call(`/v1/admin/subscriptions/${subscriptionId}/custom-price`, {
    method: 'POST',
    body: { price: '2990.00', reason: 'проверка гонки утверждения' },
  });
  const before = await sql(
    `SELECT count(*)::int AS n FROM audit.events
      WHERE verb = 'billing.custom_price.approved' AND subject_id = $1`,
    [subscriptionId],
  );
  const parallel = await Promise.all([
    admin2.call(`/v1/admin/subscriptions/${subscriptionId}/custom-price/approve`, {
      method: 'POST',
    }),
    admin2.call(`/v1/admin/subscriptions/${subscriptionId}/custom-price/approve`, {
      method: 'POST',
    }),
  ]);
  const after = await sql(
    `SELECT count(*)::int AS n FROM audit.events
      WHERE verb = 'billing.custom_price.approved' AND subject_id = $1`,
    [subscriptionId],
  );
  const added = after[0].n - before[0].n;
  check(
    'одновременное утверждение записывает ровно одно согласование',
    added === 1,
    `записано согласований: ${added}, ответы: ${parallel.map((p) => p.response.status).join(',')}`,
  );
}

// ------------------------------------------------------------- фичефлаги
{
  const { response, json } = await admin.call('/v1/admin/feature-flags');
  check('список функций доступен администратору', response.status === 200);
  const investments = (json?.items ?? []).filter((f) => f.key.startsWith('investments.'));
  check(
    'регулируемый контур по-прежнему выключен',
    investments.length > 0 && investments.every((f) => f.enabled === false),
    `флагов ${investments.length}`,
  );
}
{
  const [flag] = await sql(
    `SELECT key FROM audit.feature_flags WHERE key NOT LIKE 'investments%' ORDER BY key LIMIT 1`,
  );
  const before = (
    await sql('SELECT enabled FROM audit.feature_flags WHERE key = $1', [flag.key])
  )[0].enabled;
  const { response, json } = await admin.call(`/v1/admin/feature-flags/${flag.key}`, {
    method: 'PATCH',
    body: { enabled: !before, reason: 'проверка переключателя' },
  });
  check(
    'флаг переключён администратором',
    response.status === 200 && json?.enabled === !before,
    `${flag.key}: ${json?.enabled}`,
  );

  const [event] = await sql(
    `SELECT context_jsonb->>'reason' AS reason FROM audit.events
      WHERE verb = 'admin.feature_flag.changed' ORDER BY ts DESC LIMIT 1`,
  );
  check('переключение попало в журнал с основанием', event?.reason === 'проверка переключателя');

  // Возвращаем как было: прогон не должен менять состояние платформы.
  await admin.call(`/v1/admin/feature-flags/${flag.key}`, {
    method: 'PATCH',
    body: { enabled: before, reason: 'возврат после проверки' },
  });
}

// ----------------------------------------------------- снятие тарифа с продажи
{
  const [t4] = await sql(
    `SELECT id FROM billing.subscription_plans
      WHERE code = 'founder_t4' AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())`,
  );
  const { response } = await admin.call(`/v1/admin/plans/${t4.id}/close`, {
    method: 'POST',
    body: { reason: 'проверка снятия с продажи' },
  });
  check('тариф снят с продажи', response.status === 200 || response.status === 201);

  const { json } = await raw('/v1/pricing');
  check(
    'снятый тариф исчез с публичной витрины',
    !(json?.plans ?? []).some((p) => p.code === 'founder_t4'),
    `тарифов на витрине: ${json?.plans?.length}`,
  );

  // Возврат сетки в исходное состояние: следующий прогон должен начинаться с той же точки.
  await sql('UPDATE billing.subscription_plans SET valid_to = NULL WHERE id = $1', [t4.id]);
  const { json: restored } = await raw('/v1/pricing');
  check(
    'сетка восстановлена',
    (restored?.plans ?? []).some((p) => p.code === 'founder_t4'),
    `тарифов: ${restored?.plans?.length}`,
  );
}

// ------------------------------------------------------------------ журнал
{
  const verbs = (
    await sql(
      `SELECT DISTINCT verb FROM audit.events
        WHERE verb LIKE 'billing.%' OR verb LIKE 'admin.%'`,
    )
  ).map((r) => r.verb);
  check('публикация тарифа в журнале', verbs.includes('billing.plan.published'));
  check('отмена объявления в журнале', verbs.includes('billing.plan.schedule_canceled'));
  check('закрытие тарифа в журнале', verbs.includes('billing.plan.closed'));
  check('оформление подписки в журнале', verbs.includes('billing.subscription.created'));
  check(
    'согласование персональной цены в журнале',
    verbs.includes('billing.custom_price.approved'),
  );

  const broken = await sql('SELECT * FROM audit.verify_event_chain(NULL)');
  check('цепочка журнала цела', broken.length === 0, `разрывов ${broken.length}`);
}

console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено.\n`);
await pool.end();
if (failed > 0) process.exitCode = 1;
