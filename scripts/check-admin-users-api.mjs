#!/usr/bin/env node
/**
 * Раздел «Пользователи» административного кабинета — проверка API.
 *
 * Браузерный проход показывает, что экран работает. Здесь проверяется то,
 * чего с экрана не видно и что дороже всего стоит при ошибке:
 *
 *   * границы доступа — кому раздел закрыт и на каком уровне;
 *   * честность поиска — экранирование шаблона, точное совпадение по
 *     зашифрованному контакту, мусор вместо идентификатора;
 *   * отбор и страницы считаются в БД, а не по загруженной странице;
 *   * раскрытие контактов оставляет след в журнале;
 *   * в ответах нет ни одного технического секрета.
 *
 * Позитивный контроль обязателен: каждая проверка «нельзя» сопровождается
 * проверкой «а вот так — можно», иначе зелёный цвет ничего не значит.
 *
 * Запуск: node scripts/check-admin-users-api.mjs (нужны БД и ядро на :4300)
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
  async function call(path, { method = 'GET', body, csrf = true } = {}) {
    const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrf && state.csrf) {
      headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
    }
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
  return { call, login };
}

const q = (params) => `/v1/admin/users?${new URLSearchParams(params).toString()}`;

try {
  if (!DEMO_PASSWORD) {
    throw new Error('нет DEMO_USER_PASSWORD/DEV_TEST_USER_PASSWORD в .env — комплект не загружен');
  }

  console.warn('\n=== РАЗДЕЛ «ПОЛЬЗОВАТЕЛИ»: API ===\n');

  const admin = makeClient();
  await admin.login('demo-admin@unicorn.local', DEMO_PASSWORD);

  // ------------------------------------------------------------ [1] список
  console.warn('[1] Страница списка');
  const first = await admin.call(q({ perPage: '100' }));
  check('Список открывается администратору', first.status === 200, `HTTP ${first.status}`);
  const page = first.json ?? {};
  check(
    'Ответ — страница, а не голый массив',
    Array.isArray(page.items) && typeof page.total === 'number' && page.total >= page.items.length,
    `всего ${page.total}, на странице ${page.items?.length}`,
  );
  const sample = page.items?.[0] ?? {};
  check(
    'В строке есть всё, чем таблица живёт',
    ['id', 'displayName', 'roles', 'status', 'kycStatus', 'createdAt'].every((k) => k in sample),
    Object.keys(sample).join(', '),
  );

  // ------------------------------------------------------------- [2] поиск
  console.warn('\n[2] Поиск по полям');
  const byName = await admin.call(q({ field: 'name', q: 'Сокол' }));
  check(
    'Поиск по части имени находит человека',
    byName.json?.items?.some((u) => u.displayName.includes('Сокол')),
    `найдено ${byName.json?.total}`,
  );

  const wildcard = await admin.call(q({ field: 'name', q: '%' }));
  check(
    'Шаблон из поля ввода экранирован, а не выполняется',
    wildcard.json?.total === 0,
    `по запросу «%» найдено ${wildcard.json?.total} (не должно быть всех)`,
  );

  const byEmail = await admin.call(q({ field: 'email', q: 'demo-admin@unicorn.local' }));
  check(
    'Поиск по адресу находит ровно одного',
    byEmail.json?.total === 1 && byEmail.json.items[0].displayName.includes('Соколова'),
    `найдено ${byEmail.json?.total}`,
  );

  const partialEmail = await admin.call(q({ field: 'email', q: 'demo-admin' }));
  check(
    'По части адреса не находит — и это честная граница модели, а не ошибка',
    partialEmail.status === 200 && partialEmail.json?.total === 0,
    `HTTP ${partialEmail.status}, найдено ${partialEmail.json?.total}`,
  );

  const adminId = byEmail.json.items[0].id;
  const byId = await admin.call(q({ field: 'id', q: adminId }));
  check('Поиск по идентификатору точный', byId.json?.total === 1, `найдено ${byId.json?.total}`);

  const badId = await admin.call(q({ field: 'id', q: 'не-идентификатор' }));
  check(
    'Мусор вместо идентификатора — пустой результат, а не ошибка сервера',
    badId.status === 200 && badId.json?.total === 0,
    `HTTP ${badId.status}`,
  );

  // ----------------------------------------------------------- [3] фильтры
  console.warn('\n[3] Фильтры, сортировка, страницы');
  const experts = await admin.call(q({ role: 'expert', perPage: '100' }));
  check(
    'Фильтр по роли отбирает только её носителей',
    experts.json?.items?.length > 0 && experts.json.items.every((u) => u.roles.includes('expert')),
    `экспертов ${experts.json?.total}`,
  );

  const active = await admin.call(q({ status: 'active', perPage: '100' }));
  check(
    'Фильтр по состоянию аккаунта работает',
    active.json?.items?.every((u) => u.status === 'active'),
    `активных ${active.json?.total}`,
  );

  const asc = await admin.call(q({ sort: 'display_name', dir: 'asc', perPage: '10' }));
  const desc = await admin.call(q({ sort: 'display_name', dir: 'desc', perPage: '10' }));
  // Сверяемся не со второй страницей, а с самой базой: сортировка «по всей
  // выборке» означает, что на первой странице стоит глобально первый, а не
  // первый из загруженных.
  const edges = await sql(
    `SELECT (SELECT display_name FROM identity.users WHERE deleted_at IS NULL
               ORDER BY lower(display_name) ASC, id ASC LIMIT 1) AS lowest,
            (SELECT display_name FROM identity.users WHERE deleted_at IS NULL
               ORDER BY lower(display_name) DESC, id DESC LIMIT 1) AS highest`,
  );
  check(
    'Сортировка по имени идёт по всей выборке, а не по странице',
    asc.json?.items?.[0]?.displayName === edges[0].lowest &&
      desc.json?.items?.[0]?.displayName === edges[0].highest,
    `${asc.json?.items?.[0]?.displayName} … ${desc.json?.items?.[0]?.displayName}`,
  );

  const p1 = await admin.call(q({ perPage: '5', page: '1' }));
  const p2 = await admin.call(q({ perPage: '5', page: '2' }));
  const ids1 = new Set((p1.json?.items ?? []).map((u) => u.id));
  const overlap = (p2.json?.items ?? []).filter((u) => ids1.has(u.id));
  check(
    'Страницы не пересекаются, а всего одинаково',
    overlap.length === 0 && p1.json?.total === p2.json?.total,
    `пересечений ${overlap.length}, всего ${p1.json?.total}`,
  );

  const filteredPaged = await admin.call(q({ role: 'founder', perPage: '5', page: '1' }));
  check(
    'Фильтр и страницы работают вместе: всего считается по отбору',
    filteredPaged.status === 200 &&
      filteredPaged.json.total !== page.total &&
      filteredPaged.json.items.length <= 5 &&
      filteredPaged.json.items.every((u) => u.roles.includes('founder')),
    `основателей всего ${filteredPaged.json?.total} из ${page.total}, на странице ${filteredPaged.json?.items?.length}`,
  );

  const tooSmall = await admin.call(q({ perPage: '1' }));
  check(
    'Размер страницы вне допустимого отвергается, а не молча правится',
    tooSmall.status === 400,
    `HTTP ${tooSmall.status}`,
  );

  // ---------------------------------------------------------- [4] карточка
  console.warn('\n[4] Карточка человека');
  const card = await admin.call(`/v1/admin/users/${adminId}`);
  check('Карточка открывается', card.status === 200, `HTTP ${card.status}`);
  check(
    'В карточке собраны разделы, а не одна строка',
    ['roles', 'kyc', 'projects', 'entities', 'capabilities', 'assignments', 'history'].every(
      (k) => k in (card.json ?? {}),
    ),
    Object.keys(card.json ?? {}).length + ' полей',
  );
  check(
    'Контакт в карточке — маска, а не значение',
    typeof card.json?.emailMasked === 'string' && card.json.emailMasked.includes('*'),
    String(card.json?.emailMasked),
  );

  const missing = await admin.call('/v1/admin/users/00000000-0000-7000-8000-000000000000');
  check(
    'Несуществующий человек — 404, а не пустая карточка',
    missing.status === 404,
    `HTTP ${missing.status}`,
  );

  const malformed = await admin.call('/v1/admin/users/не-идентификатор');
  check(
    'Кривой адрес карточки — отказ валидации',
    malformed.status === 400,
    `HTTP ${malformed.status}`,
  );

  // -------------------------------------------------------- [5] секреты
  console.warn('\n[5] Технических секретов в ответах нет');
  const body = JSON.stringify(card.json ?? {}) + JSON.stringify(page);
  const leaked = [
    'password_hash',
    'passwordHash',
    'wrapped_dek',
    'wrappedDek',
    'email_hmac',
    'phone_hmac',
    'ciphertext',
    'evidence_ref',
  ].filter((needle) => body.includes(needle));
  check('Ни хешей, ни ключей, ни шифротекста', leaked.length === 0, leaked.join(', ') || 'чисто');

  // -------------------------------------------------- [6] раскрытие контактов
  console.warn('\n[6] Раскрытие контактов оставляет след');
  const before = await sql(
    `SELECT count(*)::int AS n FROM audit.events
      WHERE verb = 'identity.user_contacts.revealed' AND subject_id = $1`,
    [adminId],
  );
  const reveal = await admin.call(`/v1/admin/users/${adminId}/contacts/reveal`, { method: 'POST' });
  check(
    'Контакт раскрывается по явному действию',
    reveal.status === 200 && reveal.json?.email === 'demo-admin@unicorn.local',
    `HTTP ${reveal.status}, ${reveal.json?.email}`,
  );
  const after = await sql(
    `SELECT count(*)::int AS n, max(context_jsonb::text) AS ctx FROM audit.events
      WHERE verb = 'identity.user_contacts.revealed' AND subject_id = $1`,
    [adminId],
  );
  check(
    'Событие записано в журнал',
    after[0].n === before[0].n + 1,
    `было ${before[0].n}, стало ${after[0].n}`,
  );
  check(
    'В журнал ушёл факт, а не сами данные',
    typeof after[0].ctx === 'string' && !after[0].ctx.includes('@'),
    after[0].ctx,
  );

  const noCsrf = await admin.call(`/v1/admin/users/${adminId}/contacts/reveal`, {
    method: 'POST',
    csrf: false,
  });
  check('Без CSRF-заголовка раскрытие не проходит', noCsrf.status === 403, `HTTP ${noCsrf.status}`);

  // ------------------------------------------------------------ [7] границы
  console.warn('\n[7] Кому раздел закрыт');
  const anon = await fetch(`${BASE}/v1/admin/users`, { signal: AbortSignal.timeout(20_000) });
  check('Аноним не видит список', anon.status === 401, `HTTP ${anon.status}`);

  const founder = makeClient();
  await founder.login('demo-founder-aero@unicorn.local', DEMO_PASSWORD);
  const founderList = await founder.call('/v1/admin/users');
  const founderCard = await founder.call(`/v1/admin/users/${adminId}`);
  const founderReveal = await founder.call(`/v1/admin/users/${adminId}/contacts/reveal`, {
    method: 'POST',
  });
  check('Основателю закрыт список', founderList.status === 403, `HTTP ${founderList.status}`);
  check('Основателю закрыта карточка', founderCard.status === 403, `HTTP ${founderCard.status}`);
  check(
    'Основателю закрыто раскрытие контактов',
    founderReveal.status === 403,
    `HTTP ${founderReveal.status}`,
  );

  // Роль организатора при выключенных сезонах срезается на guard'е (M088):
  // это не ошибка проверки, а действующее решение — и раздел ему закрыт.
  const organizer = makeClient();
  await organizer.login('demo-organizer@unicorn.local', DEMO_PASSWORD);
  const organizerList = await organizer.call('/v1/admin/users');
  check(
    'Организатору при выключенных сезонах раздел закрыт',
    organizerList.status === 403,
    `HTTP ${organizerList.status}`,
  );
} catch (error) {
  failed += 1;
  console.error(`\nПрогон прерван: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await pool.end();
}

console.warn('\n--- ИТОГ ---');
console.warn(`  пройдено: ${passed}, дефектов: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
