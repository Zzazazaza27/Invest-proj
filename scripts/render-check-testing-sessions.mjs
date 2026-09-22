#!/usr/bin/env node
/**
 * Браузерный проход: тестовые сессии и просмотр кабинета (этап 6.5).
 *
 * Проверяется то, чего не видно из API-прогона, — поведение ВКЛАДКИ:
 *
 *   1. администратор заводит сессию и открывает кабинет участника;
 *   2. идентификатор контекста уходит из адреса в состояние вкладки;
 *   3. кабинет показывает участника, а не администратора;
 *   4. АДМИНИСТРАТОРСКАЯ вкладка при этом остаётся администраторской;
 *   5. «Посмотреть кабинет» из списка пользователей открывает режим только
 *      для чтения, и сервер отказывает в изменении;
 *   6. картинки в контекстной вкладке грузятся тем же контекстом, а не
 *      административной сессией;
 *   7. завершение просмотра закрывает контекст.
 *
 * Снимки — `out/render-testing-sessions/`.
 * Запуск: UNICORN_ENTRY=web node scripts/render-check-testing-sessions.mjs
 */
import { chromium } from 'playwright';
import pg from 'pg';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { frontendUrl } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const toSite = (url) => url.replace('127.0.0.1', 'localhost');
const ADMIN_URL = toSite(process.env.ADMIN_URL ?? frontendUrl('admin')).replace(/\/+$/, '');

const OUT = join(ROOT, 'out', 'render-testing-sessions');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const verdicts = [];
function expect(scenario, condition, note = '') {
  verdicts.push({ scenario, state: condition ? 'ПРОЙДЕН' : 'ДЕФЕКТ', note });
  console.warn(`  ${condition ? 'OK  ' : 'FAIL'}  ${scenario}${note ? ` — ${note}` : ''}`);
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

const ADMIN = {
  email: 'demo-admin@unicorn.local',
  password: process.env.DEMO_USER_PASSWORD ?? process.env.DEV_TEST_USER_PASSWORD ?? '',
};

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

async function signIn(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  const form = await page.waitForSelector('#email', { timeout: 15_000 }).catch(() => null);
  if (form) {
    await page.fill('#email', ADMIN.email);
    await page.fill('#password', ADMIN.password);
    await page.getByRole('button', { name: /^Войти$/ }).click();
    await page.waitForTimeout(3500);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  }
  await page.waitForTimeout(1200);
}

let shot = 0;
async function screenshot(page, name) {
  shot += 1;
  await page.screenshot({
    path: join(OUT, `${String(shot).padStart(2, '0')}-${name}.png`),
    fullPage: true,
  });
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  if (/\b(400|401|403|404|409) \(/.test(message.text())) return;
  consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

try {
  if (!ADMIN.password) throw new Error('нет пароля демонстрационного комплекта в .env');

  console.warn('\n=== ТЕСТОВЫЕ СЕССИИ В БРАУЗЕРЕ ===\n');

  // ------------------------------------------------------- [1] раздел и создание
  console.warn('[1] Раздел и создание сессии');
  await signIn(page, `${ADMIN_URL}/testing`);
  expect(
    'Раздел «Тестовые сессии» открывается',
    (await page.locator('[data-page="testing-sessions"]').count()) > 0,
  );
  await screenshot(page, 'sessions-list');

  const title = `Прогон интерфейса ${Date.now().toString().slice(-6)}`;
  await page.fill('[data-session-title]', title);
  await page.locator('[data-session-create]').click();
  await page.waitForTimeout(3500);

  const created = await sql(
    `SELECT id FROM testing.sessions WHERE title = $1 ORDER BY created_at DESC LIMIT 1`,
    [title],
  );
  const sessionId = created[0]?.id ?? null;
  expect('Сессия создана', Boolean(sessionId), title);

  const cast = await sql(
    `SELECT p.role, u.origin FROM testing.session_participants p
       JOIN identity.users u ON u.id = p.user_id
      WHERE p.session_id = $1`,
    [sessionId],
  );
  expect(
    'Подготовлены основатель, эксперт и инвестор',
    cast.length === 3 && cast.every((row) => row.origin === 'test_session'),
    cast.map((row) => row.role).join(', '),
  );
  await screenshot(page, 'session-card');

  // ------------------------------------------------- [2] кабинет участника
  console.warn('\n[2] Кабинет участника в отдельной вкладке');
  const [cabinetPage] = await Promise.all([
    context.waitForEvent('page'),
    page.locator('[data-open-cabinet="founder"]').click(),
  ]);
  await cabinetPage.waitForLoadState('networkidle');
  await cabinetPage.waitForTimeout(2500);

  const urlAfter = cabinetPage.url();
  expect('Адрес вкладки очищен от идентификатора', !urlAfter.includes('ctx='), urlAfter);

  const stored = await cabinetPage.evaluate(() =>
    // eslint-disable-next-line no-undef -- исполняется в браузере
    window.sessionStorage.getItem('unicorn.test-context'),
  );
  expect('Контекст живёт в состоянии ВКЛАДКИ', Boolean(stored), stored ? 'sessionStorage' : 'нет');

  const banner = cabinetPage.locator('[data-test-context]');
  expect('Плашка режима видна', (await banner.count()) > 0);
  expect(
    'Плашка называет сессию, а не режим чтения',
    (await banner.getAttribute('data-test-context')) === 'participant' &&
      (await cabinetPage.locator('[data-test-context-readonly]').count()) === 0,
  );
  await screenshot(cabinetPage, 'participant-cabinet');

  const whoAmI = await cabinetPage.evaluate(async () => {
    const response = await fetch('/v1/auth/me', {
      credentials: 'include',
      // Предел ожидания обязателен у любого внешнего вызова — правило проекта
      // (`unicorn-external-call-requires-timeout`). Без него зависший ответ
      // держит прогон до общего таймаута шага, и причина остаётся неясной.
      signal: AbortSignal.timeout(15_000),
      // eslint-disable-next-line no-undef -- исполняется в браузере
      headers: { 'X-Unicorn-Context': window.sessionStorage.getItem('unicorn.test-context') },
    });
    return response.json();
  });
  const participantIds = await sql(
    'SELECT user_id FROM testing.session_participants WHERE session_id = $1',
    [sessionId],
  );
  expect(
    'Кабинет отвечает участником, а не администратором',
    participantIds.some((row) => row.user_id === whoAmI.id),
    `id=${whoAmI.id}`,
  );

  // ------------------------------------------- [3] админская вкладка цела
  console.warn('\n[3] Административная вкладка не переключилась');
  await page.goto(`${ADMIN_URL}/users`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  expect(
    'Список пользователей по-прежнему доступен',
    (await page.locator('[data-users-table]').count()) > 0,
    'админская сессия цела',
  );
  const adminSees = await page.evaluate(async () => {
    const response = await fetch('/v1/auth/me', {
      credentials: 'include',
      signal: AbortSignal.timeout(15_000),
    });
    return response.json();
  });
  expect(
    'В админской вкладке — администратор',
    Array.isArray(adminSees.roles) && adminSees.roles.includes('admin'),
    (adminSees.roles ?? []).join(', '),
  );

  // --------------------------------------- [4] «Посмотреть кабинет» из списка
  console.warn('\n[4] Просмотр кабинета рабочего пользователя');
  const [realFounder] = await sql(
    `SELECT u.id, u.display_name FROM identity.users u
       JOIN identity.user_roles r ON r.user_id = u.id AND r.role = 'founder'
      WHERE u.origin = 'seed_demo' AND u.deleted_at IS NULL
      ORDER BY u.display_name LIMIT 1`,
  );
  await page.selectOption('[data-search-field]', 'id');
  await page.fill('[data-search-input]', realFounder.id);
  await page.getByRole('button', { name: /^Искать$/ }).click();
  await page.waitForTimeout(2000);
  const row = page.locator(`[data-user-row="${realFounder.id}"]`);
  expect('Человек найден в списке', (await row.count()) > 0, realFounder.display_name);
  expect(
    'В строке есть действие «Посмотреть кабинет»',
    (await row.locator('[data-view-cabinet]').count()) > 0,
  );

  const [viewPage] = await Promise.all([
    context.waitForEvent('page'),
    row.locator('[data-view-cabinet]').first().click(),
  ]);
  await viewPage.waitForLoadState('networkidle');
  await viewPage.waitForTimeout(2500);
  expect(
    'Плашка сообщает режим только для чтения',
    (await viewPage.locator('[data-test-context-readonly]').count()) > 0,
  );
  expect(
    'В плашке названо имя просматриваемого',
    (await viewPage.locator('[data-test-context-title]').innerText()).includes(
      realFounder.display_name,
    ),
    await viewPage.locator('[data-test-context-title]').innerText(),
  );
  await screenshot(viewPage, 'view-readonly');

  const refusal = await viewPage.evaluate(async () => {
    // eslint-disable-next-line no-undef -- исполняется в браузере
    const csrf = (document.cookie.match(/ul_csrf=([^;]+)/) ?? [])[1] ?? '';

    const response = await fetch('/v1/me/profile', {
      method: 'PATCH',
      credentials: 'include',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
        // eslint-disable-next-line no-undef -- исполняется в браузере
        'X-Unicorn-Context': window.sessionStorage.getItem('unicorn.test-context'),
      },
      body: JSON.stringify({ displayName: 'Попытка изменения из просмотра' }),
    });
    return response.status;
  });
  expect('Изменение из просмотра отклонено сервером', refusal === 403, `HTTP ${refusal}`);

  const [unchanged] = await sql('SELECT display_name FROM identity.users WHERE id = $1', [
    realFounder.id,
  ]);
  expect(
    'Данные пользователя не изменились',
    unchanged.display_name === realFounder.display_name,
    unchanged.display_name,
  );

  // ------------------------------------------------ [5] картинки в контексте
  console.warn('\n[5] Картинки идут тем же контекстом');
  const imageMode = await viewPage.evaluate(() => {
    // eslint-disable-next-line no-undef -- исполняется в браузере
    const images = [...document.querySelectorAll('img[src]')];
    const apiImages = images.filter((img) => img.getAttribute('src')?.includes('/v1/'));
    return { total: images.length, direct: apiImages.length };
  });
  expect(
    'Ни одна картинка не тянется с /v1 напрямую',
    imageMode.direct === 0,
    `картинок ${imageMode.total}, прямых обращений ${imageMode.direct}`,
  );
  // Проверка выше зелёная и тогда, когда картинок на экране просто нет, —
  // поэтому рядом стоит проверка РАЗМЕТКИ. Она отвечает на тот же вопрос
  // («может ли картинка уйти мимо контекста») и не зависит от того, есть ли
  // у просматриваемого человека аватар и обложка.
  const imageSites = [
    'packages/cabinet/src/ProfilePage.tsx',
    'packages/cabinet/src/ProjectCard.tsx',
    'apps/lab/src/pages/MediaCard.tsx',
  ];
  const offenders = imageSites.filter((file) => {
    const source = readFileSync(join(ROOT, file), 'utf8');
    // Прямой <img src={...}> с адресом от API — это загрузка под
    // административной сессией во вкладке участника.
    return /<img[^>]*\ssrc=\{(?![^}]*blob)/.test(source);
  });
  expect(
    'Во всех местах вывода изображений стоит ContextualImage',
    offenders.length === 0,
    offenders.length === 0 ? imageSites.length + ' файла' : offenders.join(', '),
  );

  // --------------------------------------------------- [6] завершение просмотра
  console.warn('\n[6] Завершение просмотра');
  await viewPage.locator('[data-test-context-finish]').click();
  await viewPage.waitForTimeout(3000);
  expect(
    'После завершения вкладка уходит в админку',
    viewPage.url().includes('/admin'),
    viewPage.url(),
  );
  const closed = await sql(
    `SELECT count(*)::int AS n FROM testing.access_contexts
      WHERE kind = 'readonly' AND revoked_at IS NOT NULL
        AND created_at > now() - interval '10 minutes'`,
  );
  expect('Контекст отозван в базе', closed[0].n > 0, `отозвано: ${closed[0].n}`);

  // -------------------------------------------- [7] плашка не оставляет двусмысленности
  //
  // Все три свойства найдены владельцем вручную и потому закрепляются здесь.
  console.warn('\n[7] Плашка: один выход, честное состояние, чистая история');
  const [secondView] = await Promise.all([
    context.waitForEvent('page'),
    page.locator(`[data-user-row="${realFounder.id}"] [data-view-cabinet]`).first().click(),
  ]);
  await secondView.waitForLoadState('networkidle');
  await secondView.waitForTimeout(2000);

  expect(
    'В плашке ровно один выход',
    (await secondView.locator('[data-test-context] button').count()) === 1 &&
      (await secondView.locator('[data-test-context-back]').count()) === 0,
    'ссылка «вернуться», уходившая БЕЗ завершения просмотра, убрана',
  );

  // Недействительный контекст обязан быть виден. Прежде плашка в этом случае
  // просто не рисовалась — вкладка оставалась в режиме просмотра молча.
  await secondView.evaluate(() => {
    // eslint-disable-next-line no-undef -- исполняется в браузере
    window.sessionStorage.setItem('unicorn.test-context', '00000000-0000-4000-8000-000000000000');
  });
  await secondView.reload({ waitUntil: 'networkidle' });
  await secondView.waitForTimeout(2500);
  expect(
    'Недействительный просмотр назван, а не скрыт',
    (await secondView.locator('[data-test-context="stale"]').count()) > 0,
    await secondView
      .locator('[data-test-context="stale"]')
      .innerText()
      .catch(() => 'плашки нет'),
  );
  await secondView.locator('[data-test-context-drop]').click();
  await secondView.waitForTimeout(2500);
  const dropped = await secondView.evaluate(() =>
    // eslint-disable-next-line no-undef -- исполняется в браузере
    window.sessionStorage.getItem('unicorn.test-context'),
  );
  expect('Выход из просмотра забывает контекст', dropped === null, String(dropped));

  // История: после завершения «назад» не должно возвращать в кабинет, где
  // режима уже нет, — именно это читается как «плашка пропала».
  const [thirdView] = await Promise.all([
    context.waitForEvent('page'),
    page.locator(`[data-user-row="${realFounder.id}"] [data-view-cabinet]`).first().click(),
  ]);
  await thirdView.waitForLoadState('networkidle');
  await thirdView.waitForTimeout(2000);
  await thirdView.locator('[data-test-context-finish]').click();
  await thirdView.waitForTimeout(3000);
  await thirdView.goBack();
  await thirdView.waitForTimeout(2500);
  expect(
    'После завершения «назад» не возвращает в кабинет',
    !thirdView.url().includes('/lab/'),
    thirdView.url(),
  );
  await thirdView.close();
  await secondView.close();

  // ------------------------------------------------------------ [8] уборка
  console.warn('\n[8] Уборка сессии из интерфейса');
  await page.goto(`${ADMIN_URL}/testing`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await page.locator(`[data-session-row="${sessionId}"] [data-session-open]`).click();
  await page.waitForTimeout(1500);
  await page.locator('[data-session-cleanup-plan]').click();
  await page.waitForTimeout(1500);
  expect('Показан состав уборки', (await page.locator('[data-cleanup-plan]').count()) > 0);
  await screenshot(page, 'cleanup-plan');
  await page.locator('[data-session-cleanup]').click();
  await page.waitForTimeout(3000);

  const alive = await sql(
    `SELECT count(*)::int AS n FROM identity.users u
       JOIN testing.session_participants p ON p.user_id = u.id
      WHERE p.session_id = $1 AND u.deleted_at IS NULL`,
    [sessionId],
  );
  expect('Участники убраны', alive[0].n === 0, `живых осталось: ${alive[0].n}`);

  expect('Ошибок в консоли нет', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
} catch (error) {
  expect('Прогон дошёл до конца', false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
  await pool.end();
}

const defects = verdicts.filter((v) => v.state === 'ДЕФЕКТ');
console.warn(`\nпройдено: ${verdicts.length - defects.length}, дефектов: ${defects.length}`);
console.warn(`снимки: ${OUT}\n`);
process.exit(defects.length === 0 ? 0 : 1);
