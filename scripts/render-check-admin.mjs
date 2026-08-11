#!/usr/bin/env node
/**
 * Проверка административного кабинета в РЕАЛЬНОМ рендере (`RULES.md` §2).
 *
 * Админка существует с Ф5, но рендер-проверки у неё не было: работоспособность
 * подтверждалась ручным открытием браузера, то есть никак. Здесь проверяется
 * то, что дороже всего сломать незаметно: вход, доступность экранов, выдача
 * роли и невозможность выдать её себе.
 *
 * Запуск: node scripts/render-check-admin.mjs
 * Требуется: core на 4300 и админка на 5174.
 */
import { chromium } from 'playwright';
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const APP_URL = process.env.ADMIN_URL ?? 'http://127.0.0.1:5174/';
const CORE_URL = process.env.CORE_URL ?? 'http://127.0.0.1:4300';

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
  const email = `adm-${tag}-${suffix}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const response = await fetch(`${CORE_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      email,
      password,
      displayName: `Оператор ${tag}`,
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

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: АДМИНИСТРАТИВНЫЙ КАБИНЕТ ===\n');

const admin = await register('admin');
const target = await register('target');
await sql(`INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin')`, [admin.userId]);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  if (/\b(401|403|404|409) \(/.test(message.text())) return;
  consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

console.warn('[1] Вход');
await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30_000 });
check('незалогиненному показан вход', (await page.locator('#password').count()) === 1);

await page.fill('#email', admin.email);
await page.fill('#password', admin.password);
await page.getByRole('button', { name: /Войти/i }).click();
await page.waitForSelector('text=Тарифы', { timeout: 15_000 });
check('вход выполнен, кабинет открыт', true);

console.warn('\n[2] Разделы кабинета');
for (const label of ['Тарифы', 'Подписки', 'Комплаенс', 'Сезон', 'Функции платформы', 'Доступ']) {
  check(
    `раздел «${label}» присутствует`,
    (await page.getByText(label, { exact: true }).count()) > 0,
  );
}

console.warn('\n[3] Управление ролями');
await page.getByText('Доступ', { exact: true }).click();
await page.waitForSelector('#role-user', { timeout: 15_000 });

// Выдать роль СЕБЕ нельзя — это правило сервера, и кабинет обязан показать
// отказ, а не обойти его.
await page.fill('#role-user', admin.userId);
await page.selectOption('#role-name', 'organizer');
await page.getByRole('button', { name: 'Выдать' }).click();
await page.waitForTimeout(2000);
const selfText = await page.locator('main').innerText();
check(
  'выдача роли себе отклонена сервером',
  /Недостаточно прав|Forbidden|403/i.test(selfText),
  selfText.replace(/\s+/g, ' ').slice(0, 90),
);

await page.fill('#role-user', target.userId);
await page.selectOption('#role-name', 'expert');
await page.getByRole('button', { name: 'Выдать' }).click();
await page.waitForTimeout(2500);
const grantText = await page.locator('main').innerText();
check(
  'роль другому пользователю выдана',
  grantText.includes('Роль выдана'),
  grantText.replace(/\s+/g, ' ').slice(0, 90),
);

const [granted] = await sql(
  `SELECT role FROM identity.user_roles WHERE user_id = $1 AND role = 'expert' AND revoked_at IS NULL`,
  [target.userId],
);
check('роль записана в БД', granted !== undefined);

const [journal] = await sql(
  `SELECT count(*)::int AS n FROM audit.events
    WHERE verb = 'identity.role.granted' AND subject_id = $1`,
  [target.userId],
);
check('выдача попала в журнал', journal.n === 1, `записей: ${journal.n}`);

console.warn('\n[4] Клиенты Integration API');
check('раздел клиентов отрисован', (await page.getByText('Клиенты Integration API').count()) === 1);

console.warn('\n[5] Доступность и раскладка');
check('ровно один h1', (await page.locator('h1').count()) === 1);
const unlabeled = await page
  .locator('input:not([id]):not([aria-label]):not([type="hidden"])')
  .count();
check('поля ввода имеют подписи', unlabeled === 0, `без подписи: ${unlabeled}`);

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const overflow = await page.evaluate(
  // eslint-disable-next-line no-undef
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
check('горизонтальной прокрутки нет на 390px', overflow <= 1, `переполнение: ${overflow}px`);
check(
  'ошибок в консоли нет',
  consoleErrors.length === 0,
  consoleErrors.slice(0, 2).join(' | ') || 'нет',
);

await browser.close();
await pool.end();

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exit(failed > 0 ? 1 : 0);
