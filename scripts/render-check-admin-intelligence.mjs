#!/usr/bin/env node
/**
 * Рендер-проверка: Market Intelligence (M137) — /admin/intelligence.
 *
 * Проходит ТЗ §16 руками: раздел в меню, ручное добавление, таблица, поиск и
 * фильтры, карточка и правка, второй источник, предупреждение о дубле,
 * «Импорт URL» (в том числе отказ загружать адрес внутренней сети).
 *
 * Записи прогона удаляются в `finally` по префиксу имени: раздел — класс
 * `content`, лишнего в нём оставаться не должно.
 *
 * INTEL_LIVE_IMPORT=1 — дополнительно нажать «Импорт get-investor.ru». Шаг
 * ходит в интернет, поэтому по умолчанию выключен; импортированные записи —
 * настоящие данные и НЕ удаляются.
 *
 * Запуск: UNICORN_ENTRY=web node scripts/render-check-admin-intelligence.mjs
 */
import { chromium } from 'playwright';
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL as DEFAULT_CORE_URL, frontendUrl } from './lib/ports.mjs';
import { startProbeRun } from './lib/probe-run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

/*
 * Запуск открывается до первой регистрации: он даёт право назвать
 * заведённых людей следом прогона и записывает их за собой. Без него
 * сервер пометку не назначит — разрешённое значение заголовка не
 * полномочие.
 */
const run = await startProbeRun('RND-ADMIN-INTELLIGENCE');

const ADMIN_URL = process.env.ADMIN_URL ?? frontendUrl('admin');
const CORE_URL = process.env.CORE_URL ?? DEFAULT_CORE_URL;
const OUT = join(ROOT, 'out', 'render-admin-intelligence');
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
  const email = `mi-${tag}-${suffix}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const response = await fetch(`${CORE_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...run.headers() },
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

const MARK = `Проверка MI ${suffix}`;
// Свои домены прогона: источники заводятся по домену, и чужой example.com
// уборка не тронет.
const HOST_A = `mi${suffix}.example.com`;
const HOST_B = `mi${suffix}.example.org`;
const BASE = ADMIN_URL.replace(/\/$/, '');

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: MARKET INTELLIGENCE (M137) ===\n');
const admin = await register('admin');
await sql(`INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin')`, [admin.userId]);

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  if (/\b(401|403|404) \(/.test(message.text())) return;
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

async function addEntity({ type, name, org, source }) {
  await page.click('[data-intel-add]');
  const form = page.locator('[data-intel-form]');
  await form.locator('select').first().selectOption(type);
  await form.locator('input[name="name"]').fill(name);
  await form.locator('input[name="organizationName"]').fill(org);
  await form.locator('input[name="sourceUrl"]').fill(source);
  await form.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.waitForSelector('[data-page="intelligence-card"] h1', { timeout: 15_000 });
}

try {
  console.warn('[1] Вход и раздел в меню');
  await page.goto(ADMIN_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.fill('#email', admin.email);
  await page.fill('#password', admin.password);
  await page.getByRole('button', { name: /Войти/i }).click();
  await page.waitForSelector('text=Тарифы', { timeout: 15_000 });
  const menu = page.getByRole('link', { name: 'Market Intelligence', exact: true });
  check('раздел есть в меню', (await menu.count()) === 1);
  await menu.click();
  await page.waitForSelector('[data-page="intelligence"]', { timeout: 15_000 });
  check(
    'адрес раздела — …/admin/intelligence',
    new URL(page.url()).pathname.endsWith('/admin/intelligence'),
    new URL(page.url()).pathname,
  );

  console.warn('[2] Ручное добавление: адрес из формы — кандидат');
  await addEntity({
    type: 'fund',
    name: MARK,
    org: 'MI Capital',
    source: `https://${HOST_A}/fund`,
  });
  check('карточка открылась', (await page.locator('h1').innerText()).includes(MARK));
  const id = new URL(page.url()).pathname.split('/').pop();
  const [factA] = await sql(
    `SELECT m.verification, s.source_url, s.is_profile FROM intelligence.mentions m
       JOIN intelligence.sources s ON s.id = m.source_id WHERE m.entity_id = $1`,
    [id],
  );
  check('адрес из формы — факт-кандидат', factA?.verification === 'candidate', factA?.verification);
  check(
    'источник заведён на сайт и не разобран',
    factA?.source_url === `https://${HOST_A}/` && factA?.is_profile === null,
  );
  await screenshot('card');

  console.warn('[3] Подтверждённый факт с организацией, профильная площадка, вес');
  const [org] = await sql(
    `SELECT id, name FROM intelligence.entities WHERE type = 'investor_club' ORDER BY name LIMIT 1`,
  );
  await page.fill('[data-intel-fact-add] [data-intel-fact-url]', `https://${HOST_B}/demo-day`);
  await page.fill('[data-intel-fact-add] [data-intel-fact-role]', 'член жюри');
  await page.fill('[data-intel-fact-add] [data-intel-fact-date]', '2026-05-14');
  await page.fill('[data-intel-fact-add] [data-intel-fact-action]', 'оценивал питчи ранней стадии');
  await page.fill('[data-intel-fact-add] [data-intel-fact-evidence]', 'В жюри — MI Capital');
  if (org) {
    await page.fill(
      '[data-intel-fact-add] [data-intel-picker="organization"]',
      org.name.slice(0, 6),
    );
    await page.locator('.intel-picker__list button', { hasText: org.name }).first().click();
  }
  await page.selectOption('[data-intel-fact-add] [data-intel-fact-verification]', 'verified');
  await page.getByRole('button', { name: 'Добавить факт' }).click();
  await page.waitForSelector('text=оценивал питчи ранней стадии', { timeout: 10_000 });
  const first = page.locator('[data-intel-fact]').first();
  check(
    'датированный факт — первым в хронологии',
    (await first.innerText()).includes('14.05.2026'),
  );
  check(
    'подтверждённый факт на неразобранной площадке веса не даёт',
    (await page.locator('[data-intel-metrics] .intel-metric__value').first().innerText()) === '0',
  );
  await first.locator('[data-intel-fact-edit]').click();
  await first.locator('select').first().selectOption('month');
  await first.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.waitForSelector('[data-intel-fact] >> text=май 2026', { timeout: 10_000 });
  const [prec] = await sql(
    `SELECT happened_on::text AS d, happened_precision AS p, organization_id FROM intelligence.mentions
      WHERE entity_id = $1 AND happened_on IS NOT NULL`,
    [id],
  );
  check(
    'точность даты сохранена, день не сдвинут, организация на месте',
    prec?.p === 'month' && prec?.d === '2026-05-14' && (!org || prec?.organization_id === org.id),
    `${prec?.d} ${prec?.p}`,
  );
  if (org) {
    check(
      'роль с организацией видна в «Ролях»',
      (await page.locator('[data-intel-roles]').innerText()).includes(org.name),
    );
  }

  // Площадку размечаем профильной через её карточку — как это сделает человек.
  const [srcB] = await sql(`SELECT id FROM intelligence.sources WHERE source_domain = $1`, [
    HOST_B,
  ]);
  await page.goto(`${BASE}/intelligence/sources/${srcB.id}`, { waitUntil: 'networkidle' });
  await page.click('[data-intel-source-edit]');
  await page.selectOption('[data-intel-source-form] select[name="isProfile"]', 'true');
  await page.selectOption('[data-intel-source-form] select[name="sourceType"]', 'demo_day');
  await page.selectOption('[data-intel-source-form] select[name="reviewStatus"]', 'checked');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.waitForSelector('text=Изменения сохранены', { timeout: 10_000 });
  await page.goto(`${BASE}/intelligence/${id}`, { waitUntil: 'networkidle' });
  const metric = await page.locator('[data-intel-metrics] .intel-metric__value').allInnerTexts();
  check(
    'профильная площадка: вес 1, кандидат 1 в вес не идёт',
    metric[0] === '1' && metric[3] === '1',
    metric.join(' / '),
  );
  if (org) {
    await page.goto(`${BASE}/intelligence/${org.id}`, { waitUntil: 'networkidle' });
    check(
      'у организации в «Связях» видна наша сущность',
      (await page.locator('[data-intel-related]').innerText()).includes(MARK),
    );
    await page.goto(`${BASE}/intelligence/${id}`, { waitUntil: 'networkidle' });
  }

  await page.click('[data-intel-edit]');
  await page.locator('[data-intel-form] input[name="email"]').fill('hello@example.com');
  await page.getByRole('button', { name: 'Сохранить изменения' }).click();
  await page.waitForSelector('text=Изменения сохранены', { timeout: 10_000 });
  const [saved] = await sql('SELECT email FROM intelligence.entities WHERE id = $1', [id]);
  check('правка сохранена в базе', saved?.email === 'hello@example.com');
  await page.selectOption('[data-intel-card-status]', 'interesting');
  await page.waitForSelector('text=Статус изменён', { timeout: 10_000 });
  const [status] = await sql('SELECT status FROM intelligence.entities WHERE id = $1', [id]);
  check('статус меняется из карточки', status?.status === 'interesting');

  console.warn('[4] Дубль с кавычками и родовым словом');
  await page.goto(`${BASE}/intelligence`, { waitUntil: 'networkidle' });
  await addEntity({ type: 'fund', name: `Фонд «${MARK}»`, org: '', source: '' });
  const dupId = new URL(page.url()).pathname.split('/').pop();
  check(
    '«Фонд «X»» узнан как дубль «X»',
    (await page.locator('[data-intel-duplicates]').count()) === 1,
  );

  console.warn('[5] Таблица, поиск, фильтры');
  await page.goto(`${BASE}/intelligence`, { waitUntil: 'networkidle' });
  await page.fill('[data-intel-search]', MARK);
  const rows = page.locator('[data-intel-row]');
  check('поиск находит записи прогона', (await rows.count()) === 2, `${await rows.count()}`);
  check(
    'строка помечена «дубль?»',
    (await page.locator('[data-intel-table]').innerText()).includes('дубль?'),
  );
  await page.selectOption('[data-intel-status]', 'interesting');
  check('фильтр по статусу', (await rows.count()) === 1, `${await rows.count()}`);
  await page.selectOption('[data-intel-status]', '');
  await page.selectOption('[data-intel-type]', 'event');
  check('фильтр по типу', (await rows.count()) === 0, `${await rows.count()}`);
  await page.selectOption('[data-intel-type]', '');
  await screenshot('table');

  console.warn('[5б] Объединение дублей');
  await page.goto(`${BASE}/intelligence/${id}`, { waitUntil: 'networkidle' });
  page.once('dialog', (d) => void d.accept());
  await page.click(`[data-intel-merge="${dupId}"]`);
  await page.waitForSelector('text=объединена с этой записью', { timeout: 10_000 });
  const [after] = await sql(
    `SELECT (SELECT count(*)::int FROM intelligence.entities WHERE name LIKE $1) AS n,
            (SELECT count(*)::int FROM intelligence.mentions WHERE entity_id = $2) AS facts`,
    [`%${MARK}%`, id],
  );
  check(
    'после объединения одна запись, факты на месте',
    after.n === 1 && after.facts === 2,
    `${after.n} / ${after.facts}`,
  );

  console.warn('[6] Источники и профильные площадки');
  await page.goto(`${BASE}/intelligence/sources`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-intel-sources] table', { timeout: 15_000 });
  const [gi] = await sql(
    `SELECT id, (SELECT count(DISTINCT entity_id)::int FROM intelligence.mentions m
                  WHERE m.source_id = s.id) AS n
       FROM intelligence.sources s WHERE source_url = 'https://get-investor.ru/'`,
  );
  if (gi) {
    const row = page.locator(`[data-intel-source-row="${gi.id}"]`);
    check(
      'get-investor.ru — один источник со всеми сущностями',
      (await row.count()) === 1 && (await row.innerText()).includes(String(gi.n)),
      `${gi.n}`,
    );
  }
  await screenshot('sources-list');
  await page.click('[data-intel-tab-platforms]');
  await page.waitForSelector('[data-intel-sources]', { timeout: 15_000 });
  const platforms = await page.locator('[data-intel-source-row]').count();
  const [{ profileCount }] = await sql(
    `SELECT count(*)::int AS "profileCount" FROM intelligence.sources WHERE is_profile`,
  );
  check(
    'во вкладке «Профильные площадки» только профильные',
    platforms === profileCount && platforms >= 1,
    `${platforms} / ${profileCount}`,
  );
  check(
    'размеченная площадка прогона — среди профильных',
    (await page.locator(`[data-intel-source-row="${srcB.id}"]`).count()) === 1,
  );
  await screenshot('platforms');
  // Профиль самого «богатого» фактами человека — для глаз.
  const [person] = await sql(
    `SELECT e.id FROM intelligence.entities e
      JOIN intelligence.mentions m ON m.entity_id = e.id
     WHERE e.type = 'person'
     GROUP BY e.id ORDER BY count(*) DESC LIMIT 1`,
  );
  if (person) {
    await page.goto(`${BASE}/intelligence/${person.id}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-intel-facts]', { timeout: 15_000 });
    await screenshot('profile');
  }
  await page.goto(`${BASE}/intelligence/sources`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-intel-sources] table', { timeout: 15_000 });
  await page.click('[data-intel-source-add]');
  await page.fill('[data-intel-source-form] input[name="url"]', 'http://127.0.0.1/admin/');
  await page.getByRole('button', { name: 'Сохранить источник' }).click();
  await page.waitForSelector('[data-page="intelligence-source"] h1', { timeout: 20_000 });
  const [inner] = await sql(
    `SELECT source_title, notes FROM intelligence.sources
      WHERE source_url = 'http://127.0.0.1/admin/' AND entity_id IS NULL`,
  );
  check(
    'адрес внутренней сети сохранён, но НЕ загружен',
    Boolean(inner) && inner.source_title === null && /внутреннюю сеть/.test(inner.notes ?? ''),
    inner?.notes ?? 'нет строки',
  );
  await screenshot('sources');

  if (process.env.INTEL_LIVE_IMPORT === '1') {
    console.warn('[7] Импорт get-investor.ru (живой)');
    await page.goto(`${BASE}/intelligence`, { waitUntil: 'networkidle' });
    await page.click('[data-intel-import-gi]');
    await page.waitForSelector('text=Импорт get-investor.ru завершён', { timeout: 150_000 });
    console.warn(`  ·     ${await page.locator('.alert--ok').innerText()}`);
    const [{ total }] = await sql(
      `SELECT count(*)::int AS total FROM intelligence.entities WHERE import_source = 'get-investor'`,
    );
    check('импортированные записи есть в базе', total > 100, `${total}`);
    // Сообщение появляется раньше, чем таблица перечитана: ждём строки.
    const shown = await page
      .waitForFunction(
        (n) => globalThis.document.querySelectorAll('[data-intel-row]').length >= n,
        total,
        {
          timeout: 15_000,
        },
      )
      .then(() => true)
      .catch(() => false);
    check('и в таблице', shown, `${total}`);
    const [{ dup }] = await sql(
      `SELECT count(*)::int AS dup FROM (SELECT external_id FROM intelligence.entities
          WHERE import_source = 'get-investor' GROUP BY external_id HAVING count(*) > 1) d`,
    );
    check('повторный импорт не плодит записи', dup === 0, `${dup}`);
    await screenshot('imported');
  }

  const unexpected = consoleErrors.filter((t) => !/status of (400|409|422|429)/.test(t));
  check('непредвиденных ошибок в консоли нет', unexpected.length === 0, unexpected[0] ?? '');
} finally {
  await browser.close();
  await sql(`DELETE FROM intelligence.entities WHERE name LIKE $1`, [`%${MARK}%`]);
  await sql(
    `DELETE FROM intelligence.sources WHERE source_url = 'http://127.0.0.1/admin/' AND entity_id IS NULL`,
  );
  await sql(`DELETE FROM intelligence.sources WHERE source_domain = ANY($1)`, [[HOST_A, HOST_B]]);
  await pool.end();
}

console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено. Снимки: ${OUT}`);
await run.finish(failed === 0);
process.exit(failed > 0 ? 1 : 0);
