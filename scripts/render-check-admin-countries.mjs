#!/usr/bin/env node
/**
 * Рендер-проверка экрана «Страны обслуживания» в админке (этап 5.6.5).
 *
 * Что проверяется: раздел в меню; справочник стран строками; новая страна
 * заводится выключенной и включается кнопкой; регистрация основателя при одной
 * активной стране предлагает её для подтверждения и записывает в аккаунт.
 *
 * Условия страны (версии service_country_policies) удалены в 2.1-W05 вместе с
 * биллингом: от раздела остался справочник стран. Прежний адрес условий
 * проверяется на отсутствие — он не должен отвечать ничем.
 *
 * Снимки — `out/render-admin-countries/`. Тестовые страны получают коды из
 * диапазона, который ISO не занимает (`x?`) и выключаются в конце.
 *
 * Запуск: ADMIN_URL=http://127.0.0.1/admin/ node scripts/render-check-admin-countries.mjs
 */
import { chromium } from 'playwright';
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL as DEFAULT_CORE_URL, frontendUrl } from './lib/ports.mjs';
import { startProbeRun } from './lib/probe-run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

/*
 * Запуск открывается до первой регистрации: он даёт право назвать
 * заведённых людей следом прогона и записывает их за собой. Без него
 * сервер пометку не назначит — разрешённое значение заголовка не
 * полномочие.
 */
const run = await startProbeRun('RND-ADMIN-COUNTRIES');

const ADMIN_URL = process.env.ADMIN_URL ?? frontendUrl('admin');
const LOGIN_URL = process.env.LOGIN_URL ?? frontendUrl('auth');
const CORE_URL = process.env.CORE_URL ?? DEFAULT_CORE_URL;
const OUT = join(ROOT, 'out', 'render-admin-countries');
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

function blindIndex(email) {
  return createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
}

const suffix = `${Date.now() % 1e9}`;
const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

async function register(tag) {
  const email = `sc-${tag}-${suffix}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const response = await fetch(`${CORE_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...run.headers() },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      email,
      password,
      displayName: `Проверка ${tag}`,
      role: 'founder',
      locale: 'ru-RU',
      consents: CONSENTS,
    }),
  });
  if (!response.ok) throw new Error(`регистрация ${tag}: HTTP ${response.status}`);
  const [row] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
    blindIndex(email),
  ]);
  return { email, password, userId: row.id };
}

/** Код тестовой страны: `x` + буква — ISO 3166-1 такие коды не назначает. */
const TEST_CODE = `x${String.fromCharCode(97 + (Number(suffix) % 26))}`;

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: СТРАНЫ ОБСЛУЖИВАНИЯ ===\n');
const admin = await register('admin');
await sql(`INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin')`, [admin.userId]);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  if (/\b(401|403|404) \(/.test(message.text())) return;
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

try {
  console.warn('[1] Вход и раздел в меню');
  await page.goto(ADMIN_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.fill('#email', admin.email);
  await page.fill('#password', admin.password);
  await page.getByRole('button', { name: /Войти/i }).click();
  await page.waitForSelector('text=Комплаенс', { timeout: 15_000 });
  check(
    'раздел «Страны обслуживания» есть в меню',
    (await page.getByRole('link', { name: 'Страны обслуживания', exact: true }).count()) === 1,
  );
  await page.getByRole('link', { name: 'Страны обслуживания', exact: true }).click();
  await page.waitForSelector('[data-country-row="ru"]', { timeout: 20_000 });
  check(
    'страна RU в справочнике включена',
    (await page.locator('[data-country-row="ru"]').getAttribute('data-country-active')) === 'true',
  );
  await screenshot('countries');

  console.warn('\n[2] Новая страна заводится выключенной');
  await page.fill('#country-code', TEST_CODE);
  await page.getByRole('button', { name: 'Завести выключенной' }).click();
  await page.waitForSelector(`[data-country-row="${TEST_CODE}"]`, { timeout: 15_000 });
  check(
    `страна ${TEST_CODE.toUpperCase()} заведена выключенной`,
    (await page
      .locator(`[data-country-row="${TEST_CODE}"]`)
      .getAttribute('data-country-active')) === 'false',
  );
  const [publicRow] = await sql(`SELECT is_active FROM billing.service_countries WHERE code = $1`, [
    TEST_CODE,
  ]);
  check('в базе страна выключена', publicRow?.is_active === false);
  await page
    .locator(`[data-country-row="${TEST_CODE}"]`)
    .getByRole('button', { name: 'Включить' })
    .click();
  await page.waitForSelector(`[data-country-row="${TEST_CODE}"][data-country-active="true"]`, {
    timeout: 15_000,
  });
  check(`страна ${TEST_CODE.toUpperCase()} включена кнопкой`, true);
  const publicList = await fetch(`${CORE_URL}/v1/service-countries`).then((r) => r.json());
  check(
    'включённая страна видна в публичном списке для регистрации',
    (publicList.items ?? []).some((c) => c.code === TEST_CODE && c.isActive),
  );
  await page
    .locator(`[data-country-row="${TEST_CODE}"]`)
    .getByRole('button', { name: 'Выключить' })
    .click();
  await page.waitForSelector(`[data-country-row="${TEST_CODE}"][data-country-active="false"]`, {
    timeout: 15_000,
  });
  await screenshot('country-toggled');

  console.warn('\n[3] Условий страны больше нет');
  const founder = await register('founder');
  const login = await fetch(`${CORE_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...run.headers() },
    body: JSON.stringify({ email: founder.email, password: founder.password }),
    signal: AbortSignal.timeout(30_000),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const policy = await fetch(`${CORE_URL}/v1/service-countries/ru/policy`, {
    headers: { cookie },
    signal: AbortSignal.timeout(30_000),
  });
  check('адрес условий страны больше не отвечает', policy.status === 404, `HTTP ${policy.status}`);

  console.warn('\n[4] Регистрация: одна активная страна предлагается для подтверждения');
  const regPage = await (
    await browser.newContext({ viewport: { width: 1280, height: 900 } })
  ).newPage();
  await regPage.goto(`${LOGIN_URL.replace(/\/$/, '')}/#register`, {
    waitUntil: 'networkidle',
    timeout: 30_000,
  });
  await regPage.waitForSelector('[data-service-country]', { timeout: 15_000 });
  check(
    'при одной активной стране показан флажок подтверждения RU, а не выбор',
    (await regPage.locator('#serviceCountry').getAttribute('type')) === 'checkbox' &&
      (await regPage.locator('[data-service-country]').innerText()).includes('RU'),
  );
  await regPage.locator('input[name=role][value=investor]').check();
  await regPage.waitForSelector('[data-service-country]', { timeout: 5_000 });
  check(
    'инвестору страна обслуживания предлагается так же, как основателю',
    (await regPage.locator('#serviceCountry').count()) === 1,
  );
  await regPage.locator('input[name=role][value=founder]').check();
  check(
    'страна не подставляется молча: до подтверждения не выбрана',
    (await regPage.locator('[data-service-country]').getAttribute('data-service-country')) ===
      'none',
  );
  await regPage.locator('#serviceCountry').check();
  const regEmail = `sc-reg-${suffix}@test.local`;
  await regPage.fill('#displayName', 'Основатель со страной');
  await regPage.fill('#email', regEmail);
  await regPage.fill('#password', `Pw-${randomUUID()}`);
  await regPage.locator('label.auth-consent input[type=checkbox]').last().check();
  await regPage.getByRole('button', { name: 'Создать аккаунт' }).click();
  /* eslint-disable no-undef */
  await regPage
    .waitForFunction(() => !location.pathname.startsWith('/login/'), undefined, {
      timeout: 20_000,
    })
    .catch(() => undefined);
  /* eslint-enable no-undef */
  const [registered] = await sql(
    'SELECT service_country FROM identity.users WHERE email_hmac = $1',
    [blindIndex(regEmail)],
  );
  check(
    'подтверждённая страна записана в аккаунт при регистрации',
    registered?.service_country === 'ru',
    `${registered?.service_country}`,
  );
  await regPage.close();

  const unexpected = consoleErrors.filter((t) => !/status of (400|409|422|429)/.test(t));
  check('непредвиденных ошибок в консоли нет', unexpected.length === 0, unexpected[0] ?? '');
} finally {
  await browser.close();
  /*
   * Страна прогона УДАЛЯЕТСЯ, а не просто прячется.
   *
   * Скрытая строка всё равно остаётся в базе, и проверка переноса содержимого
   * честно показывала расхождение с комплектом: «+2 страны». Справочник — это
   * подготовленное содержимое, и лишних записей в нём быть не должно.
   * Настоящие страны не трогаются — отбор строго по коду прогона.
   */
  await sql(`DELETE FROM billing.service_countries WHERE code = $1`, [TEST_CODE]);
  await pool.end();
}

console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено. Снимки: ${OUT}`);
await run.finish(failed === 0);
process.exit(failed > 0 ? 1 : 0);
