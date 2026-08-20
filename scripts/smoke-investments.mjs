#!/usr/bin/env node
/**
 * Живой прогон регулируемого контура.
 *
 * Проверяется главное: контур выключен по умолчанию; предложение размещает
 * только владелец проекта от проверенного юрлица; приём предложения требует
 * второго фактора; вознаграждение начисляется ровно один раз, на ПОЛНУЮ сумму
 * договора, и только после подтверждённого банковского события.
 *
 * Часть шагов выполняется фикстурами в БД — те, что через API в dev пройти
 * нельзя: приём и подписание договора требуют step-up MFA, которого локальный
 * адаптер аутентификации не выдаёт. Это ограничение среды, а не обход правила:
 * сам факт отказа без второго фактора проверяется отдельно.
 *
 * Запуск: node scripts/smoke-investments.mjs
 */
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const BASE = CORE_URL;
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

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

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
  return { call };
}

const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));
const suffix = `${Date.now() % 1e9}`;

function blindIndex(email) {
  return createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
}

async function register(role, tag) {
  const client = makeClient();
  const email = `inv-${tag}-${suffix}@test.local`;
  const password = `Pw-${randomUUID()}`;
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
  if (response.status >= 400) throw new Error(`регистрация ${tag}: ${JSON.stringify(json)}`);
  const [row] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
    blindIndex(email),
  ]);
  return { client, email, password, userId: row.id };
}

console.warn('\n=== ЖИВОЙ ПРОГОН: РЕГУЛИРУЕМЫЙ КОНТУР ===\n');

const founder = await register('founder', 'f');
const investor = await register('investor', 'i');
// Второй инвестор нужен ровно для одной проверки: чужой ключ идемпотентности
// не должен мешать чужой сделке (M019).
const investor2 = await register('investor', 'i2');
const adminUser = await register('founder', 'a');
await sql(
  `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
  [adminUser.userId],
);
const admin = makeClient();
await admin.call('/v1/auth/login', {
  method: 'POST',
  body: { email: adminUser.email, password: adminUser.password },
});

// Предусловия: проект с одобренным KYC владельца, проверенное юрлицо, подписки.
const [taxonomy] = await sql(`SELECT id FROM lab.project_taxonomy WHERE slug = 'fintech'`);
const [{ id: projectId }] = await sql(
  `INSERT INTO lab.projects (id, taxonomy_id, title, stage, investment_ask, required_plan_id)
   VALUES (public.uuid_generate_v7(), $1, 'Проект регулируемого контура', 'growth', 5000000,
           billing.resolve_founder_plan(5000000))
   RETURNING id`,
  [taxonomy.id],
);
await sql(
  `INSERT INTO lab.founders_projects (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
  [projectId, founder.userId],
);
for (const person of [investor, investor2]) {
  await sql(
    `INSERT INTO kyc.kyc_verifications
     (id, user_id, kind, status, risk_level, sanctions_status, reviewed_by, decided_at)
   VALUES (public.uuid_generate_v7(), $1, 'identity', 'approved', 'low', 'clear', $2, now())`,
    [person.userId, adminUser.userId],
  );
}
const [{ id: entityId }] = await sql(
  `INSERT INTO kyc.business_entities
     (id, legal_name, inn_ciphertext, entity_wrapped_dek, inn_hmac, jurisdiction,
      registry_status, owner_user_id)
   VALUES (public.uuid_generate_v7(), 'ООО «Эмитент»', '\\x00'::bytea, '\\x00'::bytea,
           digest($2, 'sha256'), 'RU', 'active', $1)
   RETURNING id`,
  [founder.userId, `inn-${suffix}`],
);
await sql(
  `INSERT INTO kyc.entity_members (entity_id, user_id, member_role, verified_at)
   VALUES ($1, $2, 'signatory', now())`,
  [entityId, founder.userId],
);
await sql(
  `INSERT INTO kyc.kyb_verifications
     (id, entity_id, kind, status, reviewed_by, decided_at)
   VALUES (public.uuid_generate_v7(), $1, 'registry_check', 'approved', $2, now())`,
  [entityId, adminUser.userId],
);
await sql(
  `INSERT INTO billing.subscriptions
     (id, user_id, plan_id, price_snapshot, terms_version, status, current_period_end)
   SELECT public.uuid_generate_v7(), $1, sp.id, sp.price, 'v1', 'active', now() + interval '30 days'
     FROM billing.subscription_plans sp WHERE sp.code = 'investor_membership'`,
  [investor.userId],
);

// Прогон, прерванный на середине, мог оставить флаги включёнными. Приводим к
// исходному состоянию ЯВНО и громко: иначе следующая проверка «контур закрыт»
// молча проверяла бы не то, что заявлено.
for (const key of ['investments.enabled', 'investments.instrument.loan']) {
  const [flag] = await sql('SELECT enabled FROM audit.feature_flags WHERE key = $1', [key]);
  if (flag?.enabled) {
    console.warn(`  ВНИМАНИЕ: флаг ${key} остался включённым от прошлого прогона — выключаю`);
    await admin.call(`/v1/admin/feature-flags/${key}`, {
      method: 'PATCH',
      body: { enabled: false, reason: 'сброс состояния перед прогоном' },
    });
  }
}

// Всё, что ниже, обязано вернуть контур в выключенное состояние даже при
// падении: включённый регулируемый контур — это не «остаток от теста».
try {
  // ----------------------------------------------- контур выключен по умолчанию
  {
    const { response, json } = await founder.client.call('/v1/investments/offers', {
      method: 'POST',
      body: {
        projectId,
        issuerEntityId: entityId,
        instrumentType: 'loan',
        targetAmount: '3000000.00',
        minInvestment: '100000.00',
        terms: { rate: '18%' },
      },
    });
    check(
      'регулируемый контур закрыт фичефлагом',
      response.status === 503 && json?.code === 'feature_disabled',
      `статус ${response.status} ${json?.code ?? ''}`,
    );
  }

  // Включаем контур через админский API — как это делал бы оператор после гейта A.
  await admin.call('/v1/admin/feature-flags/investments.enabled', {
    method: 'PATCH',
    body: { enabled: true, reason: 'живой прогон регулируемого контура' },
  });
  await admin.call('/v1/admin/feature-flags/investments.instrument.loan', {
    method: 'PATCH',
    body: { enabled: true, reason: 'живой прогон: заём' },
  });

  // -------------------------------------------------------------- предложение
  let offerId;
  {
    const { response, json } = await investor.client.call('/v1/investments/offers', {
      method: 'POST',
      body: {
        projectId,
        issuerEntityId: entityId,
        instrumentType: 'loan',
        targetAmount: '3000000.00',
        minInvestment: '100000.00',
        terms: { rate: '18%' },
      },
    });
    check(
      'посторонний не размещает предложение по чужому проекту',
      response.status === 403,
      `статус ${response.status} ${json?.code ?? ''}`,
    );
  }
  {
    const { response, json } = await founder.client.call('/v1/investments/offers', {
      method: 'POST',
      body: {
        projectId,
        issuerEntityId: entityId,
        instrumentType: 'loan',
        targetAmount: '3000000.00',
        minInvestment: '100000.00',
        terms: { rate: '18%' },
      },
    });
    offerId = json?.id;
    check(
      'ЛПИ создал предложение',
      response.status === 201 || response.status === 200,
      `статус ${response.status} ${json?.code ?? ''}`,
    );
    check('предложение в статусе draft', json?.status === 'draft', json?.status ?? '');
    check('версия Правил зафиксирована', typeof json?.rulesVersion === 'string');

    const [doc] = await sql(
      'SELECT document_s3_key, document_sha256 FROM investments.investment_offers WHERE id = $1',
      [offerId],
    );
    check('документ предложения сохранён в хранилище', Boolean(doc?.document_s3_key));
    check('отпечаток документа записан', Buffer.isBuffer(doc?.document_sha256));
  }
  {
    const { response } = await founder.client.call(`/v1/investments/offers/${offerId}/publish`, {
      method: 'POST',
      body: {},
    });
    check('ЛПИ не публикует предложение сам', response.status === 403, `статус ${response.status}`);
  }
  {
    const { response, json } = await admin.call(`/v1/investments/offers/${offerId}/publish`, {
      method: 'POST',
      body: {},
    });
    check(
      'комплаенс опубликовал предложение',
      (response.status === 200 || response.status === 201) && json?.status === 'published',
      `статус ${response.status} ${json?.status ?? ''}`,
    );
  }

  // ------------------------------------- видимость опубликованного предложения
  // Позитивный контроль: подписка — это не украшение каталога, а условие
  // доступа. Проверяем на реальном ответе API, а не по тексту политики.
  {
    const { json } = await investor.client.call('/v1/investments/offers');
    check(
      'подписчик видит опубликованное предложение',
      (json?.items ?? []).some((o) => o.id === offerId),
      `предложений ${(json?.items ?? []).length}`,
    );

    await sql(`UPDATE billing.subscriptions SET status = 'expired' WHERE user_id = $1`, [
      investor.userId,
    ]);
    const withoutSub = await investor.client.call('/v1/investments/offers');
    check(
      'без активной подписки предложение не видно',
      !(withoutSub.json?.items ?? []).some((o) => o.id === offerId),
      `предложений ${(withoutSub.json?.items ?? []).length}`,
    );
    await sql(`UPDATE billing.subscriptions SET status = 'active' WHERE user_id = $1`, [
      investor.userId,
    ]);
  }

  // ------------------------------------------------ приём требует второго фактора
  {
    const { response, json } = await investor.client.call('/v1/investments/agreements', {
      method: 'POST',
      body: { offerId, amount: '1000000.00', idempotencyKey: `acc-${suffix}-${randomUUID()}` },
    });
    check(
      'приём предложения требует step-up MFA',
      response.status === 403 && json?.code === 'step_up_required',
      `статус ${response.status} ${json?.code ?? ''}`,
    );
  }

  // Договор и подписи — фикстурой: через API они закрыты вторым фактором.
  const [{ id: feeScheduleId }] = await sql(
    `SELECT id FROM billing.fee_schedules WHERE code = 'operator_success_fee'
    AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
    ORDER BY version DESC LIMIT 1`,
  );
  const [{ id: agreementId }] = await sql(
    `INSERT INTO investments.investment_agreements
     (id, offer_id, investor_id, contract_amount, fee_schedule_id,
      document_s3_key, document_sha256, document_wrapped_dek, status, idempotency_key)
   VALUES (public.uuid_generate_v7(), $1, $2, 1000000, $3, 'k', '\\x00'::bytea, '\\x00'::bytea,
           'pending_signatures', $4)
   RETURNING id`,
    [offerId, investor.userId, feeScheduleId, `fixture-${suffix}`],
  );
  await sql(
    `UPDATE investments.investment_agreements
      SET investor_signed_at = now(), issuer_signed_at = now(), status = 'signed'
    WHERE id = $1`,
    [agreementId],
  );

  // ------------------------------ ключ идемпотентности принадлежит инвестору
  // Позитивный контроль к M019: тот же ключ у ДРУГОГО инвестора обязан
  // проходить (иначе посторонний блокирует чужую сделку), а повтор у того же —
  // отвергаться уникальным индексом.
  {
    let foreignOk = false;
    try {
      await sql(
        `INSERT INTO investments.investment_agreements
           (id, offer_id, investor_id, contract_amount, fee_schedule_id,
            document_s3_key, document_sha256, document_wrapped_dek, status, idempotency_key)
         VALUES (public.uuid_generate_v7(), $1, $2, 100000, $3, 'k', '\\x00'::bytea, '\\x00'::bytea,
                 'pending_signatures', $4)`,
        [offerId, investor2.userId, feeScheduleId, `fixture-${suffix}`],
      );
      foreignOk = true;
    } catch (error) {
      foreignOk = false;
      void error;
    }
    check('чужой ключ идемпотентности не блокирует другого инвестора', foreignOk);

    let ownDuplicateRejected = false;
    try {
      await sql(
        `INSERT INTO investments.investment_agreements
           (id, offer_id, investor_id, contract_amount, fee_schedule_id,
            document_s3_key, document_sha256, document_wrapped_dek, status, idempotency_key)
         VALUES (public.uuid_generate_v7(), $1, $2, 100000, $3, 'k', '\\x00'::bytea, '\\x00'::bytea,
                 'pending_signatures', $4)`,
        [offerId, investor.userId, feeScheduleId, `fixture-${suffix}`],
      );
    } catch (error) {
      ownDuplicateRejected = error.code === '23505';
    }
    check('повтор своего ключа отвергается', ownDuplicateRejected);
  }

  // Позитивный контроль на IDOR: договор видят только его стороны.
  {
    const own = await investor.client.call('/v1/investments/agreements');
    check(
      'инвестор видит свой договор',
      (own.json?.items ?? []).some((a) => a.id === agreementId),
    );
    const foreign = await investor2.client.call('/v1/investments/agreements');
    check(
      'посторонний не видит чужой договор',
      !(foreign.json?.items ?? []).some((a) => a.id === agreementId),
      `видно договоров ${(foreign.json?.items ?? []).length}`,
    );
  }

  // ------------------------------------------- подтверждение первого транша
  const bankRef = `BANK-${suffix}`;
  {
    const { response, json } = await investor.client.call('/v1/investments/tranches/confirm', {
      method: 'POST',
      body: {
        agreementId,
        bankTransactionRef: bankRef,
        amount: '300000.00',
        bookedAt: new Date().toISOString(),
        statementSha256: 'a'.repeat(64),
      },
    });
    check(
      'инвестор не может подтвердить транш сам',
      response.status === 403,
      `статус ${response.status} ${json?.code ?? ''}`,
    );
  }
  let accrualId;
  {
    const { response, json } = await admin.call('/v1/investments/tranches/confirm', {
      method: 'POST',
      body: {
        agreementId,
        bankTransactionRef: bankRef,
        amount: '300000.00',
        bookedAt: new Date().toISOString(),
        statementSha256: 'a'.repeat(64),
      },
    });
    accrualId = json?.accrualId;
    check(
      'первый транш подтверждён банковским событием',
      response.status === 201 || response.status === 200,
      `статус ${response.status} ${json?.code ?? ''}`,
    );
    check('начисление создано', Boolean(accrualId));
    check('событие обработано впервые', json?.alreadyProcessed === false);
  }
  {
    const [agreement] = await sql(
      `SELECT status, effective_at FROM investments.investment_agreements WHERE id = $1`,
      [agreementId],
    );
    check('договор вступил в силу', agreement?.status === 'effective', agreement?.status ?? '');
    check('момент вступления в силу зафиксирован', Boolean(agreement?.effective_at));
  }
  {
    const [accrual] = await sql(
      `SELECT base_amount::text AS base, investor_fee_amount::text AS inv,
            issuer_fee_amount::text AS iss
       FROM billing.commission_accruals WHERE id = $1`,
      [accrualId],
    );
    check(
      'база начисления — ПОЛНАЯ сумма договора, а не транша',
      accrual?.base === '1000000.00',
      `база ${accrual?.base}, транш 300000.00`,
    );
    check('вознаграждение инвестора 10%', accrual?.inv === '100000.00', accrual?.inv ?? '');
    check('вознаграждение ЛПИ 5%', accrual?.iss === '50000.00', accrual?.iss ?? '');
  }
  {
    const { json } = await admin.call('/v1/investments/tranches/confirm', {
      method: 'POST',
      body: {
        agreementId,
        bankTransactionRef: bankRef,
        amount: '300000.00',
        bookedAt: new Date().toISOString(),
        statementSha256: 'a'.repeat(64),
      },
    });
    check('повторная доставка события идемпотентна', json?.alreadyProcessed === true);

    const accruals = await sql(
      'SELECT id FROM billing.commission_accruals WHERE agreement_id = $1',
      [agreementId],
    );
    check(
      'начисление осталось единственным',
      accruals.length === 1,
      `начислений ${accruals.length}`,
    );
  }
  {
    // Второй транш не создаёт нового начисления и не меняет базу.
    const { json } = await admin.call('/v1/investments/tranches/confirm', {
      method: 'POST',
      body: {
        agreementId,
        bankTransactionRef: `${bankRef}-2`,
        amount: '700000.00',
        bookedAt: new Date().toISOString(),
        statementSha256: 'b'.repeat(64),
      },
    });
    void json;
    const accruals = await sql(
      'SELECT base_amount::text AS base FROM billing.commission_accruals WHERE agreement_id = $1',
      [agreementId],
    );
    check(
      'последующий транш не создаёт второго начисления',
      accruals.length === 1 && accruals[0]?.base === '1000000.00',
      `начислений ${accruals.length}`,
    );
  }

  // ------------------------------------------------------------------ журнал
  {
    const verbs = (
      await sql(
        `SELECT DISTINCT verb FROM audit.events WHERE verb LIKE 'investment.%' OR verb LIKE 'billing.commission%'`,
      )
    ).map((r) => r.verb);
    check('создание предложения в журнале', verbs.includes('investment.offer.created'));
    check('публикация предложения в журнале', verbs.includes('investment.offer.published'));
    check('подтверждение транша в журнале', verbs.includes('investment.first_tranche.confirmed'));
    check('начисление вознаграждения в журнале', verbs.includes('billing.commission.accrued'));

    const broken = await sql('SELECT * FROM audit.verify_event_chain(NULL)');
    check('цепочка журнала цела', broken.length === 0, `разрывов ${broken.length}`);
  }
} finally {
  // Возвращаем контур в исходное выключенное состояние: прогон не должен
  // оставлять платформу с включённым регулируемым контуром.
  await admin.call('/v1/admin/feature-flags/investments.instrument.loan', {
    method: 'PATCH',
    body: { enabled: false, reason: 'возврат после прогона' },
  });
  await admin.call('/v1/admin/feature-flags/investments.enabled', {
    method: 'PATCH',
    body: { enabled: false, reason: 'возврат после прогона' },
  });
}
{
  const [flag] = await sql(
    `SELECT enabled FROM audit.feature_flags WHERE key = 'investments.enabled'`,
  );
  check('контур снова выключен', flag?.enabled === false);
}

console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено.\n`);
await pool.end();
if (failed > 0) process.exitCode = 1;
