#!/usr/bin/env node
/**
 * Рендер-проверка страницы проекта (этап 7.3, состав после 2.1-W05).
 *
 * Один проект, один серверный предикат аудитории и две поверхности:
 *
 *   • аноним   — витрина, `/p/<id>`, проекция Public View (тизер);
 *   • владелец — кабинет основателя, предпросмотр «как видит аудитория».
 *
 * Карточка собирается из данных самого проекта: ответы анкеты, раунд и
 * оценка платформы удалены в 2.1-W05. Допуска инвестора по роли больше нет,
 * поэтому инвестор без личного разрешения видит то же, что аноним, — это
 * проверяется на сервере и в предпросмотре. Кабинет инвестора — пустая
 * оболочка, его страница проекта не открывается.
 *
 * Требуется поднятое: ядро, витрина, кабинет основателя, приложение входа.
 *
 * Снимки — `out/render-project-page/`.
 */
import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL as DEFAULT_CORE_URL, frontendUrl } from './lib/ports.mjs';
import { startProbeRun } from './lib/probe-run.mjs';
import {
  CONSENTS,
  blindIndex,
  createProject,
  loadDotEnv,
  makePool,
} from './lib/project-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

/*
 * Запуск открывается до первой регистрации: он даёт право назвать
 * заведённых людей следом прогона и записывает их за собой. Без него
 * сервер пометку не назначит — разрешённое значение заголовка не
 * полномочие.
 */
const run = await startProbeRun('RND-PROJECT-PAGE');

/**
 * Адреса приводятся к `localhost`: у сырого IP нет регистрируемого домена, и
 * браузер не может установить «тот же сайт» — изображение проекта на странице
 * блокируется политикой встраивания. Свойство адресации стенда, не продукта.
 */
const toSite = (url) => url.replace('127.0.0.1', 'localhost');

const PUBLIC_URL = toSite(process.env.WEB_PUBLIC_URL ?? frontendUrl('webPublic'));
const LAB_URL = toSite(process.env.LAB_URL ?? frontendUrl('lab'));
const CORE_URL = toSite(process.env.CORE_URL ?? DEFAULT_CORE_URL);
const OUT = join(ROOT, 'out', 'render-project-page');
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

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'ul_csrf';

const pool = makePool('unicorn-render-project-page');
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

function makeClient() {
  const state = { session: null, csrf: null };
  async function call(path, { method = 'GET', body } = {}) {
    const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    // Регистрация называет серверу своё происхождение: иначе заведённый
    // прогоном человек неотличим от настоящего (M127).
    if (path === '/v1/auth/register') Object.assign(headers, run.headers());
    if (method !== 'GET' && state.csrf) {
      headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
    }
    const response = await fetch(`${CORE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
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

const suffix = `${Date.now() % 1e9}`;

async function register(role, tag) {
  const client = makeClient();
  const email = `pp-${tag}-${suffix}@test.local`;
  const password = `Pw-${crypto.randomUUID()}`;
  await client.json('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: `Проверка ${tag}`,
      role,
      locale: 'ru-RU',
      consents: CONSENTS,
    },
  });
  const [row] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
    blindIndex(email),
  ]);
  return { client, email, password, userId: row?.id ?? null };
}

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: СТРАНИЦА ПРОЕКТА (7.3, после 2.1-W05) ===\n');

const founder = await register('founder', 'f');
const investor = await register('investor', 'i');

// Открытые режимы видимости закрыты, пока владелец не верифицирован: это
// продуктовое правило, а не препятствие прогону. Верификацию одобряет
// администратор — так же, как в жизни.
const adminUser = await register('founder', 'a');
await sql(
  `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
  [adminUser.userId],
);
const admin = makeClient();
await admin.json('/v1/auth/login', {
  method: 'POST',
  body: { email: adminUser.email, password: adminUser.password },
});
{
  const kyc = await founder.client.json('/v1/kyc/verifications', {
    method: 'POST',
    body: { kind: 'identity', docType: 'passport', docCountry: 'RU' },
  });
  if (kyc.status !== 'approved') {
    await admin.json(`/v1/kyc/verifications/${kyc.id}/decision`, {
      method: 'POST',
      body: { decision: 'approved', riskLevel: 'low' },
    });
  }
}

const browser = await chromium.launch();
const consoleErrors = [];
function watch(page, who) {
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (/\b(400|401|403|404|409|503) \(/.test(message.text())) return;
    consoleErrors.push(`${who}: ${message.text()}`);
  });
  page.on('pageerror', (error) => consoleErrors.push(`${who}: ${String(error)}`));
}

try {
  const { project } = await createProject(founder.client, sql, suffix);
  // Публичный режим: тизер и описание открыты всем. Решает предикат в базе,
  // не клиент.
  await founder.client.json(`/v1/projects/${project.id}/visibility`, {
    method: 'PUT',
    body: { visibility: 'public' },
  });
  // Публикация листинга: без неё проект не появляется в каталоге.
  await founder.client.json(`/v1/projects/${project.id}/listing`, { method: 'POST' });

  // Серверные проекции до браузера — чтобы отличить «страница не нарисовала»
  // от «сервер не отдал».
  const anonView = await fetch(`${CORE_URL}/v1/catalog/${project.id}`, {
    signal: AbortSignal.timeout(20_000),
  }).then((r) => r.json());
  const investorView = await investor.client.json(`/v1/projects/${project.id}/investor-view`);
  check('аноним получает публичную проекцию', anonView?.id === project.id);
  check(
    'инвестору без разрешения открыто то же, что всем (допуска по роли нет)',
    investorView.access?.profile === 'public' && investorView.access?.materials === null,
    JSON.stringify(investorView.access),
  );
  check(
    'в проекциях нет раунда, ответов и оценки',
    !('round' in investorView) &&
      !('sections' in investorView) &&
      !('passport' in investorView) &&
      !('raising' in anonView),
  );

  // ------------------------------------------------------------- аноним
  console.warn('\n[1] Аноним — витрина');
  const anon = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const anonPage = await anon.newPage();
  watch(anonPage, 'аноним');
  await anonPage.goto(`${PUBLIC_URL.replace(/\/$/, '')}/p/${project.id}`, {
    waitUntil: 'networkidle',
    timeout: 30_000,
  });
  await anonPage.waitForSelector(`[data-project-page="${project.id}"]`, { timeout: 20_000 });
  check('страница проекта открылась без входа', true);
  check(
    'название проекта показано',
    (await anonPage.locator('h1').innerText()).includes(project.title.slice(0, 12)),
    await anonPage.locator('h1').innerText(),
  );
  check(
    'витрина показывает общую карточку проекта',
    (await anonPage.locator('[data-project-card="public"]').count()) === 1,
  );
  const anonBody = await anonPage.locator('[data-project-card]').innerText();
  check(
    'анониму не показаны блоки инвесторской проекции',
    !anonBody.includes('Материалы') && !anonBody.includes('О проекте'),
    'описание и материалы отсутствуют',
  );
  check(
    'на публичной странице нет сессии',
    (await anon.cookies()).every((c) => c.name !== SESSION_COOKIE),
  );
  await anonPage.screenshot({ path: join(OUT, '01-anon.png'), fullPage: true });

  // Ссылка из каталога ведёт на ту же страницу.
  await anonPage.goto(PUBLIC_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  const link = anonPage.locator(`[data-teaser-link]`).first();
  check('в каталоге есть ссылка на страницу проекта', (await link.count()) > 0);

  // ---------------------------------------------------------- владелец
  console.warn('\n[2] Владелец — предпросмотр в кабинете');
  const ownerCtx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const ownerPage = await ownerCtx.newPage();
  watch(ownerPage, 'владелец');
  await ownerPage.goto(LAB_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await ownerPage.fill('#email', founder.email);
  await ownerPage.fill('#password', founder.password);
  await ownerPage.getByRole('button', { name: /Войти/i }).click();
  await ownerPage.waitForSelector('text=Проекты', { timeout: 20_000 });
  await ownerPage.goto(`${LAB_URL.replace(/\/$/, '')}/projects/${project.id}`, {
    waitUntil: 'networkidle',
    timeout: 30_000,
  });
  await ownerPage.waitForSelector('[data-visibility-audience="investors"]', { timeout: 20_000 });
  await ownerPage.locator('[data-visibility-audience="investors"]').click();
  await ownerPage.waitForTimeout(2000);
  const previewCard = ownerPage.locator('[data-project-card="preview"]');
  check(
    'предпросмотр владельца показывает ту же общую карточку',
    (await previewCard.count()) === 1,
  );
  const investorPreview = (await previewCard.count()) > 0 ? await previewCard.innerText() : '';
  check(
    'в предпросмотре видно название проекта',
    investorPreview.includes(project.title.slice(0, 12)),
    project.title.slice(0, 20),
  );
  // Допуска по роли нет: «как видит инвестор» совпадает с «как видит аноним»
  // по составу блоков. Решает предикат на сервере, не карточка.
  await ownerPage.locator('[data-visibility-audience="public"]').click();
  await ownerPage.waitForTimeout(2000);
  const publicPreview = (await previewCard.count()) > 0 ? await previewCard.innerText() : '';
  check(
    'аудитории «инвестор» и «аноним» видят одинаковый состав',
    investorPreview.includes('Материалы закрыты') === publicPreview.includes('Материалы закрыты'),
  );
  check(
    'в предпросмотре нет читалки документов',
    (await ownerPage
      .locator('[data-project-card="preview"]')
      .getByRole('button', { name: 'Смотреть' })
      .count()) === 0,
  );
  await ownerPage.screenshot({ path: join(OUT, '02-owner.png'), fullPage: true });

  // ------------------------------------------- закрытый проект и аноним
  console.warn('\n[3] Закрытый проект анониму не показывается');
  await founder.client.json(`/v1/projects/${project.id}/visibility`, {
    method: 'PUT',
    body: { visibility: 'private' },
  });
  await anonPage.goto(`${PUBLIC_URL.replace(/\/$/, '')}/p/${project.id}`, {
    waitUntil: 'networkidle',
    timeout: 30_000,
  });
  const closed = await anonPage.locator('[role="alert"]').count();
  check(
    'страница закрытого проекта показывает объяснение, а не пустоту',
    closed === 1,
    `блоков объяснения: ${closed}`,
  );
  await anonPage.screenshot({ path: join(OUT, '03-anon-closed.png'), fullPage: true });

  check(
    'ошибок в консоли нет',
    consoleErrors.length === 0,
    consoleErrors.join(' | ').slice(0, 200),
  );
} finally {
  await browser.close();
  await pool.end();
}

console.warn(`\n  Снимки: ${OUT}`);
console.warn(`  Итог: ${passed} OK, ${failed} FAIL\n`);
await run.finish(failed === 0);
process.exit(failed === 0 ? 0 : 1);
