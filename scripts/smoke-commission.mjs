#!/usr/bin/env node
/**
 * Живой прогон «условия вознаграждения и зачёт услуг» (этап 5.9.3).
 *
 * Проверяется фактическое поведение запущенного core: ставка одна и доли
 * обязаны в неё складываться; изменение — новая версия, прежняя закрывается;
 * витрина раскрывает базу начисления честно (сумма подтверждённого транша, а
 * не весь договор); зачёт услуг включить нельзя, пока правило не утверждено.
 *
 * Деньги не двигаются: начисления создаёт только команда подтверждения
 * транша, и этот прогон её не вызывает.
 *
 * Запуск: node scripts/smoke-commission.mjs [--api http://127.0.0.1:4300]
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
  application_name: 'unicorn-smoke-commission',
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
  return { response, json };
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
  async function json(path, init) {
    const { response, json: body } = await call(path, init);
    if (response.status >= 400) {
      throw new Error(
        `${init?.method ?? 'GET'} ${path}: ${response.status} ${JSON.stringify(body)}`,
      );
    }
    return body;
  }
  return { call, json };
}

const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

const suffix = `${Date.now() % 1e9}`;

async function register(role, tag) {
  const client = makeClient();
  const email = `fee-${tag}-${suffix}@test.local`;
  const password = `Pw-${crypto.randomUUID()}`;
  await client.json('/v1/auth/register', {
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
  const index = createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
  const [row] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [index]);
  return { client, email, password, userId: row?.id ?? null };
}

console.warn('\n=== ЖИВОЙ ПРОГОН: ВОЗНАГРАЖДЕНИЕ И ЗАЧЁТ УСЛУГ ===\n');

const outsider = await register('investor', 'o');
const adminUser = await register('founder', 'a');
await sql(
  `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
  [adminUser.userId],
);
const admin = makeClient();
await admin.json('/v1/auth/login', {
  method: 'POST',
  body: { email: adminUser.email, password: adminUser.password },
});

// Коды прогона отдельные: действующие условия сделок трогать нельзя — на них
// ссылаются договоры.
const CODE = `smk_fee_${suffix}`;

// --------------------------------------------------------- закрытость контура
{
  const { response } = await raw('/v1/admin/fee-schedules');
  check('контур закрыт без токена', response.status === 401, `статус ${response.status}`);
}
{
  const { response } = await outsider.client.call('/v1/admin/fee-schedules');
  check('инвестор условия не настраивает', response.status === 403, `статус ${response.status}`);
}

// ------------------------------------------------------------------ условия
{
  const { response, json } = await admin.call('/v1/admin/fee-schedules', {
    method: 'POST',
    body: {
      code: CODE,
      totalPct: '15',
      investorFeePct: '10',
      issuerFeePct: '4',
      rulesVersion: 'v1',
      reason: 'прогон: доли не сходятся с общей ставкой',
    },
  });
  check('несходящиеся доли отклонены', response.status === 400, `статус ${response.status}`);
  check(
    'отказ указывает на общую ставку',
    JSON.stringify(json?.errors ?? {}).includes('складываться'),
    JSON.stringify(json?.errors ?? {}).slice(0, 120),
  );
}
let first = null;
{
  const created = await admin.json('/v1/admin/fee-schedules', {
    method: 'POST',
    body: {
      code: CODE,
      totalPct: '15',
      investorFeePct: '10',
      issuerFeePct: '5',
      rulesVersion: 'v1',
      reason: 'прогон: первая версия условий',
    },
  });
  check('версия условий опубликована', created.version === 1, `версия ${created.version}`);
  check('общая ставка сохранена', created.totalPct === '15.00', created.totalPct);
  check('версия действует', created.isActive === true, `${created.isActive}`);
  first = created;
}
{
  const next = await admin.json('/v1/admin/fee-schedules', {
    method: 'POST',
    body: {
      code: CODE,
      totalPct: '12',
      investorFeePct: '8',
      issuerFeePct: '4',
      rulesVersion: 'v2',
      reason: 'прогон: ставка снижена новой версией',
    },
  });
  check('изменение ставки — новая версия', next.version === 2, `версия ${next.version}`);

  const list = await admin.json('/v1/admin/fee-schedules');
  const previous = list.items.find((t) => t.id === first.id);
  check(
    'прежняя версия закрыта, а не переписана',
    previous?.validTo !== null,
    `${previous?.validTo}`,
  );
  check('ставка прежней версии не изменилась', previous?.totalPct === '15.00', previous?.totalPct);
  const active = list.items.filter((t) => t.code === CODE && t.isActive);
  check('действует ровно одна версия кода', active.length === 1, `${active.length}`);
}

// ------------------------------------------------------- раскрытие на витрине
{
  const { json } = await raw('/v1/pricing');
  check(
    'витрина раскрывает базу как сумму подтверждённого транша',
    json?.feeDisclosure?.baseIsConfirmedTranche === true,
    `${json?.feeDisclosure?.baseIsConfirmedTranche}`,
  );
  check(
    'витрина раскрывает начисление по каждому траншу',
    json?.feeDisclosure?.accrualPerTranche === true,
    `${json?.feeDisclosure?.accrualPerTranche}`,
  );
  check(
    'в тексте раскрытия названа общая ставка',
    (json?.feeDisclosure?.triggerDescription ?? '').includes('Общая ставка'),
    (json?.feeDisclosure?.triggerDescription ?? '').slice(0, 90),
  );
  check(
    'условия сделок содержат общую ставку',
    json?.feeSchedule?.totalPct !== undefined,
    `${json?.feeSchedule?.totalPct}`,
  );
}

// ------------------------------------------------------------------- зачёт
{
  const { response, json } = await admin.call('/v1/admin/fee-offset-rules', {
    method: 'POST',
    body: { isEnabled: true, reason: 'прогон: попытка включить зачёт' },
  });
  check('зачёт включить нельзя', response.status === 400, `статус ${response.status}`);
  check(
    'отказ называет причину',
    JSON.stringify(json?.errors ?? {}).includes('не утверждено'),
    JSON.stringify(json?.errors ?? {}).slice(0, 120),
  );
}
{
  const created = await admin.json('/v1/admin/fee-offset-rules', {
    method: 'POST',
    body: { isEnabled: false, reason: 'прогон: новая версия правила, зачёт выключен' },
  });
  check('выключенную версию правила активировать можно', created.isEnabled === false);
  check('версия стала активной', created.isActive === true);

  const [{ n }] = await sql(
    `SELECT count(*)::int AS n FROM billing.fee_offset_rules WHERE is_active`,
  );
  check('активная версия правила ровно одна', n === 1, `${n}`);
  const [{ on }] = await sql(`SELECT billing.fee_offsets_enabled() AS on`);
  check('зачёт в базе выключен', on === false, `${on}`);
}
{
  // Запись зачёта запрещена в базе, а не только в сервисе: проверяем прямым
  // обращением от роли приложения.
  let denied = false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_backend');
    await client.query(
      `INSERT INTO billing.fee_offsets
         (id, accrual_id, purchase_item_id, rule_version, amount, currency, reason)
       VALUES (public.uuid_generate_v7(), public.uuid_generate_v7(), public.uuid_generate_v7(),
               1, 100, 'RUB', 'прогон: прямая запись зачёта')`,
    );
  } catch {
    denied = true;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
  check('прямая запись зачёта отклонена базой', denied);
}

// --------------------------------------------------------------------- аудит
{
  const rows = await sql(
    `SELECT verb FROM audit.events
      WHERE verb IN ('billing.fee_schedule.published','billing.fee_offset_rule.activated')
        AND ts > now() - interval '10 minutes'`,
  );
  const verbs = new Set(rows.map((r) => r.verb));
  check('публикация условий в аудите', verbs.has('billing.fee_schedule.published'));
  check('активация правила зачёта в аудите', verbs.has('billing.fee_offset_rule.activated'));
}

// Условия прогона закрываются: сетка остаётся такой, какой была.
await sql(
  `UPDATE billing.fee_schedules
      SET valid_to = GREATEST(now(), valid_from + interval '1 millisecond')
    WHERE code = $1 AND (valid_to IS NULL OR valid_to > now())`,
  [CODE],
);

console.warn(`\n  Итог: ${passed} OK, ${failed} FAIL\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);
