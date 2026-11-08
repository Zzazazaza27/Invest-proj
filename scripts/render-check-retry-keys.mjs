#!/usr/bin/env node
/**
 * Клиентское удержание ключа повтора (блок 2, 2.6; пакет 7, замечания Тэнка к 094c8ad).
 *
 *   FIFTH_ENTRY=web node scripts/render-check-retry-keys.mjs
 *
 *   1. Медиа: подтверждение выполнено, ответ потерян → «Проверить загрузку» → тот же
 *      uploadId и ключ, без второго билета, обработки и события.
 *   2. Ротация секрета: ответ потерян → повтор получил «выполняется» → повтор получил
 *      временный отказ → успешный повтор; во всех запросах один ключ, одна ротация.
 *   3. Создание сервисного аккаунта: то же — один ключ, один аккаунт.
 */
/* global document */
import { chromium } from 'playwright';
import pg from 'pg';
import sharp from 'sharp';
import { createHmac } from 'node:crypto';
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
const stamp = Date.now() % 1e9;
const blindIndex = (email) =>
  createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();

const browser = await chromium.launch();
const pageErrors = [];
async function session(label, admin = false) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const email = `rk-keys-${label}-${stamp}@test.local`;
  const password = `Pw-${stamp}-${Math.random().toString(36).slice(2)}`;
  await page.goto(`${SITE}/login/`);
  await page.evaluate(
    async ([address, secret]) => {
      await fetch('/v1/auth/register', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: address,
          password: secret,
          displayName: 'RK keys',
          role: 'founder',
          locale: 'ru-RU',
          consents: ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
            kind,
            version: 'v1',
            locale: 'ru-RU',
          })),
        }),
      });
    },
    [email, password],
  );
  const [u] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [blindIndex(email)]);
  if (admin) {
    await sql(
      "INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING",
      [u.id],
    );
    await context.clearCookies();
    await page.goto(`${SITE}/login/`);
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await page.waitForTimeout(1500);
  }
  return { context, page, userId: u.id };
}
const csrf = (page) =>
  page.evaluate(() => /(?:^|;\s*)ul_csrf=([^;]+)/.exec(document.cookie)?.[1] ?? '');

console.warn('\n=== УДЕРЖАНИЕ КЛЮЧА ПОВТОРА В КЛИЕНТЕ (2.6) ===\n');
const cleanup = { project: null, accounts: [], admin: null };
try {
  console.warn('[1] Медиа: потерянный ответ подтверждения');
  const f = await session('f');
  const token = await csrf(f.page);
  cleanup.project = await f.page.evaluate(async (c) => {
    const tax = await (await fetch('/v1/taxonomy')).json();
    const r = await fetch('/v1/projects', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': c },
      body: JSON.stringify({
        title: 'RK keys',
        stage: 'mvp',
        taxonomyId: (tax.items ?? tax)[0].id,
        investmentAsk: '1000000.00',
        askCurrency: 'RUB',
      }),
    });
    return (await r.json()).id;
  }, token);
  const tickets = [];
  const finals = [];
  let dropNext = true;
  await f.page.route('**/v1/projects/*/media/upload', async (route) => {
    tickets.push(route.request().method());
    return route.continue();
  });
  await f.page.route('**/v1/projects/*/media/logo/finalize', async (route) => {
    finals.push({
      key: route.request().headers()['idempotency-key'],
      body: JSON.parse(route.request().postData() ?? '{}'),
    });
    if (dropNext) {
      dropNext = false;
      await route.fetch(); // сервер выполнил подтверждение
      return route.abort('connectionreset'); // ответ потерян
    }
    return route.continue();
  });
  await f.page.goto(`${SITE}/lab/projects/${cleanup.project}`);
  const png = await sharp({
    create: { width: 300, height: 300, channels: 3, background: { r: 20, g: 80, b: 150 } },
  })
    .png()
    .toBuffer();
  await f.page
    .locator('[data-media-input="logo"]')
    .setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png });
  await f.page.locator('[data-media-upload="logo"]').click();
  await f.page.waitForSelector('[data-media-check="logo"]', { timeout: 20_000 });
  check(
    'потерянный ответ — неизвестный исход и «Проверить загрузку»',
    (await f.page.locator('[data-media-notice="error"]').innerText()).includes('неизвестен'),
  );
  await f.page.locator('[data-media-check="logo"]').click();
  await f.page.waitForSelector('[data-media-notice="ok"]', { timeout: 20_000 });
  check(
    'проверка — тот же uploadId и ключ',
    finals.length === 2 &&
      finals[0].body.uploadId === finals[1].body.uploadId &&
      finals[0].key === finals[1].key &&
      Boolean(finals[0].key),
    JSON.stringify(finals.map((x) => [x.key, x.body.uploadId])),
  );
  check('второго билета нет', tickets.length === 1, `билетов ${tickets.length}`);
  const [ev] = await sql(
    `SELECT count(*)::int AS n FROM audit.events WHERE verb = 'lab.project_media.set' AND subject_id = $1`,
    [cleanup.project],
  );
  check('одна обработка и одно событие', ev.n === 1, `событий ${ev.n}`);
  check(
    'кнопка проверки снята после подтверждения',
    (await f.page.locator('[data-media-check="logo"]').count()) === 0,
  );

  console.warn('[2] Ротация: потерянный ответ → «выполняется» → временный отказ → успех');
  const a = await session('a', true);
  cleanup.admin = a.userId;
  const acc = await a.page.evaluate(
    async ([c, s]) => {
      const r = await fetch('/v1/admin/service-accounts', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': c },
        body: JSON.stringify({
          name: 'RK keys',
          clientId: `rk-keys-${s}`,
          scopes: ['webhooks:manage'],
          mtlsCertFingerprint: 'cd'.repeat(32),
        }),
      });
      return (await r.json()).id;
    },
    [await csrf(a.page), stamp],
  );
  cleanup.accounts.push(acc);
  const [e0] = await sql(`SELECT token_epoch FROM integration.service_accounts WHERE id = $1`, [
    acc,
  ]);
  const rotKeys = [];
  let rotStep = 0;
  const problem = (status, code) => ({
    status,
    contentType: 'application/problem+json',
    body: JSON.stringify({
      type: `https://5espace.com/problems/${code}`,
      title: 'x',
      status,
      code,
    }),
  });
  await a.page.route(`**/v1/admin/service-accounts/${acc}/rotation`, async (route) => {
    rotKeys.push(route.request().headers()['idempotency-key']);
    rotStep += 1;
    if (rotStep === 1) {
      await route.fetch();
      return route.abort('connectionreset');
    }
    if (rotStep === 2) return route.fulfill(problem(409, 'operation_in_progress'));
    if (rotStep === 3) return route.fulfill(problem(503, 'dependency_unavailable'));
    return route.continue();
  });
  await a.page.goto(`${SITE}/admin/integrations`);
  const rotate = async () => {
    const retry = a.page.getByRole('button', { name: /Повторить/ });
    if (await retry.count()) await retry.first().click();
    await a.page.getByText(`rk-keys-${stamp}`).first().waitFor({ timeout: 15_000 });
    const row = a.page.locator('*', { hasText: `rk-keys-${stamp}` }).last();
    await a.page.getByRole('button', { name: 'Ротировать секрет' }).first().click();
    await a.page.waitForTimeout(1500);
    return row;
  };
  for (let i = 0; i < 4; i += 1) await rotate();
  const [e1] = await sql(`SELECT token_epoch FROM integration.service_accounts WHERE id = $1`, [
    acc,
  ]);
  check(
    'во всех запросах ротации один ключ',
    rotKeys.length === 4 && new Set(rotKeys).size === 1 && Boolean(rotKeys[0]),
    JSON.stringify(rotKeys),
  );
  check(
    'одна ротация',
    Number(e1.token_epoch) === Number(e0.token_epoch) + 1,
    `${e0.token_epoch}→${e1.token_epoch}`,
  );
  const [r1] = await sql(
    `SELECT count(*)::int AS n FROM audit.outbox_events WHERE event_type = 'integration.service_account.rotated' AND aggregate_id = $1`,
    [acc],
  );
  check('одно событие ротации', r1.n === 1, `событий ${r1.n}`);

  console.warn('[3] Создание: потерянный ответ → «выполняется» → временный отказ → успех');
  const createKeys = [];
  let createStep = 0;
  await a.page.route('**/v1/admin/service-accounts', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    createKeys.push(route.request().headers()['idempotency-key']);
    createStep += 1;
    if (createStep === 1) {
      await route.fetch();
      return route.abort('connectionreset');
    }
    if (createStep === 2) return route.fulfill(problem(409, 'operation_in_progress'));
    if (createStep === 3) return route.fulfill(problem(503, 'dependency_unavailable'));
    return route.continue();
  });
  const clientId = `rk-keys-c-${stamp}`;
  for (let i = 0; i < 4; i += 1) {
    const retry = a.page.getByRole('button', { name: /Повторить/ });
    if (await retry.count()) await retry.first().click();
    await a.page.locator('#sa-name').fill('RK create');
    await a.page.locator('#sa-client-id').fill(clientId);
    await a.page.locator('#sa-scopes').fill('webhooks:manage');
    await a.page.locator('#sa-fingerprint').fill('ef'.repeat(32));
    await a.page.getByRole('button', { name: 'Создать клиента' }).click();
    await a.page.waitForTimeout(1500);
  }
  const made = await sql(`SELECT id FROM integration.service_accounts WHERE client_id = $1`, [
    clientId,
  ]);
  cleanup.accounts.push(...made.map((r) => r.id));
  check(
    'во всех запросах создания один ключ',
    createKeys.length === 4 && new Set(createKeys).size === 1 && Boolean(createKeys[0]),
    JSON.stringify(createKeys),
  );
  check('один аккаунт', made.length === 1, `аккаунтов ${made.length}`);
  check(
    'повтор после потерянного ответа — «секрет уже выдан»',
    (
      await a.page
        .locator('[data-secret-note]')
        .innerText()
        .catch(() => '')
    ).includes('уже выполнена'),
  );
  check('ошибок страницы нет', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200));
} finally {
  for (const id of cleanup.accounts.filter(Boolean)) {
    await sql('DELETE FROM integration.service_accounts WHERE id = $1', [id]).catch(
      () => undefined,
    );
  }
  if (cleanup.project) {
    await sql('DELETE FROM lab.project_media WHERE project_id = $1', [cleanup.project]).catch(
      () => undefined,
    );
    await sql('DELETE FROM lab.founders_projects WHERE project_id = $1', [cleanup.project]).catch(
      () => undefined,
    );
    await sql('DELETE FROM lab.projects WHERE id = $1', [cleanup.project]).catch(() => undefined);
  }
  if (cleanup.admin)
    await sql(`DELETE FROM identity.user_roles WHERE user_id = $1 AND role = 'admin'`, [
      cleanup.admin,
    ]).catch(() => undefined);
  await browser.close();
  await pool.end();
}
console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exit(failed > 0 ? 1 : 0);
