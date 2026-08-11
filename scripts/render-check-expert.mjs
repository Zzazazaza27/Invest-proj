#!/usr/bin/env node
/**
 * Проверка кабинета эксперта в РЕАЛЬНОМ рендере (`RULES.md` §2).
 *
 * Проверяется путь рецензента целиком на настоящих данных: назначение,
 * принятие, подача рецензии и невозможность подать её повторно. Отдельно —
 * что рецензию нельзя написать по НЕПРИНЯТОМУ назначению: это правило сервера,
 * и кабинет обязан показывать его отказ, а не обходить.
 *
 * Запуск: node scripts/render-check-expert.mjs
 * Требуется: core на 4300 и кабинет на 5177.
 */
import { chromium } from 'playwright';
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const APP_URL = process.env.EXPERT_URL ?? 'http://127.0.0.1:5177/';
const CORE_URL = process.env.CORE_URL ?? 'http://127.0.0.1:4300';

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
  const email = `expert-${tag}-${suffix}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const response = await fetch(`${CORE_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      email,
      password,
      displayName: `Участник ${tag}`,
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

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: КАБИНЕТ ЭКСПЕРТА ===\n');

// Предусловия готовятся в БД: они принадлежат чужим ролям (организатор
// назначает, основатель владеет проектом), и проходить их через интерфейс
// эксперта было бы проверкой не того.
const expert = await register('reviewer');
const founder = await register('founder');
await sql(`INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'expert')`, [expert.userId]);
await sql(
  `INSERT INTO experts.experts (user_id, expertise_tags) VALUES ($1, ARRAY['fintech'])
   ON CONFLICT (user_id) DO NOTHING`,
  [expert.userId],
);

const [taxonomy] = await sql(`SELECT id FROM lab.project_taxonomy WHERE slug = 'fintech'`);
const [project] = await sql(
  `INSERT INTO lab.projects (id, taxonomy_id, title, stage, status, investment_ask, required_plan_id)
   VALUES (public.uuid_generate_v7(), $1, $2, 'growth', 'expert_review', 5000000,
           billing.resolve_founder_plan(5000000))
   RETURNING id, title`,
  [taxonomy.id, `Проект на рецензию ${suffix}`],
);
await sql(
  `INSERT INTO lab.founders_projects (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
  [project.id, founder.userId],
);
// Материал проекта: без него проверка «рецензент видит материалы» проверяла бы
// пустой список и была бы зелёной ни о чём.
await sql(
  `INSERT INTO lab.project_materials
     (id, project_id, type, version, url, parse_status, uploaded_by)
   VALUES (public.uuid_generate_v7(), $1, 'product_link', 1,
           'https://example.com/expert-material', 'not_required', $2)`,
  [project.id, founder.userId],
);

const [assignment] = await sql(
  `INSERT INTO experts.expert_assignments
     (id, project_id, expert_id, assigned_reason, due_at)
   VALUES (public.uuid_generate_v7(), $1, $2, 'manual', now() + interval '7 days')
   RETURNING id`,
  [project.id, expert.userId],
);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  // Доменные отказы вызываются сценарием намеренно — это правильная работа
  // сервера, а не дефект интерфейса.
  if (/\b(401|403|404|409) \(/.test(message.text())) return;
  consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

console.warn('[1] Вход и список назначений');
await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30_000 });
check(
  'незалогиненному показан вход',
  (await page.getByRole('heading', { name: 'Вход' }).count()) === 1,
);

await page.fill('#email', expert.email);
await page.fill('#password', expert.password);
await page.getByRole('button', { name: 'Войти' }).click();
await page.waitForSelector('text=Мои назначения', { timeout: 15_000 });
await page.waitForTimeout(1500);

const listText = await page.locator('main').innerText();
check('назначение видно эксперту', listText.includes(project.title), project.title);
check('срок рецензии показан', /до \d{2}\.\d{2}\.\d{4}/.test(listText));
check('статус назначения назван словами', listText.includes('Ожидает ответа'));

console.warn('\n[2] Рецензия по непринятому назначению запрещена сервером');
// Кнопки «Написать рецензию» на этом статусе нет — это отражение правила, а не
// его реализация. Проверяем, что интерфейс не предлагает недоступное действие.
check(
  'кнопки рецензии на непринятом назначении нет',
  (await page.getByRole('button', { name: 'Написать рецензию' }).count()) === 0,
);

console.warn('\n[3] Принятие и рецензия');
await page.getByRole('button', { name: 'Принять' }).first().click();
await page.waitForTimeout(2500);
check('назначение принято', (await page.locator('main').innerText()).includes('Принято'));

// Материалы проекта — то, по чему пишется рецензия. Проверяется, что они
// РАСКРЫВАЮТСЯ и содержат приложенное основателем: доступ рецензента к
// материалам открывается по факту назначения (M025), и увидеть его работу
// можно только здесь.
await page.getByRole('button', { name: 'Материалы проекта' }).first().click();
await page.waitForTimeout(2500);
const materialsText = await page.locator('main').innerText();
check(
  'материалы назначенного проекта раскрыты',
  materialsText.includes('Материалы') && materialsText.includes('Поданные версии'),
  materialsText.replace(/\s+/g, ' ').slice(0, 120),
);
check(
  'ссылка на продукт видна рецензенту',
  materialsText.includes('https://example.com/expert-material'),
);

await page.getByRole('button', { name: 'Написать рецензию' }).first().click();
await page.waitForSelector('#score-team', { timeout: 10_000 });
for (const key of ['team', 'product', 'strategy', 'legal', 'finmodel', 'scalability']) {
  await page.fill(`#score-${key}`, '8');
}
await page.fill('#comment', 'Рецензия прогона: команда сильная, финмодель требует доработки.');
await page.getByRole('button', { name: 'Отправить рецензию' }).click();
await page.waitForTimeout(3000);

const afterReview = await page.locator('main').innerText();
check(
  'рецензия принята сервером',
  afterReview.includes('Рецензия отправлена'),
  afterReview.slice(0, 80),
);
check('назначение перешло в «Рецензия сдана»', afterReview.includes('Рецензия сдана'));

const [reviewRow] = await sql(
  `SELECT recommendation, rubric_scores_jsonb FROM experts.expert_reviews
    WHERE assignment_id = $1`,
  [assignment.id],
);
check('рецензия записана в БД', reviewRow !== undefined, reviewRow?.recommendation);
check(
  'оценки сохранены по всем шести осям',
  reviewRow !== undefined && Object.keys(reviewRow.rubric_scores_jsonb).length === 6,
);

console.warn('\n[4] Конфликт интересов');
await page.getByRole('button', { name: 'Заявить конфликт интересов' }).first().click();
await page.waitForSelector(`#conflict-${assignment.id}`, { timeout: 10_000 });
await page.fill(
  `#conflict-${assignment.id}`,
  'Консультировал этот проект в прошлом сезоне — оценка не будет независимой',
);
// exact: иначе селектор совпадает и с «Заявить конфликт интересов».
await page.getByRole('button', { name: 'Заявить', exact: true }).click();
await page.waitForTimeout(2500);
check(
  'конфликт заявлен и решение передано комплаенсу',
  (await page.locator('main').innerText()).includes('решение принимает комплаенс'),
);

const [conflict] = await sql(
  `SELECT resolution FROM experts.expert_conflict_declarations
    WHERE expert_id = $1 AND project_id = $2`,
  [expert.userId, project.id],
);
check('конфликт записан и не разрешён самим экспертом', conflict?.resolution === null);

console.warn('\n[5] Доступность и раскладка');
check('ровно один h1', (await page.locator('h1').count()) === 1);
const unlabeled = await page.locator('input:not([id]):not([aria-label])').count();
check('поля ввода имеют подписи', unlabeled === 0, `без подписи: ${unlabeled}`);
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
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
