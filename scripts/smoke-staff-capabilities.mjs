#!/usr/bin/env node
/**
 * Живой прогон «полномочия сотрудника и ручные денежные записи» (M097).
 *
 * Проверяется фактическое поведение запущенного core:
 *
 *   • роль `expert` сама по себе не даёт ни полномочия, ни доступа к сделке;
 *   • полномочие без назначения на проект сделку не открывает, а назначение
 *     без полномочия не даёт трогать деньги — оба слоя нужны одновременно;
 *   • отзыв полномочия закрывает действие при следующем запросе;
 *   • возвраты частичные, в сумме не больше транша, повторная отправка не
 *     создаёт дубликат, ошибочная запись аннулируется с основанием;
 *   • уменьшение начисления и возврат уплаченного — разные полномочия.
 *
 * Деньги не двигаются: все действия — записи о состоявшихся событиях.
 * Обстановка сделки создаётся напрямую в БД (через API это отдельный контур,
 * и не он здесь проверяется); всё проверяемое идёт через HTTP.
 *
 * Запуск: node scripts/smoke-staff-capabilities.mjs [--api http://127.0.0.1:4300]
 */
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
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
  application_name: 'unicorn-smoke-staff-capabilities',
});

async function sql(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows;
}

async function raw(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(20_000) });
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
  const email = `cap-${tag}-${suffix}@test.local`;
  const password = `Pw-${randomUUID()}`;
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

async function login(user) {
  const client = makeClient();
  await client.json('/v1/auth/login', {
    method: 'POST',
    body: { email: user.email, password: user.password },
  });
  return client;
}

/**
 * Сделка с подтверждённым траншем и начислением — обстановка для записей.
 *
 * Строится напрямую в БД: сделочный контур со своими правилами здесь не
 * проверяется, и гонять его через API значило бы проверять не то.
 */
async function makeDeal(founderId, investorId, amount) {
  const projectId = randomUUID();
  await sql(
    `INSERT INTO lab.projects (id, title, stage, investment_ask, status)
     VALUES ($1, $2, 'mvp', $3, 'draft')`,
    [projectId, `Прогон полномочий ${suffix}`, amount],
  );
  await sql(
    `INSERT INTO lab.founders_projects (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [projectId, founderId],
  );

  const entityId = randomUUID();
  const inn = `77${String(Date.now()).slice(-8)}`;
  await sql(
    `INSERT INTO kyc.business_entities
       (id, legal_name, inn_ciphertext, entity_wrapped_dek, inn_hmac, jurisdiction,
        registry_status, owner_user_id)
     VALUES ($1, $2, $3, '\\x00'::bytea, digest($4, 'sha256'), 'RU', 'active', $5)`,
    [entityId, `ООО Прогон ${suffix}`, Buffer.from(inn), inn, founderId],
  );
  await sql(
    `INSERT INTO kyc.entity_members (entity_id, user_id, member_role, verified_at)
     VALUES ($1, $2, 'signatory', now())`,
    [entityId, founderId],
  );
  // Решение по юрлицу принимает посторонний администратор: своё же юрлицо
  // подтвердить нельзя (M013).
  const [reviewer] = await sql(
    `SELECT user_id FROM identity.user_roles WHERE role = 'admin' AND revoked_at IS NULL LIMIT 1`,
  );
  await sql(
    `INSERT INTO kyc.kyb_verifications (id, entity_id, kind, status, reviewed_by, decided_at)
     VALUES (public.uuid_generate_v7(), $1, 'registry_check', 'approved', $2, now())`,
    [entityId, reviewer.user_id],
  );
  await sql(
    `INSERT INTO kyc.kyc_verifications
       (id, user_id, kind, status, risk_level, sanctions_status, reviewed_by, decided_at)
     VALUES (public.uuid_generate_v7(), $1, 'identity', 'approved', 'low', 'clear', $2, now())`,
    [investorId, reviewer.user_id],
  );

  const offerId = randomUUID();
  await sql(
    `INSERT INTO investments.investment_offers
       (id, project_id, issuer_entity_id, instrument_type, rules_version, target_amount,
        min_investment, terms_jsonb, document_s3_key, document_sha256, document_wrapped_dek,
        status, opens_at, created_by)
     VALUES ($1, $2, $3, 'loan', 'platform_rules_v1', $4, 1000, '{}'::jsonb,
             'offers/doc.pdf', digest('doc','sha256'), '\\x00'::bytea,
             'published', now() - interval '1 day', $5)`,
    [offerId, projectId, entityId, amount * 5, founderId],
  );

  const [{ id: feeId }] = await sql(
    `SELECT id FROM billing.fee_schedules
      WHERE code = 'operator_success_fee' AND valid_to IS NULL ORDER BY version DESC LIMIT 1`,
  );
  const agreementId = randomUUID();
  await sql(
    `INSERT INTO investments.investment_agreements
       (id, offer_id, investor_id, contract_amount, fee_schedule_id, document_s3_key,
        document_sha256, document_wrapped_dek, idempotency_key, status,
        investor_signed_at, issuer_signed_at)
     VALUES ($1, $2, $3, $4, $5, 'agreements/doc.pdf', digest('a','sha256'), '\\x00'::bytea,
             $6, 'signed', now(), now())`,
    [agreementId, offerId, investorId, amount, feeId, `idem-${agreementId}`],
  );

  const [tranche] = await sql(
    `SELECT tranche_id, accrual_id
       FROM billing.confirm_tranche($1, $2, $3, now(), digest('stmt','sha256'), NULL, 'smoke')`,
    [agreementId, `bank-${agreementId}`, amount],
  );
  return { projectId, agreementId, trancheId: tranche.tranche_id, accrualId: tranche.accrual_id };
}

console.warn('\n=== ЖИВОЙ ПРОГОН: ПОЛНОМОЧИЯ И РУЧНЫЕ ЗАПИСИ О ДЕНЬГАХ ===\n');

const founder = await register('founder', 'f');
const investor = await register('investor', 'i');
// Роль эксперта выдаётся администратором: самостоятельно ею не регистрируются.
const expertUser = await register('founder', 'e');
const adminUser = await register('founder', 'a');
await sql(
  `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
  [adminUser.userId],
);
const admin = await login(adminUser);
await sql(
  `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'expert') ON CONFLICT DO NOTHING`,
  [expertUser.userId],
);
const expert = await login(expertUser);
await sql(`INSERT INTO experts.experts (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [
  expertUser.userId,
]);

const deal = await makeDeal(founder.userId, investor.userId, 1_000_000);
console.warn(`  ·     сделка на 1 000 000 RUB с подтверждённым траншем создана`);

// ------------------------------------------------- каталог и его смысл
{
  const catalog = await admin.json('/v1/admin/capabilities');
  const codes = catalog.items.map((c) => c.code);
  check(
    'каталог перечисляет полномочия раздела «Финансы»',
    codes.includes('finance.tranche_return.record') && codes.includes('finance.commission.reduce'),
    codes.join(', '),
  );
  const record = catalog.items.find((c) => c.code === 'finance.tranche_return.record');
  check('фиксация возврата — денежная корректировка', record?.action === 'financial_adjust');
  check('фиксация возврата требует области работы', record?.requiresAssignment === true);
  const discuss = catalog.items.find((c) => c.code === 'finance.return.discuss');
  check('обсуждение возврата — отдельное полномочие', discuss?.action === 'discuss');
}
{
  const { response } = await expert.call('/v1/admin/capabilities');
  check('эксперт каталогом не управляет', response.status === 403, `статус ${response.status}`);
}

// ------------------------------------- роль expert сама по себе ничего не даёт
{
  const mine = await expert.json('/v1/me/capabilities');
  check('у эксперта нет полномочий по умолчанию', mine.items.length === 0, mine.items.join(', '));
}
{
  const { response, json } = await expert.call('/v1/investments/deals/tranche-returns', {
    method: 'POST',
    body: {
      trancheId: deal.trancheId,
      amount: '1000.00',
      currency: 'RUB',
      occurredOn: '2026-09-19',
      reason: 'попытка без полномочия',
      idempotencyKey: `no-cap-${suffix}`,
    },
  });
  check(
    'без полномочия возврат не фиксируется',
    response.status === 403,
    `статус ${response.status}`,
  );
  check(
    'отказ называет недостающее полномочие',
    (json?.detail ?? '').includes('finance.tranche_return.record'),
    json?.detail ?? '',
  );
}

// ------------------------------- полномочие без назначения сделку не открывает
await admin.json('/v1/admin/capabilities/grant', {
  method: 'POST',
  body: {
    userId: expertUser.userId,
    capability: 'finance.tranche_return.record',
    reason: 'прогон: выдано полномочие фиксировать возврат',
  },
});
{
  const mine = await expert.json('/v1/me/capabilities');
  check(
    'выданное полномочие видно сотруднику',
    mine.items.includes('finance.tranche_return.record'),
    mine.items.join(', '),
  );
}
{
  const { response, json } = await expert.call('/v1/investments/deals/tranche-returns', {
    method: 'POST',
    body: {
      trancheId: deal.trancheId,
      amount: '1000.00',
      currency: 'RUB',
      occurredOn: '2026-09-19',
      reason: 'попытка без назначения',
      idempotencyKey: `no-assign-${suffix}`,
    },
  });
  check(
    'полномочие без назначения сделку не открывает',
    response.status === 403 || response.status === 404,
    `статус ${response.status} ${json?.detail ?? ''}`,
  );
}

// ------------------------------------------- назначение открывает свою сделку
await sql(
  `INSERT INTO experts.expert_assignments
     (id, project_id, expert_id, assigned_reason, status, due_at)
   VALUES ($1, $2, $3, 'manual', 'accepted', now() + interval '30 days')`,
  [randomUUID(), deal.projectId, expertUser.userId],
);
let firstReturn;
{
  const created = await expert.json('/v1/investments/deals/tranche-returns', {
    method: 'POST',
    body: {
      trancheId: deal.trancheId,
      amount: '400000.00',
      currency: 'RUB',
      occurredOn: '2026-09-19',
      reason: 'частичный возврат по договорённости сторон',
      evidenceRef: 'протокол №7',
      idempotencyKey: `part1-${suffix}`,
    },
  });
  check('с полномочием и назначением возврат фиксируется', created.amount === '400000.00');
  check('подтверждение сохранено', created.evidenceRef === 'протокол №7');
  firstReturn = created;
}
{
  const again = await expert.json('/v1/investments/deals/tranche-returns', {
    method: 'POST',
    body: {
      trancheId: deal.trancheId,
      amount: '400000.00',
      currency: 'RUB',
      occurredOn: '2026-09-19',
      reason: 'повторное нажатие',
      idempotencyKey: `part1-${suffix}`,
    },
  });
  check('повторная отправка не создаёт дубликат', again.id === firstReturn.id);
}
{
  const ledger = await expert.json(`/v1/investments/deals/${deal.agreementId}/ledger`);
  const tranche = ledger.tranches.find((t) => t.id === deal.trancheId);
  check(
    'возвращённая сумма посчитана',
    tranche?.returnedAmount === '400000.00',
    `${tranche?.returnedAmount}`,
  );
}
{
  const { response, json } = await expert.call('/v1/investments/deals/tranche-returns', {
    method: 'POST',
    body: {
      trancheId: deal.trancheId,
      amount: '700000.00',
      currency: 'RUB',
      occurredOn: '2026-09-19',
      reason: 'возврат сверх суммы транша',
      idempotencyKey: `over-${suffix}`,
    },
  });
  check(
    'возврат сверх суммы транша отклонён как ошибка ввода',
    response.status === 400,
    `статус ${response.status} ${json?.detail ?? ''}`,
  );
  check(
    'отказ объясняет, что суммы не сходятся',
    JSON.stringify(json?.errors ?? {}).includes('превышают'),
    JSON.stringify(json?.errors ?? {}).slice(0, 140),
  );
}
{
  const cancelled = await expert.json(
    `/v1/investments/deals/tranche-returns/${firstReturn.id}/cancel`,
    { method: 'POST', body: { reason: 'ошибочная запись: сумма уточнена' } },
  );
  check('ошибочная запись аннулирована, а не удалена', cancelled.cancelledAt !== null);
  const ledger = await expert.json(`/v1/investments/deals/${deal.agreementId}/ledger`);
  const tranche = ledger.tranches.find((t) => t.id === deal.trancheId);
  check('аннулированная запись не считается возвращённой', tranche?.returnedAmount === '0.00');
  check('история аннулированной записи видна', tranche?.returns.length === 1);
}

// --------------------------------- корректировка комиссии — другое полномочие
{
  const { response, json } = await expert.call('/v1/investments/deals/commission-adjustments', {
    method: 'POST',
    body: {
      accrualId: deal.accrualId,
      kind: 'accrual_reduction',
      party: 'investor',
      amount: '1000.00',
      currency: 'RUB',
      reason: 'попытка без полномочия на комиссию',
      idempotencyKey: `adj-no-cap-${suffix}`,
    },
  });
  check(
    'назначение и возврат не дают права трогать комиссию',
    response.status === 403,
    `статус ${response.status}`,
  );
  check(
    'отказ называет полномочие на уменьшение начисления',
    (json?.detail ?? '').includes('finance.commission.reduce'),
    json?.detail ?? '',
  );
}
await admin.json('/v1/admin/capabilities/grant', {
  method: 'POST',
  body: {
    userId: expertUser.userId,
    capability: 'finance.commission.reduce',
    reason: 'прогон: выдано полномочие уменьшать начисление',
  },
});
{
  const created = await expert.json('/v1/investments/deals/commission-adjustments', {
    method: 'POST',
    body: {
      accrualId: deal.accrualId,
      kind: 'accrual_reduction',
      party: 'investor',
      amount: '30000.00',
      currency: 'RUB',
      reason: 'решение по итогам переговоров: доля инвестора уменьшена',
      idempotencyKey: `adj-1-${suffix}`,
    },
  });
  check('уменьшение начисления зафиксировано', created.kind === 'accrual_reduction');
}
{
  const { response, json } = await expert.call('/v1/investments/deals/commission-adjustments', {
    method: 'POST',
    body: {
      accrualId: deal.accrualId,
      kind: 'paid_refund',
      party: 'investor',
      amount: '30000.00',
      currency: 'RUB',
      reason: 'попытка объявить деньги возвращёнными',
      idempotencyKey: `adj-2-${suffix}`,
    },
  });
  check(
    'возврат уплаченного — отдельное полномочие',
    response.status === 403,
    `статус ${response.status}`,
  );
  check(
    'отказ называет полномочие на возврат уплаченного',
    (json?.detail ?? '').includes('finance.commission.refund_paid'),
    json?.detail ?? '',
  );
}

// --------------------------------------------------- отзыв закрывает действие
await admin.json('/v1/admin/capabilities/revoke', {
  method: 'POST',
  body: {
    userId: expertUser.userId,
    capability: 'finance.tranche_return.record',
    reason: 'прогон: полномочие отозвано',
  },
});
{
  const { response } = await expert.call('/v1/investments/deals/tranche-returns', {
    method: 'POST',
    body: {
      trancheId: deal.trancheId,
      amount: '1000.00',
      currency: 'RUB',
      occurredOn: '2026-09-19',
      reason: 'после отзыва',
      idempotencyKey: `after-revoke-${suffix}`,
    },
  });
  check('после отзыва действие закрыто', response.status === 403, `статус ${response.status}`);
}
{
  const mine = await expert.json('/v1/me/capabilities');
  check(
    'отозванное полномочие исчезло из списка',
    !mine.items.includes('finance.tranche_return.record'),
    mine.items.join(', '),
  );
}

// --------------------------------------------------------------------- аудит
{
  const rows = await sql(
    `SELECT verb FROM audit.events
      WHERE verb IN ('identity.capability.granted','identity.capability.revoked',
                     'investments.tranche_return.recorded','investments.tranche_return.cancelled',
                     'billing.commission.adjusted')
        AND ts > now() - interval '10 minutes'`,
  );
  const verbs = new Set(rows.map((r) => r.verb));
  check('выдача полномочия в аудите', verbs.has('identity.capability.granted'));
  check('отзыв полномочия в аудите', verbs.has('identity.capability.revoked'));
  check('фиксация возврата в аудите', verbs.has('investments.tranche_return.recorded'));
  check('аннулирование записи в аудите', verbs.has('investments.tranche_return.cancelled'));
  check('корректировка комиссии в аудите', verbs.has('billing.commission.adjusted'));
}

console.warn(`\n  Итог: ${passed} OK, ${failed} FAIL\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);
