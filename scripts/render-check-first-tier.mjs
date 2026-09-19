#!/usr/bin/env node
/**
 * Проход 7.4: первая очередь целиком, в браузере.
 *
 * Это не проверка одной функции, а связный путь продукта: основатель доводит
 * проект до открытого раунда, платформа принимает оплату и выполняет услугу,
 * а затем на тот же проект смотрят инвестор и посторонний.
 *
 * По каждому сценарию печатается вердикт — ПРОЙДЕН, ДЕФЕКТ или НЕ ПРОВЕРЕН —
 * и делается снимок экрана. «Не проверен» здесь такой же законный результат,
 * как «пройден»: сценарий, который нельзя пройти сегодня, должен называться
 * своим именем, а не прятаться.
 *
 * Данные, не относящиеся к экранам (регистрация, проверка личности, сетка
 * пакетов), готовятся через API — в браузере проходится то, что делает
 * человек.
 *
 * Требуется поднятое: ядро, шлюз (8100), вход (5179), кабинет основателя
 * (5175), кабинет инвестора (5176), админка (5174), витрина (5173).
 *
 * Снимки — `out/render-first-tier/`.
 */
import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { CORE_URL as DEFAULT_CORE_URL, frontendUrl } from './lib/ports.mjs';
import { activePolicyConfig, restoreCountryPolicy } from './lib/country-policy.mjs';
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
} from './lib/round-pricing-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

/** По сырому IP браузер не определяет «тот же сайт» — изображения блокируются. */
const toSite = (url) => url.replace('127.0.0.1', 'localhost');
const LAB_URL = toSite(process.env.LAB_URL ?? frontendUrl('lab'));
const ADMIN_URL = toSite(process.env.ADMIN_URL ?? frontendUrl('admin'));
const INVESTOR_URL = toSite(process.env.INVESTOR_URL ?? frontendUrl('investor'));
const PUBLIC_URL = toSite(process.env.WEB_PUBLIC_URL ?? frontendUrl('webPublic'));
const CORE_URL = toSite(process.env.CORE_URL ?? DEFAULT_CORE_URL);
const OUT = join(ROOT, 'out', 'render-first-tier');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/** Вердикты по сценариям — то, ради чего прогон и существует. */
const verdicts = [];
function verdict(scenario, state, note = '') {
  verdicts.push({ scenario, state, note });
  const mark = state === 'ПРОЙДЕН' ? 'OK  ' : state === 'ДЕФЕКТ' ? 'FAIL' : '—   ';
  console.warn(`  ${mark}  ${scenario}${note ? ` — ${note}` : ''}`);
}

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'ul_csrf';

const pool = makePool('unicorn-render-first-tier');
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
      signal: AbortSignal.timeout(60_000),
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
  const email = `ft-${tag}-${suffix}@test.local`;
  const password = `Pw-${crypto.randomUUID()}`;
  await client.json('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: `Проход ${tag}`,
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

async function login(page, url, who) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.fill('#email', who.email);
  await page.fill('#password', who.password);
  await page.getByRole('button', { name: /Войти/i }).click();
}

/**
 * Пауза для ограничителя частоты.
 *
 * Класс аутентификации ограничен 30 запросами в минуту на адрес, а связный
 * проход открывает четыре кабинета и перезагружает страницы — каждая
 * перезагрузка спрашивает «кто я». Исчерпав лимит, страница выглядит как
 * страница вышедшего пользователя, и проход упирается не в продукт, а в
 * защиту стенда. Пауза честнее, чем поднимать лимит ради проверки.
 */
async function coolDown(reason) {
  console.warn(`        · пауза 65 с (${reason}): лимит частоты входа`);
  await new Promise((resolve) => setTimeout(resolve, 65_000));
}

let shot = 0;
async function screenshot(page, name) {
  shot += 1;
  await page.screenshot({
    path: join(OUT, `${String(shot).padStart(2, '0')}-${name}.png`),
    fullPage: true,
  });
}

console.warn('\n=== ПРОХОД 7.4: ПЕРВАЯ ОЧЕРЕДЬ В БРАУЗЕРЕ ===\n');

const founder = await register('founder', 'f');
const investor = await register('investor', 'i');
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
{
  const kyc = await founder.client.json('/v1/kyc/verifications', {
    method: 'POST',
    body: { kind: 'identity', docType: 'passport', docCountry: 'RU' },
  });
  if (kyc.status !== 'approved') {
    await admin.json(`/v1/kyc/verifications/${kyc.id}/decision`, {
      method: 'POST',
      body: { decision: 'approved', riskLevel: 'low' },
    });
  }
}

const codes = codesFor(suffix);
const originalPolicy = await activePolicyConfig(sql, 'ru');
const [flagBefore] = await sql(
  `SELECT enabled FROM audit.feature_flags WHERE key = 'billing.test_payment_confirmation'`,
);
const [v2Before] = await sql(
  `SELECT enabled FROM audit.feature_flags WHERE key = 'lab.ui.application_v2'`,
);

const browser = await chromium.launch();
const consoleErrors = [];

try {
  await sql(`UPDATE audit.feature_flags SET enabled = true WHERE key = 'lab.ui.application_v2'`);
  await sql(
    `UPDATE audit.feature_flags SET enabled = true WHERE key = 'billing.test_payment_confirmation'`,
  );
  await closeLeftoverPackages(sql);

  // Предложение: одна услуга, выполняемая платформой по правилам.
  for (const [code, name] of [[codes.svcBase, 'Разбор заявки (проход 7.4)']]) {
    const service = await admin.json('/v1/admin/round-services', {
      method: 'POST',
      body: { code, name },
    });
    await admin.json(`/v1/admin/round-services/${service.id}`, {
      method: 'PATCH',
      body: { isImplemented: true, executionKind: 'rules_analysis', reason: 'проход 7.4' },
    });
  }
  await admin.json('/v1/admin/round-packages', {
    method: 'POST',
    body: {
      code: codes.pkgSmall,
      countryCode: 'ru',
      name: 'Запуск раунда (проход 7.4)',
      price: GRID.smallPrice,
      currency: 'RUB',
      minTarget: GRID.smallFrom,
      maxTarget: GRID.smallTo,
      serviceCodes: [codes.svcBase],
      reason: 'проход 7.4: пакет запуска',
    },
  });

  const { project, application, roundId } = await createProjectWithDraftRound(
    founder.client,
    sql,
    suffix,
  );
  await enablePaidPackages(admin, sql);

  const founderPage = await (
    await browser.newContext({ viewport: { width: 1280, height: 1100 } })
  ).newPage();
  founderPage.on('pageerror', (error) => consoleErrors.push(`основатель: ${String(error)}`));
  // Диагностика: неуспешные ответы API видны сразу, а не по отсутствию блока.
  founderPage.on('response', (r) => {
    if (r.url().includes('/v1/') && r.status() >= 400) {
      console.warn(`        ! ${r.status()} ${r.url().replace(CORE_URL, '')}`);
    }
  });

  // ------------------------------------------------- 1. вход основателя
  await login(founderPage, LAB_URL, founder);
  await founderPage.waitForSelector('text=Проекты', { timeout: 20_000 });
  verdict('Основатель: регистрация и вход', 'ПРОЙДЕН');
  await screenshot(founderPage, 'founder-login');

  // ------------------------------------------- 2. карточка и изображения
  await founderPage.goto(`${LAB_URL.replace(/\/$/, '')}/projects/${project.id}`, {
    waitUntil: 'networkidle',
    timeout: 30_000,
  });
  await founderPage.waitForSelector('[data-project-media]', { timeout: 20_000 });
  const logoFile = join(OUT, 'logo.jpg');
  await sharp({
    create: { width: 512, height: 512, channels: 3, background: { r: 60, g: 90, b: 200 } },
  })
    .jpeg()
    .toFile(logoFile);
  const coverFile = join(OUT, 'cover.jpg');
  await sharp({
    create: { width: 1280, height: 720, channels: 3, background: { r: 20, g: 150, b: 120 } },
  })
    .jpeg()
    .toFile(coverFile);
  await founderPage.locator('[data-media-input="logo"]').setInputFiles(logoFile);
  await founderPage.locator('[data-media-upload="logo"]').click();
  await founderPage.waitForSelector('[data-media-preview="logo"]', { timeout: 30_000 });
  await founderPage.locator('[data-media-input="cover"]').setInputFiles(coverFile);
  await founderPage.locator('[data-media-upload="cover"]').click();
  await founderPage.waitForSelector('[data-media-preview="cover"]', { timeout: 30_000 });
  verdict('Основатель: логотип и обложка', 'ПРОЙДЕН');
  await screenshot(founderPage, 'founder-media');

  // --------------------------------------------- 3. стоимость и покупка
  const roundUrl = `${LAB_URL.replace(/\/$/, '')}/applications/${application.id}/round`;
  await founderPage.goto(roundUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  await founderPage.waitForSelector('[data-round-cost="priced"]', { timeout: 20_000 });
  const cost = await founderPage.locator('[data-round-cost]').innerText();
  verdict(
    'Основатель: видит стоимость запуска с пакетом и валютой',
    cost.includes('Требуется пакет') && /₽|RUB/.test(cost) ? 'ПРОЙДЕН' : 'ДЕФЕКТ',
    cost.split('\n')[1] ?? '',
  );
  await screenshot(founderPage, 'founder-cost');

  await founderPage.getByRole('button', { name: 'Оформить покупку' }).click();
  await founderPage.waitForSelector('[data-round-purchase="pending_payment"]', { timeout: 20_000 });
  verdict('Основатель: оформляет покупку запуска', 'ПРОЙДЕН');

  // ------------------------------------------------------- 4. оплата
  await founderPage.getByRole('button', { name: 'Перейти к оплате' }).click();
  await founderPage.waitForSelector('[data-round-payment="pending"]', { timeout: 20_000 });
  const payText = await founderPage.locator('[data-round-payment]').innerText();
  verdict(
    'Основатель: платёж создан, поступление НЕ подтверждено',
    payText.includes('только после подтверждения оператора') ? 'ПРОЙДЕН' : 'ДЕФЕКТ',
    'оператор платежей не подключён — оплата тестовая',
  );
  await screenshot(founderPage, 'founder-payment');

  // ---------------------------------------- 5. оператор подтверждает оплату
  const adminPage = await (
    await browser.newContext({ viewport: { width: 1280, height: 1100 } })
  ).newPage();
  adminPage.on('pageerror', (error) => consoleErrors.push(`админ: ${String(error)}`));
  adminPage.on('dialog', (dialog) => void dialog.accept('проход 7.4: услуга выполнена'));
  await login(adminPage, ADMIN_URL, adminUser);
  await adminPage.waitForSelector('text=Пакеты раунда', { timeout: 20_000 });
  await adminPage.goto(`${ADMIN_URL.replace(/\/$/, '')}/round-packages`, {
    waitUntil: 'networkidle',
    timeout: 30_000,
  });
  const [ownPurchase] = await sql(
    `SELECT id FROM billing.round_purchases WHERE round_id = $1
      AND status IN ('pending_payment','paid') ORDER BY created_at DESC LIMIT 1`,
    [roundId],
  );
  const row = `[data-purchase-row="${ownPurchase.id}"]`;
  await adminPage.waitForSelector(row, { timeout: 20_000 });
  await adminPage.locator(`${row} button:has-text("Подтвердить тестовую оплату")`).click();
  await adminPage.waitForSelector(`${row}[data-purchase-status="paid"]`, { timeout: 20_000 });
  verdict('Оператор: отмечает оплату (тестовую)', 'ПРОЙДЕН');
  await screenshot(adminPage, 'admin-payment');

  // ------------------------------------------- 6. услуга: разбор заявки
  await founderPage.reload({ waitUntil: 'networkidle' });
  await founderPage.waitForSelector('[data-service-runs]', { timeout: 20_000 });
  await founderPage.getByRole('button', { name: 'Запустить разбор' }).click();
  await founderPage.waitForSelector('[data-service-run="succeeded"]', { timeout: 60_000 });
  const runText = await founderPage.locator('[data-service-run]').innerText();
  verdict(
    'Основатель: разбор заявки выполнен и назван честно',
    runText.includes('без языковой модели') && runText.includes('поданной версии')
      ? 'ПРОЙДЕН'
      : 'ДЕФЕКТ',
    'ИИ-анализ моделью не подключён — выполняется разбор по правилам',
  );
  await screenshot(founderPage, 'founder-analysis');

  // ------------------------- 6б. оператор закрывает остальные позиции
  //
  // Строка самого пакета — не услуга платформы, и её закрывает человек: это
  // подтверждение, что пакет оказан целиком.
  await adminPage.reload({ waitUntil: 'networkidle' });
  await adminPage.waitForSelector(row, { timeout: 20_000 });
  let guard = 0;
  const markButton = adminPage.locator(`${row} button:has-text("Отметить выполненной")`);
  while ((await markButton.count()) > 0) {
    await markButton.first().click();
    await adminPage.waitForTimeout(700);
    if ((guard += 1) > 10) break;
  }
  const [pending] = await sql(
    `SELECT count(*)::int AS n FROM billing.round_purchase_items
      WHERE purchase_id = $1 AND fulfillment_status <> 'fulfilled'`,
    [ownPurchase.id],
  );
  verdict(
    'Оператор: отмечает выполнение остальных позиций покупки',
    pending.n === 0 ? 'ПРОЙДЕН' : 'ДЕФЕКТ',
    `осталось ${pending.n}`,
  );
  await screenshot(adminPage, 'admin-fulfillment');

  // ---------------------------------------------- 7. открытие раунда
  await coolDown('перед открытием раунда');
  await founderPage.reload({ waitUntil: 'networkidle' });
  await founderPage.waitForSelector('[data-round-purchase]', { timeout: 20_000 });
  const purchaseState = await founderPage
    .locator('[data-round-purchase]')
    .getAttribute('data-round-purchase');
  const blockerText =
    (await founderPage.locator('[data-purchase-blocker]').count()) > 0
      ? await founderPage.locator('[data-purchase-blocker]').innerText()
      : `блок покупки в состоянии «${purchaseState}»`;
  const ready = (await founderPage.locator('[data-purchase-blocker="none"]').count()) === 1;
  if (ready) {
    await founderPage.getByRole('button', { name: 'Открыть раунд привлечения' }).click();
    await founderPage.waitForTimeout(1500);
  }
  const [round] = await sql(`SELECT status FROM lab.funding_rounds WHERE id = $1`, [roundId]);
  verdict(
    'Основатель: открывает раунд после выполнения условий',
    round?.status === 'open' ? 'ПРОЙДЕН' : 'ДЕФЕКТ',
    round?.status === 'open' ? `состояние ${round?.status}` : `экран говорит: ${blockerText}`,
  );
  await screenshot(founderPage, 'founder-round-open');

  // -------------------------------------------- 8. публикация и витрина
  await founder.client.json(`/v1/projects/${project.id}/visibility`, {
    method: 'PUT',
    body: { visibility: 'public' },
  });
  await founder.client.json(`/v1/projects/${project.id}/listing`, { method: 'POST' });

  const anonPage = await (
    await browser.newContext({ viewport: { width: 1280, height: 1100 } })
  ).newPage();
  anonPage.on('pageerror', (error) => consoleErrors.push(`аноним: ${String(error)}`));
  await anonPage.goto(`${PUBLIC_URL.replace(/\/$/, '')}/p/${project.id}`, {
    waitUntil: 'networkidle',
    timeout: 30_000,
  });
  await anonPage.waitForSelector(`[data-project-page="${project.id}"]`, { timeout: 20_000 });
  const coverLoaded = await anonPage
    .waitForFunction(
      /* eslint-disable no-undef */
      () => {
        const img = document.querySelector('[data-project-cover]');
        return img instanceof HTMLImageElement && img.naturalWidth > 0;
      },
      /* eslint-enable no-undef */
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false);
  const withheld = await anonPage.locator('[data-project-withheld]').innerText();
  verdict(
    'Посторонний: страница проекта с обложкой и честным «скрыто N»',
    coverLoaded && withheld.length > 0 ? 'ПРОЙДЕН' : 'ДЕФЕКТ',
    withheld.slice(0, 60),
  );
  await screenshot(anonPage, 'anon-project');

  // --------------------------------------------- 9. посторонний и закрытое
  const otherProject = await createProjectWithDraftRound(founder.client, sql, `${suffix}c`);
  await anonPage.goto(`${PUBLIC_URL.replace(/\/$/, '')}/p/${otherProject.project.id}`, {
    waitUntil: 'networkidle',
    timeout: 30_000,
  });
  const notFound = await anonPage.locator('[role="alert"]').innerText();
  verdict(
    'Посторонний: закрытый проект неотличим от несуществующего',
    notFound.includes('не найдена') && !notFound.includes(otherProject.project.title)
      ? 'ПРОЙДЕН'
      : 'ДЕФЕКТ',
    notFound.split('\n')[0] ?? '',
  );
  await screenshot(anonPage, 'anon-closed');

  // -------------------------------------------------- 10. инвестор
  await coolDown('перед входом инвестора');
  const investorPage = await (
    await browser.newContext({ viewport: { width: 1280, height: 1100 } })
  ).newPage();
  investorPage.on('pageerror', (error) => consoleErrors.push(`инвестор: ${String(error)}`));
  await login(investorPage, INVESTOR_URL, investor);
  await investorPage.waitForSelector('text=Каталог', { timeout: 20_000 });
  await investorPage.getByRole('button', { name: 'Подробнее' }).first().click();
  await investorPage.waitForSelector('[data-investor-view]', { timeout: 20_000 });
  const investorText = await investorPage.locator('[data-investor-view]').innerText();
  verdict('Инвестор: каталог и карточка проекта', investorText.length > 0 ? 'ПРОЙДЕН' : 'ДЕФЕКТ');
  await screenshot(investorPage, 'investor-card');

  // --------------------------- сценарии, которые сегодня не пройти
  verdict(
    'Инвестор: связаться с основателем',
    'НЕ ПРОВЕРЕН',
    'не реализовано: переписки в продукте нет',
  );
  verdict(
    'Инвестор: перевести деньги в проект',
    'НЕ ПРОВЕРЕН',
    'отложено: денежная схема сделки не определена',
  );
  verdict(
    'Основатель: оплатить настоящими деньгами',
    'НЕ ПРОВЕРЕН',
    'оператор платежей не выбран; тестовая оплата в рабочем окружении раунд не откроет',
  );
  verdict(
    'Основатель: купить ИИ-анализ языковой моделью',
    'НЕ ПРОВЕРЕН',
    'услуга не продаётся: нет провайдера и ключа, база не даёт пометить её реализованной',
  );
  verdict(
    'Оператор: выдать полномочия сотруднику экраном',
    'НЕ ПРОВЕРЕН',
    'работает только по API, экрана нет',
  );

  verdict(
    'Ошибок в консоли нет',
    consoleErrors.length === 0 ? 'ПРОЙДЕН' : 'ДЕФЕКТ',
    consoleErrors.join(' | ').slice(0, 160),
  );
} finally {
  await sql(`UPDATE audit.feature_flags SET enabled = $1 WHERE key = 'lab.ui.application_v2'`, [
    v2Before?.enabled ?? false,
  ]);
  await sql(
    `UPDATE audit.feature_flags SET enabled = $1 WHERE key = 'billing.test_payment_confirmation'`,
    [flagBefore?.enabled ?? false],
  );
  await restoreCountryPolicy(sql, 'ru', originalPolicy, 'проход 7.4: возврат условий');
  await browser.close();
  await pool.end();
}

const passedCount = verdicts.filter((v) => v.state === 'ПРОЙДЕН').length;
const defects = verdicts.filter((v) => v.state === 'ДЕФЕКТ');
const skipped = verdicts.filter((v) => v.state === 'НЕ ПРОВЕРЕН');

console.warn(`\n  Снимки: ${OUT}`);
console.warn(
  `  Итог: пройдено ${passedCount}, дефектов ${defects.length}, не проверено ${skipped.length}\n`,
);
if (defects.length > 0) {
  console.warn('  Дефекты:');
  for (const d of defects) console.warn(`    • ${d.scenario} — ${d.note}`);
  console.warn('');
}
process.exit(defects.length === 0 ? 0 : 1);
