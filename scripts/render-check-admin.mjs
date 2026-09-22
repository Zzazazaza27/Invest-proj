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
 * Требуется: core и админка подняты (порты — из .env).
 */
import { chromium } from 'playwright';
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL as DEFAULT_CORE_URL, frontendUrl } from './lib/ports.mjs';
import { PROBE_ORIGIN } from './lib/probe-run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const APP_URL = process.env.ADMIN_URL ?? frontendUrl('admin');
const CORE_URL = process.env.CORE_URL ?? DEFAULT_CORE_URL;

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
    headers: { 'Content-Type': 'application/json', 'X-Unicorn-Origin': PROBE_ORIGIN },
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
// Сезоны отложены (M088): пункты сезона показываются только при включённом
// `seasons.enabled`. Проверка идёт по фактическому положению флага — так она
// остаётся честной и до, и после его возврата.
const [seasonsFlag] = await sql(
  `SELECT enabled FROM audit.feature_flags WHERE key = 'seasons.enabled'`,
);
const seasonsOn = seasonsFlag?.enabled === true;
for (const label of [
  'Тарифы',
  'Подписки',
  'Комплаенс',
  'Уведомления',
  'Функции платформы',
  'Доступ',
]) {
  check(
    `раздел «${label}» присутствует`,
    (await page.getByText(label, { exact: true }).count()) > 0,
  );
}
for (const label of ['Сезон', 'Воронка сезона']) {
  const present = (await page.getByText(label, { exact: true }).count()) > 0;
  check(
    seasonsOn
      ? `раздел «${label}» присутствует при включённых сезонах`
      : `раздел «${label}» скрыт при отложенных сезонах`,
    present === seasonsOn,
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

console.warn('\n[3b] Воронка сезона и тексты уведомлений');
if (seasonsOn) {
  await page.getByRole('link', { name: 'Воронка сезона', exact: true }).click();
  await page.getByRole('heading', { name: 'Воронка сезона' }).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  const funnelText = await page.locator('main').innerText();
  check(
    'экран воронки открылся',
    funnelText.includes('Воронка сезона'),
    funnelText.replace(/\s+/g, ' ').slice(0, 110),
  );
  check(
    'состояние воронки объяснено словами: либо этапы, либо отсутствие сезона',
    funnelText.includes('Буткемп') || funnelText.includes('Активного сезона нет'),
  );
} else {
  // Экран воронки жив и открывается по прямому адресу — сезоны отключены, а не
  // удалены; из меню он убран, поэтому и кликать по нему здесь нечего.
  console.warn('  ·     сезоны отложены: экран воронки из меню убран, проверка пропущена');
}

// Ссылка в боковом меню, а не любой текст «Уведомления» на странице: клик по
// произвольному совпадению никуда не ведёт, а проверка потом читает прежний
// экран и краснеет по своей же вине.
await page.getByRole('link', { name: 'Уведомления', exact: true }).click();
await page.getByRole('heading', { name: 'Тексты уведомлений' }).waitFor({ timeout: 15_000 });
// Ждём КОНЦА загрузки, а не появления заголовка: заголовок отрисован сразу, и
// проверка списка на этом месте измеряла бы скорость машины.
await page
  .locator('table')
  .first()
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
const templatesText = await page.locator('main').innerText();
check(
  'список шаблонов загружен, а не пуст молча',
  templatesText.includes('season.stage.advanced') || templatesText.includes('Шаблонов нет'),
  templatesText.replace(/\s+/g, ' ').slice(0, 110),
);
check(
  'запрет персональных данных объявлен на экране',
  templatesText.includes('Имена, телефоны и реквизиты запрещены'),
);

console.warn('\n[4] Клиенты Integration API');
// Раздел переехал с экрана «Доступ» в «Интеграции», на вкладку: всё внешнее
// собрано в одном месте. Проверка, искавшая его на прежнем экране, краснела не
// по делу.
await page.getByRole('link', { name: 'Интеграции', exact: true }).click();
await page.getByRole('tab', { name: 'Клиенты Integration API' }).click();
await page.waitForSelector('#sa-name', { timeout: 15_000 });
check(
  'раздел клиентов отрисован',
  (await page.getByRole('heading', { name: 'Клиенты Integration API' }).count()) === 1,
);

// Создание клиента из админки появилось в Ф55: до него список и ротация были, а
// завести ПЕРВОГО клиента можно было только через служебную консоль.
const saSuffix = `${Date.now() % 1e8}`;
await page.fill('#sa-name', `Прогон ${saSuffix}`);
await page.fill('#sa-client-id', `probe-${saSuffix}`);
await page.fill('#sa-scopes', 'graduates:read');
// Отпечаток сертификата — 64 hex-символа. Неверный обязан отвергаться сервером,
// а не «подставляться как есть»: без mTLS клиент к Integration API не допускается.
await page.fill('#sa-fingerprint', 'zz');
await page.getByRole('button', { name: 'Создать клиента' }).click();
await page.waitForTimeout(1500);
check(
  'неверный отпечаток сертификата отвергнут',
  (await page.getByText('Секрет клиента').count()) === 0,
);
// Этот отказ 400 вызван прогоном НАМЕРЕННО, и он не должен краснить проверку
// «ошибок в консоли нет». Вычищается РОВНО ОДНА ожидаемая запись, а не все 400
// подряд: иначе прогон перестал бы замечать чужие отказы того же кода.
const deliberate = consoleErrors.findIndex((message) => message.includes('400'));
if (deliberate >= 0) consoleErrors.splice(deliberate, 1);

await page.fill('#sa-fingerprint', 'a'.repeat(64));
await page.getByRole('button', { name: 'Создать клиента' }).click();
await page.waitForTimeout(2000);
check('клиент создан из админки', (await page.getByText('Секрет клиента').count()) > 0);
check(
  'сказано, что секрет больше не покажут',
  (await page.getByText('Повторно он не отображается').count()) > 0,
);
check('новый клиент появился в списке', (await page.getByText(`probe-${saSuffix}`).count()) > 0);

await page.getByRole('button', { name: 'Приостановить' }).last().click();
await page.waitForTimeout(1500);
// Приостановка — не удаление: клиент остаётся в списке, меняется состояние.
check(
  'приостановленный клиент остаётся в списке',
  (await page.getByText(`probe-${saSuffix}`).count()) > 0,
);
check(
  'состояние клиента изменилось на приостановленное',
  (await page.getByRole('button', { name: 'Возобновить' }).count()) > 0,
);

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
