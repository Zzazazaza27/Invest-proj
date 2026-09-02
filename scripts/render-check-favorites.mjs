#!/usr/bin/env node
/**
 * Избранное инвестора в РЕАЛЬНОМ рендере (`RULES.md` §2).
 *
 * ТЗ требовало проверить сценарий end-to-end. Проверяется путь человека:
 *
 *   1. в каталоге у карточки есть отметка, и её состояние объявлено не только
 *      цветом (`aria-pressed`, текст) — иначе для экранного диктора её нет;
 *   2. нажатие добавляет проект, повторное — убирает;
 *   3. отмеченный проект появляется в разделе «Избранное»;
 *   4. состояние переживает ПЕРЕЗАГРУЗКУ страницы и повторный вход — то есть
 *      живёт на сервере, а не в браузере;
 *   5. из раздела проект убирается и исчезает из списка;
 *   6. на телефоне раздел не рвёт вёрстку.
 *
 * Прогон идёт через единую точку входа.
 *
 * Запуск: node scripts/render-check-favorites.mjs
 * Требуется: `npm run web:up`, ядро, собранные фронтенды и заполненный стенд.
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PORTS } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE =
  process.env.WEB_URL ?? (PORTS.web === 80 ? 'http://127.0.0.1' : `http://127.0.0.1:${PORTS.web}`);

/** Пароль стенда читается из `.env` и НЕ печатается. */
function standPassword() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return null;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('DEV_TEST_USER_PASSWORD=')) continue;
    return trimmed.slice('DEV_TEST_USER_PASSWORD='.length).trim();
  }
  return null;
}

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

const password = standPassword();
if (!password) {
  console.error('DEV_TEST_USER_PASSWORD не задан в .env — прогон невозможен.');
  process.exit(1);
}

async function signIn(page) {
  await page.goto(`${BASE}/login/`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.locator('#email').fill('stand-investor');
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Войти' }).first().click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
}

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: ИЗБРАННОЕ ИНВЕСТОРА ===\n');

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

console.warn('[1] Каталог и отметка на карточке');
await signIn(page);
check('инвестор в своём кабинете', page.url().includes('/investor'), page.url());

const addButtons = page.getByRole('button', { name: /В избранное|В избранном/ });
const cardCount = await addButtons.count();
if (cardCount === 0) {
  console.error('В каталоге нет карточек — заполните стенд: node scripts/dev-stand.mjs');
  await browser.close();
  process.exit(1);
}
check('отметка есть у карточек каталога', cardCount > 0, `карточек: ${cardCount}`);

// Название проекта берётся из карточки: по нему потом ищем его в избранном.
const firstCard = page.locator('li').filter({ has: addButtons.first() }).first();
const projectTitle = ((await firstCard.locator('strong').first().textContent()) ?? '').trim();
check('название проекта прочитано', projectTitle.length > 0, projectTitle);

console.warn('\n[2] Состояние отметки доступно не только глазами');
{
  const button = addButtons.first();
  const pressedBefore = await button.getAttribute('aria-pressed');
  check('состояние объявлено через aria-pressed', pressedBefore !== null, String(pressedBefore));
  const textBefore = ((await button.textContent()) ?? '').trim();
  check('состояние читается словами, а не только цветом', textBefore.length > 0, textBefore);
}

console.warn('\n[3] Добавление');
{
  const button = page
    .locator('li')
    .filter({ hasText: projectTitle })
    .first()
    .getByRole('button', { name: /В избранное|В избранном/ });
  // Прогон должен быть повторяемым: если проект уже отмечен прошлым запуском,
  // сначала снимаем отметку — иначе «добавить» проверяло бы не то.
  if ((await button.getAttribute('aria-pressed')) === 'true') {
    await button.click();
    await page.waitForTimeout(1200);
  }
  await button.click();
  await page.waitForTimeout(1500);
  check('отметка встала', (await button.getAttribute('aria-pressed')) === 'true');
  check(
    'надпись сменилась на «В избранном»',
    ((await button.textContent()) ?? '').includes('В избранном'),
  );
}

console.warn('\n[4] Раздел «Избранное»');
{
  await page.getByRole('button', { name: 'Избранное', exact: true }).click();
  await page.waitForTimeout(1500);
  check(
    'раздел открылся',
    (await page.getByRole('heading', { name: 'Избранные проекты' }).count()) === 1,
  );
  check('проект в списке', (await page.getByText(projectTitle).count()) >= 1, projectTitle);
  check('показан момент добавления', (await page.getByText(/в избранном с/).count()) >= 1);
}

console.warn('\n[5] Состояние живёт на сервере');
{
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  // После перезагрузки кабинет открывается на каталоге: отметка обязана быть
  // на месте, иначе она хранилась только в памяти вкладки.
  const button = page
    .locator('li')
    .filter({ hasText: projectTitle })
    .first()
    .getByRole('button', { name: /В избранное|В избранном/ });
  check(
    'после перезагрузки отметка на месте',
    (await button.getAttribute('aria-pressed')) === 'true',
  );

  // Новый контекст = новые cookie: повторный вход с чистого листа.
  const second = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const fresh = await second.newPage();
  fresh.on('pageerror', (error) => pageErrors.push(`повторный вход: ${error}`));
  await signIn(fresh);
  await fresh.getByRole('button', { name: 'Избранное', exact: true }).click();
  await fresh.waitForTimeout(1500);
  check(
    'после повторного входа проект в избранном',
    (await fresh.getByText(projectTitle).count()) >= 1,
  );
  await second.close();
}

console.warn('\n[6] Удаление из раздела');
{
  await page.getByRole('button', { name: 'Избранное', exact: true }).click();
  await page.waitForTimeout(1500);
  await page
    .locator('li')
    .filter({ hasText: projectTitle })
    .first()
    .getByRole('button', { name: 'Убрать из избранного' })
    .click();
  await page.waitForTimeout(1800);
  check('проект пропал из списка', (await page.getByText(projectTitle).count()) === 0);

  await page.getByRole('button', { name: 'Каталог', exact: true }).click();
  await page.waitForTimeout(1500);
  const button = page
    .locator('li')
    .filter({ hasText: projectTitle })
    .first()
    .getByRole('button', { name: /В избранное|В избранном/ });
  check('в каталоге отметка снята', (await button.getAttribute('aria-pressed')) === 'false');
}

console.warn('\n[7] Телефон');
{
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Избранное', exact: true }).click();
  await page.waitForTimeout(1200);
  const overflow = await page.evaluate(
    // eslint-disable-next-line no-undef -- код исполняется в браузере, не в Node
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check('горизонтальной прокрутки нет на 390px', overflow <= 1, `переполнение: ${overflow}px`);
}

check('исключений на страницах нет', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await context.close();
await browser.close();

console.warn(`\nИТОГО: ${passed} пройдено, ${failed} провалено\n`);
process.exit(failed === 0 ? 0 : 1);
