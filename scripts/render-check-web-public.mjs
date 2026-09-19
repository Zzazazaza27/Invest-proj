#!/usr/bin/env node
/**
 * Проверка витрины в РЕАЛЬНОМ рендере (`RULES.md` §2).
 *
 * Вычитка кода не показывает ни того, что страница вообще отрисовалась, ни
 * того, что она показала пользователю вместо данных при недоступном API.
 * Поэтому здесь настоящий браузер: сначала обычная загрузка, затем те же
 * экраны с оборванной сетью — состояния ошибки обязаны быть видимыми, а не
 * пустым местом.
 *
 * Запуск: node scripts/render-check-web-public.mjs
 * Требуется: витрина поднята (порт — из .env) (`npm run preview -w apps/web-public`).
 */
import { chromium } from 'playwright';

import { frontendUrl } from './lib/ports.mjs';

/**
 * Адрес приводится к `localhost`: у сырого IP нет регистрируемого домена, и
 * браузер не может установить «тот же сайт» — изображения проектов на витрине
 * блокируются политикой встраивания (разобрано в 7.2). Свойство адресации
 * стенда, не продукта; остальные браузерные проверки ходят так же.
 */
const URL = (process.env.WEB_PUBLIC_URL ?? frontendUrl('webPublic')).replace(
  '127.0.0.1',
  'localhost',
);

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

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: ПУБЛИЧНАЯ ВИТРИНА ===\n');

const browser = await chromium.launch();

// ------------------------------------------------------- обычная загрузка
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  console.warn('[1] Обычная загрузка');
  const response = await page.goto(URL, { waitUntil: 'networkidle', timeout: 30_000 });
  check('страница отвечает', response?.ok() === true, `HTTP ${response?.status()}`);

  const heading = await page.locator('h1').first().textContent();
  check(
    'заголовок отрисован',
    Boolean(heading && heading.trim().length > 10),
    heading?.slice(0, 40),
  );

  check(
    'каталог и тарифы присутствуют на странице',
    (await page.locator('#catalog').count()) === 1 &&
      (await page.locator('#pricing').count()) === 1,
  );

  // Тарифы приходят из API: если блок отрисовал карточки — данные реальные.
  await page.waitForTimeout(1500);
  const planCards = await page.locator('#pricing li').count();
  const pricingError = await page.locator('#pricing [role="alert"]').count();
  check(
    'тарифы получены из API либо ошибка показана явно',
    planCards > 0 || pricingError > 0,
    `карточек: ${planCards}, блоков ошибки: ${pricingError}`,
  );

  // Захардкоженных проектов из прежнего макета быть не должно.
  const body = (await page.locator('body').innerText()).toLowerCase();
  const fakes = ['neuromind', 'courseai', 'designhub', 'payflow', 'stageflow'];
  const found = fakes.filter((name) => body.includes(name));
  check('выдуманных проектов на витрине нет', found.length === 0, found.join(', ') || 'нет');

  check(
    'ошибок в консоли нет',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 2).join(' | ') || 'нет',
  );

  // Доступность: у страницы один h1, есть ссылка «к содержимому», у полей есть подписи.
  check('ровно один h1', (await page.locator('h1').count()) === 1);
  check('есть ссылка «перейти к содержимому»', (await page.locator('.u-skip-link').count()) === 1);
  const unlabeled = await page.locator('input:not([aria-label]):not([id])').count();
  check('поля ввода имеют подписи', unlabeled === 0, `без подписи: ${unlabeled}`);

  console.warn('\n[2] Мобильная ширина');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  // Функция сериализуется и исполняется В БРАУЗЕРЕ, а не в Node: `document`
  // здесь существует, но линтер видит только окружение Node.
  const overflow = await page.evaluate(
    // eslint-disable-next-line no-undef
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check('горизонтальной прокрутки нет', overflow <= 1, `переполнение: ${overflow}px`);

  await page.screenshot({ path: 'graphify-out/web-public-mobile.png' });
  await context.close();
}

// --------------------------------------------------- недоступный бэкенд
{
  console.warn('\n[3] Бэкенд недоступен');
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  // Рвём ровно вызовы API, оставляя саму страницу доступной.
  await page.route('**/v1/**', (route) => route.abort('failed'));
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(2500);

  const alerts = await page.locator('[role="alert"]').count();
  check('состояние ошибки показано, а не пустой экран', alerts > 0, `блоков: ${alerts}`);

  const retry = await page.getByRole('button', { name: 'Повторить' }).count();
  check('есть действие восстановления', retry > 0, `кнопок «Повторить»: ${retry}`);

  const text = await page.locator('body').innerText();
  check(
    'страница не показывает технические детали сбоя',
    !/TypeError|undefined|NetworkError|stack/i.test(text),
  );

  await page.screenshot({ path: 'graphify-out/web-public-offline.png' });
  await context.close();
}

await browser.close();

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exit(failed > 0 ? 1 : 0);
