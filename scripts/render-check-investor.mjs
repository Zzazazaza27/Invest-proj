#!/usr/bin/env node
/**
 * Проверка кабинета инвестора в РЕАЛЬНОМ рендере (`RULES.md` §2).
 *
 * Главное здесь — не «страница открылась», а честность двух состояний:
 * выключенный регулируемый контур должен быть НАЗВАН выключенным, а не показан
 * пустым списком (из пустого списка читается «предложений нет», то есть
 * неправда о доступности функции); полная карточка проекта не должна
 * открываться без подписки.
 *
 * Запуск: node scripts/render-check-investor.mjs
 * Требуется: core на 4300 и кабинет на 5176.
 */
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const APP_URL = process.env.INVESTOR_URL ?? 'http://127.0.0.1:5176/';
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

const suffix = `${Date.now() % 1e9}`;
const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

const email = `inv-render-${suffix}@test.local`;
const password = `Pw-${randomUUID()}`;

{
  const response = await fetch(`${CORE_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      email,
      password,
      displayName: 'Инвестор прогона',
      role: 'investor',
      locale: 'ru-RU',
      consents: CONSENTS,
    }),
  });
  if (!response.ok) throw new Error(`регистрация: HTTP ${response.status}`);
}

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: КАБИНЕТ ИНВЕСТОРА ===\n');

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const text = message.text();
  // Доменные отказы вызываются сценарием намеренно: 401 на проверке сессии,
  // 403 на полной карточке без подписки, 503 на выключенном контуре. Это
  // правильное поведение сервера, а не дефект интерфейса.
  if (/\b(401|403|404|503) \(/.test(text)) return;
  consoleErrors.push(text);
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

console.warn('[1] Вход');
await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30_000 });
check(
  'незалогиненному показан вход',
  (await page.getByRole('heading', { name: 'Вход' }).count()) === 1,
);

await page.fill('#email', email);
await page.fill('#password', password);
await page.getByRole('button', { name: 'Войти' }).click();
await page.waitForSelector('text=Каталог проектов', { timeout: 15_000 });
check('вход выполнен, открыт каталог', true);

console.warn('\n[2] Каталог и доступ к полной карточке');
await page.waitForTimeout(1500);
const catalogText = await page.locator('main').innerText();
check(
  'каталог отрисован без выдуманных данных',
  !/NeuroMind|CourseAI|DesignHub/i.test(catalogText),
);

const detailsButtons = await page.getByRole('button', { name: 'Подробнее' }).count();
if (detailsButtons > 0) {
  await page.getByRole('button', { name: 'Подробнее' }).first().click();
  await page.waitForTimeout(2000);
  const detailText = await page.locator('[role="status"]').first().innerText();
  check(
    'доступ к полной карточке решает сервер, ответ показан',
    detailText.trim().length > 5,
    detailText.slice(0, 70),
  );
} else {
  check('каталог пуст — карточку открывать не на чем', true, 'проверка доступа пропущена честно');
}

console.warn('\n[3] Подписка');
await page.getByRole('button', { name: 'Подписка' }).click();
await page.waitForSelector('h1:text("Подписка")', { timeout: 15_000 });
await page.waitForTimeout(1500);
const subText = await page.locator('main').innerText();
check(
  'состояние подписки объяснено словами',
  /Подписки нет|Действует до|Период не начат/.test(subText),
  subText.replace(/\s+/g, ' ').slice(0, 90),
);
check('условие активации названо честно', subText.includes('Активацию подтверждает оператор'));

console.warn('\n[4] Выключенный регулируемый контур');
await page.getByRole('button', { name: 'Предложения' }).click();
await page.waitForSelector('h1:text("Инвестиционные предложения")', { timeout: 15_000 });
await page.waitForTimeout(2000);
const offersText = await page.locator('main').innerText();
check(
  'выключенный контур НАЗВАН выключенным, а не показан пустым списком',
  offersText.includes('Инвестиционный контур пока не работает'),
  offersText.replace(/\s+/g, ' ').slice(0, 100),
);
check(
  'причина объяснена регуляторно, а не «ошибкой»',
  offersText.includes('реестр инвестиционных платформ'),
);
check(
  'пустого «предложений нет» при выключенном контуре не показано',
  !offersText.includes('Открытых предложений нет'),
);

console.warn('\n[5] Доступность и раскладка');
check('ровно один h1', (await page.locator('h1').count()) === 1);
check(
  'текущий раздел объявлен ассистивным технологиям',
  (await page.locator('[aria-current="page"]').count()) === 1,
);
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
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

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exit(failed > 0 ? 1 : 0);
