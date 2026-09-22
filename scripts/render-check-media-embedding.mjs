#!/usr/bin/env node
/**
 * Проверка встраивания изображений проекта (7.2, уточнение).
 *
 * Отвечает на вопрос, который нельзя закрыть рассуждением: что произойдёт,
 * если изображение закрытого проекта встроить на ЧУЖУЮ страницу в браузере,
 * где пользователь уже вошёл и доступ у него есть.
 *
 * Проверяются обе защиты по отдельности, потому что они разные:
 *
 *  1. `SameSite=Strict` у сессии — чужой сайт не получает куку, и сервер
 *     отвечает как постороннему;
 *  2. `Cross-Origin-Resource-Policy: same-site` — браузер не даёт чужой
 *     странице встроить ответ, даже если бы кука дошла.
 *
 * Чужой сайт настоящий, а не «другой порт»: домен `foreign.test`
 * резолвится в 127.0.0.1 правилом браузера, поэтому для него наш адрес —
 * другой сайт по всем правилам, а не по одному лишь порту.
 *
 * Снимки — `out/render-media-embedding/`.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { CORE_URL as DEFAULT_CORE_URL, PORTS } from './lib/ports.mjs';
import { PROBE_ORIGIN } from './lib/probe-run.mjs';
import {
  CONSENTS,
  blindIndex,
  createProjectWithDraftRound,
  loadDotEnv,
  makePool,
} from './lib/round-pricing-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

// Адреса — по `localhost`, а не по сырому IP: у IP нет регистрируемого домена,
// и «тот же сайт» для него не определяется. Это свойство адресации, а не
// продукта, и проверка не должна о него спотыкаться.
const CORE_URL = (process.env.CORE_URL ?? DEFAULT_CORE_URL).replace('127.0.0.1', 'localhost');
const OWN_PAGE_PORT = 4461;
const FOREIGN_PAGE_PORT = 4462;
const OUT = join(ROOT, 'out', 'render-media-embedding');
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

const pool = makePool('unicorn-render-media-embedding');
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

function makeClient() {
  const state = { session: null, csrf: null };
  async function call(path, { method = 'GET', body } = {}) {
    const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    // Регистрация называет серверу своё происхождение: иначе заведённый
    // прогоном человек неотличим от настоящего (M127).
    if (path === '/v1/auth/register') headers['X-Unicorn-Origin'] = PROBE_ORIGIN;
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
    return { response, json, state };
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
  return { call, json, state };
}

const suffix = `${Date.now() % 1e9}`;

async function register(role, tag) {
  const client = makeClient();
  const email = `emb-${tag}-${suffix}@test.local`;
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

async function uploadLogo(client, projectId) {
  const buffer = await sharp({
    create: { width: 512, height: 512, channels: 3, background: { r: 10, g: 90, b: 180 } },
  })
    .jpeg()
    .toBuffer();
  const ticket = await client.json(`/v1/projects/${projectId}/media/upload`, {
    method: 'POST',
    body: { kind: 'logo', contentType: 'image/jpeg', sizeBytes: buffer.byteLength },
  });
  const form = new FormData();
  for (const [key, value] of Object.entries(ticket.formFields)) form.append(key, value);
  form.append('file', new Blob([buffer], { type: 'image/jpeg' }), 'logo.jpg');
  await fetch(ticket.uploadUrl, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  return client.json(`/v1/projects/${projectId}/media/logo/finalize`, {
    method: 'POST',
    body: { focusX: 0.5, focusY: 0.5 },
  });
}

/** Страница, которая просто встраивает картинку по заданному адресу. */
function servePage(port, imageUrl) {
  return createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><img id="t" src="${imageUrl}">`);
  }).listen(port, '127.0.0.1');
}

console.warn('\n=== ПРОВЕРКА ВСТРАИВАНИЯ ИЗОБРАЖЕНИЙ (7.2) ===\n');

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

// Чужой домен резолвится в тот же хост: для браузера это ДРУГОЙ сайт.
const browser = await chromium.launch({
  args: ['--host-resolver-rules=MAP foreign.test 127.0.0.1, MAP own.test 127.0.0.1'],
});

let ownServer = null;
let foreignServer = null;

try {
  // Закрытый проект (режим по умолчанию — только команда) с логотипом.
  const closed = await createProjectWithDraftRound(founder.client, sql, suffix);
  await uploadLogo(founder.client, closed.project.id);
  const closedUrl = `${CORE_URL}/v1/projects/${closed.project.id}/media/logo/card`;

  // Публичный проект с логотипом.
  const open = await createProjectWithDraftRound(founder.client, sql, `${suffix}b`);
  await uploadLogo(founder.client, open.project.id);
  await founder.client.json(`/v1/projects/${open.project.id}/visibility`, {
    method: 'PUT',
    body: { visibility: 'public' },
  });
  const openUrl = `${CORE_URL}/v1/projects/${open.project.id}/media/logo/card`;

  console.warn('[0] Факты о заголовках');
  {
    const head = await fetch(openUrl, { signal: AbortSignal.timeout(20_000) });
    check(
      'публичное изображение отдаётся анониму',
      head.status === 200,
      `${head.status} ${head.headers.get('content-type')}`,
    );
    check(
      'политика встраивания — same-site (минимальная для нашей схемы)',
      head.headers.get('cross-origin-resource-policy') === 'same-site',
      `${head.headers.get('cross-origin-resource-policy')}`,
    );
    const closedAnon = await fetch(closedUrl, { signal: AbortSignal.timeout(20_000) });
    check(
      'закрытое изображение анониму не отдаётся',
      closedAnon.status === 404,
      `${closedAnon.status}`,
    );
  }

  // Браузер владельца: вход выполняется НА САЙТЕ, кука ставится для localhost.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page
    .goto(`${CORE_URL}/v1/health`, { waitUntil: 'domcontentloaded' })
    .catch(() => undefined);
  const login = await page.request.post(`${CORE_URL}/v1/auth/login`, {
    data: { email: founder.email, password: founder.password },
  });
  check('владелец вошёл в браузере', login.ok(), `${login.status()}`);
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === SESSION_COOKIE);
  check(
    'сессия ограничена своим сайтом (SameSite=Strict)',
    session?.sameSite === 'Strict',
    `${session?.sameSite}`,
  );

  async function embedFrom(origin, url) {
    const p = await context.newPage();
    let failure = null;
    let status = null;
    p.on('requestfailed', (r) => {
      if (r.url() === url) failure = r.failure()?.errorText ?? 'fail';
    });
    p.on('response', (r) => {
      if (r.url() === url) status = r.status();
    });
    await p.goto(origin, { waitUntil: 'networkidle', timeout: 30_000 });
    await p.waitForTimeout(600);
    const width = await p.evaluate(
      /* eslint-disable no-undef */
      () => {
        const img = document.getElementById('t');
        return img instanceof HTMLImageElement ? img.naturalWidth : 0;
      },
      /* eslint-enable no-undef */
    );
    return { page: p, width, failure, status };
  }

  console.warn('\n[1] Своя страница того же сайта, пользователь вошёл');
  ownServer = servePage(OWN_PAGE_PORT, closedUrl);
  {
    const result = await embedFrom(`http://localhost:${OWN_PAGE_PORT}/`, closedUrl);
    check(
      'закрытое изображение видно владельцу на нашей странице',
      result.width > 0,
      `${result.width}px, ответ ${result.status}, ошибка ${result.failure}`,
    );
    await result.page.screenshot({ path: join(OUT, '01-own-site.png') });
    await result.page.close();
  }

  console.warn('\n[2] ЧУЖОЙ сайт, тот же вошедший пользователь');
  foreignServer = servePage(FOREIGN_PAGE_PORT, closedUrl);
  {
    const result = await embedFrom(`http://foreign.test:${FOREIGN_PAGE_PORT}/`, closedUrl);
    check(
      'чужой сайт закрытое изображение не показывает',
      result.width === 0,
      `${result.width}px, ошибка ${result.failure}, ответ ${result.status}`,
    );
    check(
      'причина — запрет встраивания браузером',
      (result.failure ?? '').includes('BLOCKED_BY_RESPONSE'),
      `${result.failure}`,
    );
    await result.page.screenshot({ path: join(OUT, '02-foreign-closed.png') });
    await result.page.close();
  }

  console.warn('\n[3] ЧУЖОЙ сайт и ПУБЛИЧНОЕ изображение');
  foreignServer.close();
  foreignServer = servePage(FOREIGN_PAGE_PORT, openUrl);
  {
    const result = await embedFrom(`http://foreign.test:${FOREIGN_PAGE_PORT}/`, openUrl);
    check(
      'чужой сайт не встраивает и публичное изображение',
      result.width === 0,
      `${result.width}px, ошибка ${result.failure}`,
    );
    await result.page.screenshot({ path: join(OUT, '03-foreign-public.png') });
    await result.page.close();
  }

  console.warn('\n[4] Своя страница и ПУБЛИЧНОЕ изображение');
  ownServer.close();
  ownServer = servePage(OWN_PAGE_PORT, openUrl);
  {
    const result = await embedFrom(`http://localhost:${OWN_PAGE_PORT}/`, openUrl);
    check('наша страница публичное изображение показывает', result.width > 0, `${result.width}px`);
    await result.page.close();
  }

  console.warn('\n[5] Чужой сайт не получает куку — проверка отдельно от браузерного запрета');
  {
    // Прямой запрос без куки — ровно то, что увидит сервер от чужого сайта.
    const withoutCookie = await fetch(closedUrl, { signal: AbortSignal.timeout(20_000) });
    check(
      'без сессии сервер отвечает как постороннему',
      withoutCookie.status === 404,
      `${withoutCookie.status}`,
    );
    const withCookie = await fetch(closedUrl, {
      headers: { Cookie: founder.client.state.session ?? '' },
      signal: AbortSignal.timeout(20_000),
    });
    check('с сессией владельца — отдаётся', withCookie.status === 200, `${withCookie.status}`);
  }
} finally {
  ownServer?.close();
  foreignServer?.close();
  await browser.close();
  await pool.end();
}

console.warn(`\n  Снимки: ${OUT}`);
console.warn(`  Итог: ${passed} OK, ${failed} FAIL\n`);
console.warn(
  `  (порты страниц: своя ${OWN_PAGE_PORT}, чужая ${FOREIGN_PAGE_PORT}; ядро ${PORTS.core})\n`,
);
process.exit(failed === 0 ? 0 : 1);
