#!/usr/bin/env node
/**
 * Защищённая отправка формы в браузере (блок 2, 2.2 и 2.6, первый пакет).
 *
 *   FIFTH_ENTRY=web node scripts/render-check-guarded-send.mjs
 *
 * Форма «Новый проект» кабинета основателя. Ответ сервера «теряется» ПОСЛЕ записи:
 * Playwright пропускает запрос к ядру и обрывает соединение до браузера. Сценарии:
 *   A. потерянный ответ: предупреждение без ложного успеха, поля заперты, проверка тем же
 *      ключом (сама и кнопкой) → один проект;
 *   B. проверка получает 401, затем 503: ключ и снимок остаются, причина показана, новой
 *      отправки с новым ключом нет;
 *   C. форма закрыта «Отменой» и открыта снова: на экране отправленное, ключ прежний;
 *   D. настоящий повторный вход: сессия кончилась, «Войти» → вход → кабинет сам выясняет
 *      исход по ключу и открывает тот же проект;
 *   E. 201 с ответом не по схеме: «принято, но не прочитано», выяснение по ключу, а не
 *      новая отправка.
 * В каждом — ровно один проект и один ключ. Убирает за собой проекты и ключи.
 */
/* global document */
import { chromium } from 'playwright';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else failed += 1;
  console.warn(`  ${condition ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;
const stamp = Date.now() % 1e9;
const titles = [];

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const email = `rk-form-${stamp}@test.local`;
const password = `Pw-${stamp}-${randomUUID().slice(0, 12)}`;
let userId = null;

/** Перехват создания проекта: `plan` — что сделать с очередным ответом. */
const sent = [];
let plan = [];
/** Запросы, задержанные «до сервера»: исходная отправка, которая придёт позже. */
const held = [];
await page.route('**/v1/projects', async (route) => {
  if (route.request().method() !== 'POST') return route.continue();
  const step = plan.shift() ?? 'pass';
  const headers = route.request().headers();
  const key = headers['idempotency-key'];
  const title = JSON.parse(route.request().postData() ?? '{}').title;
  if (step === 'hold') {
    // До ядра запрос не доходит сейчас; браузер видит обрыв. Повторим его позже сами.
    sent.push({ key, step, title, reached: false });
    held.push({ url: route.request().url(), headers, body: route.request().postData() });
    return route.abort('connectionreset');
  }
  if (step === '401' || step === '503') {
    sent.push({ key, step, reached: false });
    const status = Number(step);
    return route.fulfill({
      status,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: `https://5espace.com/problems/${status === 401 ? 'unauthenticated' : 'dependency_unavailable'}`,
        title: 'x',
        status,
        code: status === 401 ? 'unauthenticated' : 'dependency_unavailable',
      }),
    });
  }
  const response = await route.fetch();
  sent.push({ key, step, title, reached: true, status: response.status() });
  if (step === 'drop') return route.abort('connectionreset');
  if (step === 'garble') {
    return route.fulfill({
      status: response.status(),
      contentType: 'application/json',
      body: '{}',
    });
  }
  return route.fulfill({ response });
});

/** Кабинет; при ограничении частоты с адреса (429) — дождаться сброса, как в RND-UPLOAD-OPERATIONS. */
async function openLab() {
  for (let i = 0; i < 4; i += 1) {
    await page.goto(`${SITE}/lab/`);
    await page.waitForTimeout(800);
    if ((await page.getByText('Слишком много запросов').count()) === 0) return;
    await page.waitForTimeout(30_000);
  }
}

async function openForm(title) {
  await openLab();
  await page
    .getByRole('button', { name: /Новый проект/ })
    .first()
    .click({ timeout: 15_000 })
    .catch(async (error) => {
      const text = (await page.locator('main, body').first().innerText()).slice(0, 300);
      console.warn(`  (нет кнопки: ${page.url()} — ${text.replace(/\s+/g, ' ')})`);
      throw error;
    });
  // Без направления сервер отвечает 400: ждём справочник, иначе проверяется не то.
  await page.waitForFunction(() => document.querySelector('#taxonomyId')?.value);
  await page.locator('#title').fill(title);
  await page.locator('#investmentAsk').fill('1000000');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
}
const phase = () =>
  page
    .locator('[data-guarded]')
    .first()
    .getAttribute('data-guarded')
    .catch(() => null);
async function waitPhase(expected, timeout = 10_000) {
  await page
    .waitForFunction(
      (want) => document.querySelector(`[data-guarded="${want}"]`) !== null,
      expected,
      { timeout },
    )
    .catch(() => undefined);
  return phase();
}
const projectCount = async (title) =>
  (await sql('SELECT count(*)::int AS n FROM lab.projects WHERE title = $1', [title]))[0].n;
async function waitProjectOpened() {
  return page
    .waitForURL(/\/lab\/projects\//, { timeout: 15_000, waitUntil: 'commit' })
    .then(() => true)
    .catch(() => false);
}
function keysOf(from) {
  return new Set(sent.slice(from).map((s) => s.key)).size;
}

console.warn('\n=== ЗАЩИЩЁННАЯ ОТПРАВКА ФОРМЫ (2.6) ===\n');
try {
  await page.goto(`${SITE}/login/`);
  const status = await page.evaluate(
    async ([address, secret]) => {
      const r = await fetch('/v1/auth/register', {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: address,
          password: secret,
          displayName: 'RK форма',
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
    [email, password],
  );
  check('участник заведён', status === 201, `HTTP ${status}`);

  console.warn('[A] Потерянный ответ');
  {
    const title = `RK A ${stamp}`;
    titles.push(title);
    const from = sent.length;
    plan = ['drop', 'drop'];
    await openForm(title);
    await page.waitForTimeout(3000);
    check('неизвестный результат показан', (await phase()) === 'unknown');
    check('ложного успеха нет', page.url().endsWith('/lab/'));
    check('поля заперты', await page.locator('#title').isDisabled());
    check(
      'кнопки «Создать» нет',
      (await page.getByRole('button', { name: 'Создать', exact: true }).count()) === 0,
    );
    check('автоматическая проверка была', sent.length - from === 2);
    await page.locator('[data-guarded-check]').click();
    const opened = await waitProjectOpened();
    check(
      'проверка кнопкой открыла проект',
      opened,
      opened
        ? ''
        : `состояние ${await phase()}, ответы ${JSON.stringify(sent.slice(from))}, адрес ${page.url()}`,
    );
    check('один ключ на все попытки', keysOf(from) === 1, `попыток ${sent.length - from}`);
    check(
      'проект один',
      (await projectCount(title)) === 1,
      `проектов ${await projectCount(title)}`,
    );
  }

  console.warn('[B] Проверка получает 401, затем 503');
  {
    const title = `RK B ${stamp}`;
    titles.push(title);
    const from = sent.length;
    plan = ['drop', '401'];
    await openForm(title);
    check('после 401 — нужен вход, ключ сохранён', (await waitPhase('login')) === 'login');
    check('поля по-прежнему заперты', await page.locator('#title').isDisabled());
    check(
      'новой отправки не начать: кнопки «Создать» нет',
      (await page.getByRole('button', { name: 'Создать', exact: true }).count()) === 0,
    );
    // Вход «восстановился» (здесь 401 был подставной): страница открыта заново — исход
    // выясняется по метке вкладки, без повтора создания.
    await openLab();
    check('после возвращения кабинет сам открыл тот же проект', await waitProjectOpened());
    check(
      'создание вызвано дважды, с одним ключом',
      sent.length - from === 2 && keysOf(from) === 1,
      `обращений ${sent.length - from}, ключей ${keysOf(from)}`,
    );
    check('проект один', (await projectCount(title)) === 1);
  }

  console.warn('[B2] Проверка получает 503');
  {
    const title = `RK B2 ${stamp}`;
    titles.push(title);
    const from = sent.length;
    plan = ['drop', '503'];
    await openForm(title);
    check(
      '503 — проверка недоступна, ключ сохранён',
      (await waitPhase('unavailable')) === 'unavailable',
    );
    check(
      'новой отправки не начать: кнопки «Создать» нет',
      (await page.getByRole('button', { name: 'Создать', exact: true }).count()) === 0,
    );
    await page.locator('[data-guarded-check]').click();
    check('проверка кнопкой выяснила исход: открыт проект', await waitProjectOpened());
    check(
      'три обращения к созданию — один ключ',
      sent.length - from === 3 && keysOf(from) === 1,
      `обращений ${sent.length - from}, ключей ${keysOf(from)}`,
    );
    check('проект один', (await projectCount(title)) === 1);
  }

  console.warn('[C] Закрытие и повторное открытие формы');
  {
    const title = `RK C ${stamp}`;
    titles.push(title);
    const from = sent.length;
    plan = ['drop', 'drop'];
    await openForm(title);
    await waitPhase('unknown');
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Отмена' }).click();
    check(
      'форма закрыта, предупреждение осталось на странице',
      (await page.locator('#title').count()) === 0 && (await phase()) !== null,
    );
    await page
      .getByRole('button', { name: /Новый проект/ })
      .first()
      .click();
    check(
      'открыта снова — на экране отправленное',
      (await page.locator('#title').inputValue()) === title,
    );
    check('и поля заперты', await page.locator('#title').isDisabled());
    await page.locator('[data-guarded-check]').click();
    check('проверка открыла проект', await waitProjectOpened());
    check('один ключ', keysOf(from) === 1, `обращений ${sent.length - from}`);
    check('проект один', (await projectCount(title)) === 1);
  }

  console.warn('[D] Настоящий повторный вход');
  {
    const title = `RK D ${stamp}`;
    titles.push(title);
    const from = sent.length;
    plan = ['drop', 'drop'];
    await openForm(title);
    await waitPhase('unknown');
    await page.waitForTimeout(2500);
    await context.clearCookies();
    await page.locator('[data-guarded-check]').click();
    check('сессии нет — просит войти', (await waitPhase('login')) === 'login');
    await page.locator('[data-guarded-login]').click();
    await page.waitForURL(/\/login\//, { timeout: 15_000 });
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await page.locator('#password').press('Enter');
    check('после входа кабинет сам выяснил исход и открыл проект', await waitProjectOpened());
    check(
      'после входа работа не повторялась',
      sent.length - from === 3 && keysOf(from) === 1,
      `обращений ${sent.length - from}, ключей ${keysOf(from)}`,
    );
    check('проект один', (await projectCount(title)) === 1);
  }

  console.warn('[E] 201 с ответом не по схеме');
  {
    const title = `RK E ${stamp}`;
    titles.push(title);
    const from = sent.length;
    plan = ['garble'];
    await openForm(title);
    check('«принято, но не прочитано»', (await waitPhase('unreadable')) === 'unreadable');
    check(
      'новой отправки не начать',
      (await page.getByRole('button', { name: 'Создать', exact: true }).count()) === 0,
    );
    await page.locator('[data-guarded-check]').click();
    check('выяснено по ключу: открыт проект', await waitProjectOpened());
    check('создание вызвано один раз', sent.length - from === 1);
    check('проект один', (await projectCount(title)) === 1);
  }

  /** Задержанная исходная отправка доходит до ядра — с её ключом и сессией. */
  async function replayHeld() {
    const h = held.shift();
    for (let i = 0; ; i += 1) {
      const response = await page.request.post(h.url, {
        headers: {
          'content-type': 'application/json',
          'idempotency-key': h.headers['idempotency-key'],
          'x-csrf-token': h.headers['x-csrf-token'],
        },
        data: h.body,
      });
      // Ограничение частоты с адреса — не ответ на операцию: подождать и повторить.
      if (response.status() === 429 && i < 3) {
        await page.waitForTimeout(1000 * (Number(response.headers()['retry-after']) || 30));
        continue;
      }
      return { status: response.status(), json: await response.json().catch(() => null) };
    }
  }
  /** Пауза перед сценарием: окно ограничения частоты с адреса сбрасывается. */
  const cool = () => page.waitForTimeout(45_000);
  /** Неизвестная отправка, о которой сервер ещё не знает: после перезагрузки — «не найдена». */
  async function notFoundYet(title) {
    held.length = 0;
    plan = ['hold', 'hold'];
    await openForm(title);
    await waitPhase('unknown');
    await page.waitForTimeout(2500);
    await openLab();
    return waitPhase('not_found');
  }

  await cool();
  console.warn('[F1] «Не найдена», затем поздняя исходная, затем новая отправка');
  {
    const t1 = `RK F1 исходная ${stamp}`;
    const t2 = `RK F1 новая ${stamp}`;
    titles.push(t1, t2);
    const from = sent.length;
    check(
      'по ключу «не найдена» — не окончательный отказ',
      (await notFoundYet(t1)) === 'not_found',
    );
    const late = await replayHeld();
    check('поздняя исходная выполнилась', late.status === 201, `HTTP ${late.status}`);
    await page
      .getByRole('button', { name: /Новый проект/ })
      .first()
      .click();
    await page.waitForFunction(() => document.querySelector('#taxonomyId')?.value);
    check('форма открыта для новой отправки', !(await page.locator('#title').isDisabled()));
    await page.locator('#title').fill(t2);
    await page.locator('#investmentAsk').fill('1000000');
    plan = ['pass'];
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    check('новая получила конфликт — открыт результат поздней исходной', await waitProjectOpened());
    check('новая отправка шла прежним ключом', keysOf(from) === 1, `ключей ${keysOf(from)}`);
    const n1 = await projectCount(t1);
    const n2 = await projectCount(t2);
    check('выполнилась ровно одна', n1 + n2 === 1 && n1 === 1, `исходная ${n1}, новая ${n2}`);
  }

  await cool();
  console.warn('[F2] «Не найдена», затем новая отправка, затем поздняя исходная');
  {
    const t1 = `RK F2 исходная ${stamp}`;
    const t2 = `RK F2 новая ${stamp}`;
    titles.push(t1, t2);
    const from = sent.length;
    check('по ключу «не найдена»', (await notFoundYet(t1)) === 'not_found');
    await page
      .getByRole('button', { name: /Новый проект/ })
      .first()
      .click();
    await page.waitForFunction(() => document.querySelector('#taxonomyId')?.value);
    await page.locator('#title').fill(t2);
    await page.locator('#investmentAsk').fill('1000000');
    plan = ['pass'];
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    check('новая выполнена', await waitProjectOpened());
    const late = await replayHeld();
    check(
      'поздняя исходная получила конфликт ключа',
      late.status === 409 && late.json?.code === 'idempotency_key_reused',
      `HTTP ${late.status} ${late.json?.code}`,
    );
    check('один ключ', keysOf(from) === 1);
    const n1 = await projectCount(t1);
    const n2 = await projectCount(t2);
    check('выполнилась ровно одна', n1 === 0 && n2 === 1, `исходная ${n1}, новая ${n2}`);
  }

  await cool();
  console.warn('[G] A оставил неизвестную отправку → вошёл B и отправил свою → вернулся A');
  {
    const ta = `RK G A ${stamp}`;
    const tb = `RK G B ${stamp}`;
    titles.push(ta, tb);
    const from = sent.length;
    plan = ['drop', 'drop'];
    await openForm(ta);
    await waitPhase('unknown');
    await page.waitForTimeout(2500);
    const keyA = sent[sent.length - 1].key;
    // Вход B в этой же вкладке.
    await context.clearCookies();
    await page.goto(`${SITE}/login/`);
    const emailB = `rk-form-b-${stamp}@test.local`;
    await page.evaluate(async (address) => {
      await fetch('/v1/auth/register', {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: address,
          password: `Pw-${crypto.randomUUID()}`,
          displayName: 'RK форма B',
          role: 'founder',
          locale: 'ru-RU',
          consents: ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
            kind,
            version: 'v1',
            locale: 'ru-RU',
          })),
        }),
      });
    }, emailB);
    await openLab();
    await page
      .getByRole('button', { name: /Новый проект/ })
      .first()
      .waitFor();
    check(
      'у B чужой незавершённой отправки нет',
      (await page.locator('[data-guarded]').count()) === 0,
    );
    const beforeB = sent.length;
    plan = ['drop', 'drop'];
    await openForm(tb);
    await waitPhase('unknown');
    await page.waitForTimeout(2500);
    const marks = await page.evaluate(() =>
      Object.keys(sessionStorage)
        .filter((k) => k.startsWith('fifth.pending.'))
        .map((k) => JSON.parse(sessionStorage.getItem(k)).owner),
    );
    check(
      'во вкладке две метки разных владельцев',
      marks.length === 2 && new Set(marks).size === 2,
      JSON.stringify(marks),
    );
    const asB = sent.slice(beforeB);
    check(
      'под B не ушло ни ключа, ни содержимого A',
      asB.every((s) => s.key !== keyA && s.title !== ta),
      JSON.stringify(asB.map((s) => s.title)),
    );
    await page.locator('[data-guarded-check]').click();
    check('B выяснил свою отправку', await waitProjectOpened());
    // Возвращается A.
    await context.clearCookies();
    await page.goto(`${SITE}/login/`);
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await page.locator('#password').press('Enter');
    check('A после входа получил свою отправку', await waitProjectOpened());
    const aCount = await projectCount(ta);
    const bCount = await projectCount(tb);
    check('у каждого по одному проекту', aCount === 1 && bCount === 1, `A ${aCount}, B ${bCount}`);
    const ownerOf = async (t) =>
      (
        await sql(
          `SELECT u.display_name FROM lab.projects p JOIN lab.founders_projects f ON f.project_id = p.id
             JOIN identity.users u ON u.id = f.user_id WHERE p.title = $1`,
          [t],
        )
      )[0]?.display_name;
    check(
      'проекты у своих владельцев',
      (await ownerOf(ta)) === 'RK форма' && (await ownerOf(tb)) === 'RK форма B',
    );
    check('A и B — разные ключи', keysOf(from) === 2);
  }

  const owners = await sql(
    "SELECT id FROM identity.users WHERE display_name IN ('RK форма', 'RK форма B') AND created_at > now() - interval '1 hour'",
  );
  userId = owners.map((o) => o.id);
  check('исключений на странице нет', errors.length === 0, errors.join('; ').slice(0, 200));
} finally {
  for (const title of titles) {
    for (const { id } of await sql('SELECT id FROM lab.projects WHERE title = $1', [title])) {
      await sql('DELETE FROM lab.founders_projects WHERE project_id = $1', [id]);
      await sql('DELETE FROM lab.projects WHERE id = $1', [id]);
    }
  }
  if (userId?.length) {
    await sql('DELETE FROM requests.idempotency_keys WHERE actor_id = ANY($1::uuid[])', [userId]);
  }
  await browser.close();
  await pool.end();
}

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exit(failed > 0 ? 1 : 0);
