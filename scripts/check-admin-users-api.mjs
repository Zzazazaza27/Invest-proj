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
  /**
   * Ограничение частоты — часть поведения платформы, а не помеха.
   *
   * Административные действия ограничены по частоте. Когда прогон идёт в
   * наборе следом за другими, он упирается в лимит и краснеет не на
   * продукте, а на соседях. Клиент ждёт названное сервером время и
   * повторяет — ровно так должен вести себя любой, кто упёрся в ограничение.
   */
  async function call(path, options = {}) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await callOnce(path, options);
      if (result.status !== 429) return result;
      const wait = Number(String(result.json?.detail ?? '').match(/(\d+)/)?.[1] ?? 20) + 2;
      console.warn(`  (ограничение частоты: жду ${wait} с)`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    }
    return callOnce(path, options);
  }

  async function callOnce(path, { method = 'GET', body, csrf = true } = {}) {
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
  await admin.login('demo-admin@fifth.local', DEMO_PASSWORD);

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

  const byEmail = await admin.call(q({ field: 'email', q: 'demo-admin@fifth.local' }));
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
  const admins = await admin.call(q({ role: 'admin', perPage: '100' }));
  check(
    'Фильтр по роли отбирает только её носителей',
    admins.json?.items?.length > 0 && admins.json.items.every((u) => u.roles.includes('admin')),
    `администраторов ${admins.json?.total}`,
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
  //
  // Отбор ТОТ ЖЕ, что у списка по умолчанию: он прячет записи проверок
  // (следы прогонов и участников тестовых сессий). Без этого условия
  // сравнение шло с другой выборкой, и проверка краснела не на сортировке,
  // а на появлении участника сессии с подходящим именем.
  const edges = await sql(
    `SELECT (SELECT display_name FROM identity.users
               WHERE deleted_at IS NULL AND origin <> ALL($1::text[])
               ORDER BY lower(display_name) ASC, id ASC LIMIT 1) AS lowest,
            (SELECT display_name FROM identity.users
               WHERE deleted_at IS NULL AND origin <> ALL($1::text[])
               ORDER BY lower(display_name) DESC, id DESC LIMIT 1) AS highest`,
    [['render_check', 'load_test', 'test_session']],
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
    ['roles', 'kyc', 'projects', 'entities', 'capabilities', 'history'].every(
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
    reveal.status === 200 && reveal.json?.email === 'demo-admin@fifth.local',
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
  await founder.login('demo-founder-aero@fifth.local', DEMO_PASSWORD);
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

  // Роль организатора удалена в 2.1-W05; вторая неадминская роль — инвестор,
  // и раздел ему закрыт так же, как основателю.
  const investor = makeClient();
  await investor.login('demo-investor@fifth.local', DEMO_PASSWORD);
  const investorList = await investor.call('/v1/admin/users');
  check('Инвестору закрыт список', investorList.status === 403, `HTTP ${investorList.status}`);

  // ------------------------------------------------- [8] блокировка аккаунта
  console.warn('\n[8] Блокировка и снятие блокировки');
  const victimEmail = 'demo-investor-trial@fifth.local';
  const victim = makeClient();
  await victim.login(victimEmail, DEMO_PASSWORD);
  const meBefore = await victim.call('/v1/auth/me');
  check('До блокировки живая сессия работает', meBefore.status === 200, `HTTP ${meBefore.status}`);

  const found = await admin.call(q({ field: 'email', q: victimEmail }));
  const victimId = found.json.items[0].id;

  const noReason = await admin.call(`/v1/admin/users/${victimId}/status`, {
    method: 'PATCH',
    body: { action: 'suspend', reason: '' },
  });
  check('Блокировка без причины отвергается', noReason.status === 400, `HTTP ${noReason.status}`);

  const suspended = await admin.call(`/v1/admin/users/${victimId}/status`, {
    method: 'PATCH',
    body: { action: 'suspend', reason: 'Проверка прогоном: временная блокировка' },
  });
  check(
    'Блокировка проходит и возвращает карточку',
    suspended.status === 200 && suspended.json?.status === 'suspended',
    `HTTP ${suspended.status}, статус ${suspended.json?.status}`,
  );
  check(
    'Причина и автор блокировки видны в карточке',
    suspended.json?.statusReason?.includes('Проверка прогоном') &&
      suspended.json?.statusChangedBy === adminId,
    `${suspended.json?.statusReason} · ${suspended.json?.statusChangedByName}`,
  );

  const meAfter = await victim.call('/v1/auth/me');
  check(
    'Уже выданная сессия заблокированного перестала работать',
    meAfter.status === 401,
    `HTTP ${meAfter.status}`,
  );

  const reLogin = makeClient();
  const reLoginResult = await reLogin.call('/v1/auth/login', {
    method: 'POST',
    body: { email: victimEmail, password: DEMO_PASSWORD },
  });
  check(
    'Заблокированный не может войти заново',
    reLoginResult.status === 401 || reLoginResult.status === 403,
    `HTTP ${reLoginResult.status}`,
  );

  const twice = await admin.call(`/v1/admin/users/${victimId}/status`, {
    method: 'PATCH',
    body: { action: 'suspend', reason: 'Повторная блокировка' },
  });
  check(
    'Повторная блокировка отвергается, а не переписывает',
    twice.status === 409,
    `HTTP ${twice.status}`,
  );

  const self = await admin.call(`/v1/admin/users/${adminId}/status`, {
    method: 'PATCH',
    body: { action: 'suspend', reason: 'Попытка запереть себя' },
  });
  check('Себя заблокировать нельзя', self.status === 403, `HTTP ${self.status}`);

  const restored = await admin.call(`/v1/admin/users/${victimId}/status`, {
    method: 'PATCH',
    body: { action: 'restore', reason: 'Проверка прогоном: снятие блокировки' },
  });
  check(
    'Снятие блокировки возвращает в положенное состояние',
    restored.status === 200 && restored.json?.status === 'active',
    `HTTP ${restored.status}, статус ${restored.json?.status}`,
  );

  const backIn = makeClient();
  const backInResult = await backIn.call('/v1/auth/login', {
    method: 'POST',
    body: { email: victimEmail, password: DEMO_PASSWORD },
  });
  check(
    'После снятия блокировки вход снова работает',
    backInResult.status === 200 || backInResult.status === 201,
    `HTTP ${backInResult.status}`,
  );

  const journal = await sql(
    `SELECT verb, context_jsonb->>'reason' AS reason FROM audit.events
      WHERE subject_id = $1 AND verb IN ('identity.user.suspended','identity.user.restored')
      ORDER BY ts DESC LIMIT 2`,
    [victimId],
  );
  check(
    'Обе операции записаны в журнал вместе с причиной',
    journal.length === 2 &&
      journal.every((row) => typeof row.reason === 'string' && row.reason.length > 3),
    journal.map((r) => `${r.verb}: ${r.reason}`).join(' | '),
  );

  // --------------------------------------------- [9] правка обычного поля
  console.warn('\n[9] Изменение обычного профильного поля');
  // Имя берётся из карточки ДО правки, а не из ответа предыдущей проверки:
  // если та упала, прогон не должен записать в базу `undefined` вместо имени.
  const beforeRename = await admin.call(`/v1/admin/users/${victimId}`);
  const originalName = beforeRename.json.displayName;
  const renamed = await admin.call(`/v1/admin/users/${victimId}/profile`, {
    method: 'PATCH',
    body: { displayName: 'Роман Ковалёв (проверка)' },
  });
  check(
    'Имя меняется администратором',
    renamed.status === 200 && renamed.json?.displayName === 'Роман Ковалёв (проверка)',
    `HTTP ${renamed.status}`,
  );
  const tooShort = await admin.call(`/v1/admin/users/${victimId}/profile`, {
    method: 'PATCH',
    body: { displayName: 'я' },
  });
  check('Слишком короткое имя отвергается', tooShort.status === 400, `HTTP ${tooShort.status}`);
  const extraField = await admin.call(`/v1/admin/users/${victimId}/profile`, {
    method: 'PATCH',
    body: { displayName: 'Роман Ковалёв', status: 'active' },
  });
  check(
    'Через правку профиля нельзя протащить чужое поле',
    extraField.status === 400,
    `HTTP ${extraField.status}`,
  );
  const back = await admin.call(`/v1/admin/users/${victimId}/profile`, {
    method: 'PATCH',
    body: { displayName: originalName },
  });
  check('Имя возвращено на место', back.json?.displayName === originalName, originalName);

  const profileJournal = await sql(
    // Контекст автора (блок 10) — отдельный ключ actor: содержимое сверяется без него.
    `SELECT (context_jsonb - 'actor')::text AS ctx, context_jsonb->'actor'->>'role' AS role,
            context_jsonb->'actor'->'basis'->0->>'check' AS basis FROM audit.events
      WHERE subject_id = $1 AND verb = 'identity.user.profile_updated'
      ORDER BY ts DESC LIMIT 1`,
    [victimId],
  );
  check(
    'В журнале — что изменено, но не само значение',
    profileJournal[0]?.ctx === '{"field": "displayName"}',
    profileJournal[0]?.ctx,
  );
  check(
    'Автор правки в журнале — администратор по пройденной проверке маршрута',
    profileJournal[0]?.role === 'admin' && profileJournal[0]?.basis === 'route-role',
    `${profileJournal[0]?.role} / ${profileJournal[0]?.basis}`,
  );
} catch (error) {
  failed += 1;
  console.error(`\nПрогон прерван: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  /*
   * Восстановление демонстрационной записи обязательно.
   *
   * Прогон блокирует `demo-investor-trial`, чтобы проверить блокировку. Если
   * он прерывается между блокировкой и снятием — а однажды так и вышло,
   * прогон упёрся в ограничение частоты, — учётная запись остаётся
   * заблокированной. Дальше под ней не входит ни этот прогон, ни человек на
   * приёмке, и выглядит это как дефект платформы.
   *
   * Поэтому снятие блокировки стоит здесь, а не только в успешном пути.
   */
  try {
    const restored = await pool.query(
      `UPDATE identity.users SET status = 'active', status_reason = NULL,
              status_changed_at = now()
        WHERE origin = 'seed_demo' AND status = 'suspended'`,
    );
    if ((restored.rowCount ?? 0) > 0) {
      console.warn(`  (восстановлено демонстрационных записей: ${restored.rowCount})`);
    }
  } catch {
    console.warn('  (восстановить демонстрационные записи не удалось — проверьте вручную)');
  }
  await pool.end();
}

console.warn('\n--- ИТОГ ---');
console.warn(`  пройдено: ${passed}, дефектов: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
