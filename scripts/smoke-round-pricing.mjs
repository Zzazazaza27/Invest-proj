#!/usr/bin/env node
/**
 * Живой прогон «расчёт стоимости запуска раунда» (этап 5.9.2).
 *
 * Проверяется фактическое поведение запущенного core: расчёт объясняет, какой
 * пакет требуется по сумме, что выбрано сверх, сколько итого и в какой
 * валюте; более полный пакет и докупка разрешены, а пакет с другим набором
 * услуг требуемый не заменяет; при включённых платных пакетах открытие
 * отказывает с ценой, а не проходит бесплатно.
 *
 * Деньги не списываются: покупка не создаётся, счетов нет. Прогон временно
 * включает платные пакеты новой версией условий и в конце возвращает прежнее
 * состояние такой же версией с основанием — условия страны версионируются,
 * «откатить» их иначе нельзя.
 *
 * Запуск: node scripts/smoke-round-pricing.mjs [--api http://127.0.0.1:4300]
 */
import { CORE_URL } from './lib/ports.mjs';
import { activePolicyConfig } from './lib/country-policy.mjs';
import {
  CONSENTS,
  GRID,
  blindIndex,
  closeLeftoverPackages,
  codesFor,
  createProjectWithDraftRound,
  enablePaidPackages,
  loadDotEnv,
  makePool,
  publishGrid,
  restorePolicy,
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

const pool = makePool('unicorn-smoke-round-pricing');

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
  const email = `prc-${tag}-${suffix}@test.local`;
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

async function makeAdmin(user) {
  await sql(
    `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
    [user.userId],
  );
  const client = makeClient();
  await client.json('/v1/auth/login', {
    method: 'POST',
    body: { email: user.email, password: user.password },
  });
  return client;
}

console.warn('\n=== ЖИВОЙ ПРОГОН: РАСЧЁТ СТОИМОСТИ ЗАПУСКА РАУНДА ===\n');

const founder = await register('founder', 'f');
const admin = await makeAdmin(await register('founder', 'a'));
const codes = codesFor(suffix);

// Исходные условия страны запоминаются ДО первого изменения: вернуть их
// обязан даже упавший прогон, иначе следующая проверка увидит чужое
// состояние. История версий при этом растёт — для локальных тестовых данных
// это норма, переписывать версии нельзя.
const originalPolicy = await activePolicyConfig(sql, 'ru');

await closeLeftoverPackages(sql);
const { roundId } = await createProjectWithDraftRound(founder.client, sql, suffix);
console.warn(`  ·     проект и черновик раунда на ${GRID.target} RUB созданы`);

// ------------------------------------------- расчёт при выключенных пакетах
{
  const quote = await founder.client.json(`/v1/rounds/${roundId}/quote`);
  check('пока пакеты выключены — запуск бесплатен', quote.mode === 'free', `режим ${quote.mode}`);
  check('итог нулевой', quote.total === '0.00', quote.total);
  check(
    'объяснение говорит о бесплатности',
    quote.explanation[0]?.includes('бесплат'),
    quote.explanation[0],
  );
}
{
  const outsider = await register('investor', 'o');
  const { response } = await outsider.client.call(`/v1/rounds/${roundId}/quote`);
  check('посторонний расчёт не видит', response.status === 403, `статус ${response.status}`);
}

try {
  await publishGrid(admin, codes);
  console.warn('  ·     сетка прогона опубликована (три пакета, одна цена докупки)');
  await enablePaidPackages(admin, sql);

  {
    const quote = await founder.client.json(`/v1/rounds/${roundId}/quote`);
    check('режим стал платным', quote.mode === 'priced', `режим ${quote.mode}`);
    check(
      'требуемый пакет определён по диапазону',
      quote.requiredPackage?.code === codes.pkgSmall,
      `${quote.requiredPackage?.code}`,
    );
    check('итог равен цене требуемого пакета', quote.total === GRID.smallPrice, quote.total);
    check('валюта названа', quote.currency === 'RUB', quote.currency);
    check(
      'объяснение называет пакет и итог',
      quote.explanation.some((line) => line.includes('Малый (прогон)')) &&
        quote.explanation.at(-1) === `Итого: ${GRID.smallPrice} RUB.`,
      quote.explanation.join(' | ').slice(0, 120),
    );
    check(
      'строка счёта помечена как требуемый пакет',
      quote.lines[0]?.role === 'required_package',
      `${quote.lines[0]?.role}`,
    );
  }
  {
    const quote = await founder.client.json(
      `/v1/rounds/${roundId}/quote?packageCode=${codes.pkgFull}`,
    );
    check('более полный пакет выбрать можно', quote.mode === 'priced', `режим ${quote.mode}`);
    check(
      'в счёт попал выбранный пакет',
      quote.chosenPackage?.code === codes.pkgFull,
      `${quote.chosenPackage?.code}`,
    );
    check('итог по выбранному пакету', quote.total === GRID.fullPrice, quote.total);
    check(
      'объяснение называет выбор более полного',
      quote.explanation.some((line) => line.includes('более полный')),
      quote.explanation.join(' | ').slice(0, 120),
    );
  }
  {
    const quote = await founder.client.json(
      `/v1/rounds/${roundId}/quote?packageCode=${codes.pkgSide}`,
    );
    check('дороже не значит полнее', quote.mode === 'blocked', `режим ${quote.mode}`);
    check(
      'отказ называет недостающее',
      quote.blockers[0]?.message.includes('не включает всё'),
      quote.blockers[0]?.message,
    );
  }
  {
    const quote = await founder.client.json(
      `/v1/rounds/${roundId}/quote?serviceCodes=${codes.svcOther}`,
    );
    check('докупка услуги считается', quote.mode === 'priced', `режим ${quote.mode}`);
    check('итог — пакет плюс услуга', quote.total === '22000.00', quote.total);
    check(
      'докупка видна отдельной строкой',
      quote.lines.some((line) => line.role === 'extra_service' && line.code === codes.svcOther),
      quote.lines.map((l) => l.role).join(','),
    );
  }
  {
    const quote = await founder.client.json(
      `/v1/rounds/${roundId}/quote?serviceCodes=${codes.svcBase}`,
    );
    check(
      'входящая в пакет услуга второй раз не оплачивается',
      quote.mode === 'blocked' && quote.blockers[0]?.message.includes('уже входит'),
      quote.blockers[0]?.message,
    );
  }

  // --------------------------------------------------- гейт трёх маршрутов
  {
    const preview = await founder.client.json(`/v1/rounds/${roundId}/open-preview`);
    const { response, json } = await founder.client.call(`/v1/rounds/${roundId}/open`, {
      method: 'POST',
      body: {
        confirmDisclosureVersion: preview.activeFormVersion,
        contentDigest: preview.contentDigest,
      },
    });
    check(
      'открытие платного раунда отклонено',
      response.status === 400,
      `статус ${response.status}`,
    );
    const message = JSON.stringify(json?.errors ?? json ?? {});
    check(
      'отказ называет цену, а не «не реализовано»',
      message.includes(GRID.smallPrice),
      message.slice(0, 160),
    );
  }
  {
    const [row] = await sql(`SELECT status FROM lab.funding_rounds WHERE id = $1`, [roundId]);
    check('раунд остался черновиком', row?.status === 'draft', `${row?.status}`);
  }
  {
    const [live] = await sql(
      `SELECT count(*)::int AS n FROM billing.round_purchases WHERE round_id = $1`,
      [roundId],
    );
    check('покупка не создавалась: продажи выключены', live?.n === 0, `${live?.n}`);
  }
} finally {
  await restorePolicy(sql, originalPolicy);
}

{
  const [{ enabled }] = await sql(
    `SELECT (config_jsonb->'paidPackages'->>'enabled')::boolean AS enabled
       FROM billing.service_country_policies WHERE country_code = 'ru' AND is_active`,
  );
  check('платные пакеты снова выключены', enabled === false, `${enabled}`);
}
{
  const quote = await founder.client.json(`/v1/rounds/${roundId}/quote`);
  check('расчёт снова бесплатный', quote.mode === 'free', `режим ${quote.mode}`);
}

console.warn(`\n  Итог: ${passed} OK, ${failed} FAIL\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);
