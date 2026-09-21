#!/usr/bin/env node
/**
 * Тестовые сессии и контексты доступа — проверка границ доверия.
 *
 * Здесь проверяется не «работает ли переключение», а то, чего с экрана не
 * видно и что дороже всего стоит при ошибке: подстановка личности внутри
 * стража доступа. Каждое «нельзя» сопровождается «а вот так можно» —
 * иначе зелёный цвет означал бы лишь то, что всё сломано одинаково.
 *
 * Что проверяется:
 *   * запрос под контекстом идёт от лица УЧАСТНИКА, а не администратора;
 *   * административная сессия при этом цела и остаётся административной;
 *   * негодный, чужой, отозванный и просроченный контекст — ОТКАЗ, а не
 *     тихий возврат к правам администратора;
 *   * контекст привязан к сессии инициатора: из другой его не открыть;
 *   * гостевой контекст = неавторизованный запрос, несмотря на админскую cookie;
 *   * режим просмотра запрещает изменения НА СЕРВЕРЕ, включая неявные;
 *   * CSRF не ослабляется ни созданием, ни использованием, ни завершением;
 *   * рабочий пользователь не может стать участником сессии;
 *   * уборка работает по перечню объектов сессии и повторяется безопасно.
 *
 * Запуск: node scripts/check-testing-sessions.mjs (нужны БД и ядро)
 */
import pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const BASE = process.env.CORE_URL ?? CORE_URL;
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'ul_csrf';
const DEMO_PASSWORD = process.env.DEMO_USER_PASSWORD ?? process.env.DEV_TEST_USER_PASSWORD ?? '';

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

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

function makeClient() {
  const state = { session: null, csrf: null };
  async function call(path, { method = 'GET', body, csrf = true, context = null } = {}) {
    const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrf && state.csrf) {
      headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
    }
    if (context) headers['X-Unicorn-Context'] = context;
    const response = await fetch(`${BASE}${path}`, {
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
      /* не JSON — так бывает у пустых ответов */
    }
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(';')[0];
      if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
      if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
    }
    return { status: response.status, json, text };
  }
  async function login(email, password) {
    const result = await call('/v1/auth/login', { method: 'POST', body: { email, password } });
    if (result.status !== 200 && result.status !== 201) {
      throw new Error(
        `вход ${email} не удался: HTTP ${result.status} ${result.text.slice(0, 200)}`,
      );
    }
    return result;
  }
  return { call, login, state };
}

try {
  if (!DEMO_PASSWORD) {
    throw new Error('нет DEMO_USER_PASSWORD/DEV_TEST_USER_PASSWORD в .env — комплект не загружен');
  }

  console.warn('\n=== ТЕСТОВЫЕ СЕССИИ: ГРАНИЦЫ ДОВЕРИЯ ===\n');

  const admin = makeClient();
  await admin.login('demo-admin@unicorn.local', DEMO_PASSWORD);
  const whoAmI = await admin.call('/v1/auth/me');
  const adminId = whoAmI.json?.id ?? null;
  check('администратор вошёл', whoAmI.status === 200 && Boolean(adminId));

  // ------------------------------------------------------- [1] создание сессии
  console.warn('\n[1] Создание сессии');
  const created = await admin.call('/v1/admin/testing/sessions', {
    method: 'POST',
    body: { title: `Проверка ${new Date().toISOString().slice(11, 19)}` },
  });
  check(
    'сессия создана',
    created.status === 200 || created.status === 201,
    `HTTP ${created.status} ${created.text.slice(0, 160)}`,
  );
  const sessionId = created.json?.id ?? null;

  const card = await admin.call(`/v1/admin/testing/sessions/${sessionId}`);
  const participants = card.json?.participants ?? [];
  check(
    'подготовлены три участника',
    participants.length === 3,
    participants.map((p) => p.role).join(', '),
  );

  const origins = await sql(
    `SELECT DISTINCT origin FROM identity.users
      WHERE id = ANY($1::uuid[])`,
    [participants.map((p) => p.user_id)],
  );
  check(
    'участники помечены как записи сессии',
    origins.length === 1 && origins[0].origin === 'test_session',
    origins.map((o) => o.origin).join(', '),
  );

  const founder = participants.find((p) => p.role === 'founder');

  // ------------------------------------------- [2] рабочий пользователь не участник
  console.warn('\n[2] Граница между рабочим пользователем и участником');
  let blocked = false;
  try {
    await sql(
      `INSERT INTO testing.session_participants (session_id, user_id, role, label)
       VALUES ($1, $2, 'founder', 'Подмена')`,
      [sessionId, adminId],
    );
  } catch (error) {
    blocked = /test_session/.test(String(error.message));
  }
  check('рабочего пользователя нельзя записать в участники', blocked);

  // ------------------------------------------------------ [3] контекст участника
  console.warn('\n[3] Запрос от лица участника');
  const opened = await admin.call(`/v1/admin/testing/sessions/${sessionId}/contexts`, {
    method: 'POST',
    body: { kind: 'participant', userId: founder.user_id },
  });
  check(
    'контекст открыт',
    opened.status === 200,
    `HTTP ${opened.status} ${opened.text.slice(0, 160)}`,
  );
  const contextId = opened.json?.contextId ?? null;

  const asFounder = await admin.call('/v1/auth/me', { context: contextId });
  check(
    'под контекстом отвечает УЧАСТНИК, а не администратор',
    asFounder.status === 200 && asFounder.json?.id === founder.user_id,
    `id=${asFounder.json?.id}`,
  );
  check(
    'роли берутся у участника, административных среди них нет',
    Array.isArray(asFounder.json?.roles) && !asFounder.json.roles.includes('admin'),
    (asFounder.json?.roles ?? []).join(', '),
  );

  const stillAdmin = await admin.call('/v1/auth/me');
  check(
    'та же cookie без заголовка — по-прежнему администратор',
    stillAdmin.status === 200 && stillAdmin.json?.id === adminId,
    `id=${stillAdmin.json?.id}`,
  );

  const adminRouteUnderContext = await admin.call('/v1/admin/users?perPage=1', {
    context: contextId,
  });
  check(
    'административный маршрут под контекстом закрыт',
    adminRouteUnderContext.status === 403,
    `HTTP ${adminRouteUnderContext.status}`,
  );

  // --------------------------------------------------------- [4] негодные контексты
  console.warn('\n[4] Негодные контексты — отказ, а не возврат к админу');
  // Значение заголовка обязано быть ASCII: кириллица в него не влезает по
  // спецификации, и проверка падала бы на собственном мусоре, а не на чужом.
  const garbage = await admin.call('/v1/auth/me', { context: 'not-a-uuid-at-all' });
  check('мусор вместо контекста — отказ', garbage.status === 403, `HTTP ${garbage.status}`);

  const unknown = await admin.call('/v1/auth/me', {
    context: '00000000-0000-4000-8000-000000000000',
  });
  check('неизвестный контекст — отказ', unknown.status === 403, `HTTP ${unknown.status}`);
  check(
    'при негодном контексте ответ НЕ администраторский',
    unknown.json?.id !== adminId,
    `id=${unknown.json?.id ?? 'нет'}`,
  );

  // Второй вход тем же администратором = другая сессия. Контекст к ней не привязан.
  const secondSession = makeClient();
  await secondSession.login('demo-admin@unicorn.local', DEMO_PASSWORD);
  const fromOtherSession = await secondSession.call('/v1/auth/me', { context: contextId });
  check(
    'из другой сессии того же администратора контекст не открывается',
    fromOtherSession.status === 403,
    `HTTP ${fromOtherSession.status}`,
  );

  // Чужой администратор — другой человек.
  const stranger = makeClient();
  await stranger.login('demo-organizer@unicorn.local', DEMO_PASSWORD);
  const fromStranger = await stranger.call('/v1/auth/me', { context: contextId });
  check(
    'чужой контекст не открывается',
    fromStranger.status === 403,
    `HTTP ${fromStranger.status}`,
  );

  // --------------------------------------------------------------- [5] CSRF
  console.warn('\n[5] CSRF не ослабляется контекстом');
  const noCsrfCreate = await admin.call('/v1/admin/testing/sessions', {
    method: 'POST',
    csrf: false,
    body: { title: 'Без CSRF' },
  });
  check(
    'создание сессии без CSRF-заголовка отклонено',
    noCsrfCreate.status === 403,
    `HTTP ${noCsrfCreate.status}`,
  );

  const noCsrfClose = await admin.call(`/v1/admin/testing/contexts/${contextId}`, {
    method: 'DELETE',
    csrf: false,
  });
  check(
    'завершение контекста без CSRF отклонено',
    noCsrfClose.status === 403,
    `HTTP ${noCsrfClose.status}`,
  );

  // --------------------------------------------------------- [6] гостевой режим
  console.warn('\n[6] Гость — это неавторизованный запрос');
  const guestOpened = await admin.call(`/v1/admin/testing/sessions/${sessionId}/contexts`, {
    method: 'POST',
    body: { kind: 'guest' },
  });
  const guestContext = guestOpened.json?.contextId ?? null;
  check('гостевой контекст открыт', guestOpened.status === 200 && Boolean(guestContext));

  const guestMe = await admin.call('/v1/auth/me', { context: guestContext });
  check(
    'закрытый маршрут гостю недоступен, несмотря на админскую cookie',
    guestMe.status === 401,
    `HTTP ${guestMe.status}`,
  );
  const guestPanel = await admin.call('/v1/testing/context/current', { context: guestContext });
  check('панель гостю доступна', guestPanel.status === 200 && guestPanel.json?.kind === 'guest');

  // ------------------------------------------------- [7] просмотр только для чтения
  console.warn('\n[7] Просмотр кабинета рабочего пользователя');
  const [realFounder] = await sql(
    `SELECT u.id FROM identity.users u
       JOIN identity.user_roles r ON r.user_id = u.id AND r.role = 'founder'
      WHERE u.origin = 'seed_demo' AND u.deleted_at IS NULL LIMIT 1`,
  );
  const view = await admin.call('/v1/admin/testing/user-views', {
    method: 'POST',
    body: { userId: realFounder.id },
  });
  check('просмотр открыт', view.status === 200, `HTTP ${view.status} ${view.text.slice(0, 160)}`);
  const viewContext = view.json?.contextId ?? null;

  const viewMe = await admin.call('/v1/auth/me', { context: viewContext });
  check(
    'под просмотром отвечает выбранный пользователь',
    viewMe.status === 200 && viewMe.json?.id === realFounder.id,
    `id=${viewMe.json?.id}`,
  );
  const viewPanel = await admin.call('/v1/testing/context/current', { context: viewContext });
  check('панель сообщает режим только для чтения', viewPanel.json?.readOnly === true);

  const mutate = await admin.call('/v1/me/profile', {
    method: 'PATCH',
    body: { displayName: 'Попытка изменения' },
    context: viewContext,
  });
  check(
    'изменение под просмотром отклонено сервером',
    mutate.status === 403,
    `HTTP ${mutate.status}`,
  );

  const [unchanged] = await sql('SELECT display_name FROM identity.users WHERE id = $1', [
    realFounder.id,
  ]);
  check(
    'данные пользователя не изменились',
    unchanged.display_name !== 'Попытка изменения',
    unchanged.display_name,
  );

  const realStillClean = await sql(
    `SELECT count(*)::int AS n FROM testing.session_participants WHERE user_id = $1`,
    [realFounder.id],
  );
  check('просматриваемый не стал участником сессии', realStillClean[0].n === 0);

  // --------------------------------------------------------- [8] завершение
  console.warn('\n[8] Завершение и отзыв');
  const closed = await admin.call(`/v1/admin/testing/contexts/${viewContext}`, {
    method: 'DELETE',
  });
  check('просмотр завершён', closed.status === 200);
  const afterClose = await admin.call('/v1/auth/me', { context: viewContext });
  check(
    'после завершения контекст не работает',
    afterClose.status === 403,
    `HTTP ${afterClose.status}`,
  );

  const audit = await sql(
    `SELECT verb FROM audit.events
      WHERE verb IN ('identity.user.view_started','identity.user.view_ended')
        AND ts > now() - interval '5 minutes'
      ORDER BY ts`,
  );
  check(
    'начало и завершение просмотра попали в журнал',
    audit.some((r) => r.verb === 'identity.user.view_started') &&
      audit.some((r) => r.verb === 'identity.user.view_ended'),
    audit.map((r) => r.verb).join(', '),
  );

  const finish = await admin.call(`/v1/admin/testing/sessions/${sessionId}/finish`, {
    method: 'POST',
    body: { result: 'passed' },
  });
  check('сессия завершена', finish.status === 200);
  const afterFinish = await admin.call('/v1/auth/me', { context: contextId });
  check(
    'завершение сессии прекращает её контексты',
    afterFinish.status === 403,
    `HTTP ${afterFinish.status}`,
  );

  const resumed = await admin.call(`/v1/admin/testing/sessions/${sessionId}/resume`, {
    method: 'POST',
  });
  check('завершённую сессию можно продолжить', resumed.status === 200);

  // ------------------------------------------------------------- [9] уборка
  console.warn('\n[9] Уборка по перечню объектов сессии');
  const plan = await admin.call(`/v1/admin/testing/sessions/${sessionId}/cleanup`);
  check(
    'показ состава уборки',
    plan.status === 200 && (plan.json?.plan ?? []).some((p) => p.table === 'identity.users'),
    JSON.stringify(plan.json?.plan ?? []),
  );

  const cleaned = await admin.call(`/v1/admin/testing/sessions/${sessionId}/cleanup`, {
    method: 'POST',
  });
  check('уборка выполнена', cleaned.status === 200, JSON.stringify(cleaned.json));

  const alive = await sql(
    `SELECT count(*)::int AS n FROM identity.users
      WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [participants.map((p) => p.user_id)],
  );
  check('участники убраны из выдач', alive[0].n === 0);

  const again = await admin.call(`/v1/admin/testing/sessions/${sessionId}/cleanup`, {
    method: 'POST',
  });
  check('повторная уборка безопасна', again.status === 200, JSON.stringify(again.json));

  const record = await sql('SELECT status, result FROM testing.sessions WHERE id = $1', [
    sessionId,
  ]);
  check(
    'запись о сессии и её итоге сохранилась',
    record[0]?.status === 'cleaned' && record[0]?.result === 'passed',
    JSON.stringify(record[0]),
  );

  // --------------------------------------------- [10] отзыв сессии инициатора
  console.warn('\n[10] Выход администратора прекращает доступ');
  const fresh = await admin.call('/v1/admin/testing/sessions', {
    method: 'POST',
    body: { title: 'Сессия для проверки выхода' },
  });
  const freshId = fresh.json?.id;
  const freshCard = await admin.call(`/v1/admin/testing/sessions/${freshId}`);
  const freshFounder = (freshCard.json?.participants ?? []).find((p) => p.role === 'founder');
  const freshCtx = (
    await admin.call(`/v1/admin/testing/sessions/${freshId}/contexts`, {
      method: 'POST',
      body: { kind: 'participant', userId: freshFounder.user_id },
    })
  ).json?.contextId;
  const beforeLogout = await admin.call('/v1/auth/me', { context: freshCtx });
  check('до выхода контекст работает', beforeLogout.json?.id === freshFounder.user_id);

  await admin.call('/v1/auth/logout', { method: 'POST' });
  const adminAgain = makeClient();
  await adminAgain.login('demo-admin@unicorn.local', DEMO_PASSWORD);
  const afterLogout = await adminAgain.call('/v1/auth/me', { context: freshCtx });
  check(
    'после выхода инициатора контекст мёртв',
    afterLogout.status === 403,
    `HTTP ${afterLogout.status}`,
  );

  // Уборка за собой: эта сессия для проверки выхода больше не нужна.
  await adminAgain.call(`/v1/admin/testing/sessions/${freshId}/cleanup`, { method: 'POST' });
} catch (error) {
  failed += 1;
  console.error(`\n  ПРОГОН ОБОРВАН: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await pool.end();
}

console.warn(`\nпройдено: ${passed}, дефектов: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
