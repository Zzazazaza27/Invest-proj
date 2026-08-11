#!/usr/bin/env node
/**
 * Проверка стенда глазами браузера.
 *
 * Развёрнутый стенд и работающий стенд — разные утверждения. Скрипт
 * `dev-stand.mjs` заводит учётные записи и данные; здесь проверяется, что этими
 * учётными записями действительно ВХОДЯТ, и что в каждом кабинете видно ровно
 * то, ради чего он открывается.
 *
 * Запуск: node scripts/check-stand.mjs (после node scripts/dev-stand.mjs)
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

function loadDotEnv() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    process.env[trimmed.slice(0, eq).trim()] ??= trimmed.slice(eq + 1).trim();
  }
}

const PASSWORD = process.env.DEV_TEST_USER_PASSWORD ?? '';
if (!PASSWORD) {
  console.error('Не задан DEV_TEST_USER_PASSWORD — стенд не развёрнут.');
  process.exit(1);
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

const browser = await chromium.launch();

/**
 * Вход в кабинет и снимок содержимого.
 *
 * Форма входа у кабинетов одна и та же по разметке (`#email`, `#password`), но
 * ожидаемый признак успеха у каждого свой — его называет вызывающий, потому что
 * «страница сменилась» не означает «вошли как нужная роль».
 */
async function enter(url, login, expect) {
  // Класс `auth` ограничен 30 запросами в минуту — это работающая защита, а не
  // помеха. Пять входов подряд в неё упираются, и вместо честного результата
  // прогон получал бы таймаут ожидания экрана. Пауза здесь дешевле, чем
  // непонятное падение.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));

  // Ответ на сам вход перехватывается: без него отказ 401/429 выглядит как
  // «экран не появился», и причина теряется.
  let loginStatus = null;
  page.on('response', (response) => {
    if (response.url().endsWith('/v1/auth/login')) loginStatus = response.status();
  });

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.fill('#email', login);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: /Войти/i }).click();
  await page.waitForSelector(`text=${expect}`, { timeout: 20_000 }).catch(() => undefined);
  const text = await page.locator('body').innerText();
  check(
    `вход ${login} принят сервером`,
    loginStatus === 200 || loginStatus === 201,
    `HTTP ${loginStatus}`,
  );
  return { page, context, text, errors };
}

console.warn('\n=== ПРОВЕРКА СТЕНДА ===\n');

// ------------------------------------------------------------------ витрина
console.warn('--- публичная витрина ---');
{
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle', timeout: 30_000 });
  const text = await page.locator('body').innerText();
  check(
    'витрина показывает проект стенда без входа',
    text.includes('Стенд · демонстрационный проект'),
    text.replace(/\s+/g, ' ').slice(0, 90),
  );
  await context.close();
}

// ------------------------------------------------------------ кабинет инвестора
console.warn('\n--- кабинет инвестора (stand-investor) ---');
{
  const { page, context, text, errors } = await enter(
    'http://127.0.0.1:5176/',
    'stand-investor',
    'Каталог',
  );
  check('вход выполнен', text.includes('Кабинет инвестора') && !text.includes('Вход'), '');
  check('в каталоге виден проект стенда', text.includes('Стенд · демонстрационный проект'));

  await page.getByRole('button', { name: 'Подписка' }).click();
  await page.waitForTimeout(2000);
  const subscription = await page.locator('main').innerText();
  check(
    // Экран подписки показывает статус так, как его отдаёт сервер (`active`).
    // Проверка сверяется с ТЕМ, ЧТО НА ЭКРАНЕ, а не с тем, как хотелось бы:
    // подгонять ожидание под желаемое — способ не заметить расхождение.
    'подписка инвестора показана активной',
    /active|активна/i.test(subscription),
    subscription.replace(/\s+/g, ' ').slice(0, 90),
  );

  await page.getByRole('button', { name: 'Верификация' }).click();
  await page.waitForTimeout(2000);
  const verification = await page.locator('main').innerText();
  check(
    'верификация показана подтверждённой',
    verification.includes('подтверждена'),
    verification.replace(/\s+/g, ' ').slice(0, 90),
  );
  check('исключений на странице нет', errors.length === 0, errors.slice(0, 1).join(' | '));
  await context.close();
}

// ---------------------------------------------------------- кабинет основателя
console.warn('\n--- кабинет основателя (stand-founder) ---');
{
  const { page, context, text, errors } = await enter(
    'http://127.0.0.1:5175/',
    'stand-founder',
    'Мои проекты',
  );
  check('вход выполнен и проект виден', text.includes('Стенд · демонстрационный проект'));

  await page.getByText('Стенд · демонстрационный проект').first().click();
  await page.waitForSelector('text=Путь по сезону', { timeout: 20_000 }).catch(() => undefined);
  // История подач подгружается отдельным запросом: читать карточку сразу —
  // значит проверять скорость машины, а не наличие данных.
  await page
    .getByText(/версия 1/)
    .first()
    .waitFor({ timeout: 15_000 })
    .catch(() => undefined);
  const card = await page.locator('main').innerText();
  check('карточка показывает путь по сезону', card.includes('Путь по сезону'));
  check('материалы проекта видны основателю', card.includes('https://example.com/product'));
  check(
    'история подач заполнена',
    /версия 1/.test(card),
    card.match(/версия \d+[^\n]*/)?.[0] ?? '',
  );
  check('исключений на странице нет', errors.length === 0, errors.slice(0, 1).join(' | '));
  await context.close();
}

// ------------------------------------------------------------ кабинет эксперта
console.warn('\n--- кабинет эксперта (stand-expert) ---');
{
  const { page, context, text, errors } = await enter(
    'http://127.0.0.1:5177/',
    'stand-expert',
    'Мои назначения',
  );
  check('назначение видно эксперту', text.includes('Стенд · демонстрационный проект'));

  await page.getByRole('button', { name: 'Материалы проекта' }).first().click();
  await page.waitForTimeout(2500);
  const materials = await page.locator('main').innerText();
  check(
    'материалы назначенного проекта раскрываются',
    materials.includes('https://example.com/product'),
    materials.replace(/\s+/g, ' ').slice(0, 90),
  );
  check('исключений на странице нет', errors.length === 0, errors.slice(0, 1).join(' | '));
  await context.close();
}

// -------------------------------------------------------------------- админка
console.warn('\n--- админка (stand-admin) ---');
{
  const { page, context, text, errors } = await enter(
    'http://127.0.0.1:5174/',
    'stand-admin',
    'Тарифы',
  );
  check('вход выполнен', text.includes('Тарифы') && text.includes('Воронка сезона'));

  await page.getByRole('link', { name: 'Воронка сезона', exact: true }).click();
  await page.getByRole('heading', { name: 'Воронка сезона' }).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  const funnel = await page.locator('main').innerText();
  check(
    'воронка показывает сезон стенда и квоты',
    funnel.includes('Буткемп'),
    funnel.replace(/\s+/g, ' ').slice(0, 90),
  );
  check('исключений на странице нет', errors.length === 0, errors.slice(0, 1).join(' | '));
  await context.close();
}

// ----------------------------------------------------------------- организатор
console.warn('\n--- организатор (stand-organizer) ---');
{
  const { context, text } = await enter('http://127.0.0.1:5174/', 'stand-organizer', 'Тарифы');
  // Организатор — не администратор: кабинет обязан сказать это прямо, а не
  // молча показать экраны, действия на которых сервер отклонит.
  check(
    'организатору объявлено ограничение прав',
    text.includes('нет роли администратора'),
    text.replace(/\s+/g, ' ').slice(0, 90),
  );
  await context.close();
}

await browser.close();

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exitCode = failed > 0 ? 1 : 0;
