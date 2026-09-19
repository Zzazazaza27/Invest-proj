#!/usr/bin/env node
/**
 * Рендер-проверка сквозного сценария покупки (5.9.7).
 *
 * Проходит путь в браузере под ДВУМЯ ролями: основатель выбирает пакет и
 * оформляет покупку, администратор подтверждает тестовую оплату и отмечает
 * выполнение услуг, основатель открывает раунд.
 *
 * Что здесь проверяется помимо «кнопки нажимаются»: экран основателя честно
 * говорит, чего не хватает для открытия, и это сообщение меняется по мере
 * выполнения условий. Настоящих платежей нет — оплата подтверждается тестовым
 * действием, и покупка помечается тестовой.
 *
 * Условия страны и флаг возвращаются в исходное состояние даже при падении.
 * Снимки — `out/render-round-purchase/`.
 *
 * Запуск: LAB_URL=http://127.0.0.1/lab/ ADMIN_URL=http://127.0.0.1/admin/ \
 *         node scripts/render-check-round-purchase.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL as DEFAULT_CORE_URL, frontendUrl } from './lib/ports.mjs';
import { activePolicyConfig, restoreCountryPolicy } from './lib/country-policy.mjs';
import {
  CONSENTS,
  GRID,
  blindIndex,
  closeLeftoverPackages,
  codesFor,
  createProjectWithDraftRound,
  loadDotEnv,
  makePool,
} from './lib/round-pricing-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const LAB_URL = process.env.LAB_URL ?? frontendUrl('lab');
const ADMIN_URL = process.env.ADMIN_URL ?? frontendUrl('admin');
const CORE_URL = process.env.CORE_URL ?? DEFAULT_CORE_URL;
const OUT = join(ROOT, 'out', 'render-round-purchase');
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

const pool = makePool('unicorn-render-round-purchase');
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

async function register(tag) {
  const client = makeClient();
  const email = `rpu-${tag}-${suffix}@test.local`;
  const password = `Pw-${crypto.randomUUID()}`;
  await client.json('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: `Проверка ${tag}`,
      role: 'founder',
      locale: 'ru-RU',
      consents: CONSENTS,
    },
  });
  const [row] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
    blindIndex(email),
  ]);
  return { client, email, password, userId: row.id };
}

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: ПОКУПКА ЗАПУСКА РАУНДА (5.9.7) ===\n');

const founder = await register('f');
const adminUser = await register('a');
await sql(`INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin')`, [
  adminUser.userId,
]);
const admin = makeClient();
await admin.json('/v1/auth/login', {
  method: 'POST',
  body: { email: adminUser.email, password: adminUser.password },
});

const codes = codesFor(suffix);
const originalPolicy = await activePolicyConfig(sql, 'ru');
const [flagBefore] = await sql(
  `SELECT enabled FROM audit.feature_flags WHERE key = 'billing.test_payment_confirmation'`,
);
const [v2Before] = await sql(
  `SELECT enabled FROM audit.feature_flags WHERE key = 'lab.ui.application_v2'`,
);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  if (/\b(400|401|403|404|409|503) \(/.test(message.text())) return;
  consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));
page.on('dialog', (dialog) => void dialog.accept('рендер-проверка: услуга выполнена сотрудником'));

let shot = 0;
async function screenshot(name) {
  shot += 1;
  await page.screenshot({
    path: join(OUT, `${String(shot).padStart(2, '0')}-${name}.png`),
    fullPage: true,
  });
}

try {
  await sql(`UPDATE audit.feature_flags SET enabled = true WHERE key = 'lab.ui.application_v2'`);
  await sql(
    `UPDATE audit.feature_flags SET enabled = true WHERE key = 'billing.test_payment_confirmation'`,
  );
  await closeLeftoverPackages(sql);

  // Сетка прогона: услуги выполняются руками сотрудника, поэтому отметка
  // «выполнено» здесь — настоящее действие человека.
  for (const [code, name] of [
    [codes.svcBase, 'Проверка комплектности документов (прогон)'],
    [codes.svcExtra, 'Сверка реквизитов юрлица (прогон)'],
  ]) {
    const service = await admin.json('/v1/admin/round-services', {
      method: 'POST',
      body: { code, name },
    });
    await admin.json(`/v1/admin/round-services/${service.id}`, {
      method: 'PATCH',
      body: { isImplemented: true, reason: 'проверка: услуга выполняется вручную' },
    });
  }
  const required = await admin.json('/v1/admin/round-packages', {
    method: 'POST',
    body: {
      code: codes.pkgSmall,
      countryCode: 'ru',
      name: 'Требуемый (проверка)',
      price: GRID.smallPrice,
      currency: 'RUB',
      minTarget: GRID.smallFrom,
      maxTarget: GRID.smallTo,
      serviceCodes: [codes.svcBase],
      reason: 'проверка: требуемый пакет',
    },
  });
  const alternative = await admin.json('/v1/admin/round-packages', {
    method: 'POST',
    body: {
      code: codes.pkgFull,
      countryCode: 'ru',
      name: 'Расширенный (проверка)',
      price: GRID.fullPrice,
      currency: 'RUB',
      minTarget: GRID.smallTo,
      maxTarget: GRID.fullTo,
      serviceCodes: [codes.svcBase, codes.svcExtra],
      reason: 'проверка: разрешённая замена',
    },
  });

  const { application, roundId } = await createProjectWithDraftRound(founder.client, sql, suffix);
  await admin.json('/v1/admin/service-countries/ru/policies', {
    method: 'POST',
    body: {
      config: { ...originalPolicy, paidPackages: { enabled: true } },
      reason: 'проверка покупки: включены платные пакеты',
    },
  });

  console.warn('[1] Администратор назначает допустимую замену');
  await page.goto(ADMIN_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.fill('#email', adminUser.email);
  await page.fill('#password', adminUser.password);
  await page.getByRole('button', { name: /Войти/i }).click();
  await page.waitForSelector('text=Тарифы', { timeout: 20_000 });
  await page.getByRole('link', { name: 'Пакеты раунда', exact: true }).click();
  await page.waitForSelector('[data-package-alternatives]', { timeout: 20_000 });
  await page.selectOption('#alt-package', required.id);
  await page.selectOption('#alt-alternative', alternative.id);
  await page.getByRole('button', { name: 'Назначить замену' }).click();
  await page.waitForFunction(
    /* eslint-disable no-undef */
    (code) =>
      (document.querySelector(`[data-alternatives-of="${code}"]`)?.textContent ?? '').includes(
        'Расширенный',
      ),
    /* eslint-enable no-undef */
    codes.pkgSmall,
    { timeout: 20_000 },
  );
  check('замена назначена и видна администратору', true);
  await screenshot('admin-alternatives');

  console.warn('\n[2] Основатель оформляет покупку');
  const roundUrl = `${LAB_URL.replace(/\/$/, '')}/applications/${application.id}/round`;
  const founderPage = await (
    await browser.newContext({ viewport: { width: 1280, height: 1100 } })
  ).newPage();
  founderPage.on('pageerror', (error) => consoleErrors.push(String(error)));
  await founderPage.goto(LAB_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await founderPage.fill('#email', founder.email);
  await founderPage.fill('#password', founder.password);
  await founderPage.getByRole('button', { name: /Войти/i }).click();
  await founderPage.waitForSelector('text=Проекты', { timeout: 20_000 });
  await founderPage.goto(roundUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  await founderPage.waitForSelector('[data-round-cost="priced"]', { timeout: 20_000 });
  check(
    'основателю показана стоимость запуска',
    (await founderPage.locator('[data-round-cost]').innerText()).includes('Требуется пакет'),
  );
  check(
    'покупки ещё нет',
    (await founderPage.locator('[data-round-purchase="none"]').count()) === 1,
  );
  await founderPage.selectOption('#purchase-package', codes.pkgFull);
  await founderPage.getByRole('button', { name: 'Сохранить выбор' }).click();
  await founderPage.waitForTimeout(500);
  await founderPage.getByRole('button', { name: 'Оформить покупку' }).click();
  await founderPage.waitForSelector('[data-round-purchase="pending_payment"]', { timeout: 20_000 });
  const beforePay = await founderPage.locator('[data-purchase-blocker]').innerText();
  check('экран говорит, что покупка не оплачена', beforePay.includes('не оплачена'), beforePay);
  await founderPage.screenshot({
    path: join(OUT, '02-founder-purchase.png'),
    fullPage: true,
  });

  console.warn('\n[3] Администратор подтверждает тестовую оплату и услуги');
  // Адресно по СВОЕЙ покупке, а не «первая кнопка в списке». Список общий, в
  // нём лежат покупки прошлых прогонов: при `.first()` проверка подтверждала
  // чужую оплату и засчитывала себе чужой же признак «оплачено», а
  // собственная покупка оставалась неоплаченной.
  const [ownPurchase] = await sql(
    `SELECT id FROM billing.round_purchases WHERE round_id = $1
      AND status IN ('pending_payment','paid') ORDER BY created_at DESC LIMIT 1`,
    [roundId],
  );
  if (!ownPurchase) throw new Error('покупка прогона не найдена в базе');
  const row = `[data-purchase-row="${ownPurchase.id}"]`;

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector(row, { timeout: 20_000 });
  await page.locator(`${row} button:has-text("Подтвердить тестовую оплату")`).click();
  await page.waitForSelector(`${row}[data-purchase-status="paid"]`, { timeout: 20_000 });
  check('оплата подтверждена тестовым действием', true);
  check(
    'покупка помечена тестовой',
    (await page.locator(row).innerText()).includes('оплата тестовая'),
  );

  await founderPage.reload({ waitUntil: 'networkidle' });
  await founderPage.screenshot({ path: join(OUT, '03-founder-paid.png'), fullPage: true });
  await founderPage.waitForSelector('[data-round-purchase="paid"]', { timeout: 20_000 });
  const afterPay = await founderPage.locator('[data-purchase-blocker]').innerText();
  check('теперь не хватает выполнения услуг', afterPay.includes('не выполнены'), afterPay);

  // Отмечаются услуги ТОЛЬКО своей покупки — по той же причине, что и оплата.
  let guard = 0;
  const markButton = page.locator(`${row} button:has-text("Отметить выполненной")`);
  while ((await markButton.count()) > 0) {
    await markButton.first().click();
    await page.waitForTimeout(700);
    if ((guard += 1) > 10) break;
  }
  // Проверяется фактом в базе, а не тем, что кнопки кончились.
  const [pending] = await sql(
    `SELECT count(*)::int AS n FROM billing.round_purchase_items
      WHERE purchase_id = $1 AND fulfillment_status <> 'fulfilled'`,
    [ownPurchase.id],
  );
  check('все услуги отмечены выполненными', pending.n === 0, `осталось ${pending.n}`);
  await screenshot('admin-purchases');

  console.warn('\n[4] Основатель открывает раунд');
  await founderPage.reload({ waitUntil: 'networkidle' });
  await founderPage.waitForSelector('[data-purchase-blocker="none"]', { timeout: 20_000 });
  check(
    'экран сообщает, что условия выполнены',
    (await founderPage.locator('[data-purchase-blocker]').innerText()).includes('можно открывать'),
  );

  const preview = await founder.client.json(`/v1/rounds/${roundId}/open-preview`);
  const opened = await founder.client.call(`/v1/rounds/${roundId}/open`, {
    method: 'POST',
    body: {
      confirmDisclosureVersion: preview.activeFormVersion,
      contentDigest: preview.contentDigest,
    },
  });
  check('раунд открылся', opened.response.status < 400, `статус ${opened.response.status}`);
  const [round] = await sql(`SELECT status FROM lab.funding_rounds WHERE id = $1`, [roundId]);
  check('в базе раунд открыт', round?.status === 'open', `${round?.status}`);
  await founderPage.screenshot({ path: join(OUT, '04-founder-opened.png'), fullPage: true });

  check('ошибок в консоли нет', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await sql(`UPDATE audit.feature_flags SET enabled = $1 WHERE key = $2`, [
    flagBefore?.enabled ?? false,
    'billing.test_payment_confirmation',
  ]);
  await sql(`UPDATE audit.feature_flags SET enabled = $1 WHERE key = $2`, [
    v2Before?.enabled ?? false,
    'lab.ui.application_v2',
  ]);
  await restoreCountryPolicy(
    sql,
    'ru',
    originalPolicy,
    'проверка покупки: условия возвращены в исходное состояние',
  );
  await closeLeftoverPackages(sql);
  await browser.close();
  await pool.end();
}

console.warn(`\n  Снимки: ${OUT}`);
console.warn(`  Итог: ${passed} OK, ${failed} FAIL\n`);
process.exit(failed === 0 ? 0 : 1);
