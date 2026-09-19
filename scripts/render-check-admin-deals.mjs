#!/usr/bin/env node
/**
 * Рендер-проверка экрана «Сделки» в админке (M097).
 *
 * Что проверяется: раздел в меню; сделка открывается и показывает транши,
 * возвраты и начисления; «Зафиксировать возврат» записывает событие и
 * пересчитывает возвращённую сумму; ошибочная запись аннулируется с
 * основанием и перестаёт считаться; уменьшение начисления и возврат
 * уплаченного — разные записи; каталог полномочий виден с видами действий.
 *
 * Деньги не двигаются: экран пишет факты, а не платит. Снимки —
 * `out/render-admin-deals/`.
 *
 * Запуск: ADMIN_URL=http://127.0.0.1/admin/ node scripts/render-check-admin-deals.mjs
 */
import { chromium } from 'playwright';
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL as DEFAULT_CORE_URL, frontendUrl } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const ADMIN_URL = process.env.ADMIN_URL ?? frontendUrl('admin');
const CORE_URL = process.env.CORE_URL ?? DEFAULT_CORE_URL;
const OUT = join(ROOT, 'out', 'render-admin-deals');
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
const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

async function register(tag) {
  const email = `rdeal-${tag}-${suffix}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const response = await fetch(`${CORE_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

/** Сделка с подтверждённым траншем: обстановка строится в БД. */
async function makeDeal(founderId, investorId, reviewerId, amount) {
  const projectId = randomUUID();
  await sql(
    `INSERT INTO lab.projects (id, title, stage, investment_ask, status)
     VALUES ($1, $2, 'mvp', $3, 'draft')`,
    [projectId, `Сделка прогона ${suffix}`, amount],
  );
  await sql(
    `INSERT INTO lab.founders_projects (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [projectId, founderId],
  );
  const entityId = randomUUID();
  const inn = `77${String(Date.now()).slice(-8)}`;
  await sql(
    `INSERT INTO kyc.business_entities
       (id, legal_name, inn_ciphertext, entity_wrapped_dek, inn_hmac, jurisdiction,
        registry_status, owner_user_id)
     VALUES ($1, $2, $3, '\\x00'::bytea, digest($4, 'sha256'), 'RU', 'active', $5)`,
    [entityId, `ООО Прогон ${suffix}`, Buffer.from(inn), inn, founderId],
  );
  await sql(
    `INSERT INTO kyc.entity_members (entity_id, user_id, member_role, verified_at)
     VALUES ($1, $2, 'signatory', now())`,
    [entityId, founderId],
  );
  await sql(
    `INSERT INTO kyc.kyb_verifications (id, entity_id, kind, status, reviewed_by, decided_at)
     VALUES (public.uuid_generate_v7(), $1, 'registry_check', 'approved', $2, now())`,
    [entityId, reviewerId],
  );
  await sql(
    `INSERT INTO kyc.kyc_verifications
       (id, user_id, kind, status, risk_level, sanctions_status, reviewed_by, decided_at)
     VALUES (public.uuid_generate_v7(), $1, 'identity', 'approved', 'low', 'clear', $2, now())`,
    [investorId, reviewerId],
  );

  const offerId = randomUUID();
  await sql(
    `INSERT INTO investments.investment_offers
       (id, project_id, issuer_entity_id, instrument_type, rules_version, target_amount,
        min_investment, terms_jsonb, document_s3_key, document_sha256, document_wrapped_dek,
        status, opens_at, created_by)
     VALUES ($1, $2, $3, 'loan', 'platform_rules_v1', $4, 1000, '{}'::jsonb,
             'offers/doc.pdf', digest('doc','sha256'), '\\x00'::bytea,
             'published', now() - interval '1 day', $5)`,
    [offerId, projectId, entityId, amount * 5, founderId],
  );
  const [{ id: feeId }] = await sql(
    `SELECT id FROM billing.fee_schedules
      WHERE code = 'operator_success_fee' AND valid_to IS NULL ORDER BY version DESC LIMIT 1`,
  );
  const agreementId = randomUUID();
  await sql(
    `INSERT INTO investments.investment_agreements
       (id, offer_id, investor_id, contract_amount, fee_schedule_id, document_s3_key,
        document_sha256, document_wrapped_dek, idempotency_key, status,
        investor_signed_at, issuer_signed_at)
     VALUES ($1, $2, $3, $4, $5, 'agreements/doc.pdf', digest('a','sha256'), '\\x00'::bytea,
             $6, 'signed', now(), now())`,
    [agreementId, offerId, investorId, amount, feeId, `idem-${agreementId}`],
  );
  await sql(
    `SELECT tranche_id FROM billing.confirm_tranche($1, $2, $3, now(),
             digest('stmt','sha256'), NULL, 'render')`,
    [agreementId, `bank-${agreementId}`, amount],
  );
  return { projectId, agreementId };
}

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: СДЕЛКИ И РУЧНЫЕ ЗАПИСИ (M097) ===\n');

const admin = await register('admin');
await sql(`INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin')`, [admin.userId]);
const founder = await register('f');
const investor = await register('i');
const deal = await makeDeal(founder.userId, investor.userId, admin.userId, 1_000_000);

const browser = await chromium.launch();
const page = await (
  await browser.newContext({ viewport: { width: 1280, height: 1100 } })
).newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  if (/\b(400|401|403|404) \(/.test(message.text())) return;
  consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));
// Аннулирование спрашивает основание через window.prompt.
page.on('dialog', (dialog) => void dialog.accept('рендер-проверка: запись ошибочна'));

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
    'раздел «Сделки» есть в меню',
    (await page.getByRole('link', { name: 'Сделки', exact: true }).count()) === 1,
  );
  await page.getByRole('link', { name: 'Сделки', exact: true }).click();
  await page.waitForSelector(`[data-deal-row="${deal.agreementId}"]`, { timeout: 20_000 });
  await page.locator(`[data-deal-row="${deal.agreementId}"]`).getByRole('button').click();
  await page.waitForSelector('[data-tranches]', { timeout: 20_000 });
  check('транши сделки показаны', (await page.locator('[data-tranche-row]').count()) >= 1);
  check('начисление по сделке показано', (await page.locator('[data-accrual-row]').count()) === 1);
  check(
    'каталог полномочий виден с видами действий',
    (await page.locator('[data-capabilities]').innerText()).includes('денежная корректировка'),
  );
  await screenshot('deal');

  console.warn('\n[2] Фиксация возврата');
  await page.selectOption('#return-tranche', { index: 1 });
  await page.fill('#return-amount', '250000');
  await page.fill('#return-date', '2026-09-19');
  await page.fill('#return-reason', 'рендер-проверка: частичный возврат по соглашению');
  await page.getByRole('button', { name: 'Зафиксировать возврат' }).click();
  await page.waitForSelector('[data-return-row]', { timeout: 20_000 });
  check(
    'возвращённая сумма пересчитана',
    (await page
      .locator('[data-tranche-row] td[data-returned]')
      .first()
      .getAttribute('data-returned')) === '250000.00',
    (await page.locator('[data-tranche-row] td[data-returned]').first().innerText()).trim(),
  );
  const [stored] = await sql(
    `SELECT r.amount::text AS amount, r.reason
       FROM investments.tranche_returns r
       JOIN investments.investment_tranches t ON t.id = r.tranche_id
      WHERE t.agreement_id = $1`,
    [deal.agreementId],
  );
  check('запись сохранена с основанием', stored?.amount === '250000.00' && Boolean(stored?.reason));
  await screenshot('return-recorded');

  console.warn('\n[3] Аннулирование ошибочной записи');
  await page.getByRole('button', { name: 'Аннулировать' }).first().click();
  await page.waitForFunction(
    /* eslint-disable no-undef */
    () =>
      document
        .querySelector('[data-tranche-row] td[data-returned]')
        ?.getAttribute('data-returned') === '0.00',
    /* eslint-enable no-undef */
    undefined,
    { timeout: 20_000 },
  );
  check('после аннулирования сумма не считается возвращённой', true);
  check(
    'история аннулированной записи осталась',
    (await page.locator('[data-return-row]').count()) === 1,
  );
  await screenshot('return-cancelled');

  console.warn('\n[4] Корректировка вознаграждения');
  await page.selectOption('#adjust-accrual', { index: 1 });
  await page.selectOption('#adjust-kind', 'accrual_reduction');
  await page.selectOption('#adjust-party', 'investor');
  await page.fill('#adjust-amount', '20000');
  await page.fill('#adjust-reason', 'рендер-проверка: доля инвестора уменьшена по договорённости');
  await page.getByRole('button', { name: 'Зафиксировать корректировку' }).click();
  await page.waitForSelector('[data-adjustment-row]', { timeout: 20_000 });
  const adjustmentText = await page.locator('[data-adjustment-row]').first().innerText();
  check(
    'уменьшение начисления названо своим именем',
    adjustmentText.includes('уменьшение начисления'),
    adjustmentText,
  );
  const [adjustment] = await sql(
    `SELECT j.kind FROM billing.commission_adjustments j
       JOIN billing.commission_accruals a ON a.id = j.accrual_id
      WHERE a.agreement_id = $1`,
    [deal.agreementId],
  );
  check('в базе это уменьшение, а не возврат денег', adjustment?.kind === 'accrual_reduction');
  await screenshot('adjustment');

  check('ошибок в консоли нет', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
  await pool.end();
}

console.warn(`\n  Снимки: ${OUT}`);
console.warn(`  Итог: ${passed} OK, ${failed} FAIL\n`);
process.exit(failed === 0 ? 0 : 1);
