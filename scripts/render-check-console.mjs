#!/usr/bin/env node
/**
 * Проверка консоли API в РЕАЛЬНОМ рендере (`RULES.md` §2).
 *
 * Консоль служебная, но именно ею тестировщики проходят сквозные сценарии —
 * значит её поломка останавливает проверку всей платформы, а не только себя.
 * Здесь проверяется то, что дороже всего сломать незаметно: список операций
 * отрисован целиком, форма перестраивается при смене операции, отказ сервера
 * показывается как отказ (а не как пустой экран), и блокнот идентификаторов
 * переживает перезагрузку страницы.
 *
 * Часть проверок сознательно выполняется БЕЗ поднятого ядра: консоль обязана
 * оставаться работоспособной, когда API недоступен, — иначе по ней нельзя
 * отличить «сервер отказал» от «страница сломалась».
 *
 * Запуск: node scripts/render-check-console.mjs
 * Требуется: консоль поднята (порт — из .env).
 */
import { chromium } from 'playwright';

import { frontendUrl } from './lib/ports.mjs';

const URL = process.env.CONSOLE_URL ?? frontendUrl('console');

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

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: КОНСОЛЬ API ===\n');

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();

const pageErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(message.text());
});
page.on('pageerror', (error) => pageErrors.push(String(error)));

console.warn('[1] Загрузка и список операций');
const response = await page.goto(URL, { waitUntil: 'networkidle', timeout: 30_000 });
check('страница отвечает', response?.ok() === true, `HTTP ${response?.status()}`);

const heading = await page.locator('h1').first().textContent();
check('заголовок отрисован', heading?.includes('Консоль') === true, heading ?? '');

const operationCount = await page.locator('.console-op').count();
// Меньше полусотни означало бы, что часть групп не попала в сборку: покрытие
// API — единственная причина, по которой консоль вообще существует.
check('операции отрисованы', operationCount >= 50, `${operationCount} операций`);

const groupCount = await page.locator('.console-group').count();
check('группы отрисованы', groupCount >= 10, `${groupCount} групп`);

// Метод виден до нажатия: он задаёт цену ошибки — GET читает, DELETE удаляет.
const deleteBadges = await page.locator('.console-method--delete').count();
check('разрушающие операции помечены методом', deleteBadges > 0, `${deleteBadges} шт.`);

console.warn('\n[2] Смена операции перестраивает форму');
await page.getByRole('button', { name: /Регистрация/ }).click();
await page.waitForTimeout(300);
const registerFields = await page.locator('form label').allTextContents();
check(
  'форма регистрации показывает поля контракта',
  registerFields.some((l) => l.includes('Пароль')) &&
    registerFields.some((l) => l.includes('Роль')),
  registerFields.slice(0, 4).join(', '),
);

await page.getByRole('button', { name: /Выпустить предложение/ }).click();
await page.waitForTimeout(300);
const offerFields = await page.locator('form label').allTextContents();
check(
  'форма предложения показывает свои поля, а не прежние',
  offerFields.some((l) => l.includes('Целевая сумма')) &&
    !offerFields.some((l) => l.includes('Пароль')),
  offerFields.slice(0, 4).join(', '),
);

// Ключ идемпотентности виден и заполнен: спрятанный ключ не позволил бы
// повторить запрос тем же ключом, а в этом половина смысла проверки.
const idempotency = await page.locator('input#offer-create-idempotencyKey').inputValue();
check('ключ идемпотентности предзаполнен и виден', idempotency.startsWith('offer-'), idempotency);

console.warn('\n[3] Отказ сервера показывается как отказ');
await page.getByRole('button', { name: /Проверка живости/ }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Выполнить GET/ }).click();
// Ядро в этой проверке может быть поднято или нет: важно, что ЛЮБОЙ исход
// объявлен явно — успехом или отказом, а не пустым местом.
await page.waitForTimeout(2500);
const resultText = await page.locator('.console-json').first().textContent();
check(
  'результат вызова показан',
  Boolean(resultText && resultText.trim().length > 0),
  resultText?.replace(/\s+/g, ' ').slice(0, 60),
);
const badgeText = await page.locator('span:has-text("успех"), span:has-text("отказ")').count();
check('исход помечен успехом или отказом', badgeText > 0);

console.warn('\n[4] Блокнот переживает перезагрузку страницы');
// Прогон подкладывает блокнот руками, чтобы проверить, что он переживает
// перезагрузку. В хранилище идут идентификаторы объектов, а не сессия: сессия
// консоли живёт в httpOnly-cookie и коду страницы недоступна.
await page.evaluate(() =>
  // nosemgrep: unicorn-no-token-in-web-storage
  sessionStorage.setItem(
    'unicorn-console-notebook',
    JSON.stringify({ projectId: '01920000-0000-7000-8000-000000000001' }),
  ),
);
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Карточка проекта$/ }).click();
await page.waitForTimeout(300);
const prefilled = await page.locator('input#projects-get-projectId').inputValue();
check(
  'идентификатор из блокнота подставлен в поле',
  prefilled === '01920000-0000-7000-8000-000000000001',
  prefilled,
);

const notebookRows = await page.locator('.console-table tr').count();
check('блокнот показан на странице', notebookRows > 0, `${notebookRows} строк`);

console.warn('\n[5] Исключений на странице нет');
// Отказы сети сюда не относятся: без поднятого ядра они ожидаемы и попадают в
// консоль браузера как ошибки загрузки ресурса, а не как поломка приложения.
const realErrors = pageErrors.filter(
  (text) => !/Failed to load resource|net::ERR|ERR_CONNECTION|401|Unauthorized/i.test(text),
);
check('исключений нет', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));

await context.close();
await browser.close();

console.warn(`\nИТОГО: ${passed} пройдено, ${failed} провалено\n`);
if (failed > 0) process.exit(1);
