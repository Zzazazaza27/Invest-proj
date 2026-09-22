#!/usr/bin/env node
/**
 * Рендер-проверка экрана «Пакеты раунда» в админке (этап 5.9.1).
 *
 * Что проверяется: раздел в меню; экран честно говорит, что продажи
 * выключены; услуга заводится нереализованной и не предлагается ни в состав
 * пакета, ни для докупки, пока не помечена; отметка «реализована» открывает
 * её для сетки; версия пакета публикуется с составом и диапазоном; изменение
 * цены даёт новую версию, а прежняя закрывается, а не переписывается;
 * пересечение диапазонов отклоняется с понятным сообщением; снятие с продажи
 * убирает версию из действующих.
 *
 * Покупок здесь нет: экран настраивает предложение, деньги не списываются.
 * Снимки — `out/render-admin-round-packages/`. Коды прогона несут суффикс, а
 * созданные версии закрываются в конце.
 *
 * Запуск: ADMIN_URL=http://127.0.0.1/admin/ node scripts/render-check-admin-round-packages.mjs
 */
import { chromium } from 'playwright';
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL as DEFAULT_CORE_URL, frontendUrl } from './lib/ports.mjs';
import { PROBE_ORIGIN } from './lib/probe-run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const ADMIN_URL = process.env.ADMIN_URL ?? frontendUrl('admin');
const CORE_URL = process.env.CORE_URL ?? DEFAULT_CORE_URL;
const OUT = join(ROOT, 'out', 'render-admin-round-packages');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

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
  const email = `rp-${tag}-${suffix}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const response = await fetch(`${CORE_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Unicorn-Origin': PROBE_ORIGIN },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      email,
      password,
      displayName: `Проверка ${tag}`,
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

const SERVICE = `rnd_${suffix}`;
const PACKAGE = `rndp_${suffix}`;
// Диапазон прогона берётся заведомо выше уже настроенных сеток, чтобы
// проверка не спорила с настройкой стенда.
const MIN_TARGET = '900000000';
const MAX_TARGET = '950000000';

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: ПАКЕТЫ РАУНДА (ЭТАП 5.9.1) ===\n');

// Предусловие: оборвавшийся прошлый прогон мог оставить действующую версию в
// том же диапазоне. Версии не удаляются (история цены — факт), закрываем.
await sql(
  `UPDATE billing.round_packages
      SET valid_to = GREATEST(now(), valid_from + interval '1 millisecond')
    WHERE code LIKE 'rndp\\_%' AND (valid_to IS NULL OR valid_to > now())`,
);

const admin = await register('admin');
await sql(`INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin')`, [admin.userId]);

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  // 400 сценарий вызывает намеренно (пересечение диапазонов), 401/403/404 —
  // обычный ответ до входа: это не поломка страницы.
  if (/\b(400|401|403|404) \(/.test(message.text())) return;
  consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));
// Основание запрашивается через window.prompt: в безголовом прогоне диалог
// надо принять, иначе действие молча отменяется.
page.on('dialog', (dialog) => void dialog.accept('проверка рендера'));

let shot = 0;
async function screenshot(name) {
  shot += 1;
  await page.screenshot({
    path: join(OUT, `${String(shot).padStart(2, '0')}-${name}.png`),
    fullPage: true,
  });
}

try {
  console.warn('[1] Вход и раздел в меню');
  await page.goto(ADMIN_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.fill('#email', admin.email);
  await page.fill('#password', admin.password);
  await page.getByRole('button', { name: /Войти/i }).click();
  await page.waitForSelector('text=Тарифы', { timeout: 15_000 });
  check(
    'раздел «Пакеты раунда» есть в меню',
    (await page.getByRole('link', { name: 'Пакеты раунда', exact: true }).count()) === 1,
  );
  await page.getByRole('link', { name: 'Пакеты раунда', exact: true }).click();
  await page.waitForSelector('[data-round-services]', { timeout: 20_000 });
  check(
    'экран говорит, что продажи выключены',
    (await page.locator('[data-sales-off]').innerText()).includes('Продажи выключены'),
  );
  check('сетка пакетов показана', (await page.locator('[data-round-packages]').count()) === 1);
  check(
    'докупка услуг показана',
    (await page.locator('[data-round-service-offers]').count()) === 1,
  );
  await screenshot('packages');

  console.warn('\n[2] Услуга заводится нереализованной');
  await page.fill('#round-service-code', SERVICE);
  await page.fill('#round-service-name', `Услуга прогона ${suffix}`);
  await page.getByRole('button', { name: 'Завести услугу' }).click();
  await page.waitForSelector(`[data-service-row="${SERVICE}"]`, { timeout: 15_000 });
  check(
    'новая услуга помечена как не реализованная',
    (await page
      .locator(`[data-service-row="${SERVICE}"]`)
      .getAttribute('data-service-implemented')) === 'false',
  );
  check(
    'нереализованная услуга не предлагается в состав пакета',
    (await page.locator(`#package-service-${SERVICE}`).count()) === 0,
  );
  check(
    'нереализованная услуга не предлагается для докупки',
    (await page
      .locator('#offer-service option', { hasText: `Услуга прогона ${suffix}` })
      .count()) === 0,
  );

  console.warn('\n[3] Отметка «реализована» открывает услугу для сетки');
  await page
    .locator(`[data-service-row="${SERVICE}"]`)
    .getByRole('button', { name: 'Отметить реализованной' })
    .click();
  await page.waitForSelector(`[data-service-row="${SERVICE}"][data-service-implemented="true"]`, {
    timeout: 15_000,
  });
  check(
    'реализованная услуга появилась в составе пакета',
    (await page.locator(`#package-service-${SERVICE}`).count()) === 1,
  );
  await screenshot('service-implemented');

  console.warn('\n[4] Публикация версии пакета');
  await page.fill('#package-code', PACKAGE);
  await page.fill('#package-name', `Пакет прогона ${suffix}`);
  await page.fill('#package-min', MIN_TARGET);
  await page.fill('#package-max', MAX_TARGET);
  await page.fill('#package-price', '15000');
  await page.fill('#package-reason', 'проверка рендера: первая версия');
  await page.check(`#package-service-${SERVICE}`);
  await page.getByRole('button', { name: 'Опубликовать версию' }).click();
  await page.waitForSelector(`[data-package-row="${PACKAGE}"]`, { timeout: 20_000 });
  check(
    'версия пакета действует',
    (await page.locator(`[data-package-row="${PACKAGE}"]`).getAttribute('data-package-active')) ===
      'true',
  );
  check(
    'состав версии виден в таблице',
    (await page.locator(`[data-package-row="${PACKAGE}"]`).innerText()).includes(
      `Услуга прогона ${suffix}`,
    ),
  );
  const [stored] = await sql(
    `SELECT price::text AS price, min_target::text AS min_target FROM billing.round_packages
      WHERE code = $1 AND valid_to IS NULL`,
    [PACKAGE],
  );
  check('цена записана копейками', stored?.price === '15000.00', `${stored?.price}`);
  check(
    'нижняя граница записана',
    stored?.min_target === `${MIN_TARGET}.00`,
    `${stored?.min_target}`,
  );
  await screenshot('package-published');

  console.warn('\n[5] Пересечение диапазонов отклоняется');
  await page.fill('#package-code', `${PACKAGE}x`);
  await page.fill('#package-name', `Пересечение ${suffix}`);
  await page.fill('#package-min', '920000000');
  await page.fill('#package-max', '960000000');
  await page.fill('#package-price', '19000');
  await page.fill('#package-reason', 'проверка рендера: пересечение диапазонов');
  await page.getByRole('button', { name: 'Опубликовать версию' }).click();
  await page.waitForSelector('.alert--error', { timeout: 15_000 });
  const overlapText = await page.locator('.alert--error').innerText();
  check(
    'пересечение названо в сообщении',
    overlapText.includes('пересекается'),
    overlapText.trim(),
  );
  check(
    'пересекающаяся версия не создана',
    (await sql(`SELECT 1 FROM billing.round_packages WHERE code = $1`, [`${PACKAGE}x`])).length ===
      0,
  );
  await screenshot('overlap-rejected');

  console.warn('\n[6] Изменение цены — новая версия, прежняя закрывается');
  await page.fill('#package-code', PACKAGE);
  await page.fill('#package-name', `Пакет прогона ${suffix}`);
  await page.fill('#package-min', MIN_TARGET);
  await page.fill('#package-max', MAX_TARGET);
  await page.fill('#package-price', '18000');
  await page.fill('#package-reason', 'проверка рендера: цена изменена новой версией');
  await page.check(`#package-service-${SERVICE}`);
  await page.getByRole('button', { name: 'Опубликовать версию' }).click();
  // Ждём именно ВТОРУЮ строку: первая всё ещё действует в момент отправки, и
  // ожидание «есть действующая версия» вернулось бы мгновенно.
  await page.waitForFunction(
    // eslint-disable-next-line no-undef
    (code) => document.querySelectorAll(`[data-package-row="${code}"]`).length === 2,
    PACKAGE,
    { timeout: 20_000 },
  );
  const versions = await sql(
    `SELECT version, price::text AS price, valid_to FROM billing.round_packages
      WHERE code = $1 ORDER BY version`,
    [PACKAGE],
  );
  check('версий стало две', versions.length === 2, `${versions.length}`);
  check(
    'цена первой версии не переписана',
    versions[0]?.price === '15000.00',
    `${versions[0]?.price}`,
  );
  check('первая версия закрыта', versions[0]?.valid_to !== null);
  check('вторая версия действует', versions[1]?.valid_to === null);
  check(
    'в таблице видны обе версии',
    (await page.locator(`[data-package-row="${PACKAGE}"]`).count()) === 2,
  );
  await screenshot('new-version');

  console.warn('\n[7] Снятие с продажи');
  await page
    .locator(`[data-package-row="${PACKAGE}"][data-package-active="true"]`)
    .getByRole('button', { name: 'Снять с продажи' })
    .click();
  await page.waitForFunction(
    /* eslint-disable no-undef */
    (code) =>
      document.querySelectorAll(`[data-package-row="${code}"][data-package-active="true"]`)
        .length === 0,
    /* eslint-enable no-undef */
    PACKAGE,
    { timeout: 20_000 },
  );
  check('действующих версий пакета не осталось', true);
  const [afterClose] = await sql(
    `SELECT count(*)::int AS live FROM billing.round_packages
      WHERE code = $1 AND (valid_to IS NULL OR valid_to > now())`,
    [PACKAGE],
  );
  check('в базе действующих версий нет', afterClose?.live === 0, `${afterClose?.live}`);
  await screenshot('closed');

  check('ошибок в консоли нет', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
  await pool.end();
}

console.warn(`\n  Снимки: ${OUT}`);
console.warn(`  Итог: ${passed} OK, ${failed} FAIL\n`);
process.exit(failed === 0 ? 0 : 1);
