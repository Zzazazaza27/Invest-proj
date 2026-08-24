#!/usr/bin/env node
/**
 * Поддержка и сообщение об ошибке в РЕАЛЬНОМ рендере (`RULES.md` §2).
 *
 * Проверяется не «компонент отрисовался», а путь человека целиком:
 *
 *   1. служебная комбинация Ctrl+Alt+B открывает форму сообщения об ошибке;
 *   2. форма показывает, ЧТО именно будет отправлено, и в этом нет ни пароля,
 *      ни токена, ни cookie;
 *   3. отправка даёт подтверждение приёма с номером обращения;
 *   4. раздел «Поддержка» принимает обращение и показывает переписку;
 *   5. сотрудник видит обращение в админке и отвечает, ответ виден автору;
 *   6. на телефоне форма помещается в экран и не рвёт вёрстку.
 *
 * Прогон идёт через ЕДИНУЮ ТОЧКУ ВХОДА (обратный прокси), а не по портам:
 * именно в этом режиме приложение работает у пользователя.
 *
 * Запуск: node scripts/render-check-support.mjs
 * Требуется: `npm run web:up`, ядро и собранные фронтенды.
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PORTS } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE =
  process.env.WEB_URL ?? (PORTS.web === 80 ? 'http://127.0.0.1' : `http://127.0.0.1:${PORTS.web}`);

/** Пароль стенда читается из `.env` и НЕ печатается: он такой же секрет, как остальные. */
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
  console.error('DEV_TEST_USER_PASSWORD не задан в .env — прогон без учётных записей невозможен.');
  process.exit(1);
}

async function signIn(page, login) {
  await page.goto(`${BASE}/login/`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.locator('#email').fill(login);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Войти' }).first().click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
}

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: ПОДДЕРЖКА И СООБЩЕНИЯ ОБ ОШИБКАХ ===\n');

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

const stamp = `${Date.now() % 1e9}`;
const bugSubject = `Проверка рендера: белый экран ${stamp}`;
const supportSubject = `Проверка рендера: вопрос по счёту ${stamp}`;

console.warn('[1] Кабинет инвестора открывается');
await signIn(page, 'stand-investor');
check('инвестор в своём кабинете', page.url().includes('/investor'), page.url());

console.warn('\n[2] Служебная комбинация Ctrl+Alt+B');
{
  // Именно комбинация, а не клик по кнопке: проверяется механизм, ради
  // которого она заведена. Клавиши шлются в страницу, а не в поле ввода.
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.keyboard.press('KeyB');
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await page.waitForTimeout(500);

  const dialog = page.getByRole('dialog', { name: 'Сообщить об ошибке' });
  check('форма открылась по комбинации клавиш', (await dialog.count()) === 1);
  check('поле «что произошло» на месте', (await page.locator('#bug-subject').count()) === 1);
}

console.warn('\n[3] Форма показывает, что именно уйдёт');
{
  await page.getByText('Что будет отправлено вместе с сообщением').click();
  await page.waitForTimeout(300);
  const shown = (await page.locator('pre').first().textContent()) ?? '';
  check('технический контекст показан человеку', shown.includes('url'), shown.slice(0, 60));
  check('в контексте есть размер окна', shown.includes('viewport'));
  // Версия сборки подставляется Vite при сборке. Без неё жалобу «не
  // открывается карточка» невозможно привязать к коду: на стенде и в
  // production крутятся разные сборки.
  const context = JSON.parse(shown);
  check(
    'версия сборки приложена и это не заглушка',
    typeof context.appVersion === 'string' &&
      context.appVersion.length > 0 &&
      context.appVersion !== 'unknown',
    String(context.appVersion),
  );
  check(
    'в контексте нет пароля, токена и cookie',
    !/password|token|cookie|secret/i.test(shown),
    shown.replace(/\s+/g, ' ').slice(0, 80),
  );
  // Токен из письма ходит во фрагменте адреса — он не должен уезжать в отчёт.
  check('фрагмент адреса не пересылается', !shown.includes('#'), shown.slice(0, 60));
}

console.warn('\n[4] Отправка сообщения об ошибке');
{
  await page.locator('#bug-subject').fill(bugSubject);
  await page.locator('#bug-details').fill('Нажал на карточку — страница осталась пустой.');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await page.waitForTimeout(1500);
  const confirmation = await page.getByText('Сообщение принято').count();
  check('человек получил подтверждение приёма', confirmation === 1);
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await page.waitForTimeout(300);
  check('форма закрылась', (await page.getByRole('dialog').count()) === 0);
}

console.warn('\n[5] Раздел «Поддержка»');
{
  await page.getByRole('button', { name: 'Поддержка' }).click();
  await page.waitForTimeout(1200);
  check('раздел открылся', (await page.locator('#support-subject').count()) === 1);
  check(
    'сообщение об ошибке попало в список обращений',
    (await page.getByText(bugSubject).count()) >= 1,
  );

  await page.locator('#support-subject').fill(supportSubject);
  await page.locator('#support-body').fill('Не понимаю, за что списана комиссия по счёту.');
  await page.getByRole('button', { name: 'Отправить' }).first().click();
  await page.waitForTimeout(2000);
  check('обращение принято', (await page.getByText('Обращение принято').count()) >= 1);
  check('переписка открылась', (await page.locator('#support-reply').count()) === 1);
  check(
    'первое сообщение видно в переписке',
    (await page.getByText('Не понимаю, за что списана комиссия').count()) >= 1,
  );
}

console.warn('\n[6] Сотрудник поддержки отвечает');
{
  const staffContext = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const staff = await staffContext.newPage();
  staff.on('pageerror', (error) => pageErrors.push(`admin: ${error}`));
  await signIn(staff, 'stand-admin');
  await staff.goto(`${BASE}/admin/support`, { waitUntil: 'networkidle' });
  await staff.waitForTimeout(1500);

  check('сотрудник видит чужое обращение', (await staff.getByText(supportSubject).count()) >= 1);
  // Формы «написать в поддержку» у сотрудника нет: обращение, заведённое
  // сотрудником за пользователя, не является обращением пользователя.
  check('формы создания за пользователя нет', (await staff.locator('#support-subject').count()) === 0);

  await staff.getByText(supportSubject).first().click();
  await staff.waitForTimeout(1200);
  await staff.getByRole('button', { name: 'Взять в работу' }).click();
  await staff.waitForTimeout(1200);
  check('обращение в работе', (await staff.getByText('в работе').count()) >= 1);

  await staff.locator('#support-reply').fill('Комиссия начислена по тарифу, детали во вложении.');
  await staff.getByRole('button', { name: 'Отправить' }).first().click();
  await staff.waitForTimeout(1500);
  check('ответ сотрудника опубликован', (await staff.getByText('Поддержка ·').count()) >= 1);

  await staffContext.close();
}

console.warn('\n[7] Автор видит ответ');
{
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Поддержка' }).click();
  await page.waitForTimeout(1500);
  await page.getByText(supportSubject).first().click();
  await page.waitForTimeout(1500);
  check(
    'ответ поддержки виден автору',
    (await page.getByText('Комиссия начислена по тарифу').count()) >= 1,
  );
  check('ответ подписан стороной разговора', (await page.getByText('Поддержка ·').count()) >= 1);
}

console.warn('\n[8] Телефон');
{
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const small = await mobile.newPage();
  small.on('pageerror', (error) => pageErrors.push(`mobile: ${error}`));
  await signIn(small, 'stand-investor');
  await small.getByRole('button', { name: 'Поддержка' }).click();
  await small.waitForTimeout(1200);

  const overflow = await small.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check('страница не едет по горизонтали', overflow <= 1, `перелив ${overflow}px`);

  await small.getByRole('button', { name: 'Сообщить об ошибке' }).click();
  await small.waitForTimeout(600);
  const box = await small.locator('#bug-subject').boundingBox();
  check('форма помещается в экран телефона', box !== null && box.width <= 390, JSON.stringify(box));
  const overflowDialog = await small.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check('открытая форма не рвёт вёрстку', overflowDialog <= 1, `перелив ${overflowDialog}px`);
  await mobile.close();
}

check('исключений на страницах нет', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await context.close();
await browser.close();

console.warn(`\nИТОГО: ${passed} пройдено, ${failed} провалено\n`);
process.exit(failed === 0 ? 0 : 1);
