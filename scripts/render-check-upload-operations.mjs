#!/usr/bin/env node
/**
 * Рендер-проверка длительных операций в кабинете основателя (2.1-W04;
 * блок 1 1.5).
 *
 * Что проверяется в настоящем браузере:
 *   1. окончательная ошибка загрузки показывается всплывающим сообщением;
 *      пока вкладка скрыта, показ НЕ отмечается; на видимой вкладке —
 *      отмечается на сервере; после этого сообщение не возвращается ни при
 *      обновлении страницы, ни на другом «устройстве» (отдельный браузерный
 *      контекст); причина остаётся в карточке материалов;
 *   2. опрос идущей загрузки: первую минуту — раз в 5 секунд, дальше — раз в
 *      30; в скрытой вкладке стоит; общая проверка — не чаще раза в минуту;
 *   3. «Отменить загрузку»: строка уходит, опрос прекращается;
 *   4. «Требует вмешательства» — честный текст, без всплывающего сообщения.
 *
 * Время для интервалов — подставные часы браузера (Playwright clock):
 * минуты наблюдения проходят за секунды, а порядок таймеров тот же.
 * Скрытая вкладка — подмена `document.visibilityState` до загрузки страницы.
 *
 * Требуется поднятое: ядро, MinIO, кабинет основателя, приложение входа.
 * Снимки — `out/render-upload-operations/`.
 */
/* global window, document, Document, innerHeight -- код в page.evaluate и addInitScript выполняется в браузере */
import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL as DEFAULT_CORE_URL, frontendUrl } from './lib/ports.mjs';
import { startProbeRun } from './lib/probe-run.mjs';
import { CONSENTS, createProject, loadDotEnv, makePool } from './lib/project-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const run = await startProbeRun('RND-UPLOAD-OPERATIONS');

const toSite = (url) => url.replace('127.0.0.1', 'localhost');
const LAB_URL = toSite(process.env.LAB_URL ?? frontendUrl('lab')).replace(/\/$/, '');
const CORE_URL = toSite(process.env.CORE_URL ?? DEFAULT_CORE_URL);
const OUT = join(ROOT, 'out', 'render-upload-operations');
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
const pool = makePool('unicorn-render-upload-operations');
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

function makeClient() {
  const state = { session: null, csrf: null };
  async function call(path, { method = 'GET', body } = {}) {
    const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
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
    const json = await response.json().catch(() => null);
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(';')[0];
      if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
      if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
    }
    if (response.status >= 400) throw new Error(`${method} ${path}: ${response.status}`);
    return json;
  }
  return { json: call, cookie: () => [state.session, state.csrf].filter(Boolean).join('; ') };
}

const suffix = `${Date.now() % 1e9}`;
const email = `uo-${suffix}@test.local`;
const password = `Pw-${crypto.randomUUID()}`;
const founder = makeClient();
await founder.json('/v1/auth/register', {
  method: 'POST',
  body: {
    email,
    password,
    displayName: 'Проверка операций',
    role: 'founder',
    locale: 'ru-RU',
    consents: CONSENTS,
  },
});

async function ticket(projectId, bytes, name) {
  return founder.json(`/v1/projects/${projectId}/materials/upload`, {
    method: 'POST',
    body: { type: 'deck', fileName: name, contentType: 'application/pdf', sizeBytes: bytes.length },
  });
}
async function sendForm(t, bytes) {
  const form = new FormData();
  for (const [key, value] of Object.entries(t.formFields)) form.append(key, value);
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'deck.pdf');
  await fetch(t.uploadUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(20_000) });
}

const consoleErrors = [];
function watch(page, who) {
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // 429 — ожидание сброса лимита адреса в длинном прогоне (calm), не дефект.
    if (/\b(400|401|403|404|409|429|503) \(/.test(message.text())) return;
    consoleErrors.push(`${who}: ${message.text()}`);
  });
  page.on('pageerror', (error) => consoleErrors.push(`${who}: ${String(error)}`));
}

/**
 * Видимость вкладки управляется из прогона: начальное значение — из
 * sessionStorage (переживает перезагрузку), смена — `__setVisibility`, с
 * настоящим событием `visibilitychange`.
 */
const VISIBILITY_SHIM = () => {
  let state = sessionStorage.getItem('__visibility') ?? 'visible';
  Object.defineProperty(Document.prototype, 'visibilityState', { get: () => state });
  Object.defineProperty(Document.prototype, 'hidden', { get: () => state !== 'visible' });
  window.__setVisibility = (next) => {
    state = next;
    // В хранилище вкладки — только «видима / скрыта» для проверки, не токен.
    // nosemgrep: unicorn-no-token-in-web-storage
    sessionStorage.setItem('__visibility', next);
    document.dispatchEvent(new Event('visibilitychange'));
  };
};

/**
 * Дождаться, пока ограничитель частоты снова пустит. Прогон длинный, а опрос
 * на подставных часах делает много запросов за секунды реального времени —
 * следующая часть иначе упирается в 429, и это неотличимо от дефекта.
 */
async function calm(page) {
  for (let i = 0; i < 20; i += 1) {
    const status = await page.evaluate(() => fetch('/v1/auth/me').then((r) => r.status));
    if (status !== 429) return;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

/**
 * Вход настоящей формой. `hidden` — вкладка скрыта уже на форме входа: после
 * входа кабинет открывается сразу, и видимая вкладка успела бы отметить показ
 * раньше, чем прогон его проверит.
 */
async function login(context, who, { hidden = false } = {}) {
  const page = await context.newPage();
  watch(page, who);
  await page.goto(`${LAB_URL}/`, { waitUntil: 'networkidle', timeout: 30_000 });
  // Поздние части прогона входят, когда лимит адреса уже выбран опросом.
  await calm(page);
  if (hidden) await page.evaluate(() => window.__setVisibility('hidden'));
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.getByRole('button', { name: /Войти/i }).click();
  await page.waitForSelector('text=Проекты', { timeout: 20_000 });
  return page;
}

const noticeRows = async (materialId) =>
  (
    await sql('SELECT count(*)::int AS n FROM comms.operation_notices WHERE operation_id = $1', [
      materialId,
    ])
  )[0].n;

const browser = await chromium.launch();
let projectId = null;
try {
  const { project } = await createProject(founder, sql, suffix);
  projectId = project.id;
  const projectUrl = `${LAB_URL}/projects/${projectId}`;

  // Не принятая загрузка: содержимое — не PDF.
  const html = Buffer.from('<html>не презентация</html>', 'utf8');
  const rejected = await ticket(projectId, html, 'Не-презентация.pdf');
  await sendForm(rejected, html);
  const fin = await founder.json(
    `/v1/projects/${projectId}/materials/${rejected.materialId}/finalize`,
    { method: 'POST' },
  );
  check('подготовка: загрузка не принята', fin.uploadState === 'rejected', fin.uploadState);

  // ------------------------------------------------ 1. сообщение и отметка
  console.warn('\n[1] Всплывающее сообщение и отметка показа');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(VISIBILITY_SHIM);
  const first = await login(ctx, 'устройство 1', { hidden: true });

  // Скрытая вкладка: кабинет загружается, сообщение рисуется, но показ не
  // подтверждается.
  const noticeCalls = [];
  const opsSeen = [];
  first.on('response', async (r) => {
    if (r.url().endsWith('/me/operations')) {
      opsSeen.push(`${r.status()} ${(await r.text().catch(() => '')).slice(0, 300)}`);
    }
  });
  first.on('request', (r) => {
    if (r.url().includes('/notice')) noticeCalls.push(r.url());
  });
  await first.goto(projectUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  const toast = first.locator(`[data-toast="${rejected.materialId}"]`);
  await toast.waitFor({ timeout: 15_000 }).catch(async (error) => {
    await first.screenshot({ path: join(OUT, '0-no-toast.png'), fullPage: true });
    console.warn('  проверка операций ответила:', opsSeen.join(' | ') || 'запросов не было');
    throw error;
  });
  check('сообщение нарисовано', (await toast.count()) === 1);
  const toastText = (await toast.innerText()).replace(/\s+/g, ' ');
  check(
    'в сообщении — имя файла, проект и причина',
    toastText.includes('Не-презентация.pdf') && toastText.includes(project.title),
    toastText.slice(0, 160),
  );
  await first.waitForTimeout(1500);
  check(
    'скрытая вкладка показ не подтверждает',
    noticeCalls.length === 0 && (await noticeRows(rejected.materialId)) === 0,
  );

  await first.evaluate(() => window.__setVisibility('visible'));
  await first.waitForResponse((r) => r.url().includes('/notice'), { timeout: 10_000 });
  check(
    'на видимой вкладке показ отмечен на сервере',
    (await noticeRows(rejected.materialId)) === 1,
  );
  check('сообщение само не исчезает', (await toast.count()) === 1);
  await first.screenshot({ path: join(OUT, '1-toast.png') });
  await toast.locator('[data-toast-open]').click();
  await first.waitForTimeout(800);
  check('«К материалам» закрывает сообщение', (await toast.count()) === 0);
  check(
    'и показывает карточку материалов',
    await first.locator('#materials').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top < window.innerHeight && r.bottom > 0;
    }),
  );

  await first.reload({ waitUntil: 'networkidle' });
  await first.waitForSelector(`[data-upload-row="${rejected.materialId}"]`, { timeout: 15_000 });
  check('после обновления сообщения нет', (await first.locator('[data-toast]').count()) === 0);
  const row = first.locator(`[data-upload-row="${rejected.materialId}"]`);
  check(
    'причина остаётся в карточке материалов',
    (await row.getAttribute('data-upload-state')) === 'rejected' &&
      (await row.locator('[data-upload-text]').innerText()).length > 10,
  );

  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const second = await login(ctx2, 'устройство 2');
  await second.goto(projectUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  await second.waitForSelector(`[data-upload-row="${rejected.materialId}"]`, { timeout: 15_000 });
  check(
    'на другом устройстве сообщение не повторяется',
    (await second.locator('[data-toast]').count()) === 0,
  );
  await second.screenshot({ path: join(OUT, '2-other-device.png'), fullPage: true });
  await ctx2.close();

  // ------------------------------------------------ 2. интервалы опроса
  console.warn('\n[2] Опрос идущей загрузки и общая проверка');
  const pending = await ticket(projectId, Buffer.from('%PDF-1.4 ждёт'), 'Ждёт.pdf');
  const page = await ctx.newPage();
  watch(page, 'опрос');
  await page.clock.install();
  const polls = [];
  const checks = [];
  page.on('request', (r) => {
    const url = r.url();
    if (url.includes('/material-uploads')) polls.push(url);
    if (url.endsWith('/me/operations')) checks.push(url);
  });
  await page.goto(projectUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForSelector(`[data-upload-cancel="${pending.materialId}"]`, { timeout: 15_000 });

  /** Прокрутить подставное время и дать ответам дойти; вернуть число опросов за отрезок. */
  async function advance(ms) {
    const before = polls.length;
    for (let t = 0; t < ms; t += 1000) {
      await page.clock.runFor(1000);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(300);
    return polls.length - before;
  }

  const fast = await advance(60_000);
  check('первая минута — раз в 5 секунд', fast >= 10 && fast <= 12, `${fast} опросов за 60 с`);
  const slow = await advance(60_000);
  check('дальше — раз в 30 секунд', slow >= 1 && slow <= 2, `${slow} опросов за 60 с`);

  const checksBefore = checks.length;
  await page.evaluate(() => window.__setVisibility('hidden'));
  const hidden = await advance(90_000);
  check('в скрытой вкладке опрос стоит', hidden === 0, `${hidden} опросов за 90 с`);
  const beforeReturn = polls.length;
  await page.evaluate(() => window.__setVisibility('visible'));
  await page.waitForTimeout(500);
  check(
    'по возвращению — сразу опрос',
    polls.length === beforeReturn + 1,
    `${polls.length - beforeReturn}`,
  );
  check(
    'общая проверка при возвращении (прошло больше минуты)',
    checks.length === checksBefore + 1,
    `${checks.length - checksBefore}`,
  );
  await page.evaluate(() => window.__setVisibility('hidden'));
  await page.evaluate(() => window.__setVisibility('visible'));
  await page.waitForTimeout(500);
  check(
    'повторное возвращение в ту же минуту проверку не зовёт',
    checks.length === checksBefore + 1,
  );

  // ------------------------------------------------ 3. отмена
  console.warn('\n[3] Отмена загрузки');
  await calm(page);
  await page.locator(`[data-upload-cancel="${pending.materialId}"]`).click();
  await page.waitForSelector(`[data-upload-row="${pending.materialId}"]`, {
    state: 'detached',
    timeout: 15_000,
  });
  const [{ upload_state: stateAfter }] = await sql(
    'SELECT upload_state FROM lab.project_materials WHERE id = $1',
    [pending.materialId],
  );
  check('строка ушла, в базе — «отменено»', stateAfter === 'cancelled');
  const notice = await page.locator('[data-upload-notice]').innerText();
  check('сообщение об отмене', /отменена/i.test(notice), notice);
  const after = await advance(60_000);
  check('опрос прекращён — идущих загрузок нет', after === 0, `${after} опросов за 60 с`);

  // ------------------------------------------------ 4. требует вмешательства
  console.warn('\n[4] «Требует вмешательства»');
  const stuck = await ticket(projectId, Buffer.from('%PDF-1.4 застрял'), 'Застрял.pdf');
  await sql(
    `UPDATE lab.project_materials
        SET upload_state = 'needs_attention', upload_state_reason = 'проба',
            upload_state_changed_at = now(), next_check_at = NULL
      WHERE id = $1`,
    [stuck.materialId],
  );
  const fresh = await ctx.newPage();
  watch(fresh, 'вмешательство');
  await fresh.goto(projectUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  const stuckRow = fresh.locator(`[data-upload-row="${stuck.materialId}"]`);
  await stuckRow.waitFor({ timeout: 15_000 });
  const stuckText = await stuckRow.locator('[data-upload-text]').innerText();
  check(
    'честный текст: повторять не нужно, требуется проверка',
    stuckText.includes('Не удалось завершить сохранение') &&
      stuckText.includes('требуется проверка'),
    stuckText,
  );
  check(
    'без всплывающего сообщения',
    (await fresh.locator(`[data-toast="${stuck.materialId}"]`).count()) === 0,
  );
  check('без кнопки отмены', (await stuckRow.locator('[data-upload-cancel]').count()) === 0);
  await fresh.screenshot({ path: join(OUT, '3-materials.png'), fullPage: true });

  await ctx.close();

  // ------------------------------------------------ 5. очередь на телефоне
  // Замечание Тэнка при приёмке W04: невидимые карточки не должны
  // отмечаться показанными. Пять длинных сообщений на узком экране.
  console.warn('\n[5] Несколько длинных сообщений на телефоне');
  const old = await ticket(projectId, Buffer.from('%PDF-1.4 старая'), 'Старая-идущая.pdf');
  const longReason =
    'Содержимое файла не соответствует типу материала: проверьте, что это PDF или PPTX, ' +
    'что файл не повреждён и не защищён паролем, и загрузите его заново. '.repeat(3);
  const queued = (
    await sql(
      `INSERT INTO lab.project_materials
         (id, project_id, type, version, upload_key, upload_state, upload_state_reason,
          upload_state_changed_at, uploaded_by, created_at, upload_file_name)
       SELECT public.uuid_generate_v7(), $1::uuid, 'doc', 200 + g,
              'projects/' || $1::text || '/materials/doc/q-' || g || '/upload', 'rejected', $3,
              now() + make_interval(secs => g), m.uploaded_by,
              now() + make_interval(secs => g), 'Длинное-имя-файла-номер-' || g || '.pdf'
         FROM generate_series(1, 5) AS g,
              (SELECT uploaded_by FROM lab.project_materials WHERE id = $2) AS m
       RETURNING id`,
      [projectId, old.materialId, longReason.slice(0, 480)],
    )
  ).map((r) => r.id);
  const noticedOf = async (ids) =>
    (
      await sql(
        'SELECT operation_id FROM comms.operation_notices WHERE operation_id = ANY($1::uuid[])',
        [ids],
      )
    ).map((r) => r.operation_id);

  const phone = await browser.newContext({ viewport: { width: 390, height: 700 } });
  const mobile = await login(phone, 'телефон');
  await mobile.waitForSelector('[data-toast]', { timeout: 15_000 });
  await mobile.waitForTimeout(1500);

  /** Какие карточки реально видны: пересечение с экраном и со стопкой ≥ 75 %. */
  const seen = () =>
    mobile.evaluate(() => {
      const stack = document.querySelector('.u-toast-stack')?.getBoundingClientRect();
      return [...document.querySelectorAll('[data-toast]')].map((el) => {
        const r = el.getBoundingClientRect();
        const top = Math.max(r.top, stack?.top ?? 0, 0);
        const bottom = Math.min(r.bottom, stack?.bottom ?? innerHeight, innerHeight);
        return { id: el.getAttribute('data-toast'), ratio: Math.max(0, bottom - top) / r.height };
      });
    });
  const cards = await seen();
  check('на экране не больше трёх карточек', cards.length === 3, `${cards.length}`);
  check(
    'остальные — в очереди со счётчиком',
    (await mobile.locator('[data-toast-queued="2"]').count()) === 1,
  );
  const visibleIds = cards.filter((c) => c.ratio >= 0.75).map((c) => c.id);
  const hiddenIds = cards.filter((c) => c.ratio < 0.75).map((c) => c.id);
  await mobile.screenshot({ path: join(OUT, '4-phone-queue.png') });
  const noticed1 = await noticedOf(queued);
  check(
    'отмечены ровно видимые карточки',
    noticed1.length === visibleIds.length && visibleIds.every((id) => noticed1.includes(id)),
    `видно ${visibleIds.length}, за краем ${hiddenIds.length}, отмечено ${noticed1.length}`,
  );
  check('есть карточка за краем стопки — проверка не пустая', hiddenIds.length > 0);

  await mobile.reload({ waitUntil: 'networkidle' });
  await mobile.waitForSelector('[data-toast]', { timeout: 15_000 });
  await mobile.waitForTimeout(1000);
  const afterReload = (await seen()).map((c) => c.id);
  check(
    'после обновления неувиденные вернулись, увиденные — нет',
    hiddenIds.every((id) => afterReload.includes(id)) &&
      visibleIds.every((id) => !afterReload.includes(id)),
  );

  // Закрываем по одной: встаёт следующая и отмечается, когда её видно.
  for (let i = 0; i < 6 && (await mobile.locator('[data-toast]').count()) > 0; i += 1) {
    await mobile.locator('[data-toast] .u-toast__close').first().click();
    await mobile.waitForTimeout(700);
  }
  check('после закрытия всех очередь пуста', (await mobile.locator('[data-toast]').count()) === 0);
  check('все пять в итоге отмечены', (await noticedOf(queued)).length === 5);

  // ------------------------------------------------ 6. история и идущая
  console.warn('\n[6] Старая идущая загрузка и много новых отказов');
  await sql(
    `INSERT INTO lab.project_materials
       (id, project_id, type, version, upload_key, upload_state, upload_state_reason,
        upload_state_changed_at, uploaded_by, created_at, upload_file_name)
     SELECT public.uuid_generate_v7(), $1::uuid, 'doc', 300 + g,
            'projects/' || $1::text || '/materials/doc/h-' || g || '/upload', 'rejected', 'история',
            now() + make_interval(secs => 10 + g), m.uploaded_by,
            now() + make_interval(secs => 10 + g), 'история-' || g || '.pdf'
       FROM generate_series(1, 20) AS g,
            (SELECT uploaded_by FROM lab.project_materials WHERE id = $2) AS m`,
    [projectId, old.materialId],
  );
  await sql(
    `INSERT INTO comms.operation_notices (operation_kind, operation_id, user_id)
     SELECT 'material_upload', id, uploaded_by FROM lab.project_materials
      WHERE project_id = $1 AND upload_state = 'rejected'
     ON CONFLICT DO NOTHING`,
    [projectId],
  );
  await mobile.goto(projectUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  const oldRow = mobile.locator(`[data-upload-row="${old.materialId}"]`);
  await oldRow.waitFor({ timeout: 15_000 });
  check(
    'старая идущая загрузка в списке при 25+ более новых отказах',
    (await oldRow.count()) === 1,
  );
  check(
    'у неё есть кнопка отмены',
    (await mobile.locator(`[data-upload-cancel="${old.materialId}"]`).count()) === 1,
  );
  check(
    'история ограничена и подписана',
    (await mobile.locator('[data-uploads-history-limit]').count()) === 1 &&
      (await mobile.locator('[data-upload-row][data-upload-state="rejected"]').count()) === 20,
  );
  await mobile.locator(`[data-upload-cancel="${old.materialId}"]`).click();
  await mobile.waitForSelector(`[data-upload-row="${old.materialId}"]`, {
    state: 'detached',
    timeout: 15_000,
  });
  check('отменяется из списка', true);
  await phone.close();

  // ------------------------------------------------ 7. 200 после обрыва
  // Замечание Тэнка при приёмке W06: при обрыве по read_body Caddy отвечает
  // 200 с пустым телом, а файл в хранилище не попадает. Ответ хранилища не
  // должен становиться успехом — итог решает завершение на сервере.
  console.warn('\n[7] Хранилище ответило 200, а файла нет');
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const cut = await login(desk, 'обрыв');
  await calm(cut);
  const formPosts = [];
  await cut.route(
    (url) => url.pathname.endsWith(`/${process.env.S3_BUCKET ?? 'unicorn-launch'}`),
    async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      formPosts.push(route.request().url());
      // Тело не уходит в хранилище: ответ как у Caddy при обрыве передачи.
      await route.fulfill({ status: 200, body: '' });
    },
  );
  await cut.goto(projectUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  const readyBefore = (
    await sql(
      `SELECT count(*)::int AS n FROM lab.project_materials
      WHERE project_id = $1 AND upload_state = 'ready'`,
      [projectId],
    )
  )[0].n;
  await cut
    .waitForSelector('#deck-file', { state: 'attached', timeout: 15_000 })
    .catch(async () => {
      await cut.screenshot({ path: join(OUT, '7-no-input.png'), fullPage: true });
      console.warn('  адрес страницы:', cut.url());
    });
  await cut.setInputFiles('#deck-file', {
    name: 'Оборванный.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 оборванная передача'),
  });
  await cut.getByRole('button', { name: 'Загрузить презентацию' }).click();
  const cutNotice = cut.locator('[data-upload-notice]');
  await cutNotice.waitFor({ timeout: 30_000 });
  const cutText = await cutNotice.innerText();
  check('форма ушла в «хранилище» и получила 200', formPosts.length === 1);
  check(
    'сообщения об успехе нет',
    !/загружен и подтверждён/i.test(cutText) &&
      (await cutNotice.getAttribute('data-upload-notice')) !== 'ok',
    cutText,
  );
  const [cutRow] = await sql(
    `SELECT upload_state, uploaded_at FROM lab.project_materials
      WHERE project_id = $1 AND upload_file_name = 'Оборванный.pdf'`,
    [projectId],
  );
  check(
    'загрузка не готова, числится идущей',
    cutRow?.upload_state === 'pending' && !cutRow.uploaded_at,
  );
  const readyAfter = (
    await sql(
      `SELECT count(*)::int AS n FROM lab.project_materials
      WHERE project_id = $1 AND upload_state = 'ready'`,
      [projectId],
    )
  )[0].n;
  check(
    'готовых материалов не прибавилось',
    readyAfter === readyBefore,
    `${readyBefore} → ${readyAfter}`,
  );
  check(
    'в карточке — идущая загрузка, не материал',
    (await cut.locator('[data-upload-row][data-upload-state="pending"]').count()) >= 1,
  );
  await desk.close();

  check('ошибок в консоли нет', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (error) {
  failed += 1;
  console.error('ПРОГОН ОБОРВАН:', error);
} finally {
  await browser.close();
  if (projectId) {
    await sql(
      `DELETE FROM comms.operation_notices
        WHERE operation_id IN (SELECT id FROM lab.project_materials WHERE project_id = $1)`,
      [projectId],
    );
  }
  await pool.end();
}

await run.finish(failed === 0);
console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exit(failed > 0 ? 1 : 0);
