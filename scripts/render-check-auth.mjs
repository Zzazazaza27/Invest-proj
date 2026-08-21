#!/usr/bin/env node
/**
 * Проверка входа и регистрации в РЕАЛЬНОМ рендере (`RULES.md` §2).
 *
 * Это единственная дверь в платформу: её поломка означает, что внутрь не может
 * попасть никто, независимо от исправности остального. Поэтому проверяется не
 * «страница отрисовалась», а фактический путь человека — вход, роль, переход в
 * свой кабинет — и границы: эксперта в самостоятельном выборе быть не должно,
 * а без согласия с документами регистрация не отправляется.
 *
 * Прогон идёт через ЕДИНУЮ ТОЧКУ ВХОДА (обратный прокси), а не по портам: под
 * прокси приложение раздаётся из подпути, API живёт на том же origin, и именно
 * в этом режиме оно работает у пользователя.
 *
 * Запуск: node scripts/render-check-auth.mjs
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
  console.error(
    'DEV_TEST_USER_PASSWORD не задан в .env — прогон без учётных записей стенда невозможен.',
  );
  process.exit(1);
}

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: ВХОД И РЕГИСТРАЦИЯ ===\n');

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

console.warn('[1] Витрина ведёт на вход');
let response = await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30_000 });
check('витрина отвечает', response?.ok() === true, `HTTP ${response?.status()}`);
// Номер порта в адресе — то, чего пользователь видеть не должен.
check('в адресе витрины нет порта', !new URL(page.url()).port, page.url());
check(
  'кнопки «Войти» и «Регистрация» на месте',
  (await page.getByRole('link', { name: 'Войти' }).count()) === 1 &&
    (await page.getByRole('link', { name: 'Регистрация' }).count()) === 1,
);

console.warn('\n[2] Экран входа');
await page.getByRole('link', { name: 'Войти' }).click();
await page.waitForLoadState('networkidle');
check('открылся /login/', page.url().endsWith('/login/'), page.url());

console.warn('\n[3] Регистрация: роли и согласия');
await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
await page.waitForTimeout(300);
const roles = await page.locator('.auth-role-title').allTextContents();
check('предложены ровно две роли', roles.length === 2, roles.join(', '));
// Роль эксперта назначает платформа: самостоятельная выдача обессмыслила бы
// экспертизу, и контракт её не допускает (SelfServiceRoleSchema).
check('роли «эксперт» в самостоятельном выборе нет', !roles.some((r) => /эксперт/i.test(r)));
check(
  'без согласия с документами отправка заблокирована',
  (await page.getByRole('button', { name: 'Создать аккаунт' }).isDisabled()) === true,
);

console.warn('\n[4] Действующие версии документов отдаются публично');
const templates = await page.evaluate(async (base) => {
  const r = await fetch(`${base}/v1/auth/consents/templates?locale=ru-RU`);
  return { status: r.status, body: await r.json() };
}, BASE);
check('маршрут версий отвечает без входа', templates.status === 200, `HTTP ${templates.status}`);
check(
  'отданы все четыре обязательных документа',
  ['platform_rules', 'tos', 'pdn', 'commission_terms'].every((kind) =>
    (templates.body.items ?? []).some((item) => item.kind === kind),
  ),
  `документов ${templates.body.items?.length ?? 0}`,
);

console.warn('\n[5] Вход уводит в кабинет по роли');
await page.getByRole('button', { name: 'Войти' }).last().click();
await page.waitForTimeout(300);
await page.locator('#email').fill('stand-founder@unicorn.local');
await page.locator('#password').fill(password);
await page.getByRole('button', { name: 'Войти' }).first().click();
await page.waitForLoadState('networkidle');
await page.waitForTimeout(1500);
check('основатель попал в свой кабинет', page.url().includes('/lab'), page.url());
check('в адресе кабинета нет порта', !new URL(page.url()).port, page.url());

console.warn('\n[6] Короткое имя учётной записи принимается');
// Служебные учётки заводятся как `имя@unicorn.local`, и кабинеты дополняют
// домен сами. Экран входа обязан вести себя так же: иначе верно введённый
// `stand-admin` отвергается проверкой адреса, и человек видит «проверьте
// заполнение полей» на правильном логине.
{
  const shortCtx = await browser.newContext();
  const shortPage = await shortCtx.newPage();
  await shortPage.goto(`${BASE}/login/`, { waitUntil: 'networkidle' });
  await shortPage.locator('#email').fill('stand-admin');
  await shortPage.locator('#password').fill(password);
  await shortPage.getByRole('button', { name: 'Войти' }).first().click();
  await shortPage.waitForTimeout(2500);
  check('вход по короткому имени без домена', shortPage.url().includes('/admin'), shortPage.url());
  await shortCtx.close();
}

console.warn('\n[7] Неверный пароль не различает причину отказа');
const clean = await browser.newContext();
const p2 = await clean.newPage();
await p2.goto(`${BASE}/login/`, { waitUntil: 'networkidle' });
await p2.locator('#email').fill('stand-founder@unicorn.local');
await p2.locator('#password').fill('заведомо-неверный-пароль');
await p2.getByRole('button', { name: 'Войти' }).first().click();
await p2.waitForTimeout(1500);
const wrongPassword = (await p2.locator('[role="alert"]').first().textContent()) ?? '';

// Адрес обязан быть СИНТАКСИЧЕСКИ верным, иначе сервер ответит отказом
// валидации, и сравнение сравнивало бы не то: разница текстов означала бы
// «неверный формат», а не «такого аккаунта нет».
await p2.locator('#email').fill('no-such-account-91745@unicorn.local');
await p2.getByRole('button', { name: 'Войти' }).first().click();
await p2.waitForTimeout(1500);
const noAccount = (await p2.locator('[role="alert"]').first().textContent()) ?? '';

// Разные тексты для «нет аккаунта» и «неверный пароль» — это перебор учётных
// записей: злоумышленник узнаёт, какие адреса зарегистрированы.
check(
  'отказ одинаков для неверного пароля и несуществующего аккаунта',
  wrongPassword.trim() === noAccount.trim() && wrongPassword.trim().length > 0,
  `пароль: «${wrongPassword.trim()}» · аккаунт: «${noAccount.trim()}»`,
);

// ------------------------------------------- восстановление пароля (Ф51)
//
// Проверяется путь, который человек проходит целиком: ссылка «Забыли пароль?»
// → форма адреса → одинаковое сообщение независимо от того, зарегистрирован ли
// адрес. Токен из письма здесь не берётся — это дело смоук-прогона; браузеру
// важно, что экран есть, отвечает и ничего не выдаёт.
console.warn('\n[8] Восстановление пароля');
const p3 = await (await browser.newContext()).newPage();
await p3.goto(`${BASE}/login/`, { waitUntil: 'networkidle' });
await p3.getByRole('button', { name: 'Забыли пароль?' }).click();
await p3.waitForTimeout(400);
check('экран восстановления открылся', (await p3.locator('#forgot-email').count()) === 1);
check(
  'на экране восстановления нет поля пароля',
  (await p3.locator('#password').count()) === 0,
);

await p3.locator('#forgot-email').fill('stand-founder@unicorn.local');
await p3.getByRole('button', { name: 'Прислать ссылку' }).click();
await p3.waitForTimeout(1500);
const knownNotice = ((await p3.locator('[role="status"]').first().textContent()) ?? '').trim();

await p3.getByRole('button', { name: 'Забыли пароль?' }).click();
await p3.waitForTimeout(300);
await p3.locator('#forgot-email').fill('no-such-account-91745@unicorn.local');
await p3.getByRole('button', { name: 'Прислать ссылку' }).click();
await p3.waitForTimeout(1500);
const unknownNotice = ((await p3.locator('[role="status"]').first().textContent()) ?? '').trim();

// Разные сообщения здесь — это перечисление пользователей, причём удобнее
// формы входа: пароль не нужен вовсе.
check(
  'сообщение одинаково для зарегистрированного и чужого адреса',
  knownNotice === unknownNotice && knownNotice.length > 0,
  `«${knownNotice.slice(0, 60)}» против «${unknownNotice.slice(0, 60)}»`,
);

// Ссылка из письма открывает форму нового пароля. Токен заведомо недействующий:
// проверяется экран, а не смена пароля — её проверяет смоук-прогон.
await p3.goto(`${BASE}/login/#reset=${'z'.repeat(43)}`, { waitUntil: 'networkidle' });
await p3.waitForTimeout(500);
check('ссылка из письма открывает форму нового пароля', (await p3.locator('#new-password').count()) === 1);
await p3.locator('#new-password').fill('Some-long-passw0rd!');
await p3.locator('#repeat-password').fill('Other-long-passw0rd!');
await p3.getByRole('button', { name: 'Сменить пароль' }).click();
await p3.waitForTimeout(400);
check(
  'несовпадение паролей ловится до отправки',
  ((await p3.locator('[role="alert"]').first().textContent()) ?? '').includes('не совпадают'),
);

await p3.locator('#repeat-password').fill('Some-long-passw0rd!');
await p3.getByRole('button', { name: 'Сменить пароль' }).click();
await p3.waitForTimeout(1500);
const resetError = ((await p3.locator('[role="alert"]').first().textContent()) ?? '').trim();
check(
  'недействующая ссылка объяснена словами и предлагает выход',
  resetError.includes('недействительна') && resetError.includes('новую'),
  resetError.slice(0, 70),
);

const inputsWithoutLabel = await p3.locator('input:not([id]):not([aria-label])').count();
check('поля восстановления имеют подписи', inputsWithoutLabel === 0, `без подписи: ${inputsWithoutLabel}`);


check('исключений на страницах нет', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();
console.warn(`\nИТОГО: ${passed} пройдено, ${failed} провалено\n`);
if (failed > 0) process.exit(1);
