#!/usr/bin/env node
/**
 * Браузерный проход: раздел «Пользователи» и карточка человека (этап 6.5).
 *
 * Проверяется то, ради чего раздел и делался, — что администратор может
 * сделать работу целиком, не открывая ни базу, ни служебную консоль:
 *
 *   1. найти человека по каждому из четырёх полей;
 *   2. отобрать нужных фильтрами и пройтись по страницам;
 *   3. открыть карточку — и ссылкой из письма тоже;
 *   4. распорядиться учётной записью: роль, блокировка, имя, контакты;
 *   5. не провалиться в пустоту на неизвестном адресе.
 *
 * Проход работает на СВОЁМ временном аккаунте: блокировать демонстрационные
 * учётные записи нельзя — ими пользуется приёмка.
 *
 * Снимки — `out/render-admin-users/`.
 * Запуск: UNICORN_ENTRY=web node scripts/render-check-admin-users.mjs
 */
import { chromium } from 'playwright';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL as DEFAULT_CORE_URL, frontendUrl } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const toSite = (url) => url.replace('127.0.0.1', 'localhost');
// Без завершающей косой черты: адреса ниже добавляют свою, а '//users'
// для маршрутизатора — другой путь (и он честно отвечает «такой страницы нет»).
const ADMIN_URL = toSite(process.env.ADMIN_URL ?? frontendUrl('admin')).replace(/\/+$/, '');
const CORE_URL = toSite(process.env.CORE_URL ?? DEFAULT_CORE_URL);

const OUT = join(ROOT, 'out', 'render-admin-users');
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

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL_OWNER,
  max: 2,
  application_name: 'unicorn-render-admin-users',
});
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

const ADMIN = {
  email: 'demo-admin@unicorn.local',
  password: process.env.DEMO_USER_PASSWORD ?? process.env.DEV_TEST_USER_PASSWORD ?? '',
};

const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

/** Временный человек, над которым проход ставит опыты. */
async function createVictim() {
  const suffix = `${Date.now() % 1e9}`;
  const email = `render-users-${suffix}@test.local`;
  const response = await fetch(`${CORE_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: `Pw-${randomUUID()}`,
      displayName: `Проходной Пользователь ${suffix}`,
      role: 'founder',
      locale: 'ru-RU',
      consents: CONSENTS,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status >= 400) {
    throw new Error(`не удалось создать временного пользователя: HTTP ${response.status}`);
  }
  const [row] = await sql(
    `SELECT id, display_name FROM identity.users
      WHERE display_name = $1 ORDER BY created_at DESC LIMIT 1`,
    [`Проходной Пользователь ${suffix}`],
  );
  return { id: row.id, email, displayName: row.display_name };
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
  await page.waitForTimeout(1200);
}

let shot = 0;
async function screenshot(page, name) {
  shot += 1;
  await page.screenshot({
    path: join(OUT, `${String(shot).padStart(2, '0')}-${name}.png`),
    fullPage: true,
  });
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  // Ожидаемые отказы прохода (401 до входа, 404 несуществующей карточки) —
  // не дефекты интерфейса.
  if (/\b(400|401|403|404|409) \(/.test(message.text())) return;
  consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

try {
  if (!ADMIN.password) throw new Error('нет пароля демонстрационного комплекта в .env');

  const victim = await createVictim();
  console.warn(`\n=== РАЗДЕЛ «ПОЛЬЗОВАТЕЛИ» В БРАУЗЕРЕ ===\nвременный человек: ${victim.id}\n`);

  await signIn(page, `${ADMIN_URL}/users`, ADMIN);
  await page.waitForTimeout(1500);
  await screenshot(page, 'users-list');

  // ------------------------------------------------------------ [1] список
  console.warn('[1] Список открывается и считает по всей выборке');
  const table = page.locator('[data-users-table]');
  expect('Таблица людей на экране', (await table.count()) > 0, 'раздел «Пользователи»');
  const totalText = await page.locator('[data-users-total]').innerText();
  expect('Сказано, сколько всего найдено', /Найдено: \d+/.test(totalText), totalText);
  const rows = await page.locator('[data-user-row]').count();
  expect('Строки отрисованы', rows > 0 && rows <= 25, `строк на странице: ${rows}`);

  // ------------------------------------------------------------- [2] поиск
  console.warn('\n[2] Поиск по выбранному полю');
  await page.fill('[data-search-input]', victim.displayName);
  await page.getByRole('button', { name: /^Искать$/ }).click();
  await page.waitForTimeout(1500);
  expect(
    'Поиск по имени находит человека',
    (await page.locator(`[data-user-row="${victim.id}"]`).count()) === 1,
    victim.displayName,
  );

  await page.selectOption('[data-search-field]', 'email');
  await page.fill('[data-search-input]', victim.email);
  await page.getByRole('button', { name: /^Искать$/ }).click();
  await page.waitForTimeout(1500);
  expect(
    'Поиск по адресу находит того же человека',
    (await page.locator(`[data-user-row="${victim.id}"]`).count()) === 1,
    victim.email,
  );
  const hint = await page.locator('form.toolbar span.small').first().innerText();
  expect(
    'Экран честно говорит, что по адресу ищет целиком',
    /полному совпадению/i.test(hint),
    hint,
  );

  await page.selectOption('[data-search-field]', 'id');
  await page.fill('[data-search-input]', victim.id);
  await page.getByRole('button', { name: /^Искать$/ }).click();
  await page.waitForTimeout(1500);
  expect(
    'Поиск по идентификатору находит того же человека',
    (await page.locator(`[data-user-row="${victim.id}"]`).count()) === 1,
    victim.id.slice(0, 8),
  );
  await screenshot(page, 'users-search-by-id');

  // -------------------------------------------------- [3] фильтры и страницы
  console.warn('\n[3] Фильтры и страницы');
  await page.goto(`${ADMIN_URL}/users`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const allTotal = Number(
    (await page.locator('[data-users-total]').innerText()).replace(/\D/g, ''),
  );
  await page.selectOption('[data-filter-role]', 'expert');
  await page.waitForTimeout(1500);
  const expertTotal = Number(
    (await page.locator('[data-users-total]').innerText()).replace(/\D/g, ''),
  );
  expect(
    'Фильтр по роли меняет выборку, а не только страницу',
    expertTotal > 0 && expertTotal < allTotal,
    `экспертов ${expertTotal} из ${allTotal}`,
  );

  const firstBefore = await page.locator('[data-user-row]').first().getAttribute('data-user-row');
  await page.locator('[data-page-next]').click();
  await page.waitForTimeout(1500);
  const firstAfter = await page.locator('[data-user-row]').first().getAttribute('data-user-row');
  expect('Вторая страница показывает других людей', firstBefore !== firstAfter, 'списки разные');
  expect(
    'Отбор сохраняется в адресе страницы',
    page.url().includes('role=expert') && page.url().includes('page=2'),
    page.url().split('?')[1] ?? '',
  );
  await screenshot(page, 'users-filtered-page-2');

  // ---------------------------------------------------------- [4] карточка
  console.warn('\n[4] Карточка человека');
  // Именно так выглядит ссылка из письма о регистрации: прямой переход.
  await page.goto(`${ADMIN_URL}/users/${victim.id}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const cardText = await page.locator('body').innerText();
  expect(
    'Ссылка вида /admin/users/<id> открывает карточку',
    (await page.locator('[data-page="user-card"]').count()) === 1 &&
      cardText.includes(victim.displayName),
    victim.displayName,
  );
  expect(
    'В карточке собраны разделы, а не одна строка',
    ['status', 'identity', 'roles', 'capabilities', 'kyc', 'linked', 'history'].every(
      async (block) => (await page.locator(`[data-block="${block}"]`).count()) === 1,
    ),
    'состояние, данные, роли, полномочия, личность, связи, история',
  );
  const masked = await page.locator('[data-block="identity"]').innerText();
  expect('Контакт показан маской', /\*{3,}/.test(masked), 'маска на месте');
  await screenshot(page, 'user-card');

  // ---------------------------------------------- [5] раскрытие контактов
  console.warn('\n[5] Раскрытие контактов');
  await page.locator('[data-reveal-contacts]').click();
  await page.waitForTimeout(1500);
  const revealed = await page.locator('[data-block="identity"]').innerText();
  expect('Контакт раскрывается по кнопке', revealed.includes(victim.email), victim.email);
  const revealEvents = await sql(
    `SELECT count(*)::int AS n FROM audit.events
      WHERE verb = 'identity.user_contacts.revealed' AND subject_id = $1`,
    [victim.id],
  );
  expect('Раскрытие записано в журнал', revealEvents[0].n === 1, `записей: ${revealEvents[0].n}`);

  // ------------------------------------------------------------ [6] роль
  console.warn('\n[6] Роль выдаётся и снимается из карточки');
  await page.selectOption('[data-grant-role]', 'expert');
  await page.locator('[data-grant-confirm]').click();
  await page.waitForTimeout(2000);
  expect(
    'Роль выдана и видна в карточке',
    (await page.locator('[data-role-row="expert"]').count()) === 1,
    'эксперт',
  );
  await page.locator('[data-revoke-role="expert"]').click();
  await page.waitForTimeout(2000);
  expect(
    'Роль снята',
    (await page.locator('[data-role-row="expert"]').count()) === 0,
    'строки роли больше нет',
  );

  // ------------------------------------------------------- [7] блокировка
  console.warn('\n[7] Блокировка с причиной');
  await page.locator('[data-status-open]').click();
  await page.waitForTimeout(500);
  await page.fill('[data-status-reason-input]', 'Проход проверки: временная блокировка');
  await page.locator('[data-status-confirm]').click();
  await page.waitForTimeout(2500);
  const statusText = await page.locator('[data-user-status]').innerText();
  expect('Состояние сменилось на «заблокирован»', /заблокирован/i.test(statusText), statusText);
  const reasonText = await page.locator('[data-status-reason]').innerText();
  expect(
    'Причина и автор блокировки показаны',
    reasonText.includes('Проход проверки') && reasonText.includes('Ирина'),
    reasonText.slice(0, 90),
  );
  await screenshot(page, 'user-suspended');

  const [dbStatus] = await sql('SELECT status, status_reason FROM identity.users WHERE id = $1', [
    victim.id,
  ]);
  expect(
    'В базе то же самое, что на экране',
    dbStatus.status === 'suspended' && dbStatus.status_reason.includes('Проход проверки'),
    `${dbStatus.status}`,
  );

  await page.locator('[data-status-open]').click();
  await page.waitForTimeout(500);
  await page.fill('[data-status-reason-input]', 'Проход проверки завершён');
  await page.locator('[data-status-confirm]').click();
  await page.waitForTimeout(2500);
  expect(
    'Блокировка снимается тем же экраном',
    /активен/i.test(await page.locator('[data-user-status]').innerText()),
    'состояние вернулось',
  );

  // ---------------------------------------------------------- [8] имя
  console.warn('\n[8] Правка обычного поля');
  await page.locator('[data-edit-name]').click();
  await page.waitForTimeout(400);
  await page.fill('[data-name-input]', 'Проходной Переименованный');
  await page.getByRole('button', { name: /^Сохранить$/ }).click();
  await page.waitForTimeout(2000);
  expect(
    'Имя изменено и показано',
    (await page.locator('h1').innerText()).includes('Переименованный'),
    'заголовок карточки',
  );

  // ------------------------------------------------------- [9] тупиков нет
  console.warn('\n[9] Неизвестные адреса');
  await page.goto(`${ADMIN_URL}/users/00000000-0000-7000-8000-000000000000`, {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(1200);
  expect(
    'Несуществующий человек — понятное состояние, а не пустая карточка',
    (await page.locator('[data-user-missing]').count()) === 1,
    'сказано, что не найден',
  );

  await page.goto(`${ADMIN_URL}/unknown-section`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const notFound = await page.locator('[data-page="not-found"]').count();
  expect(
    'Неизвестный раздел не подменяется «Тарифами»',
    notFound === 1 && !page.url().includes('/plans'),
    page.url(),
  );
  await screenshot(page, 'not-found');

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
