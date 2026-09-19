#!/usr/bin/env node
/**
 * Рендер-проверка «стоимость запуска раунда» в кабинете основателя (5.9.2).
 *
 * Что проверяется: пока запуск бесплатен, раздела про деньги в кабинете нет
 * (иначе висел бы разговор об оплате, которой не существует); при включённых
 * платных пакетах основатель видит требуемый пакет, итог с валютой и прямое
 * предупреждение, что оплата ещё не подключена; попытка открыть раунд
 * отказывает с ценой, а не с «не реализовано».
 *
 * Ничего не покупается. Условия страны включаются новой версией и
 * возвращаются такой же версией с основанием; версии пакетов прогона
 * закрываются. Снимки — `out/render-lab-round-cost/`.
 *
 * Запуск: LAB_URL=http://127.0.0.1/lab/ node scripts/render-check-lab-round-cost.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL as DEFAULT_CORE_URL, frontendUrl } from './lib/ports.mjs';
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const LAB_URL = process.env.LAB_URL ?? frontendUrl('lab');
const CORE_URL = process.env.CORE_URL ?? DEFAULT_CORE_URL;
const OUT = join(ROOT, 'out', 'render-lab-round-cost');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

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

const pool = makePool('unicorn-render-lab-round-cost');
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

function makeClient() {
  const state = { session: null, csrf: null };
  async function call(path, { method = 'GET', body } = {}) {
    const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) {
      headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
    }
    const response = await fetch(`${CORE_URL}${path}`, {
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
  const email = `rlc-${tag}-${suffix}@test.local`;
  const password = `Pw-${crypto.randomUUID()}`;
  await client.json('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: `Проверка ${tag}`,
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

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: СТОИМОСТЬ ЗАПУСКА РАУНДА (5.9.2) ===\n');

const founder = await register('founder', 'f');
const adminUser = await register('founder', 'a');
await sql(`INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin')`, [
  adminUser.userId,
]);
const admin = makeClient();
await admin.json('/v1/auth/login', {
  method: 'POST',
  body: { email: adminUser.email, password: adminUser.password },
});

// Экран раунда живёт в мастере v2: флаг включается на время прогона и
// возвращается в исходное состояние в конце.
const [flagBefore] = await sql(
  `SELECT enabled FROM audit.feature_flags WHERE key = 'lab.ui.application_v2'`,
);
await sql(`UPDATE audit.feature_flags SET enabled = true WHERE key = 'lab.ui.application_v2'`);

const codes = codesFor(suffix);
await closeLeftoverPackages(sql);
const { application, roundId } = await createProjectWithDraftRound(founder.client, sql, suffix);
await publishGrid(admin, codes);

const browser = await chromium.launch();
const page = await (
  await browser.newContext({ viewport: { width: 1280, height: 1000 } })
).newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  // 400 сценарий вызывает намеренно (платное открытие), 401/403/404 — обычный
  // ответ до входа: это не поломка страницы.
  if (/\b(400|401|403|404) \(/.test(message.text())) return;
  consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

let shot = 0;
async function screenshot(name) {
  shot += 1;
  await page.screenshot({
    path: join(OUT, `${String(shot).padStart(2, '0')}-${name}.png`),
    fullPage: true,
  });
}

const ROUND_URL = `${LAB_URL.replace(/\/$/, '')}/applications/${application.id}/round`;

async function openRoundScreen() {
  await page.goto(ROUND_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForSelector('[data-round-country]', { timeout: 20_000 });
}

let previousPolicy = null;
try {
  console.warn('[1] Вход и экран раунда при бесплатном запуске');
  await page.goto(LAB_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.fill('#email', founder.email);
  await page.fill('#password', founder.password);
  await page.getByRole('button', { name: /Войти/i }).click();
  await page.waitForSelector('text=Проекты', { timeout: 20_000 });
  await openRoundScreen();
  check(
    'пока бесплатно — раздела про стоимость нет',
    (await page.locator('[data-round-cost]').count()) === 0,
  );
  check(
    'условия страны прямо говорят о бесплатности',
    (await page.locator('[data-round-country]').innerText()).includes('бесплатн'),
  );
  await screenshot('free');

  console.warn('\n[2] Платные пакеты включены: стоимость объяснена');
  previousPolicy = await enablePaidPackages(admin, sql);
  await openRoundScreen();
  await page.waitForSelector('[data-round-cost="priced"]', { timeout: 20_000 });
  const cost = await page.locator('[data-round-cost]').innerText();
  check('назван требуемый пакет', cost.includes('Малый (прогон)'), cost.split('\n')[1] ?? '');
  check('назван итог', /Итого:/.test(cost), cost.split('\n').at(-2) ?? '');
  check(
    'итог в валюте раунда',
    cost.includes('15') && /₽|RUB/.test(cost),
    cost.replace(/\n/g, ' | ').slice(0, 160),
  );
  check(
    'сказано, что оплата не подключена',
    cost.includes('Оплата запуска ещё не подключена'),
    cost.split('\n').at(-1) ?? '',
  );
  await screenshot('priced');

  console.warn('\n[3] Открытие отказывает с ценой');
  const preview = await founder.client.json(`/v1/rounds/${roundId}/open-preview`);
  const { response, json } = await founder.client.call(`/v1/rounds/${roundId}/open`, {
    method: 'POST',
    body: {
      confirmDisclosureVersion: preview.activeFormVersion,
      contentDigest: preview.contentDigest,
    },
  });
  check('открытие отклонено', response.status === 400, `статус ${response.status}`);
  check(
    'в отказе есть цена',
    JSON.stringify(json?.errors ?? json ?? {}).includes(GRID.smallPrice),
    JSON.stringify(json?.errors ?? {}).slice(0, 140),
  );

  console.warn('\n[4] Возврат условий: раздел про деньги исчезает');
  await restorePolicy(admin, sql, previousPolicy);
  previousPolicy = null;
  await openRoundScreen();
  check(
    'после возврата условий стоимости снова нет',
    (await page.locator('[data-round-cost]').count()) === 0,
  );
  await screenshot('free-again');

  check('ошибок в консоли нет', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  if (previousPolicy) await restorePolicy(admin, sql, previousPolicy);
  await sql(`UPDATE audit.feature_flags SET enabled = $1 WHERE key = 'lab.ui.application_v2'`, [
    flagBefore?.enabled ?? false,
  ]);
  await browser.close();
  await pool.end();
}

console.warn(`\n  Снимки: ${OUT}`);
console.warn(`  Итог: ${passed} OK, ${failed} FAIL\n`);
process.exit(failed === 0 ? 0 : 1);
