#!/usr/bin/env node
/**
 * Защищённая отправка формы в браузере (блок 2, 2.2 и 2.6, первый пакет).
 *
 *   FIFTH_ENTRY=web node scripts/render-check-guarded-send.mjs
 *
 * Форма «Новый проект» кабинета основателя. Ответ сервера «теряется» ПОСЛЕ записи: Playwright
 * пропускает запрос к ядру и обрывает соединение до браузера. Проверяется:
 *   * неизвестный результат: ни успеха, ни ошибки, предупреждение и кнопка проверки;
 *   * поля заперты на отправленном, кнопки «Создать» нет — правка ввода не превращается во
 *     второй проект;
 *   * автоматическая проверка и проверка кнопкой идут с ТЕМ ЖЕ ключом;
 *   * после выяснения — один проект, кабинет открывает его.
 * Убирает за собой проект и ключи; учётка остаётся, как у остальных проб.
 */
/* global document */
import { chromium } from 'playwright';
import pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of existsSync(join(ROOT, '.env'))
  ? readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
  : []) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq > 0) process.env[trimmed.slice(0, eq).trim()] ??= trimmed.slice(eq + 1).trim();
}
const SITE = (process.env.FIFTH_SITE ?? 'http://127.0.0.1').replace(/\/$/, '');

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else failed += 1;
  console.warn(`  ${condition ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;
const title = `RK форма ${Date.now() % 1e9}`;

console.warn('\n=== ЗАЩИЩЁННАЯ ОТПРАВКА ФОРМЫ (2.6) ===\n');
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let userId = null;

try {
  await page.goto(`${SITE}/login/`);
  const email = `rk-form-${Date.now() % 1e9}@test.local`;
  const status = await page.evaluate(async (address) => {
    const r = await fetch('/v1/auth/register', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: address,
        password: `Pw-${crypto.randomUUID()}`,
        displayName: 'RK форма',
        role: 'founder',
        locale: 'ru-RU',
        consents: ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
          kind,
          version: 'v1',
          locale: 'ru-RU',
        })),
      }),
    });
    return r.status;
  }, email);
  check('участник заведён', status === 201, `HTTP ${status}`);

  // Ответ на создание проекта теряется ДВАЖДЫ (первая отправка и автоматическая проверка):
  // ядро запрос получает и записывает, браузер ответа не видит.
  const sent = [];
  let dropLeft = 2;
  await page.route('**/v1/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    sent.push({ key: route.request().headers()['idempotency-key'], status: response.status() });
    if (dropLeft > 0) {
      dropLeft -= 1;
      return route.abort('connectionreset');
    }
    return route.fulfill({ response });
  });

  await page.goto(`${SITE}/lab/`);
  await page
    .getByRole('button', { name: /Новый проект/ })
    .first()
    .click();
  await page.locator('#title').fill(title);
  await page.locator('#investmentAsk').fill('1000000');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();

  await page.locator('[data-guarded="unknown"]').waitFor({ timeout: 10_000 });
  // Дождаться автоматической проверки: она тоже теряется.
  await page.waitForFunction(() => document.querySelector('[data-guarded="unknown"]') !== null);
  await page.waitForTimeout(2500);
  check(
    'неизвестный результат показан предупреждением',
    (await page.locator('[data-guarded="unknown"]').count()) === 1,
  );
  check('ложного успеха нет: кабинет не перешёл к проекту', page.url().endsWith('/lab/'));
  check(
    'ошибки «не удалось» нет',
    (await page.locator('[role="alert"]').filter({ hasText: 'Сервис недоступен' }).count()) === 0,
  );
  check('поля заперты на отправленном', await page.locator('#title').isDisabled());
  check(
    'кнопки «Создать» нет — второй отправки не начать',
    (await page.getByRole('button', { name: 'Создать', exact: true }).count()) === 0,
  );
  check('на экране отправленное название', (await page.locator('#title').inputValue()) === title);
  check(
    'автоматическая проверка была и тоже потеряна',
    sent.length === 2,
    `запросов ${sent.length}`,
  );

  await page.locator('[data-guarded-check]').click();
  await page
    .waitForURL(/\/lab\/projects\//, { timeout: 15_000, waitUntil: 'commit' })
    .catch(async () => {
      const notice = await page
        .locator('[data-guarded]')
        .getAttribute('data-guarded')
        .catch(() => null);
      console.warn(
        `  (после проверки: запросов ${sent.length}, состояние ${notice}, адрес ${page.url()})`,
      );
    });
  check('проверка кнопкой выяснила результат: открыт проект', /\/lab\/projects\//.test(page.url()));
  check(
    'все попытки — с одним ключом',
    sent.length === 3 && new Set(sent.map((s) => s.key)).size === 1,
    `${sent.length} запросов, ключей ${new Set(sent.map((s) => s.key)).size}`,
  );
  const rows = await sql('SELECT id FROM lab.projects WHERE title = $1', [title]);
  check('проект один', rows.length === 1, `проектов ${rows.length}`);
  const [owner] = await sql('SELECT user_id FROM lab.founders_projects WHERE project_id = $1', [
    rows[0]?.id,
  ]);
  userId = owner?.user_id ?? null;
  check('исключений на странице нет', errors.length === 0, errors.join('; ').slice(0, 200));
} finally {
  const projects = await sql('SELECT id FROM lab.projects WHERE title = $1', [title]);
  for (const { id } of projects) {
    await sql('DELETE FROM lab.founders_projects WHERE project_id = $1', [id]);
    await sql('DELETE FROM lab.projects WHERE id = $1', [id]);
  }
  if (userId) await sql('DELETE FROM requests.idempotency_keys WHERE actor_id = $1', [userId]);
  await browser.close();
  await pool.end();
}

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exit(failed > 0 ? 1 : 0);
