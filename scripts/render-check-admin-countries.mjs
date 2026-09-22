#!/usr/bin/env node
/**
 * Рендер-проверка экрана «Страны обслуживания» в админке (этап 5.6.5).
 *
 * Что проверяется: раздел в меню; справочник стран строками; новая страна
 * заводится выключенной и включается кнопкой; условия страны показаны с
 * активной версией; включённая бесплатная граница и платные пакеты
 * предупреждают о недоступности открытия раунда (fail-closed); активация
 * новой версии условий с основанием даёт следующий номер и не трогает
 * прежнюю; версия читается основателем как действующие условия; регистрация
 * основателя при одной активной стране предлагает её для подтверждения и
 * записывает в аккаунт.
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
import { activePolicyConfig, restoreCountryPolicy } from './lib/country-policy.mjs';

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

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: СТРАНЫ ОБСЛУЖИВАНИЯ (ЭТАП 5.6.5) ===\n');
const admin = await register('admin');
await sql(`INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin')`, [admin.userId]);
const [activeRu] = await sql(
  `SELECT version FROM billing.service_country_policies WHERE country_code = 'ru' AND is_active`,
);
const [maxRu] = await sql(
  `SELECT MAX(version) AS max FROM billing.service_country_policies WHERE country_code = 'ru'`,
);
const NEXT = Number(maxRu.max) + 1;
console.warn(`  ·     активная версия условий RU: ${activeRu?.version ?? '—'}`);

// Проверка активирует версии условий RU и возвращает прежнее значение шагом
// сценария. Если она упадёт между этими шагами, условия остались бы
// изменёнными — поэтому исходное значение запоминается здесь и
// восстанавливается в `finally` независимо от исхода.
const originalPolicy = await activePolicyConfig(sql, 'ru');

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
  await page.waitForSelector('text=Тарифы', { timeout: 15_000 });
  check(
    'раздел «Страны обслуживания» есть в меню',
    (await page.getByRole('link', { name: 'Страны обслуживания', exact: true }).count()) === 1,
  );
  await page.getByRole('link', { name: 'Страны обслуживания', exact: true }).click();
  await page.waitForSelector('[data-country-row="ru"]', { timeout: 20_000 });
  await page.waitForSelector('[data-policy-form="ru"]', { timeout: 20_000 });
  check(
    'страна RU в справочнике включена',
    (await page.locator('[data-country-row="ru"]').getAttribute('data-country-active')) === 'true',
  );
  check(
    'условия RU показаны с активной версией',
    (await page.locator('[data-policy-form="ru"]').getAttribute('data-policy-version')) ===
      String(activeRu?.version ?? ''),
  );
  check(
    'база учёта бесплатной границы помечена «не согласовано»',
    (await page.locator('[data-policy-form="ru"]').innerText()).includes('не согласовано'),
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

  console.warn('\n[3] Условия RU: предупреждения и активация новой версии');
  await page.locator('[data-country-row="ru"] button').first().click();
  await page.waitForSelector('[data-policy-form="ru"]', { timeout: 15_000 });
  await page.locator('[data-policy-free]').check();
  check(
    'включённая бесплатная граница предупреждает о недоступности открытия раунда',
    (await page.locator('[data-policy-warning="free"]').count()) === 1,
  );
  await page.locator('[data-policy-free]').uncheck();
  await page.locator('[data-policy-paid]').check();
  check(
    'включённые платные пакеты предупреждают о fail-closed до 5.9',
    (await page.locator('[data-policy-warning="paid"]').count()) === 1,
  );
  await page.locator('[data-policy-paid]').uncheck();
  const reviewWas = await page.locator('[data-policy-review]').isChecked();
  await page.locator('[data-policy-review]').setChecked(!reviewWas);
  await page.getByRole('button', { name: 'Активировать новой версией' }).click();
  await page.waitForSelector('dialog[open], [role="dialog"]', { timeout: 10_000 });
  await page
    .locator('dialog[open] input, [role="dialog"] input')
    .first()
    .fill('рендер-проверка: участие оператора переключено');
  await page
    .locator('dialog[open], [role="dialog"]')
    .getByRole('button', { name: 'Активировать' })
    .click();
  await page.waitForSelector(`[data-policy-form="ru"][data-policy-version="${NEXT}"]`, {
    timeout: 15_000,
  });
  check(`активирована версия ${NEXT} условий RU`, true);
  const rows = await sql(
    `SELECT version, is_active, config_jsonb->'operator'->>'manualReviewRequired' AS review
       FROM billing.service_country_policies WHERE country_code = 'ru' ORDER BY version DESC LIMIT 2`,
  );
  check(
    'новая версия активна, прежняя сохранена неактивной',
    rows[0]?.version === NEXT &&
      rows[0]?.is_active === true &&
      rows[1]?.is_active === false &&
      rows[0]?.review === String(!reviewWas),
    JSON.stringify(rows),
  );
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
  }).then((r) => r.json());
  check(
    'основатель читает новую версию как действующие условия',
    policy?.version === NEXT && policy?.config?.operator?.manualReviewRequired === !reviewWas,
    `версия ${policy?.version}`,
  );
  await screenshot('policy-activated');

  // Вернуть прежнее значение — следующей версией, как и положено.
  await page.locator('[data-policy-review]').setChecked(reviewWas);
  await page.getByRole('button', { name: 'Активировать новой версией' }).click();
  await page.waitForSelector('dialog[open], [role="dialog"]', { timeout: 10_000 });
  await page
    .locator('dialog[open] input, [role="dialog"] input')
    .first()
    .fill('рендер-проверка: возврат прежнего значения');
  await page
    .locator('dialog[open], [role="dialog"]')
    .getByRole('button', { name: 'Активировать' })
    .click();
  await page.waitForSelector(`[data-policy-form="ru"][data-policy-version="${NEXT + 1}"]`, {
    timeout: 15_000,
  });
  check('возврат прежнего значения — новой версией, история сохранена', true);

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
  await sql(`UPDATE billing.service_countries SET is_active = false WHERE code = $1`, [TEST_CODE]);
  // Возврат — новой версией: переписывать версии нельзя. Ничего не делает,
  // если сценарий уже вернул прежнее значение своим шагом.
  await restoreCountryPolicy(
    sql,
    'ru',
    originalPolicy,
    'рендер-проверка: возврат исходных условий после прогона',
  );
  await pool.end();
}

console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено. Снимки: ${OUT}`);
await run.finish(failed === 0);
process.exit(failed > 0 ? 1 : 0);
