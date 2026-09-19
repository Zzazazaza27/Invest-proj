#!/usr/bin/env node
/**
 * Браузерный проход: управление сотрудниками через интерфейс.
 *
 * Проверяется завершённый сценарий администратора и эксперта — тот, ради
 * которого экраны и делались:
 *
 *   1. выдать функциональное полномочие галочкой;
 *   2. назначить эксперта на объект (оценка проекта и сопровождение сделки);
 *   3. убедиться, что разрешённое действие проходит, а лишнего доступа нет;
 *   4. отозвать полномочие и убедиться, что действие закрылось;
 *   5. вернуть полномочие, снять назначение — и убедиться, что действие снова
 *      закрыто, но уже по ДРУГОЙ причине;
 *   6. проверить независимость `review` и `deal_support` друг от друга.
 *
 * Отдельно — замечание пользовательского прохода: ответ 429 на проверке
 * сессии не должен выглядеть как выход из аккаунта.
 *
 * Денег не двигается: возврат транша — это ЗАПИСЬ о состоявшемся событии,
 * платформа ничего не перечисляет. Данные только тестовые.
 *
 * Требуется поднятое: ядро, вход (5179), админка (5174), кабинет эксперта
 * (5177), кабинет основателя (5175).
 *
 * Снимки — `out/render-staff-access/`.
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

/**
 * Хост один и тот же для страницы и API.
 *
 * `localhost` вместо сырого IP: у адреса нет регистрируемого домена, и браузер
 * не считает `127.0.0.1:5174` и `127.0.0.1:4300` одним сайтом — изображения и
 * часть защит ведут себя иначе (разобрано в 7.2).
 */
const toSite = (url) => url.replace('127.0.0.1', 'localhost');
const ADMIN_URL = toSite(process.env.ADMIN_URL ?? frontendUrl('admin'));
const EXPERT_URL = toSite(process.env.EXPERT_URL ?? frontendUrl('expert'));
const LAB_URL = toSite(process.env.LAB_URL ?? frontendUrl('lab'));
const CORE_URL = toSite(process.env.CORE_URL ?? DEFAULT_CORE_URL);

const OUT = join(ROOT, 'out', 'render-staff-access');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const verdicts = [];
function verdict(scenario, state, note = '') {
  verdicts.push({ scenario, state, note });
  const mark = state === 'ПРОЙДЕН' ? 'OK  ' : state === 'ДЕФЕКТ' ? 'FAIL' : '—   ';
  console.warn(`  ${mark}  ${scenario}${note ? ` — ${note}` : ''}`);
}

/** Условие → вердикт. Отдельной функцией, чтобы не писать тернарник в каждой. */
function expect(scenario, condition, note = '') {
  verdict(scenario, condition ? 'ПРОЙДЕН' : 'ДЕФЕКТ', note);
}

/**
 * Переключить галочку полномочия.
 *
 * `page.check()` здесь не годится: галочка управляемая и меняет состояние
 * только после ответа сервера, а `check()` проверяет её сразу после клика.
 */
async function toggleCapability(page, code, shouldBeChecked) {
  const box = page.locator('input[type=checkbox]').and(page.locator(`[id="cap-${code}"]`));
  if ((await box.isChecked()) === shouldBeChecked) return;
  await box.click();
  await page.waitForTimeout(2000);
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

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'ul_csrf';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL_OWNER,
  max: 4,
  application_name: 'unicorn-render-staff-access',
});
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

function makeClient() {
  const state = { session: null, csrf: null };
  async function call(path, { method = 'GET', body } = {}) {
    const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) {
      headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
    }
    const response = await fetch(`${CORE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* не JSON */
    }
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(';')[0];
      if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
      if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
    }
    return { response, json };
  }
  async function json(path, init) {
    const { response, json: body } = await call(path, init);
    if (response.status >= 400) {
      throw new Error(
        `${init?.method ?? 'GET'} ${path}: ${response.status} ${JSON.stringify(body)}`,
      );
    }
    return body;
  }
  return { call, json };
}

async function register(tag) {
  const client = makeClient();
  const email = `sa-${tag}-${suffix}@test.local`;
  const password = `Pw-${randomUUID()}`;
  await client.json('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: `Сотрудник ${tag} ${suffix}`,
      role: 'founder',
      locale: 'ru-RU',
      consents: CONSENTS,
    },
  });
  const [row] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
    blindIndex(email),
  ]);
  return { client, email, password, userId: row?.id ?? null };
}

/**
 * Сделка с подтверждённым траншем — обстановка для денежной записи.
 *
 * Строится в БД: сделочный контур здесь не проверяется, и гонять его через
 * интерфейс значило бы проверять не то.
 */
async function makeDeal(founderId, investorId, title, amount) {
  const projectId = randomUUID();
  await sql(
    `INSERT INTO lab.projects (id, title, stage, investment_ask, status)
     VALUES ($1, $2, 'mvp', $3, 'draft')`,
    [projectId, title, amount],
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
    [entityId, `ООО Проход ${suffix}`, Buffer.from(inn), inn, founderId],
  );
  await sql(
    `INSERT INTO kyc.entity_members (entity_id, user_id, member_role, verified_at)
     VALUES ($1, $2, 'signatory', now())`,
    [entityId, founderId],
  );
  const [reviewer] = await sql(
    `SELECT user_id FROM identity.user_roles WHERE role = 'admin' AND revoked_at IS NULL LIMIT 1`,
  );
  await sql(
    `INSERT INTO kyc.kyb_verifications (id, entity_id, kind, status, reviewed_by, decided_at)
     VALUES (public.uuid_generate_v7(), $1, 'registry_check', 'approved', $2, now())`,
    [entityId, reviewer.user_id],
  );
  await sql(
    `INSERT INTO kyc.kyc_verifications
       (id, user_id, kind, status, risk_level, sanctions_status, reviewed_by, decided_at)
     VALUES (public.uuid_generate_v7(), $1, 'identity', 'approved', 'low', 'clear', $2, now())`,
    [investorId, reviewer.user_id],
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
  const [tranche] = await sql(
    `SELECT tranche_id, accrual_id
       FROM billing.confirm_tranche($1, $2, $3, now(), digest('stmt','sha256'), NULL, 'render')`,
    [agreementId, `bank-${agreementId}`, amount],
  );
  return { projectId, agreementId, trancheId: tranche.tranche_id };
}

/**
 * Войти в кабинет через единое приложение входа.
 *
 * Кабинет сам формы входа не содержит: он перенаправляет на `apps/auth`. У
 * человека с двумя ролями там ещё и экран выбора кабинета — поэтому после
 * входа возвращаемся на адрес кабинета явно, а не полагаемся на переход.
 */
async function signIn(target, url, who) {
  await target.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  const form = await target.waitForSelector('#email', { timeout: 15_000 }).catch(() => null);
  if (form) {
    await target.fill('#email', who.email);
    await target.fill('#password', who.password);
    await target.getByRole('button', { name: /^Войти$/ }).click();
    await target.waitForTimeout(3500);
    await target.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  }
  await target.waitForTimeout(1500);
}

let shot = 0;
async function screenshot(page, name) {
  shot += 1;
  await page.screenshot({
    path: join(OUT, `${String(shot).padStart(2, '0')}-${name}.png`),
    fullPage: true,
  });
}

/** Попытка записать возврат транша: разрешено или нет — вот весь вопрос. */
async function tryRecordReturn(client, trancheId) {
  const { response, json } = await client.call('/v1/investments/deals/tranche-returns', {
    method: 'POST',
    body: {
      trancheId,
      amount: '1000.00',
      currency: 'RUB',
      occurredOn: new Date().toISOString().slice(0, 10),
      reason: 'проверка сценария управления экспертами',
      idempotencyKey: `render-${randomUUID()}`,
    },
  });
  return { status: response.status, detail: json?.detail ?? json?.title ?? '' };
}

console.warn('\n=== БРАУЗЕРНЫЙ ПРОХОД: УПРАВЛЕНИЕ ЭКСПЕРТАМИ ЧЕРЕЗ ИНТЕРФЕЙС ===\n');

// ------------------------------------------------------------- обстановка
const founder = await register('founder');
const investor = await register('investor');
const expertUser = await register('expert');
// Второй эксперт — для проверки показа заявленного конфликта интересов.
const conflicted = await register('conflict');
// Отдельный основатель для проверки поведения при 429: у владельца сделки в
// обстановке лежит фиктивное юрлицо (шифртекст подделан ради фикстуры), и его
// кабинет показал бы ошибку разбора, не относящуюся к проверяемому.
const labUser = await register('lab');
const adminUser = await register('admin');
await sql(
  `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
  [adminUser.userId],
);
await sql(
  `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'expert') ON CONFLICT DO NOTHING`,
  [expertUser.userId],
);
await sql(
  `INSERT INTO experts.experts (user_id, expertise_tags) VALUES ($1, ARRAY['fintech'])
   ON CONFLICT (user_id) DO NOTHING`,
  [expertUser.userId],
);
await sql(
  `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'expert') ON CONFLICT DO NOTHING`,
  [conflicted.userId],
);
await sql(
  `INSERT INTO experts.experts (user_id, expertise_tags) VALUES ($1, ARRAY['fintech'])
   ON CONFLICT (user_id) DO NOTHING`,
  [conflicted.userId],
);

const admin = makeClient();
await admin.json('/v1/auth/login', {
  method: 'POST',
  body: { email: adminUser.email, password: adminUser.password },
});
const expert = makeClient();
await expert.json('/v1/auth/login', {
  method: 'POST',
  body: { email: expertUser.email, password: expertUser.password },
});

// Проект со сделкой — для сопровождения; отдельный проект — для оценки.
const deal = await makeDeal(founder.userId, investor.userId, `Сделка прохода ${suffix}`, 1_000_000);
const [taxonomy] = await sql(`SELECT id FROM lab.project_taxonomy WHERE slug = 'fintech'`);
const [reviewProject] = await sql(
  `INSERT INTO lab.projects (id, taxonomy_id, title, stage, status, investment_ask)
   VALUES (public.uuid_generate_v7(), $1, $2, 'growth', 'expert_review', 5000000)
   RETURNING id, title`,
  [taxonomy.id, `Оценка прохода ${suffix}`],
);
await sql(
  `INSERT INTO lab.founders_projects (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
  [reviewProject.id, founder.userId],
);
const [dealProject] = await sql(`SELECT id, title FROM lab.projects WHERE id = $1`, [
  deal.projectId,
]);
console.warn(`  ·     проект на оценку: ${reviewProject.title}`);
console.warn(`  ·     проект со сделкой: ${dealProject.title}`);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  if (/\b(400|401|403|404|409|429) \(/.test(message.text())) return;
  consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

/** Найти раздел по якорю: на странице их четыре, и кнопки в них одноимённые. */
function section(key) {
  return page.locator(`[data-section="${key}"]`);
}

/**
 * Выбрать человека или проект через поиск на экране.
 *
 * Результат выбирается ВНУТРИ того же блока поиска: списков на странице
 * несколько, и «первая кнопка с таким текстом» легко оказывается чужой.
 */
async function pick(searchId, query, optionText) {
  const input = page.locator(`#${searchId}`);
  await input.fill(query);
  await input.locator('xpath=following-sibling::button[1]').click();
  const list = input.locator('xpath=ancestor::*[self::div][1]/following::ul[1]');
  const option = list.locator('button', { hasText: optionText }).first();
  await option.waitFor({ state: 'visible', timeout: 15_000 });
  await option.click();
  await page.waitForTimeout(500);
}

try {
  // ---------------------------------------------------------- вход в админку
  console.warn('\n[1] Администратор открывает «Доступ»');
  await page.goto(`${ADMIN_URL}access`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.fill('#email', adminUser.email);
  await page.fill('#password', adminUser.password);
  await page.getByRole('button', { name: /Войти/i }).click();
  await page.waitForTimeout(2000);
  await page.goto(`${ADMIN_URL}access`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForSelector('text=Полномочия сотрудника', { timeout: 15_000 });
  await screenshot(page, 'admin-access');
  expect(
    'Администратор: экран управления сотрудниками открывается',
    (await page.getByText('Полномочия сотрудника').count()) > 0 &&
      (await page.getByText('Назначение на оценку проекта').count()) > 0 &&
      (await page.getByText('Сопровождение сделок проекта').count()) > 0,
    'три раздела на странице «Доступ»',
  );

  // -------------------------------------------- 1. выдача полномочия галочкой
  console.warn('\n[2] Выдача функционального полномочия галочкой');
  await pick('cap-user-search', `Сотрудник expert ${suffix}`, `Сотрудник expert ${suffix}`);
  await page.waitForTimeout(800);
  const catalogVisible = await page.getByText('Фиксировать возврат транша').count();
  expect(
    'Каталог полномочий показан по разделам с понятным описанием',
    catalogVisible > 0 && (await page.getByText('Финансы').count()) > 0,
    'раздел «Финансы», понятные названия действий',
  );
  expect(
    'Полномочие, требующее назначения, помечено',
    (await page.getByText('нужно назначение на объект').count()) > 0,
    'значок рядом с правом',
  );

  await page.fill('#cap-reason', 'проход проверки управления экспертами');
  await toggleCapability(page, 'finance.tranche_return.record', true);
  await screenshot(page, 'capability-granted');
  const grants = await admin.json(`/v1/admin/capabilities/users/${expertUser.userId}`);
  expect(
    'Полномочие выдано галочкой и видно на сервере',
    grants.items.some(
      (g) => g.capability === 'finance.tranche_return.record' && g.revokedAt === null,
    ),
    'finance.tranche_return.record',
  );

  // --------------------------------- полномочие без области работы не открывает
  {
    const attempt = await tryRecordReturn(expert, deal.trancheId);
    expect(
      'Полномочие без назначения на объект ничего не открывает',
      attempt.status === 403 || attempt.status === 404,
      `HTTP ${attempt.status}${attempt.detail ? `: ${attempt.detail}` : ''}`,
    );
  }

  // ------------------------------------ 2. назначение на сопровождение сделки
  console.warn('\n[3] Назначение на сопровождение сделки');
  await pick('deal-project-search', dealProject.title, dealProject.title);
  await pick('deal-user-search', `Сотрудник expert ${suffix}`, `Сотрудник expert ${suffix}`);
  await page.fill('#deal-reason', 'ведёт сделки этого проекта в проходе проверки');
  await page.getByRole('button', { name: 'Назначить на сопровождение' }).click();
  await page.waitForTimeout(2000);
  await screenshot(page, 'deal-support-assigned');
  const dealAssignments = await admin.json('/v1/admin/capabilities/deal-support');
  expect(
    'Назначение на сопровождение создано через интерфейс и видно в списке',
    dealAssignments.items.some(
      (a) => a.userId === expertUser.userId && a.projectId === dealProject.id,
    ),
    'строка с именем сотрудника и названием проекта',
  );

  // ------------------------------------------- 3. разрешённое действие проходит
  console.warn('\n[4] Разрешённое действие и отсутствие лишнего доступа');
  {
    const attempt = await tryRecordReturn(expert, deal.trancheId);
    expect(
      'Полномочие + назначение: денежная запись проходит',
      attempt.status === 200 || attempt.status === 201,
      `HTTP ${attempt.status} (запись о состоявшемся возврате, перечислений нет)`,
    );
  }

  // ------------------------------------- 4. назначение на оценку другого проекта
  console.warn('\n[5] Назначение на оценку проекта');
  await pick('review-project-search', reviewProject.title, reviewProject.title);
  await page.waitForTimeout(800);
  await pick('review-expert-search', `Сотрудник expert ${suffix}`, `Сотрудник expert ${suffix}`);
  const due = new Date(Date.now() + 14 * 24 * 3600_000).toISOString().slice(0, 10);
  await page.fill('#review-due', due);
  await page.getByRole('button', { name: 'Назначить на оценку' }).click();
  await page.waitForTimeout(2000);
  await screenshot(page, 'review-assigned');
  const reviewList = await admin.json(`/v1/experts/projects/${reviewProject.id}/assignments`);
  expect(
    'Назначение на оценку создано через интерфейс',
    reviewList.items.some((a) => a.expertId === expertUser.userId && a.status === 'assigned'),
    'эксперт в списке рецензентов проекта',
  );

  // ---------------------- 5а. заявленный конфликт виден ДО попытки работы
  console.warn('\n[5а] Заявленный конфликт интересов показан до назначения');
  {
    const client = makeClient();
    await client.json('/v1/auth/login', {
      method: 'POST',
      body: { email: conflicted.email, password: conflicted.password },
    });
    await client.json('/v1/experts/conflicts', {
      method: 'POST',
      body: {
        projectId: reviewProject.id,
        description: 'Проход проверки: доля в конкурирующем проекте.',
      },
    });
  }
  await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
  await pick('review-project-search', reviewProject.title, reviewProject.title);
  await page.waitForTimeout(1000);
  await pick(
    'review-expert-search',
    `Сотрудник conflict ${suffix}`,
    `Сотрудник conflict ${suffix}`,
  );
  await page.waitForTimeout(800);
  await screenshot(page, 'conflict-shown');
  {
    const card = await section('review-assignments').innerText();
    expect(
      'Конфликт интересов назван до попытки работы',
      /заявлен конфликт интересов/i.test(card) && /решения по нему ещё нет/i.test(card),
      'объяснение в форме назначения',
    );
    expect(
      'Кнопка назначения на этом эксперте недоступна',
      await section('review-assignments')
        .getByRole('button', { name: 'Назначить на оценку' })
        .isDisabled(),
      'интерфейс не предлагает то, что сервер отклонит',
    );
  }
  {
    // Серверная проверка остаётся единственной защитой: показ на экране её не
    // заменяет и решения не принимает.
    const due = new Date(Date.now() + 14 * 24 * 3600_000).toISOString();
    const { response } = await admin.call('/v1/experts/assignments', {
      method: 'POST',
      body: {
        projectId: reviewProject.id,
        expertIds: [conflicted.userId],
        dueAt: due,
        reason: 'manual',
      },
    });
    expect(
      'Сервер по-прежнему отклоняет назначение с незакрытым конфликтом',
      response.status >= 400,
      `HTTP ${response.status} в обход экрана`,
    );
  }

  // ------------------------------------------- кабинет эксперта: что он видит
  console.warn('\n[6] Кабинет эксперта: назначения на оценку и ничего лишнего');
  // Отдельный контекст: сессионная кука одна на origin, и в общем окне
  // эксперт открыл бы кабинет под администратором.
  const expertContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const expertPage = await expertContext.newPage();
  await signIn(expertPage, EXPERT_URL, expertUser);
  await expertPage.waitForSelector('text=Мои назначения', { timeout: 20_000 });
  await expertPage.waitForTimeout(1500);
  const expertText = await expertPage.locator('main').innerText();
  await screenshot(expertPage, 'expert-assignments');
  expect(
    'Эксперт видит проект, на оценку которого назначен',
    expertText.includes(reviewProject.title),
    reviewProject.title,
  );
  expect(
    'Назначение на сопровождение НЕ открывает рецензентские материалы',
    !expertText.includes(dealProject.title),
    'проекта со сделкой в списке назначений на оценку нет',
  );
  {
    const own = await expert.json('/v1/experts/assignments');
    expect(
      'Список назначений эксперта содержит только оценку',
      own.items.every((a) => a.projectId !== dealProject.id) &&
        own.items.some((a) => a.projectId === reviewProject.id),
      `${own.items.length} назначени(я)`,
    );
  }
  {
    const { response } = await expert.call('/v1/admin/capabilities/grant', {
      method: 'POST',
      body: {
        userId: expertUser.userId,
        capability: 'finance.commission.reduce',
        reason: 'попытка расширить себе права',
      },
    });
    expect(
      'Эксперт не может расширить собственные права',
      response.status === 403 || response.status === 404,
      `HTTP ${response.status} на попытке выдать себе полномочие`,
    );
  }

  // ------------------------------------------------------ 5. отзыв полномочия
  console.warn('\n[7] Отзыв полномочия галочкой');
  await page.bringToFront();
  // Страница между шагами перезагружалась: выбор человека в разделе полномочий
  // держится состоянием экрана, а не адресом, и после перезагрузки его нет.
  await pick('cap-user-search', `Сотрудник expert ${suffix}`, `Сотрудник expert ${suffix}`);
  await page.fill('#cap-reason', 'проход проверки: отзываем полномочие');
  await page.waitForTimeout(800);
  await toggleCapability(page, 'finance.tranche_return.record', false);
  await screenshot(page, 'capability-revoked');
  {
    const attempt = await tryRecordReturn(expert, deal.trancheId);
    expect(
      'После отзыва полномочия денежное действие закрыто',
      attempt.status === 403,
      `HTTP ${attempt.status}${attempt.detail ? `: ${attempt.detail}` : ''}`,
    );
  }

  // ---------------------------- 6. восстановление полномочия
  console.warn('\n[8] Возврат полномочия');
  await toggleCapability(page, 'finance.tranche_return.record', true);
  {
    const attempt = await tryRecordReturn(expert, deal.trancheId);
    expect(
      'Полномочие возвращено — действие снова проходит',
      attempt.status === 200 || attempt.status === 201,
      `HTTP ${attempt.status}`,
    );
  }

  // ------------------- 7. работа выполнена, затем доступ прекращён
  //
  // Главная проверка замечания: сданная рецензия остаётся, а доступ по тому же
  // назначению закрывается. До M120 это было невозможно — «снять назначение»
  // означало отменить работу, и приложение такое снятие запрещало.
  console.warn('\n[9] Рецензия подана, затем администратор прекращает доступ');
  const myAssignment = (await expert.json('/v1/experts/assignments')).items.find(
    (a) => a.projectId === reviewProject.id,
  );
  await expert.json(`/v1/experts/assignments/${myAssignment.id}/decision`, {
    method: 'POST',
    body: { decision: 'accepted' },
  });
  const review = await expert.json('/v1/experts/reviews', {
    method: 'POST',
    body: {
      assignmentId: myAssignment.id,
      rubricScores: { team: 7, product: 6, strategy: 6, legal: 8, finmodel: 5, scalability: 7 },
      comment: 'Проход проверки: рецензия должна пережить прекращение доступа.',
      recommendation: 'needs_review',
    },
  });
  expect(
    'Эксперт подал рецензию по своему назначению',
    review?.assignmentId === myAssignment.id && review?.expertId === expertUser.userId,
    `рекомендация «${review?.recommendation}», автор ${review?.expertId?.slice(0, 8)}`,
  );

  {
    const { response } = await expert.call(`/v1/projects/${reviewProject.id}`);
    expect(
      'До прекращения доступа закрытые данные проекта эксперту открыты',
      response.status === 200,
      `HTTP ${response.status} на карточке проекта`,
    );
  }

  await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
  await pick('review-project-search', reviewProject.title, reviewProject.title);
  await page.waitForTimeout(1000);
  expect(
    'Экран показывает, что работа выполнена',
    (await section('review-assignments').innerText()).includes('рецензия подана'),
    'отметка о поданной рецензии в строке назначения',
  );

  const reviewCard = section('review-assignments');
  await page.fill('#review-reason', 'проход проверки: работа по проекту завершена');
  await reviewCard.getByRole('button', { name: 'Прекратить доступ' }).first().click();
  await page.waitForTimeout(2500);
  await screenshot(page, 'review-access-revoked');

  {
    const after = await admin.json(`/v1/experts/projects/${reviewProject.id}/assignments`);
    const mine = after.items.find((a) => a.expertId === expertUser.userId);
    expect(
      'Доступ прекращён, а состояние работы не переписано',
      mine?.accessRevokedAt !== null && mine?.status === 'completed',
      `статус ${mine?.status}, доступ прекращён ${mine?.accessRevokedAt ? 'да' : 'нет'}`,
    );
    expect(
      'Рецензия числится поданной и после прекращения доступа',
      mine?.reviewSubmitted === true,
      'отметка о работе осталась',
    );
  }
  {
    const reviews = await admin.json(`/v1/experts/projects/${reviewProject.id}/reviews`);
    // Рецензия опознаётся по назначению: своего идентификатора в контракте у
    // неё нет — она одна на назначение, и это само по себе правило.
    const mine = reviews.items.find((r) => r.assignmentId === myAssignment.id);
    expect(
      'Рецензия не удалена и осталась за своим автором',
      Boolean(mine) && mine.expertId === expertUser.userId,
      `назначение ${myAssignment.id.slice(0, 8)}, автор ${mine?.expertId?.slice(0, 8) ?? 'нет'}`,
    );
  }
  {
    const { response } = await expert.call(`/v1/projects/${reviewProject.id}`);
    expect(
      'Закрытые данные через это назначение больше недоступны',
      response.status === 404 || response.status === 403,
      `HTTP ${response.status} на карточке проекта`,
    );
  }
  {
    const own = await expert.json('/v1/experts/assignments');
    expect(
      'Назначение исчезло из рабочего списка эксперта',
      own.items.every((a) => a.projectId !== reviewProject.id),
      `назначений в кабинете: ${own.items.length}`,
    );
  }
  {
    const { response } = await admin.call(
      `/v1/experts/assignments/${myAssignment.id}/revoke-access`,
      { method: 'POST', body: { reason: 'повторное прекращение того же доступа' } },
    );
    expect(
      'Повторное прекращение отвергается, а не переписывает запись',
      response.status === 409,
      `HTTP ${response.status}`,
    );
  }

  // --------- 8. другие основания доступа считаются отдельно
  console.warn('\n[10] Другие основания доступа учитываются отдельно');
  {
    const attempt = await tryRecordReturn(expert, deal.trancheId);
    expect(
      'Прекращение доступа рецензента не тронуло сопровождение сделки',
      attempt.status === 200 || attempt.status === 201,
      `HTTP ${attempt.status} — другое назначение, другое основание`,
    );
  }

  const dealCard = section('deal-support');
  await page.fill('#deal-reason', 'проход проверки: прекращаем сопровождение');
  await dealCard.getByRole('button', { name: 'Прекратить доступ' }).first().click();
  await page.waitForTimeout(2000);
  await screenshot(page, 'deal-support-revoked');
  {
    const attempt = await tryRecordReturn(expert, deal.trancheId);
    // Причина другая, и ответ другой: без области работы сделка для
    // сотрудника просто не существует — 404, а не «нет полномочия» 403.
    expect(
      'Прекращение сопровождения закрывает действие ПО ДРУГОЙ причине',
      attempt.status === 404,
      `HTTP ${attempt.status}: ${attempt.detail} (без полномочия было 403)`,
    );
  }
  {
    const grantsAfter = await admin.json(`/v1/admin/capabilities/users/${expertUser.userId}`);
    expect(
      'Прекращение доступа не трогает выданное полномочие',
      grantsAfter.items.some(
        (g) => g.capability === 'finance.tranche_return.record' && g.revokedAt === null,
      ),
      'полномочие и назначение — разные условия доступа',
    );
  }

  // ------------------------------ замечание прохода: 429 на проверке сессии
  console.warn('\n[11] Ответ 429 на проверке сессии не выглядит как выход из аккаунта');
  const labContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const labPage = await labContext.newPage();
  await signIn(labPage, LAB_URL, labUser);
  await labPage.waitForTimeout(2000);
  const cookiesBefore = await labContext.cookies();
  const hadSession = cookiesBefore.some((c) => c.name === SESSION_COOKIE);

  // Ограничитель подделывается адресно: поднимать настоящий лимит ради
  // зелёной проверки нельзя, а поведение интерфейса нужно увидеть глазами.
  let limited = true;
  let meCalls = 0;
  await labPage.route('**/v1/auth/me', async (route) => {
    meCalls += 1;
    if (!limited) {
      await route.continue();
      return;
    }
    // Заголовки берутся у НАСТОЯЩЕГО ответа ядра, а подменяются только статус
    // и тело. Иначе проверка зелёная на выдуманном ответе: браузер отдаёт
    // межсайтовому коду лишь раскрытые сервером заголовки, и `Retry-After`
    // читается только потому, что ядро его раскрывает (`exposedHeaders`).
    const real = await route.fetch();
    const headers = { ...real.headers(), 'content-type': 'application/json' };
    headers['retry-after'] = '5';
    await route.fulfill({
      status: 429,
      headers,
      body: JSON.stringify({
        type: 'https://unicorn.vc/problems/rate_limited',
        title: 'Слишком много запросов',
        status: 429,
        code: 'rate_limited',
        detail: 'Повторите через 5 с',
      }),
    });
  });
  await labPage.reload({ waitUntil: 'networkidle', timeout: 30_000 });
  await labPage.waitForTimeout(2500);
  await screenshot(labPage, 'rate-limited-session');
  const limitedText = await labPage.locator('body').innerText();
  expect(
    'При 429 показано понятное состояние, а не форма входа',
    limitedText.includes('Слишком много запросов') && !labPage.url().includes('/login'),
    'страница осталась на кабинете',
  );
  expect(
    'Сказано прямо, что из аккаунта не вышли',
    /из аккаунта вы не вышли/i.test(limitedText),
    'текст состояния',
  );
  expect(
    'Есть возможность повторить запрос',
    (await labPage.getByRole('button', { name: /Проверить ещё раз/i }).count()) > 0,
    'кнопка повтора с отсчётом из Retry-After',
  );
  expect(
    'Названо, через сколько можно повторить',
    /Повторить можно через \d+ с/.test(limitedText),
    'срок взят из ответа сервера',
  );
  const cookiesAfter = await labContext.cookies();
  expect(
    'Сессионная кука не удалена',
    hadSession && cookiesAfter.some((c) => c.name === SESSION_COOKIE),
    'cookie на месте',
  );
  // Бесконечных повторов быть не должно: ждём и смотрим, не растёт ли счётчик.
  const callsAfterPanel = meCalls;
  await labPage.waitForTimeout(8000);
  expect(
    'Бесконечных повторов запроса нет',
    meCalls === callsAfterPanel,
    `запросов «кто я» за 8 с ожидания: ${meCalls - callsAfterPanel}`,
  );

  limited = false;
  await labPage.getByRole('button', { name: /Проверить ещё раз/i }).click();
  await labPage.waitForTimeout(3000);
  await screenshot(labPage, 'session-restored');
  expect(
    'Повтор по нажатию возвращает кабинет без повторного входа',
    !labPage.url().includes('/login') &&
      !(await labPage.locator('body').innerText()).includes('Слишком много запросов'),
    'кабинет открылся на той же сессии',
  );

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
const skipped = verdicts.filter((v) => v.state === 'НЕ ПРОВЕРЕН').length;
console.warn(`  пройдено: ${passed}, дефектов: ${defects}, не проверено: ${skipped}`);
console.warn(`  снимки: ${OUT}\n`);
process.exit(defects > 0 ? 1 : 0);
