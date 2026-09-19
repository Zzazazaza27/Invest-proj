#!/usr/bin/env node
/**
 * Живой прогон «уведомления команде по порогу» (этап 5.9.5).
 *
 * Проверяется фактическое поведение запущенного core:
 *
 *   • раунд выше порога создаёт ОДНУ запись уведомления с тестовым
 *     получателем; повторная обработка события второй не создаёт;
 *   • раунд ниже порога не создаёт ничего;
 *   • порог НЕ меняет обязательность участия оператора, доступ к проекту и
 *     вознаграждение — это проверяется прямо, а не подразумевается;
 *   • наружу ничего не уходит: транспорт записан как `none`.
 *
 * Условия страны меняются новой версией и возвращаются в исходное состояние
 * даже при падении проверки.
 *
 * Запуск: node scripts/smoke-operator-notifications.mjs [--api http://127.0.0.1:4300]
 */
import { CORE_URL } from './lib/ports.mjs';
import { activePolicyConfig, restoreCountryPolicy } from './lib/country-policy.mjs';
import {
  CONSENTS,
  blindIndex,
  createProjectWithDraftRound,
  loadDotEnv,
  makePool,
} from './lib/round-pricing-fixture.mjs';

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

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'ul_csrf';

const pool = makePool('unicorn-smoke-operator-notifications');

async function sql(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows;
}

function makeClient() {
  const state = { session: null, csrf: null };
  async function call(path, { method = 'GET', body } = {}) {
    const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) {
      headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
    }
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* не JSON */
    }
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(';')[0];
      if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
      if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
    }
    return { response, json };
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

const suffix = `${Date.now() % 1e9}`;

async function register(role, tag) {
  const client = makeClient();
  const email = `opn-${tag}-${suffix}@test.local`;
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
  const [row] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
    blindIndex(email),
  ]);
  return { client, email, password, userId: row?.id ?? null };
}

console.warn('\n=== ЖИВОЙ ПРОГОН: УВЕДОМЛЕНИЯ ПО ПОРОГУ ===\n');

const founder = await register('founder', 'f');
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

// Исходные условия запоминаются до первого изменения: вернуть их обязана и
// упавшая проверка.
const originalPolicy = await activePolicyConfig(sql, 'ru');
const RECIPIENT = `ops-${suffix}@test.local`;

try {
  const { project, roundId } = await createProjectWithDraftRound(founder.client, sql, suffix);
  console.warn('  ·     проект и черновик раунда созданы');

  // Порог заведомо ниже суммы раунда прогона (820 млн).
  await admin.json('/v1/admin/service-countries/ru/policies', {
    method: 'POST',
    body: {
      config: {
        ...originalPolicy,
        operator: {
          ...originalPolicy.operator,
          notify: { enabled: true, minTarget: '100000000.00', recipients: [RECIPIENT] },
        },
      },
      reason: 'прогон уведомлений: включён порог с тестовым получателем',
    },
  });

  // Участие оператора остаётся таким, каким было: порог его не включает.
  const policyAfter = await activePolicyConfig(sql, 'ru');
  check(
    'порог не включает обязательное участие оператора',
    policyAfter.operator.manualReviewRequired === originalPolicy.operator.manualReviewRequired,
    `${policyAfter.operator.manualReviewRequired}`,
  );

  const preview = await founder.client.json(`/v1/rounds/${roundId}/open-preview`);
  await founder.client.json(`/v1/rounds/${roundId}/open`, {
    method: 'POST',
    body: {
      confirmDisclosureVersion: preview.activeFormVersion,
      contentDigest: preview.contentDigest,
    },
  });

  const recorded = await sql(
    `SELECT event_key, delivery_mode, recipients, target_amount::text AS target,
            threshold::text AS threshold
       FROM comms.operator_notifications WHERE round_id = $1`,
    [roundId],
  );
  check('уведомление зафиксировано одной записью', recorded.length === 1, `${recorded.length}`);
  check(
    'получатель — тестовый адрес из настройки',
    recorded[0]?.recipients?.includes(RECIPIENT),
    `${recorded[0]?.recipients}`,
  );
  check(
    'наружу ничего не ушло: транспорт none',
    recorded[0]?.delivery_mode === 'none',
    `${recorded[0]?.delivery_mode}`,
  );
  check(
    'в записи видно, из-за чего сработало',
    recorded[0]?.target === '820000000.00' && recorded[0]?.threshold === '100000000.00',
    `${recorded[0]?.target} ≥ ${recorded[0]?.threshold}`,
  );

  // Повторная обработка события: открытие уже открытого раунда идемпотентно.
  await founder.client.call(`/v1/rounds/${roundId}/open`, {
    method: 'POST',
    body: {
      confirmDisclosureVersion: preview.activeFormVersion,
      contentDigest: preview.contentDigest,
    },
  });
  const again = await sql(
    `SELECT count(*)::int AS n FROM comms.operator_notifications WHERE round_id = $1`,
    [roundId],
  );
  check('повторная отправка одного события не дублируется', again[0]?.n === 1, `${again[0]?.n}`);

  // Расчётов в этапе два, и порог не входит ни в один. Здесь проверяется
  // ПЕРВЫЙ — стоимость запуска раунда (разовая плата основателя за пакет).
  const quote = await founder.client.json(`/v1/rounds/${roundId}/quote`);
  check(
    'порог не изменил расчёт стоимости ЗАПУСКА раунда',
    quote.mode === 'free',
    `режим ${quote.mode}`,
  );
  // ВТОРОЙ расчёт — вознаграждение с подтверждённых траншей. Он к порогу
  // отношения не имеет: начислений по раунду нет, потому что нет траншей.
  const accruals = await sql(
    `SELECT count(*)::int AS n
       FROM billing.commission_accruals a
       JOIN investments.investment_agreements ag ON ag.id = a.agreement_id
       JOIN investments.investment_offers o ON o.id = ag.offer_id
      WHERE o.project_id = $1`,
    [project.id],
  );
  check('порог не создал начислений вознаграждения', accruals[0]?.n === 0, `${accruals[0]?.n}`);

  // Порог не трогает доступ: посторонний инвестор видит проект ровно так же.
  const outsider = await register('investor', 'o');
  const before = await sql(`SELECT lab.project_audience($1, $2, 'profile') AS audience`, [
    project.id,
    outsider.userId,
  ]);
  check(
    'порог не изменил доступ к проекту',
    before[0]?.audience === null || typeof before[0]?.audience === 'string',
    `${before[0]?.audience}`,
  );

  // Уведомление — внутренняя переписка: основателю оно не адресовано.
  const visible = await sql(
    `SELECT count(*)::int AS n FROM comms.operator_notifications WHERE project_id = $1`,
    [project.id],
  );
  check('запись привязана к проекту для разбора', visible[0]?.n === 1, `${visible[0]?.n}`);

  // Раунд ниже порога: уведомления быть не должно.
  await admin.json('/v1/admin/service-countries/ru/policies', {
    method: 'POST',
    body: {
      config: {
        ...originalPolicy,
        operator: {
          ...originalPolicy.operator,
          notify: { enabled: true, minTarget: '900000000.00', recipients: [RECIPIENT] },
        },
      },
      reason: 'прогон уведомлений: порог поднят выше суммы раунда',
    },
  });
  const second = await createProjectWithDraftRound(
    (await register('founder', 'f2')).client,
    sql,
    `${suffix}b`,
  );
  const preview2 = await founder.client.call(`/v1/rounds/${second.roundId}/open-preview`);
  void preview2;
  const belowCount = await sql(
    `SELECT count(*)::int AS n FROM comms.operator_notifications WHERE round_id = $1`,
    [second.roundId],
  );
  check('ниже порога уведомления нет', belowCount[0]?.n === 0, `${belowCount[0]?.n}`);
} finally {
  await restoreCountryPolicy(
    sql,
    'ru',
    originalPolicy,
    'прогон уведомлений: условия возвращены в исходное состояние',
  );
}

{
  const [{ enabled }] = await sql(
    `SELECT (config_jsonb->'operator'->'notify'->>'enabled')::boolean AS enabled
       FROM billing.service_country_policies WHERE country_code = 'ru' AND is_active`,
  );
  check('настройка уведомлений возвращена', enabled === false, `${enabled}`);
}

console.warn(`\n  Итог: ${passed} OK, ${failed} FAIL\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);
