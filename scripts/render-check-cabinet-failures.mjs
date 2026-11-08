#!/usr/bin/env node
/**
 * Поведение кабинета основателя при сбоях (блок 2, 2.2/2.3; пакет 6 раздела 01).
 *
 *   FIFTH_ENTRY=web node scripts/render-check-cabinet-failures.mjs
 *
 * Стенд под единой точкой входа (http://127.0.0.1/). Ядро проба на время сценария [4]
 * останавливает и затем поднимает `stand:up --no-build --restart-core`.
 *
 *   1. уход с изменениями: несохранённые поля — диалог при переходе внутри кабинета и запрос
 *      браузера при перезагрузке; защищённая отправка с неизвестным исходом — перехода не
 *      держит (ключ в памяти), перезагрузку — держит; обычный запрос без защищённой отправки
 *      в полёте — держит переход; без изменений — тихо;
 *   2. истечение сессии: вход тем же пользователем — возврат на страницу, исход операции
 *      по ключу, без новой отправки;
 *   3. вход другим пользователем: возврата нет, чужая операция не показана и не отправлена;
 *   4. отказ API: прокси отвечает problem+json, кабинет открывается, общее предупреждение;
 *      изменение с таким ответом — «результат неизвестен», ключ сохранён, новой отправки нет;
 *   5. восстановление: «Работа восстановлена» — один раз, после свежей проверки готовности.
 */
/* global document, window */
import { chromium } from 'playwright';
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { portOwner, stopTree } from './lib/stand-processes.mjs';

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
const CORE_PORT = Number(process.env.CORE_PORT ?? 4300);

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else failed += 1;
  console.warn(`  ${condition ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;
const stamp = Date.now() % 1e9;
const restartCore = () =>
  spawnSync('npm', ['run', '-s', 'stand:up', '--', '--no-build', '--restart-core'], {
    cwd: ROOT,
    stdio: 'ignore',
    shell: true,
  });

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

// Отправки создания проекта: что делать с очередной и что дошло до сервера.
let plan = [];
const posts = [];
await page.route('**/v1/projects', async (route) => {
  if (route.request().method() !== 'POST') return route.continue();
  const step = plan.shift() ?? 'pass';
  const key = route.request().headers()['idempotency-key'];
  if (step === 'drop') {
    // До сервера дошло, ответ потерян — исход неизвестен.
    const response = await route.fetch();
    posts.push({ key, step, status: response.status() });
    return route.abort('connectionreset');
  }
  posts.push({ key, step });
  return route.continue();
});
// Обычный запрос без защищённой отправки (выдача доступа): держим, пока проверка не отпустит.
let holdGrant = null;
await page.route('**/v1/projects/*/access/grants', async (route) => {
  if (route.request().method() !== 'POST' || !holdGrant) return route.continue();
  await holdGrant;
  return route.continue();
});

async function register(label) {
  const email = `rk-fail-${label}-${stamp}@test.local`;
  const password = `Pw-${stamp}-${Math.random().toString(36).slice(2)}`;
  await page.goto(`${SITE}/login/`);
  const status = await page.evaluate(
    async ([address, secret, name]) => {
      const r = await fetch('/v1/auth/register', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: address,
          password: secret,
          displayName: name,
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
    },
    [email, password, `RK сбой ${label}`],
  );
  return { email, password, status };
}
async function login(user) {
  await page.goto(`${SITE}/login/`);
  await page.locator('#email').fill(user.email);
  await page.locator('#password').fill(user.password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
}
const csrf = () =>
  page.evaluate(() => /(?:^|;\s*)ul_csrf=([^;]+)/.exec(document.cookie)?.[1] ?? '');
async function apiCreateProject(title) {
  const token = await csrf();
  return page.evaluate(
    async ([t, c]) => {
      const tax = await (await fetch('/v1/taxonomy')).json();
      const r = await fetch('/v1/projects', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': c },
        body: JSON.stringify({
          title: t,
          stage: 'mvp',
          taxonomyId: (tax.items ?? tax)[0].id,
          investmentAsk: '1000000.00',
          askCurrency: 'RUB',
        }),
      });
      return (await r.json()).id;
    },
    [title, token],
  );
}
const unloadPrevented = () =>
  page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
const dialogOpen = () =>
  page
    .locator('[data-leave-dialog]')
    .count()
    .then((n) => n > 0);
async function openNewProjectForm() {
  await page.goto(`${SITE}/lab/`);
  await page
    .getByRole('button', { name: /Новый проект/ })
    .first()
    .click({ timeout: 15_000 })
    .catch(async (error) => {
      const info = await page.evaluate(() => ({
        text: (document.querySelector('main')?.innerText ?? '').slice(0, 400),
        disabled: [...document.querySelectorAll('button')]
          .filter((b) => /Новый проект/.test(b.textContent ?? ''))
          .map((b) => b.disabled),
        dialog: Boolean(document.querySelector('[data-leave-dialog]')),
      }));
      console.warn(`  (кнопки нет: ${page.url()} ${JSON.stringify(info).replace(/\s+/g, ' ')})`);
      throw error;
    });
  await page.waitForFunction(() => document.querySelector('#taxonomyId')?.value);
}
const waitGuardedSettled = () =>
  page
    .waitForFunction(() => document.querySelector('[data-guarded]') === null, null, {
      timeout: 20_000,
    })
    .catch(() => undefined);

console.warn('\n=== КАБИНЕТ ПРИ СБОЯХ (2.2/2.3) ===\n');
const created = [];
try {
  const a = await register('a');
  check('пользователь A создан', a.status === 201, `HTTP ${a.status}`);
  const projectId = await apiCreateProject(`RK сбой ${stamp}`);
  created.push(projectId);

  console.warn('[1] Уход со страницы');
  await openNewProjectForm();
  check('без изменений: перезагрузка не держится', (await unloadPrevented()) === false);
  await page.locator('#title').fill('Несохранённый проект');
  check('несохранённые поля: перезагрузка держится (запрос браузера)', await unloadPrevented());
  await page.getByText(`RK сбой ${stamp}`).first().click();
  await page.waitForTimeout(400);
  check('несохранённые поля: переход внутри кабинета — диалог', await dialogOpen());
  await page.locator('[data-leave-stay]').click();
  check(
    '«Остаться» — форма и введённое на месте',
    (await page.locator('#title').inputValue()) === 'Несохранённый проект' &&
      !page.url().includes('/projects/'),
  );
  await page.getByText(`RK сбой ${stamp}`).first().click();
  await page.locator('[data-leave-confirm]').click();
  await page.waitForURL(/\/lab\/projects\//);
  check('«Уйти» — переход выполнен', page.url().includes(projectId));

  // Обычный запрос без защищённой отправки в полёте (выдача доступа).
  let release;
  holdGrant = new Promise((done) => (release = done));
  await page.locator('#access-email').fill(`nobody-${stamp}@test.local`);
  await page.locator('[data-access-grant]').click();
  await page.locator('#access-email').fill('');
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: '← К списку' }).click();
  await page.waitForTimeout(300);
  check('обычный запрос в полёте: переход — диалог', await dialogOpen());
  const dialogText = await page
    .locator('[data-leave-dialog]')
    .innerText()
    .catch(() => '');
  check(
    'диалог называет потерю результата запроса',
    /результат может остаться неизвестным/.test(dialogText),
  );
  await page.locator('[data-leave-stay]').click();
  release();
  holdGrant = null;
  await page.waitForTimeout(800);

  // Защищённая отправка с неизвестным исходом: переход не держит, перезагрузку — держит.
  await openNewProjectForm();
  plan = ['drop'];
  await page.locator('#title').fill(`RK неизвестно ${stamp}`);
  await page.locator('#investmentAsk').fill('1000000');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await page.waitForSelector('[data-guarded="unknown"], [data-guarded="checking"]', {
    timeout: 15_000,
  });
  check('защищённая отправка: перезагрузка держится', await unloadPrevented());
  await page.getByText(`RK сбой ${stamp}`).first().click();
  await page.waitForTimeout(400);
  check(
    'защищённая отправка: переход без диалога (ключ в памяти страницы)',
    !(await dialogOpen()) && page.url().includes('/projects/'),
  );

  console.warn('[2] Истечение сессии — вход тем же пользователем');
  const postsBefore = posts.length;
  const returnPath = new URL(page.url()).pathname;
  await context.clearCookies({ name: 'ul_session' });
  await page.reload();
  await page.waitForURL(/\/login\//, { timeout: 15_000 });
  const mark = await page.evaluate(() => sessionStorage.getItem('fifth.return'));
  check('метка возврата записана', Boolean(mark) && mark.includes(returnPath));
  await login(a);
  await page
    .waitForURL((url) => url.pathname === returnPath, { timeout: 15_000 })
    .catch(() => undefined);
  check('возврат на ту же страницу', new URL(page.url()).pathname === returnPath, page.url());
  await page.goto(`${SITE}/lab/`);
  // Исход по ключу — «выполнено»: кабинет открывает созданный проект (как в 2.6).
  const [first] = await sql(`SELECT id FROM lab.projects WHERE title = $1`, [
    `RK неизвестно ${stamp}`,
  ]);
  await page
    .waitForURL((url) => Boolean(first) && url.pathname.includes(first.id), { timeout: 20_000 })
    .catch(() => undefined);
  await waitGuardedSettled();
  check(
    'исход по ключу — открыт созданный проект',
    Boolean(first) && page.url().includes(first.id),
    page.url(),
  );
  check(
    'после входа новой отправки нет',
    posts.length === postsBefore,
    `отправок ${posts.length - postsBefore}`,
  );
  const [made] = await sql(`SELECT count(*)::int AS n FROM lab.projects WHERE title = $1`, [
    `RK неизвестно ${stamp}`,
  ]);
  check('исход выяснен по ключу: проект один, повтора не было', made.n === 1, `проектов ${made.n}`);
  const ids = await sql(`SELECT id FROM lab.projects WHERE title = $1`, [`RK неизвестно ${stamp}`]);
  created.push(...ids.map((r) => r.id));

  console.warn('[3] Вход другим пользователем');
  await openNewProjectForm();
  plan = ['drop'];
  await page.locator('#title').fill(`RK чужое ${stamp}`);
  await page.locator('#investmentAsk').fill('1000000');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await page.waitForSelector('[data-guarded="unknown"], [data-guarded="checking"]', {
    timeout: 15_000,
  });
  await page.getByText(`RK сбой ${stamp}`).first().click();
  await page.waitForURL(/\/lab\/projects\//);
  const aPath = new URL(page.url()).pathname;
  const postsBeforeB = posts.length;
  await context.clearCookies({ name: 'ul_session' });
  await page.reload();
  await page.waitForURL(/\/login\//, { timeout: 15_000 });
  const b = await register('b');
  await page.goto(`${SITE}/login/`);
  await page.waitForURL(/\/lab\//, { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
  check(
    'другой пользователь: возврата на страницу A нет',
    new URL(page.url()).pathname !== aPath,
    page.url(),
  );
  check(
    'метка возврата снята',
    (await page.evaluate(() => sessionStorage.getItem('fifth.return'))) === null,
  );
  check('чужая операция не показана', (await page.locator('[data-guarded]').count()) === 0);
  check('чужая операция не отправлена', posts.length === postsBeforeB && b.status === 201);
  const foreign = await sql(`SELECT id FROM lab.projects WHERE title = $1`, [`RK чужое ${stamp}`]);
  created.push(...foreign.map((r) => r.id));

  console.warn('[4] Отказ API');
  await context.clearCookies({ name: 'ul_session' });
  await login(a);
  await page.waitForURL(/\/lab\//, { timeout: 15_000 });
  // У A осталась операция из [3]: после входа она выясняется по ключу, и кабинет открывает
  // созданный проект (как в 2.6). Дождаться этого перехода, иначе он сорвёт следующий шаг.
  const foreignId = foreign[0]?.id;
  await page
    .waitForURL((url) => Boolean(foreignId) && url.pathname.includes(foreignId), {
      timeout: 20_000,
    })
    .catch(() => undefined);
  await waitGuardedSettled();
  check(
    'операция A из [3] выяснена после его входа — открыт созданный проект',
    Boolean(foreignId) &&
      page.url().includes(foreignId) &&
      (await page.locator('[data-guarded]').count()) === 0,
    page.url(),
  );
  await openNewProjectForm();
  const pid = portOwner(CORE_PORT);
  if (pid) stopTree(pid);
  await sleep(1500);
  const probe = await page.evaluate(async () => {
    const r = await fetch('/v1/projects');
    return {
      status: r.status,
      type: r.headers.get('content-type'),
      body: await r.json().catch(() => null),
    };
  });
  check(
    'API без ядра — problem+json с прежним кодом',
    probe.status === 502 &&
      /problem\+json/.test(probe.type ?? '') &&
      probe.body?.code === 'dependency_unavailable',
    JSON.stringify(probe),
  );
  const postsBeforeDown = posts.length;
  await page.locator('#title').fill(`RK без ядра ${stamp}`);
  await page.locator('#investmentAsk').fill('1000000');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await page.waitForSelector(
    '[data-guarded="unknown"], [data-guarded="checking"], [data-guarded="unavailable"]',
    { timeout: 20_000 },
  );
  const phaseNow = await page.locator('[data-guarded]').first().getAttribute('data-guarded');
  check(
    'изменение с problem+json 502 — результат неизвестен, не отказ',
    ['unknown', 'checking', 'unavailable'].includes(phaseNow ?? ''),
    phaseNow,
  );
  await page.waitForTimeout(3000);
  const downPosts = posts.slice(postsBeforeDown);
  check(
    'ключ сохранён, новой отправки с другим ключом нет',
    downPosts.length >= 1 && downPosts.every((p) => p.key === downPosts[0].key),
    `отправок ${downPosts.length}`,
  );
  await page
    .waitForSelector('[data-service-notice="down"]', { timeout: 15_000 })
    .catch(() => undefined);
  check(
    'общее предупреждение показано',
    (await page.locator('[data-service-notice="down"]').count()) === 1,
  );
  await page.goto(`${SITE}/lab/`);
  await page.waitForTimeout(2500);
  check(
    'прямое открытие кабинета без ядра — страница открывается',
    (await page.locator('#content, main').count()) > 0,
  );

  console.warn('[5] Восстановление');
  await page
    .waitForSelector('[data-service-notice="down"]', { timeout: 15_000 })
    .catch(() => undefined);
  const shownDown = (await page.locator('[data-service-notice="down"]').count()) === 1;
  restartCore();
  await page
    .waitForSelector('[data-service-notice="restored"]', { timeout: 40_000 })
    .catch(() => undefined);
  check(
    'после свежей проверки готовности — «Работа восстановлена»',
    shownDown && (await page.locator('[data-service-notice="restored"]').count()) === 1,
  );
  await page.waitForTimeout(10_000);
  check(
    'сообщение — один раз, затем исчезает',
    (await page.locator('[data-service-notice]').count()) === 0,
  );
  const leftover = await sql(`SELECT id FROM lab.projects WHERE title = $1`, [
    `RK без ядра ${stamp}`,
  ]);
  created.push(...leftover.map((r) => r.id));
  check('ошибок страницы нет', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200));
} finally {
  if (!portOwner(CORE_PORT)) restartCore();
  for (const id of created.filter(Boolean)) {
    await sql('DELETE FROM lab.founders_projects WHERE project_id = $1', [id]).catch(
      () => undefined,
    );
    await sql('DELETE FROM lab.projects WHERE id = $1', [id]).catch(() => undefined);
  }
  await browser.close();
  await pool.end();
}
console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exit(failed > 0 ? 1 : 0);
