#!/usr/bin/env node
/**
 * Браузерный проход: «Мой профиль» во всех кабинетах (этап 6.7).
 *
 * Проверяется то, ради чего экран общий: человек попадает в него одинаково
 * отовсюду и видит одно и то же. И то, чего на нём быть не должно: полей для
 * подтверждённых данных.
 *
 *   1. имя и аватар в шапке — вход в профиль, а не подпись;
 *   2. имя меняется, и шапка узнаёт об этом сразу;
 *   3. аватар загружается, показывается и удаляется;
 *   4. контакт показан маской и не редактируется;
 *   5. смена пароля предупреждает о закрытии сессий и требует текущий;
 *   6. тот же экран открывается у инвестора, эксперта и администратора.
 *
 * Имя и аватар меняются у СВОЕГО временного основателя; у демонстрационных
 * учётных записей только открывается экран.
 *
 * Снимки — `out/render-profile/`.
 * Запуск: UNICORN_ENTRY=web node scripts/render-check-profile.mjs
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL as DEFAULT_CORE_URL, frontendUrl } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const toSite = (url) => url.replace('127.0.0.1', 'localhost');
const strip = (url) => url.replace(/\/+$/, '');
const LAB_URL = strip(toSite(process.env.LAB_URL ?? frontendUrl('lab')));
const INVESTOR_URL = strip(toSite(process.env.INVESTOR_URL ?? frontendUrl('investor')));
const EXPERT_URL = strip(toSite(process.env.EXPERT_URL ?? frontendUrl('expert')));
const ADMIN_URL = strip(toSite(process.env.ADMIN_URL ?? frontendUrl('admin')));
const CORE_URL = toSite(process.env.CORE_URL ?? DEFAULT_CORE_URL);

const OUT = join(ROOT, 'out', 'render-profile');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const verdicts = [];
function expect(scenario, condition, note = '') {
  verdicts.push({ scenario, state: condition ? 'ПРОЙДЕН' : 'ДЕФЕКТ', note });
  console.warn(`  ${condition ? 'OK  ' : 'FAIL'}  ${scenario}${note ? ` — ${note}` : ''}`);
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

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });
const DEMO_PASSWORD = process.env.DEMO_USER_PASSWORD ?? process.env.DEV_TEST_USER_PASSWORD ?? '';

const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

async function registerFounder() {
  const suffix = `${Date.now() % 1e9}`;
  const email = `render-profile-${suffix}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const response = await fetch(`${CORE_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      displayName: `Профиль Проходной ${suffix}`,
      role: 'founder',
      locale: 'ru-RU',
      consents: CONSENTS,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status >= 400) throw new Error(`регистрация не удалась: HTTP ${response.status}`);
  return { email, password, displayName: `Профиль Проходной ${suffix}` };
}

async function signIn(page, url, who) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  const form = await page.waitForSelector('#email', { timeout: 15_000 }).catch(() => null);
  if (form) {
    await page.fill('#email', who.email);
    await page.fill('#password', who.password);
    await page.getByRole('button', { name: /^Войти$/ }).click();
    await page.waitForTimeout(3500);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  }
  await page.waitForTimeout(1500);
}

let shot = 0;
async function screenshot(page, name) {
  shot += 1;
  await page.screenshot({
    path: join(OUT, `${String(shot).padStart(2, '0')}-${name}.png`),
    fullPage: true,
  });
}

/** Открыть профиль так, как это делает человек: нажатием на себя в шапке. */
async function openProfileFromHeader(page) {
  const link = page.locator('[data-testid="profile-link"]');
  const count = await link.count();
  if (count === 0) return false;
  await link.first().click();
  await page.waitForTimeout(2000);
  return true;
}

const avatarFile = join(OUT, 'avatar.png');
writeFileSync(
  avatarFile,
  await sharp({
    create: { width: 320, height: 320, channels: 3, background: { r: 40, g: 160, b: 120 } },
  })
    .png()
    .toBuffer(),
);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  if (/\b(400|401|403|404|409) \(/.test(message.text())) return;
  consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

try {
  if (!DEMO_PASSWORD) throw new Error('нет пароля демонстрационного комплекта в .env');

  const founder = await registerFounder();
  console.warn('\n=== «МОЙ ПРОФИЛЬ» В КАБИНЕТАХ ===\n');

  // --------------------------------------------- [1] вход в профиль из шапки
  console.warn('[1] Кабинет основателя: вход из шапки');
  await signIn(page, `${LAB_URL}/`, founder);
  expect(
    'Имя в шапке — ссылка, а не подпись',
    (await page.locator('[data-testid="profile-link"]').count()) === 1,
    'вход в профиль на месте',
  );
  const opened = await openProfileFromHeader(page);
  const bodyText = await page.locator('body').innerText();
  expect(
    'Нажатие открывает профиль',
    opened && bodyText.includes('Основные данные') && bodyText.includes('Безопасность'),
    page.url(),
  );
  await screenshot(page, 'lab-profile');

  // ------------------------------------------------------------- [2] имя
  console.warn('\n[2] Имя меняется, и шапка это показывает');
  await page.fill('[data-testid="profile-name"]', 'Профиль Переименованный');
  await page.getByRole('button', { name: /^Сохранить имя$/ }).click();
  await page.waitForTimeout(2500);
  expect(
    'Имя сохранено',
    (await page.locator('[data-testid="profile-notice"]').innerText()).includes('сохранено'),
    'сообщение об успехе',
  );
  expect(
    'Шапка показывает новое имя сразу',
    (await page.locator('[data-testid="profile-link"]').innerText()).includes('Переименованный'),
    'без перезагрузки страницы',
  );

  // ---------------------------------------------------------- [3] аватар
  console.warn('\n[3] Аватар');
  expect(
    'Пока аватара нет — показана буква имени',
    (await page.locator('[data-testid="profile-avatar-letter"]').count()) > 0,
    'заглушка с буквой, а не пустой квадрат',
  );
  await page.setInputFiles('[data-testid="avatar-input"]', avatarFile);
  await page.waitForTimeout(4000);
  expect(
    'Аватар загружен и показан',
    (await page.locator('[data-testid="profile-avatar"]').count()) > 0,
    'картинка на экране',
  );
  const headerAvatar = await page
    .locator('[data-testid="profile-link"] img')
    .getAttribute('src')
    .catch(() => null);
  expect('Шапка тоже показывает аватар', typeof headerAvatar === 'string', String(headerAvatar));
  await screenshot(page, 'lab-profile-avatar');

  await page.locator('[data-testid="avatar-remove"]').click();
  await page.waitForTimeout(2500);
  expect(
    'Аватар удаляется',
    (await page.locator('[data-testid="profile-avatar-letter"]').count()) > 0,
    'снова буква имени',
  );

  // -------------------------------------------------- [4] чего здесь нет
  console.warn('\n[4] Подтверждённые данные не редактируются');
  const profileText = await page.locator('body').innerText();
  expect(
    'Контакт показан маской',
    /\*{3,}/.test(profileText),
    'полный адрес на экран не выводится',
  );
  expect(
    'Сказано, чем меняется адрес',
    /меняется отдельной процедурой подтверждения/.test(profileText),
    'объяснение вместо кнопки, которой нет',
  );
  const emailInputs = await page.locator('input[type="email"]').count();
  expect('Поля ввода адреса нет', emailInputs === 0, `полей: ${emailInputs}`);

  // ---------------------------------------------------------- [5] пароль
  console.warn('\n[5] Смена пароля');
  expect(
    'Предупреждение о закрытии сессий стоит до кнопки',
    /все сессии закроются/.test(profileText),
    'человек знает заранее',
  );
  await page.fill('[data-testid="pwd-current"]', 'заведомо-неверный-пароль');
  await page.fill('[data-testid="pwd-new"]', 'Совершенно-Новый-Пароль-1');
  await page.fill('[data-testid="pwd-repeat"]', 'Совершенно-Новый-Пароль-1');
  await page.locator('[data-testid="pwd-submit"]').click();
  await page.waitForTimeout(2500);
  const pwdError = await page
    .locator('[data-testid="pwd-error"]')
    .innerText()
    .catch(() => '');
  expect(
    'Неверный текущий пароль назван своей причиной, а не «проверьте поля»',
    /текущий пароль неверен/i.test(pwdError),
    pwdError.slice(0, 80),
  );
  expect(
    'Человек остался в кабинете, сессия жива',
    (await page.locator('[data-testid="profile-link"]').count()) === 1,
    'экран не подменился входом',
  );

  // ------------------------------------------- [6] тот же экран в других
  console.warn('\n[6] Тот же профиль в остальных кабинетах');
  for (const [name, url, who] of [
    ['инвестора', INVESTOR_URL, { email: 'demo-investor@unicorn.local', password: DEMO_PASSWORD }],
    ['эксперта', EXPERT_URL, { email: 'demo-expert-fin@unicorn.local', password: DEMO_PASSWORD }],
    ['администратора', ADMIN_URL, { email: 'demo-admin@unicorn.local', password: DEMO_PASSWORD }],
  ]) {
    const tab = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const cabinet = await tab.newPage();
    await signIn(cabinet, `${url}/`, who);
    const found = await openProfileFromHeader(cabinet);
    const text = await cabinet.locator('body').innerText();
    expect(
      `Профиль открывается в кабинете ${name}`,
      found && text.includes('Основные данные') && text.includes('Безопасность'),
      found ? 'экран тот же' : 'вход в профиль не найден',
    );
    await screenshot(cabinet, `profile-${name}`);
    await tab.close();
  }

  const journal = await pool.query(
    `SELECT count(*)::int AS n FROM audit.events WHERE verb IN
       ('identity.avatar.set','identity.avatar.removed','identity.user.profile_updated')
       AND ts > now() - interval '10 minutes'`,
  );
  expect(
    'Действия профиля попали в журнал',
    journal.rows[0].n >= 3,
    `записей за прогон: ${journal.rows[0].n}`,
  );

  expect(
    'Ошибок в консоли нет',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 2).join(' | ') || 'ни одной',
  );
} finally {
  await browser.close();
  await pool.end();
}

console.warn('\n--- ИТОГ ---');
const passed = verdicts.filter((v) => v.state === 'ПРОЙДЕН').length;
const defects = verdicts.filter((v) => v.state === 'ДЕФЕКТ').length;
console.warn(`  пройдено: ${passed}, дефектов: ${defects}`);
console.warn(`  снимки: ${OUT}\n`);
process.exit(defects === 0 ? 0 : 1);
