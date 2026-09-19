#!/usr/bin/env node
/**
 * Рендер-проверка страницы проекта для ТРЁХ зрителей (этап 7.3).
 *
 * Один проект, один серверный предикат аудитории — и три поверхности, каждая
 * из которых уже существует:
 *
 *   • аноним        — витрина, `/p/<id>`, проекция Public View;
 *   • инвестор      — кабинет инвестора, проекция Investor View;
 *   • владелец      — кабинет основателя, предпросмотр своей заявки.
 *
 * Проверяется не «страница нарисовалась», а два свойства сразу:
 *
 *   1. зрители видят РАЗНОЕ, и разницу определяет сервер, а не клиент;
 *   2. показывает это разное ОДИН компонент (7.3) — витрина, кабинет
 *      инвестора и предпросмотр владельца перестали быть тремя разметками
 *      на одних данных.
 *
 * Витрина никаких правил видимости не повторяет — она показывает то, что ей
 * отдали, и честно называет число скрытых ответов.
 *
 * Требуется поднятое: ядро, витрина (5173), кабинет инвестора (5176),
 * кабинет основателя (5175), приложение входа (5179).
 *
 * Снимки — `out/render-project-page/`.
 */
import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL as DEFAULT_CORE_URL, frontendUrl } from './lib/ports.mjs';
import {
  CONSENTS,
  blindIndex,
  createProjectWithDraftRound,
  loadDotEnv,
  makePool,
} from './lib/round-pricing-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

/**
 * Адреса приводятся к `localhost`: у сырого IP нет регистрируемого домена, и
 * браузер не может установить «тот же сайт» — изображение проекта на странице
 * блокируется политикой встраивания. Свойство адресации стенда, не продукта.
 */
const toSite = (url) => url.replace('127.0.0.1', 'localhost');

const PUBLIC_URL = toSite(process.env.WEB_PUBLIC_URL ?? frontendUrl('webPublic'));
const INVESTOR_URL = toSite(process.env.INVESTOR_URL ?? frontendUrl('investor'));
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

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: СТРАНИЦА ПРОЕКТА ДЛЯ ТРЁХ ЗРИТЕЛЕЙ (7.3) ===\n');

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
  const { project } = await createProjectWithDraftRound(founder.client, sql, suffix);
  // Публичный режим: аноним видит публичную аудиторию ответов, вошедший
  // инвестор — свою. Решает предикат в базе, не клиент.
  await founder.client.json(`/v1/projects/${project.id}/visibility`, {
    method: 'PUT',
    body: { visibility: 'public' },
  });
  // Публикация листинга: без неё проект не появляется в каталоге инвестора.
  // Это отдельное действие владельца, а не следствие режима видимости.
  await founder.client.json(`/v1/projects/${project.id}/listing`, { method: 'POST' });

  // Серверные проекции: три ответа одного предиката. Сравниваются до
  // браузера — чтобы отличить «страница не нарисовала» от «сервер не отдал».
  const anonView = await fetch(`${CORE_URL}/v1/catalog/${project.id}`, {
    signal: AbortSignal.timeout(20_000),
  }).then((r) => r.json());
  const investorView = await investor.client.json(`/v1/projects/${project.id}/investor-view`);
  check(
    'аноним получает публичную проекцию',
    anonView?.id === project.id,
    `скрыто ${anonView?.withheld}`,
  );
  check(
    'инвестору сервер отдаёт не меньше, чем анониму',
    investorView.withheld <= anonView.withheld,
    `инвестор ${investorView.withheld} против ${anonView.withheld}`,
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
    'состояние привлечения названо',
    (await anonPage.locator('[data-project-raising]').count()) === 1,
  );
  const withheld = await anonPage.locator('[data-project-withheld]').innerText();
  check('скрытые ответы названы числом, а не спрятаны', withheld.length > 0, withheld.slice(0, 80));
  check(
    'витрина показывает общую карточку проекта',
    (await anonPage.locator('[data-project-card="public"]').count()) === 1,
  );
  // Блоки инвесторской проекции анониму не приходят с сервера — и потому их
  // нет на странице. Проверяем именно отсутствие, а не «скрытость».
  const anonBody = await anonPage.locator('[data-project-card]').innerText();
  check(
    'анониму не показаны блоки инвесторской проекции',
    !anonBody.includes('Оценка платформы') &&
      !anonBody.includes('Материалы') &&
      !anonBody.includes('О проекте'),
    'описание, оценка и материалы отсутствуют',
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

  // ---------------------------------------------------------- инвестор
  console.warn('\n[2] Инвестор — кабинет');
  const investorCtx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const investorPage = await investorCtx.newPage();
  watch(investorPage, 'инвестор');
  await investorPage.goto(INVESTOR_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await investorPage.fill('#email', investor.email);
  await investorPage.fill('#password', investor.password);
  await investorPage.getByRole('button', { name: /Войти/i }).click();
  await investorPage.waitForSelector('text=Каталог', { timeout: 20_000 });
  await investorPage.getByRole('button', { name: 'Подробнее' }).first().click();
  await investorPage.waitForSelector('[data-investor-view]', { timeout: 20_000 });
  const investorText = await investorPage.locator('[data-investor-view]').innerText();
  check('инвестору открылась карточка проекта', investorText.length > 0);
  check(
    'кабинет инвестора показывает ту же общую карточку',
    (await investorPage.locator('[data-project-card="investor"]').count()) === 1,
  );
  check(
    'инвестору показаны блоки его проекции',
    investorText.includes('Оценка платформы') &&
      investorText.includes('Материалы') &&
      investorText.includes('О проекте'),
    'описание, оценка и материалы на месте',
  );
  check(
    'состав ответов у инвестора не беднее, чем у анонима',
    (await investorPage.locator('[data-project-answer]').count()) >=
      (await anonPage.locator('[data-project-answer]').count()),
  );
  await investorPage.screenshot({ path: join(OUT, '02-investor.png'), fullPage: true });

  // ---------------------------------------------------------- владелец
  console.warn('\n[3] Владелец — предпросмотр в кабинете');
  const ownerCtx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const ownerPage = await ownerCtx.newPage();
  watch(ownerPage, 'владелец');
  await ownerPage.goto(LAB_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await ownerPage.fill('#email', founder.email);
  await ownerPage.fill('#password', founder.password);
  await ownerPage.getByRole('button', { name: /Войти/i }).click();
  await ownerPage.waitForSelector('text=Проекты', { timeout: 20_000 });
  const ownerPreview = await founder.client.json(`/v1/projects/${project.id}/view-preview`);
  check(
    'владельцу сервер отдаёт предпросмотр своей заявки',
    ownerPreview !== null && typeof ownerPreview === 'object',
  );

  // Главное в 7.3: предпросмотр показывает КАРТОЧКУ, а не строку «показано N,
  // скрыто M». Раньше проверить глазами, что увидит инвестор, было нечем.
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
  const previewText = (await previewCard.count()) > 0 ? await previewCard.innerText() : '';
  check(
    'в предпросмотре видно название проекта',
    previewText.includes(project.title.slice(0, 12)),
    project.title.slice(0, 20),
  );
  const investorAnswers = await ownerPage.locator('[data-project-answer]').count();

  // Переключение аудитории меняет состав — потому что сервер отдаёт другую
  // проекцию, а не потому что карточка что-то прячет.
  await ownerPage.locator('[data-visibility-audience="public"]').click();
  await ownerPage.waitForTimeout(2000);
  const publicAnswers = await ownerPage.locator('[data-project-answer]').count();
  check(
    'смена аудитории в предпросмотре меняет состав карточки',
    publicAnswers <= investorAnswers,
    `инвестору ${investorAnswers} ответов, анониму ${publicAnswers}`,
  );
  // Предпросмотр отвечает на вопрос «что увидит аудитория», а не заменяет
  // владельцу его список материалов: читалка документов здесь не открывается.
  check(
    'в предпросмотре нет читалки документов',
    (await ownerPage
      .locator('[data-project-card="preview"]')
      .getByRole('button', { name: 'Смотреть' })
      .count()) === 0,
  );
  await ownerPage.screenshot({ path: join(OUT, '03-owner.png'), fullPage: true });

  // ------------------------------------------- закрытый проект и аноним
  console.warn('\n[4] Закрытый проект анониму не показывается');
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
  await anonPage.screenshot({ path: join(OUT, '04-anon-closed.png'), fullPage: true });

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
process.exit(failed === 0 ? 0 : 1);
