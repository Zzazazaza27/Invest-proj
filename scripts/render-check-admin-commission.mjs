#!/usr/bin/env node
/**
 * Рендер-проверка экрана «Комиссии» в админке (этап 5.9.3).
 *
 * Что проверяется: раздел в меню; версии условий показаны с общей ставкой и
 * долями; несходящиеся доли названы ДО отправки, а не ошибкой после неё;
 * публикация даёт новую версию и закрывает прежнюю; зачёт услуг объявлен
 * выключенным, и включить его нельзя.
 *
 * Деньги не двигаются: начисления создаёт только команда подтверждения
 * транша. Условия прогона идут отдельным кодом и закрываются в конце.
 * Снимки — `out/render-admin-commission/`.
 *
 * Запуск: ADMIN_URL=http://127.0.0.1/admin/ node scripts/render-check-admin-commission.mjs
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
const OUT = join(ROOT, 'out', 'render-admin-commission');
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

const suffix = `${Date.now() % 1e9}`;
const CODE = `rnd_fee_${suffix}`;
const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

async function register(tag) {
  const email = `rfee-${tag}-${suffix}@test.local`;
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
  const index = createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
  const [row] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [index]);
  return { email, password, userId: row.id };
}

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: КОМИССИИ (ЭТАП 5.9.3) ===\n');

const admin = await register('admin');
await sql(`INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin')`, [admin.userId]);

const browser = await chromium.launch();
const page = await (
  await browser.newContext({ viewport: { width: 1280, height: 1000 } })
).newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  if (/\b(400|401|403|404) \(/.test(message.text())) return;
  consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

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
    'раздел «Комиссии» есть в меню',
    (await page.getByRole('link', { name: 'Комиссии', exact: true }).count()) === 1,
  );
  await page.getByRole('link', { name: 'Комиссии', exact: true }).click();
  await page.waitForSelector('[data-fee-terms]', { timeout: 20_000 });

  const terms = await page.locator('[data-fee-terms]').innerText();
  check('действующие условия показаны с общей ставкой', terms.includes('Общая ставка'), '');
  check('доли названы процентными пунктами, а не процентами от базы', terms.includes('п. п.'), '');
  check(
    'зачёт объявлен выключенным с причиной',
    (await page.locator('[data-offsets-off]').innerText()).includes(
      'правило расчёта не утверждено',
    ),
  );
  await screenshot('commission');

  console.warn('\n[2] Несходящиеся доли названы до отправки');
  await page.fill('#fee-code', CODE);
  await page.fill('#fee-total', '15');
  await page.fill('#fee-investor', '10');
  await page.fill('#fee-issuer', '4');
  await page.fill('#fee-reason', 'рендер-проверка: доли не сходятся');
  await page.waitForSelector('[data-terms-mismatch]', { timeout: 10_000 });
  check(
    'расхождение названо числом',
    (await page.locator('[data-terms-mismatch]').innerText()).includes('14.00'),
    (await page.locator('[data-terms-mismatch]').innerText()).slice(0, 80),
  );
  check(
    'кнопка публикации недоступна при расхождении',
    await page.getByRole('button', { name: 'Опубликовать версию' }).isDisabled(),
  );
  await screenshot('mismatch');

  console.warn('\n[3] Публикация версии и её закрытие следующей');
  await page.fill('#fee-issuer', '5');
  await page.fill('#fee-reason', 'рендер-проверка: первая версия условий');
  check(
    'при сходящихся долях предупреждения нет',
    (await page.locator('[data-terms-mismatch]').count()) === 0,
  );
  await page.getByRole('button', { name: 'Опубликовать версию' }).click();
  await page.waitForSelector(`[data-terms-row="${CODE}"]`, { timeout: 20_000 });
  check(
    'версия действует',
    (await page.locator(`[data-terms-row="${CODE}"]`).getAttribute('data-terms-active')) === 'true',
  );

  await page.fill('#fee-total', '12');
  await page.fill('#fee-investor', '8');
  await page.fill('#fee-issuer', '4');
  await page.fill('#fee-reason', 'рендер-проверка: ставка снижена новой версией');
  await page.getByRole('button', { name: 'Опубликовать версию' }).click();
  await page.waitForFunction(
    /* eslint-disable no-undef */
    (code) => document.querySelectorAll(`[data-terms-row="${code}"]`).length === 2,
    /* eslint-enable no-undef */
    CODE,
    { timeout: 20_000 },
  );
  const versions = await sql(
    `SELECT version, total_pct::text AS total, valid_to FROM billing.fee_schedules
      WHERE code = $1 ORDER BY version`,
    [CODE],
  );
  check('версий стало две', versions.length === 2, `${versions.length}`);
  check('ставка первой версии не переписана', versions[0]?.total === '15.00', versions[0]?.total);
  check('первая версия закрыта', versions[0]?.valid_to !== null);
  check('вторая версия действует', versions[1]?.valid_to === null);
  await screenshot('published');

  console.warn('\n[4] Зачёт услуг включить нельзя');
  await page.fill('#offset-reason', 'рендер-проверка: новая версия правила зачёта');
  await page.getByRole('button', { name: 'Активировать выключенной' }).click();
  await page.waitForSelector('.alert--ok', { timeout: 20_000 });
  const [rule] = await sql(`SELECT is_enabled FROM billing.fee_offset_rules WHERE is_active`);
  check('активная версия правила по-прежнему выключена', rule?.is_enabled === false);
  const [{ on }] = await sql(`SELECT billing.fee_offsets_enabled() AS on`);
  check('зачёт в базе выключен', on === false, `${on}`);
  await screenshot('offsets');

  check('ошибок в консоли нет', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  // Условия прогона закрываются: сетка сделок остаётся такой, какой была.
  await sql(
    `UPDATE billing.fee_schedules
        SET valid_to = GREATEST(now(), valid_from + interval '1 millisecond')
      WHERE code = $1 AND (valid_to IS NULL OR valid_to > now())`,
    [CODE],
  );
  await browser.close();
  await pool.end();
}

console.warn(`\n  Снимки: ${OUT}`);
console.warn(`  Итог: ${passed} OK, ${failed} FAIL\n`);
process.exit(failed === 0 ? 0 : 1);
