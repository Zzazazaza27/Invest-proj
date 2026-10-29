#!/usr/bin/env node
/**
 * Рендер-проверка логотипа и обложки НА ТЕЛЕФОНЕ (7.2).
 *
 * Размер экрана выбран не для красоты: загрузка файла, ползунки кадрирования и
 * кнопки замены — это ровно то, что ломается на узком экране и что человек
 * будет делать с телефона чаще, чем с ноутбука.
 *
 * Проходится весь цикл владельца: загрузка, замена, удаление — и показ
 * результата там, где его увидит посторонний: на витрине.
 *
 * Требуется поднятое: ядро, кабинет основателя (5175), приложение входа
 * (5179), витрина (5173), MinIO.
 *
 * Снимки — `out/render-project-media/`.
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
const run = await startProbeRun('RND-PROJECT-MEDIA');

/**
 * Адреса приводятся к `localhost`.
 *
 * У сырого IP нет регистрируемого домена, поэтому браузер не может установить
 * «тот же сайт» и блокирует встраивание изображения. Проверено опытом:
 * `localhost:5173` → `localhost:4300` картинку показывает, `127.0.0.1:5173` →
 * `127.0.0.1:4300` — нет. Это свойство адресации стенда, а не продукта: в
 * рабочем размещении всё за единой точкой входа.
 */
const toSite = (url) => url.replace('127.0.0.1', 'localhost');

const LAB_URL = toSite(process.env.LAB_URL ?? frontendUrl('lab'));
const PUBLIC_URL = toSite(process.env.WEB_PUBLIC_URL ?? frontendUrl('webPublic'));
const CORE_URL = toSite(process.env.CORE_URL ?? DEFAULT_CORE_URL);
const OUT = join(ROOT, 'out', 'render-project-media');
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

const pool = makePool('unicorn-render-project-media');
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
      signal: AbortSignal.timeout(30_000),
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
  const email = `pmr-${tag}-${suffix}@test.local`;
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

/** Файл на диске: браузер выбирает именно файл, а не буфер. */
async function imageFile(name, width, height, rgb) {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: rgb },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  const path = join(OUT, name);
  writeFileSync(path, buffer);
  return path;
}

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: ЛОГОТИП И ОБЛОЖКА НА ТЕЛЕФОНЕ (7.2) ===\n');

const founder = await register('founder', 'f');
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

try {
  const { project } = await createProject(founder.client, sql, suffix);

  // Телефон: узкий экран и касания, а не мышь.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (/\b(400|401|403|404|409|503) \(/.test(message.text())) return;
    consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  console.warn('[1] Вход и карточка изображений');
  await page.goto(LAB_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.fill('#email', founder.email);
  await page.fill('#password', founder.password);
  await page.getByRole('button', { name: /Войти/i }).click();
  await page.waitForSelector('text=Проекты', { timeout: 20_000 });
  await page.goto(`${LAB_URL.replace(/\/$/, '')}/projects/${project.id}`, {
    waitUntil: 'networkidle',
    timeout: 30_000,
  });
  await page.waitForSelector('[data-project-media]', { timeout: 20_000 });
  check('карточка изображений видна на телефоне', true);
  check(
    'пока ничего не загружено — сказано словами',
    (await page.locator('[data-media-empty="logo"]').count()) === 1,
  );
  // Карточка не должна уезжать за край узкого экрана.
  const box = await page.locator('[data-project-media]').boundingBox();
  check(
    'карточка помещается в ширину экрана',
    box !== null && box.width <= 390,
    `${Math.round(box?.width ?? 0)}px`,
  );
  await page.screenshot({ path: join(OUT, '01-empty.png'), fullPage: true });

  console.warn('\n[2] Загрузка логотипа');
  await page
    .locator('[data-media-input="logo"]')
    .setInputFiles(await imageFile('logo-a.jpg', 512, 512, { r: 30, g: 120, b: 220 }));
  await page.locator('[data-media-upload="logo"]').click();
  await page.waitForSelector('[data-media-preview="logo"]', { timeout: 30_000 });
  check('логотип загружен и показан', true);
  const firstSrc = await page.locator('[data-media-preview="logo"]').getAttribute('src');
  check('показывается по адресу ядра', (firstSrc ?? '').includes('/media/logo/card'), firstSrc);
  await page.screenshot({ path: join(OUT, '02-logo.png'), fullPage: true });

  console.warn('\n[3] Замена логотипа');
  await page
    .locator('[data-media-input="logo"]')
    .setInputFiles(await imageFile('logo-b.jpg', 640, 640, { r: 220, g: 80, b: 40 }));
  await page.locator('[data-media-focus-x="logo"]').fill('20');
  await page.locator('[data-media-upload="logo"]').click();
  await page.waitForFunction(
    /* eslint-disable no-undef */
    (previous) => {
      const img = document.querySelector('[data-media-preview="logo"]');
      return img !== null && img.getAttribute('src') !== previous;
    },
    /* eslint-enable no-undef */
    firstSrc,
    { timeout: 30_000 },
  );
  check('после замены показан новый файл', true);
  const [replaced] = await sql(
    `SELECT width, focus_x::float8 AS focus_x FROM lab.project_media
      WHERE project_id = $1 AND kind = 'logo'`,
    [project.id],
  );
  check('в базе новое изображение', replaced?.width === 640, `${replaced?.width}`);
  check('точка фокуса сохранена с ползунка', replaced?.focus_x === 0.2, `${replaced?.focus_x}`);

  console.warn('\n[4] Обложка и показ на витрине');
  await page
    .locator('[data-media-input="cover"]')
    .setInputFiles(await imageFile('cover.jpg', 1280, 720, { r: 20, g: 160, b: 120 }));
  await page.locator('[data-media-upload="cover"]').click();
  await page.waitForSelector('[data-media-preview="cover"]', { timeout: 30_000 });
  check('обложка загружена', true);
  await page.screenshot({ path: join(OUT, '03-both.png'), fullPage: true });

  await founder.client.json(`/v1/projects/${project.id}/visibility`, {
    method: 'PUT',
    body: { visibility: 'public' },
  });
  await founder.client.json(`/v1/projects/${project.id}/listing`, { method: 'POST' });

  const anon = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const anonPage = await anon.newPage();
  anonPage.on('pageerror', (error) => consoleErrors.push(`витрина: ${String(error)}`));
  await anonPage.goto(`${PUBLIC_URL.replace(/\/$/, '')}/p/${project.id}`, {
    waitUntil: 'networkidle',
    timeout: 30_000,
  });
  await anonPage.waitForSelector('[data-project-cover]', { timeout: 20_000 });
  check('обложка видна анониму на витрине', true);
  check('логотип виден анониму', (await anonPage.locator('[data-project-logo]').count()) === 1);
  const cover = await anonPage.locator('[data-project-cover]').boundingBox();
  check(
    'обложка не выходит за ширину телефона',
    cover !== null && cover.width <= 390,
    `${Math.round(cover?.width ?? 0)}px`,
  );
  // Ждём именно ЗАГРУЗКИ картинки, а не появления элемента: пустая рамка
  // тоже «видна», и проверка без этого ничего бы не значила.
  const loaded = await anonPage
    .waitForFunction(
      /* eslint-disable no-undef */
      () => {
        const img = document.querySelector('[data-project-cover]');
        return img instanceof HTMLImageElement && img.naturalWidth > 0 ? img.naturalWidth : false;
      },
      /* eslint-enable no-undef */
      undefined,
      { timeout: 20_000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => 0);
  check('изображение действительно загрузилось, а не осталось рамкой', loaded > 0, `${loaded}px`);
  await anonPage.screenshot({ path: join(OUT, '04-public.png'), fullPage: true });

  console.warn('\n[5] Удаление');
  await page.locator('[data-media-remove="logo"]').click();
  await page.waitForSelector('[data-media-empty="logo"]', { timeout: 20_000 });
  check('логотип убран, состояние названо словами', true);
  const [{ n }] = await sql(
    `SELECT count(*)::int AS n FROM lab.project_media WHERE project_id = $1`,
    [project.id],
  );
  check('в базе осталась только обложка', n === 1, `${n}`);
  await page.screenshot({ path: join(OUT, '05-removed.png'), fullPage: true });

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
