#!/usr/bin/env node
/**
 * Живой прогон фазы «KYC и проекты».
 *
 * Проверяет ФАКТИЧЕСКОЕ поведение запущенного core: изоляцию чужих проектов,
 * условия публикации листинга, границу публичного каталога, режимы видимости
 * и личный допуск, подписанную загрузку в реальное хранилище и барьеры
 * комплаенса. Это доказательство фазы;
 * без вывода этого скрипта «работает» говорить нельзя (RULES.md §2).
 *
 * Часть предусловий создаётся напрямую в БД — и только та, для которой ещё нет
 * API: роль администратора (её выдаёт не приложение, а оператор) и вторая
 * роль постороннего основателя. Всё остальное идёт строго через HTTP, как
 * ходил бы настоящий клиент.
 *
 * Запуск: node scripts/smoke-lab.mjs [--api http://127.0.0.1:4300]
 */
import pg from 'pg';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const apiIndex = process.argv.indexOf('--api');
const BASE = apiIndex >= 0 ? process.argv[apiIndex + 1] : CORE_URL;

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

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'ul_csrf';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL_OWNER,
  max: 4,
  application_name: 'fifth-smoke-lab',
});

async function sql(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows;
}

// --------------------------------------------------------------- HTTP-клиент

async function raw(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* не JSON — бывает */
  }
  return { response, json, text };
}

/** Клиент с сессией: хранит cookie и подставляет CSRF-заголовок сам. */
function makeClient() {
  const state = { session: null, csrf: null };

  function cookieHeader() {
    return [state.session, state.csrf].filter(Boolean).join('; ');
  }

  async function call(path, { method = 'GET', body } = {}) {
    const headers = { Cookie: cookieHeader() };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) {
      headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
    }
    const result = await raw(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookies = result.response.headers.getSetCookie?.() ?? [];
    for (const cookie of setCookies) {
      const pair = cookie.split(';')[0];
      if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
      if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
    }
    return result;
  }

  return { call, state };
}

const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

const suffix = `${Date.now() % 1e9}`;
// ИНН и ОГРН уникальны на прогон: они уникальны и в схеме, поэтому фиксированное
// значение делало бы второй запуск скрипта заведомо красным.
const TEST_INN = `77${suffix.padStart(8, '0').slice(-8)}`;
const TEST_OGRN = `1${suffix.padStart(12, '0').slice(-12)}`;

async function register(role, tag, extra = {}) {
  const client = makeClient();
  const email = `lab-${tag}-${suffix}@test.local`;
  const password = `Pw-${crypto.randomUUID()}`;
  const { response, json } = await client.call('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: `Тест ${tag}`,
      role,
      locale: 'ru-RU',
      consents: CONSENTS,
      ...extra,
    },
  });
  if (response.status >= 400) {
    throw new Error(`регистрация ${tag} не удалась: ${response.status} ${JSON.stringify(json)}`);
  }
  const userId = await findUserIdByEmail(email);
  if (!userId) throw new Error(`пользователь ${tag} не найден по blind index`);
  return { client, email, password, userId };
}

/**
 * Находит пользователя тем же blind index, что считает приложение.
 *
 * Выбирать «последнего созданного» здесь нельзя: скрипт регистрирует несколько
 * аккаунтов подряд, и такой поиск дал бы зелёный результат по неверной причине.
 */
async function findUserIdByEmail(email) {
  const index = createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
  const [row] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [index]);
  return row?.id ?? null;
}

console.warn('\n=== ЖИВОЙ ПРОГОН: KYC, ПРОЕКТЫ, КАТАЛОГ ===\n');

// ------------------------------------------------------------ публичный контур
{
  const { response, json } = await raw('/v1/taxonomy');
  check('справочник направлений публичен', response.status === 200, `статус ${response.status}`);
  check('направления засеяны', (json?.items?.length ?? 0) >= 12, `узлов ${json?.items?.length}`);
}
{
  const { response, json } = await raw('/v1/catalog');
  check('каталог доступен без авторизации', response.status === 200, `статус ${response.status}`);
  check('ответ каталога — страница', Array.isArray(json?.items) && 'nextCursor' in (json ?? {}));
}
{
  const { response, json } = await raw('/v1/catalog?sort=irs_desc');
  check(
    'сортировка по несуществующему скорингу отвергнута',
    response.status === 400 && json?.code === 'validation_failed',
    `статус ${response.status}`,
  );
}
{
  const { response } = await raw('/v1/catalog?cursor=%7B%22v%22%3A1%7D');
  check('повреждённый курсор отвергнут', response.status === 400, `статус ${response.status}`);
}
{
  const { response } = await raw('/v1/projects');
  check('кабинет проектов закрыт без токена', response.status === 401, `статус ${response.status}`);
}
{
  const { response } = await raw('/v1/kyc/verifications');
  check(
    'контур комплаенса закрыт без токена',
    response.status === 401,
    `статус ${response.status}`,
  );
}

// ------------------------------------------------------------- основатель A
const founderA = await register('founder', 'a');
const founderB = await register('founder', 'b');
const investor = await register('investor', 'inv');
const adminUser = await register('founder', 'adm');

// Роль администратора выдаётся оператором, а не приложением: назначаем её так же,
// как это делалось бы при развёртывании.
await sql(
  `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin')
   ON CONFLICT DO NOTHING`,
  [adminUser.userId],
);
// Роль в токене появится только после повторного входа — это и проверяем.
const adminClient = makeClient();
{
  const { json } = await adminClient.call('/v1/auth/login', {
    method: 'POST',
    body: { email: adminUser.email, password: adminUser.password },
  });
  check(
    'роль администратора попадает в сессию после повторного входа',
    json?.roles?.includes('admin'),
    `роли ${json?.roles}`,
  );
}

let projectId = null;
{
  const { response, json } = await founderA.client.call('/v1/projects', {
    method: 'POST',
    body: {
      title: 'Ортоцентрикс — платформа диагностики',
      tagline: 'Быстрая диагностика без очередей',
      description: 'Внутренняя метрика: маржинальность 42 процента и удержание когорт.',
      stage: 'mvp',
      taxonomyId: (await sql(`SELECT id FROM lab.project_taxonomy WHERE slug = 'healthtech'`))[0]
        .id,
      investmentAsk: '5000000.00',
      askCurrency: 'RUB',
      geoCountry: 'RU',
    },
  });
  projectId = json?.id ?? null;
  check(
    'проект создан',
    response.status === 201 || response.status === 200,
    `статус ${response.status}`,
  );
  check(
    'проект создан как черновик',
    json?.status === 'draft' && json?.listingStatus === 'not_listed',
  );
}

// --------------------------------------------------------------------- IDOR
{
  const { response, json } = await founderB.client.call(`/v1/projects/${projectId}`);
  check('чужой проект не читается', response.status === 404, `статус ${response.status}`);
  check('ответ не подтверждает существование чужого проекта', json?.code === 'not_found');
}
{
  const { response } = await founderB.client.call(`/v1/projects/${projectId}`, {
    method: 'PATCH',
    body: { title: 'Захвачено' },
  });
  check('чужой проект не изменяется', response.status === 404, `статус ${response.status}`);
}
{
  // Строка проекта инвестору закрыта ролью (403); карточка — только Investor
  // View по предикату (непубличный проект — 404).
  const { response } = await investor.client.call(`/v1/projects/${projectId}`);
  const view = await investor.client.call(`/v1/projects/${projectId}/investor-view`);
  check(
    'инвестор не видит непубличную карточку: строка проекта 403, Investor View 404',
    response.status === 403 && view.response.status === 404,
    `статусы ${response.status} ${view.response.status}`,
  );
}

// ------------------------------------------------------------------ листинг
{
  const { response, json } = await founderA.client.call(`/v1/projects/${projectId}/listing`, {
    method: 'POST',
  });
  check(
    'публикация без действующего KYC отклонена',
    response.status === 403 && json?.code === 'kyc_required',
    `статус ${response.status} ${json?.code ?? ''}`,
  );
}

// ------------------------------------------------------------------ KYC
let verificationId = null;
{
  const { response, json } = await founderA.client.call('/v1/kyc/verifications', {
    method: 'POST',
    body: { kind: 'identity', docType: 'passport', docCountry: 'RU' },
  });
  verificationId = json?.id ?? null;
  check(
    'заявка на верификацию создана',
    response.status === 201 || response.status === 200,
    `статус ${response.status}`,
  );
  check('заявка в статусе pending', json?.status === 'pending', json?.status ?? '');
}
{
  const { json } = await founderA.client.call('/v1/kyc/verifications', {
    method: 'POST',
    body: { kind: 'identity', docType: 'passport', docCountry: 'RU' },
  });
  check('повторная подача не плодит заявки', json?.id === verificationId);
}
{
  const { response } = await founderA.client.call(
    `/v1/kyc/verifications/${verificationId}/decision`,
    {
      method: 'POST',
      body: { decision: 'approved' },
    },
  );
  check(
    'пользователь не может одобрить себя сам',
    response.status === 403,
    `статус ${response.status}`,
  );
}
{
  const { response, json } = await adminClient.call('/v1/kyc/queue');
  check(
    'очередь комплаенса доступна администратору',
    response.status === 200,
    `статус ${response.status}`,
  );

  // Очередь листается курсором. Раньше здесь стояла проверка «заявка в первой
  // странице», и она падала, как только ожидающих становилось больше предела:
  // отдавались 50 САМЫХ СТАРЫХ, а способа дойти до остальных не было вовсе.
  // Теперь проверяется то, что и должно быть верно: до заявки можно дойти.
  let found = (json?.items ?? []).some((v) => v.id === verificationId);
  let cursor = json?.nextCursor ?? null;
  let pages = 1;
  while (!found && cursor && pages < 50) {
    const next = await adminClient.call(`/v1/kyc/queue?cursor=${encodeURIComponent(cursor)}`);
    found = (next.json?.items ?? []).some((v) => v.id === verificationId);
    cursor = next.json?.nextCursor ?? null;
    pages += 1;
  }
  check('заявка основателя достижима в очереди', found, `страниц просмотрено: ${pages}`);
  check(
    'повреждённый курсор отвергается, а не возвращает начало очереди',
    (await adminClient.call('/v1/kyc/queue?cursor=%D0%BC%D1%83%D1%81%D0%BE%D1%80')).response
      .status === 400,
  );
}
{
  const { response, json } = await adminClient.call(
    `/v1/kyc/verifications/${verificationId}/decision`,
    {
      method: 'POST',
      body: { decision: 'approved', riskLevel: 'low' },
    },
  );
  check(
    'комплаенс одобрил верификацию',
    response.status === 201 || response.status === 200,
    `статус ${response.status}`,
  );
  check('статус стал approved', json?.status === 'approved', json?.status ?? '');
}
{
  // Администратор подаёт заявку на себя и пробует её же одобрить.
  const own = await adminClient.call('/v1/kyc/verifications', {
    method: 'POST',
    body: { kind: 'identity', docType: 'passport', docCountry: 'RU' },
  });
  const { response, json } = await adminClient.call(
    `/v1/kyc/verifications/${own.json?.id}/decision`,
    { method: 'POST', body: { decision: 'approved' } },
  );
  check(
    'администратор не может одобрить СВОЮ заявку',
    response.status === 403,
    `статус ${response.status} ${json?.code ?? ''}`,
  );
}
{
  const { response, json } = await adminClient.call(
    `/v1/kyc/verifications/${verificationId}/decision`,
    {
      method: 'POST',
      body: { decision: 'rejected', reason: 'повторное решение' },
    },
  );
  check(
    'повторное решение по закрытой заявке отвергнуто',
    response.status === 409,
    `статус ${response.status} ${json?.code ?? ''}`,
  );
}

// --------------------------------------------------------------- юрлицо и KYB
let entityId = null;
{
  const { response, json } = await founderA.client.call('/v1/kyc/entities', {
    method: 'POST',
    body: {
      legalName: 'ООО «Ортоцентрикс»',
      legalForm: 'ООО',
      inn: TEST_INN,
      ogrn: TEST_OGRN,
      jurisdiction: 'RU',
    },
  });
  entityId = json?.id ?? null;
  check(
    'юрлицо заведено',
    response.status === 201 || response.status === 200,
    `статус ${response.status}`,
  );
  check('ИНН маскируется', /^\*+\d{4}$/.test(json?.innMasked ?? ''), json?.innMasked ?? '');
  check('KYB ещё не пройден', json?.kybApproved === false);

  const [row] = await sql('SELECT inn_ciphertext FROM kyc.business_entities WHERE id = $1', [
    entityId,
  ]);
  check(
    'ИНН в базе хранится зашифрованным',
    Buffer.isBuffer(row?.inn_ciphertext) && !row.inn_ciphertext.toString('utf8').includes(TEST_INN),
  );
}
{
  const { response } = await founderA.client.call('/v1/kyc/entities', {
    method: 'POST',
    body: {
      legalName: 'Дубль',
      inn: TEST_INN,
      ogrn: TEST_OGRN,
      jurisdiction: 'RU',
    },
  });
  check('дубликат юрлица по ИНН отклонён', response.status === 409, `статус ${response.status}`);
}
{
  // Одновременное создание одного и того же юрлица. Проверяется НАБЛЮДАЕМОЕ:
  // ни одного 5xx и ровно одно созданное юрлицо.
  //
  // Честная оговорка: локально эта проверка проходит и с переводом ошибки
  // 23505 в доменный отказ, и без него — запросы успевают сериализоваться, и
  // окно между проверкой дубликата и вставкой не достигается. В отличие от
  // гейта гонки регистрации (там окно расширено хешированием пароля и падение
  // на прежнем коде воспроизведено), здесь это защита от регрессии по смыслу,
  // а не проверенный на падение гейт.
  const raceInn = `77${String(Date.now() % 100000000).padStart(8, '0')}`;
  const body = {
    legalName: 'Гонка юрлица',
    inn: raceInn,
    ogrn: TEST_OGRN,
    jurisdiction: 'RU',
  };
  const attempts = await Promise.all(
    Array.from({ length: 4 }, () =>
      founderA.client.call('/v1/kyc/entities', { method: 'POST', body }),
    ),
  );
  const statuses = attempts.map((a) => a.response.status);
  check(
    'одновременное создание юрлица не даёт внутренней ошибки',
    statuses.every((s) => s < 500),
    `статусы: ${[...new Set(statuses)].join(',')}`,
  );
  check(
    'из одновременных созданий проходит ровно одно',
    statuses.filter((s) => s === 200 || s === 201).length === 1,
    `создано: ${statuses.filter((s) => s === 200 || s === 201).length}`,
  );
}
{
  const { response } = await founderB.client.call(`/v1/kyc/entities/${entityId}/kyb`, {
    method: 'POST',
    body: { kind: 'registry_check' },
  });
  check(
    'посторонний не подаёт чужое юрлицо на проверку',
    response.status === 404,
    `статус ${response.status}`,
  );
}
let kybId;
{
  const { response, json } = await founderA.client.call(`/v1/kyc/entities/${entityId}/kyb`, {
    method: 'POST',
    body: { kind: 'registry_check' },
  });
  kybId = json?.id ?? null;
  check(
    'проверка юрлица запрошена',
    response.status === 201 || response.status === 200,
    `статус ${response.status}`,
  );
}
{
  const { response, json } = await adminClient.call(`/v1/kyc/kyb/${kybId}/decision`, {
    method: 'POST',
    body: { decision: 'approved' },
  });
  check('KYB одобрен комплаенсом', json?.status === 'approved', `статус ${response.status}`);

  const { json: list } = await founderA.client.call('/v1/kyc/entities');
  const entity = (list?.items ?? []).find((e) => e.id === entityId);
  check('юрлицо помечено проверенным', entity?.kybApproved === true);
}

// ------------------------------------------------------------------ листинг
// Публикация бесплатна: денежного контура нет (2.1-W05). Проверяется, что
// листинг открывается после KYC и что рост суммы у опубликованного проекта
// ничего не ломает.
{
  const { response, json } = await founderA.client.call(`/v1/projects/${projectId}/listing`, {
    method: 'POST',
  });
  check(
    'листинг опубликован без оплаты',
    response.status === 201 || response.status === 200,
    `статус ${response.status} ${json?.code ?? ''}`,
  );
  check('статус листинга — listed', json?.listingStatus === 'listed', json?.listingStatus ?? '');
  check('дата публикации проставлена', Boolean(json?.listedAt));
}
{
  const { response, json } = await founderA.client.call(`/v1/projects/${projectId}`, {
    method: 'PATCH',
    body: { investmentAsk: '80000000.00' },
  });
  const [row] = await sql('SELECT investment_ask::text AS ask FROM lab.projects WHERE id = $1', [
    projectId,
  ]);
  check(
    'рост запроса у опубликованного проекта проходит',
    response.status === 200,
    `статус ${response.status} ${json?.code ?? ''}`,
  );
  check('сумма запроса обновилась', row?.ask === '80000000.00', row?.ask ?? '');
  const restored = await founderA.client.call(`/v1/projects/${projectId}`, {
    method: 'PATCH',
    body: { investmentAsk: '5000000.00' },
  });
  check('сумма возвращена к исходной', restored.response.status === 200);
}

// ------------------------------------------------------------------ каталог
{
  const { response, json } = await raw('/v1/catalog');
  const item = (json?.items ?? []).find((i) => i.id === projectId);
  check('листинг виден в публичном каталоге', response.status === 200 && Boolean(item));
  check('в тизере нет описания', item !== undefined && !('description' in item));
  check('в тизере нет внутреннего статуса', item !== undefined && !('status' in item));
}
{
  const { json } = await raw('/v1/catalog?q=диагностики');
  check(
    'поиск находит по заголовку',
    (json?.items ?? []).some((i) => i.id === projectId),
    `найдено ${json?.items?.length}`,
  );
}
{
  const { json } = await raw('/v1/catalog?q=маржинальность');
  check(
    'публичный поиск НЕ находит по непубличному описанию',
    !(json?.items ?? []).some((i) => i.id === projectId),
    `найдено ${json?.items?.length}`,
  );
}
{
  const { response, json } = await raw(`/v1/catalog/${projectId}`);
  check('карточка тизера доступна анонимно', response.status === 200, `статус ${response.status}`);
  check('тизер не содержит описания', !('description' in (json ?? {})));
}

// Второй листинг — чтобы проверить keyset-пагинацию на реальных данных.
let secondProjectId;
{
  const { json } = await founderA.client.call('/v1/projects', {
    method: 'POST',
    body: {
      title: 'Второй проект основателя',
      tagline: 'Для проверки пагинации',
      stage: 'idea',
      taxonomyId: (await sql(`SELECT id FROM lab.project_taxonomy WHERE slug = 'ai'`))[0].id,
      investmentAsk: '900000.00',
      askCurrency: 'RUB',
    },
  });
  secondProjectId = json.id;
  await founderA.client.call(`/v1/projects/${secondProjectId}/listing`, { method: 'POST' });

  const first = await raw('/v1/catalog?limit=1');
  check(
    'страница ограничена лимитом',
    first.json?.items?.length === 1,
    `элементов ${first.json?.items?.length}`,
  );
  check('курсор следующей страницы выдан', typeof first.json?.nextCursor === 'string');

  const second = await raw(
    `/v1/catalog?limit=1&cursor=${encodeURIComponent(first.json.nextCursor)}`,
  );
  check(
    'вторая страница не повторяет первую',
    second.json?.items?.[0]?.id !== first.json?.items?.[0]?.id,
  );
}

// ------------------------------------------- инвестор без личного разрешения
// Допуска инвестора по роли нет (2.1-W05): он держался на подписке, а подписки
// удалены. В режиме public инвестор без разрешения видит ровно то же, что
// аноним: тизер и описание, без материалов.
{
  const { response, json } = await investor.client.call(`/v1/projects/${projectId}/investor-view`);
  check(
    'инвестор без разрешения в режиме public видит карточку на уровне анонима',
    response.status === 200 &&
      json?.access?.profile === 'public' &&
      json?.access?.materials === null &&
      json?.grant === null,
    `статус ${response.status} ${JSON.stringify(json?.access ?? null)}`,
  );
  check(
    'карточка содержит описание, материалов нет',
    typeof json?.description === 'string' && json?.materials === null,
  );
  // Кабинетные маршруты проекта — только команде (роль founder или admin).
  const old = await Promise.all(
    ['', '/materials'].map((p) => investor.client.call(`/v1/projects/${projectId}${p}`)),
  );
  check(
    'кабинетные маршруты инвестору закрыты: строка проекта и материалы — 403',
    old.every((r) => r.response.status === 403),
    old.map((r) => r.response.status).join(' '),
  );
}
{
  const { response } = await investor.client.call(`/v1/projects/${secondProjectId}`, {
    method: 'PATCH',
    body: { title: 'Инвестор правит чужое' },
  });
  check(
    'инвестор не может править чужой проект',
    response.status === 403 || response.status === 404,
    `статус ${response.status}`,
  );
}

// ---------------------------------------------------------------- материалы
{
  const { response } = await founderA.client.call(`/v1/projects/${projectId}/materials/link`, {
    method: 'POST',
    body: { url: 'http://example.com/product' },
  });
  check('ссылка по http отклонена', response.status === 400, `статус ${response.status}`);
}
{
  const { response } = await founderA.client.call(`/v1/projects/${projectId}/materials/link`, {
    method: 'POST',
    body: { url: 'https://169.254.169.254/latest/meta-data' },
  });
  check(
    'ссылка на адрес метаданных отклонена',
    response.status === 400,
    `статус ${response.status}`,
  );
}
{
  const { response, json } = await founderA.client.call(
    `/v1/projects/${projectId}/materials/link`,
    {
      method: 'POST',
      body: { url: 'https://ortocentrix.example/product' },
    },
  );
  check(
    'ссылка на продукт добавлена',
    response.status === 201 || response.status === 200,
    `статус ${response.status}`,
  );
  check('материал не раскрывает путь в хранилище', !('s3Key' in (json ?? {})));
}

let ticket;
{
  const { response, json } = await founderA.client.call(
    `/v1/projects/${projectId}/materials/upload`,
    {
      method: 'POST',
      body: {
        type: 'deck',
        fileName: 'deck.pdf',
        contentType: 'application/pdf',
        sizeBytes: 2048,
      },
    },
  );
  ticket = json;
  check(
    'билет на загрузку выдан',
    response.status === 201 || response.status === 200,
    `статус ${response.status}`,
  );
  check('подписан лимит размера', typeof json?.maxSizeBytes === 'number' && json.maxSizeBytes > 0);
  check(
    'секрет хранилища не утёк в билет',
    !JSON.stringify(json ?? {}).includes(process.env.S3_SECRET_ACCESS_KEY ?? 'нет-ключа'),
  );
}
{
  const form = new FormData();
  for (const [key, value] of Object.entries(ticket.formFields)) form.append(key, value);
  form.append('file', new Blob([Buffer.from('%PDF-1.4 тестовая презентация')]), 'deck.pdf');
  const upload = await fetch(ticket.uploadUrl, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
  check(
    'файл принят хранилищем по подписанной форме',
    upload.status === 204 || upload.status === 200,
    `статус ${upload.status}`,
  );
}
{
  // Подпись покрывает Content-Type: подмена обязана быть отвергнута хранилищем.
  const form = new FormData();
  for (const [key, value] of Object.entries(ticket.formFields)) {
    form.append(key, key === 'Content-Type' ? 'text/html' : value);
  }
  form.append('file', new Blob([Buffer.from('<script>alert(1)</script>')]), 'x.html');
  const upload = await fetch(ticket.uploadUrl, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
  check('подмена типа содержимого отвергнута', upload.status >= 400, `статус ${upload.status}`);
}
{
  const { response } = await founderB.client.call(`/v1/projects/${projectId}/materials/upload`, {
    method: 'POST',
    body: { type: 'deck', fileName: 'чужой.pdf', contentType: 'application/pdf', sizeBytes: 1024 },
  });
  check(
    'посторонний не получает билет на чужой проект',
    response.status === 404,
    `статус ${response.status}`,
  );
}

// ------------------------------------------------------------- снятие листинга
{
  const { response, json } = await founderA.client.call(`/v1/projects/${projectId}/listing`, {
    method: 'DELETE',
  });
  check('листинг снят владельцем', response.status === 200, `статус ${response.status}`);
  check('статус стал unlisted', json?.listingStatus === 'unlisted', json?.listingStatus ?? '');

  const { json: catalog } = await raw('/v1/catalog');
  check(
    'снятый листинг исчез из каталога',
    !(catalog?.items ?? []).some((i) => i.id === projectId),
  );

  const [row] = await sql('SELECT title FROM lab.projects WHERE id = $1', [projectId]);
  check('данные проекта при снятии сохраняются', Boolean(row?.title));
}

// --------------------------------------------------------- журнал и партиции
{
  const rows = await sql(
    `SELECT verb FROM audit.events
      WHERE subject_id = $1 ORDER BY ts`,
    [projectId],
  );
  const verbs = rows.map((r) => r.verb);
  check('создание проекта попало в журнал', verbs.includes('lab.project.created'));
  check('публикация листинга попала в журнал', verbs.includes('lab.listing.published'));
  check('снятие листинга попало в журнал', verbs.includes('lab.listing.unpublished'));
}
{
  const broken = await sql('SELECT * FROM audit.verify_event_chain(NULL)');
  check('цепочка журнала цела', broken.length === 0, `разрывов ${broken.length}`);
}
{
  const outbox = await sql(
    `SELECT event_type FROM audit.outbox_events WHERE aggregate_id = $1 ORDER BY created_at`,
    [projectId],
  );
  check(
    'события выложены в outbox для потребителей',
    outbox.some((r) => r.event_type === 'lab.listing.published'),
    `событий ${outbox.length}`,
  );
}
{
  const parts = await sql(
    `SELECT count(*)::int AS n FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = 'events'`,
  );
  // Плановое обслуживание создаёт предыдущий, текущий и PARTITION_MONTHS_AHEAD
  // будущих месяцев: минимум пять партиций при значении по умолчанию.
  check(
    'партиции журнала созданы плановой задачей',
    (parts[0]?.n ?? 0) >= 5,
    `партиций ${parts[0]?.n}`,
  );
}

// ------------------------------------------------- режимы видимости и допуск
// Доступ наружу решает режим проекта и личные разрешения владельца
// (`lab.project_audience`). Допуска по роли нет (2.1-W05): public открывает
// внешнему зрителю тизер и описание, registered_investors вне команды не
// открывает ничего, selected_investors — только по личному разрешению.
// Подробно выдачу и отзыв разрешений проверяет scripts/smoke-project-access.mjs;
// здесь — сквозной путь на одном проекте.
console.warn('\n[видимость] режимы проекта, личное разрешение, материалы, исключения');
{
  const projectC = await founderA.client.call('/v1/projects', {
    method: 'POST',
    body: {
      title: `Режимы видимости ${suffix}`,
      tagline: 'Проверка режимов',
      description: 'Описание для проверки режимов видимости.',
      stage: 'idea',
      taxonomyId: (await sql("SELECT id FROM lab.project_taxonomy WHERE slug = 'ai'"))[0].id,
      investmentAsk: '1000000.00',
      askCurrency: 'RUB',
    },
  });
  const projectCId = projectC.json?.id;
  check(
    'проект для режимов создан',
    projectC.response.status === 201,
    `статус ${projectC.response.status}`,
  );
  {
    const anonBefore = await raw(`/v1/catalog/${projectCId}`);
    check(
      'неопубликованный проект: тизера нет',
      anonBefore.response.status === 404,
      `статус ${anonBefore.response.status}`,
    );
  }
  const listed = await founderA.client.call(`/v1/projects/${projectCId}/listing`, {
    method: 'POST',
  });
  check(
    'публикация ставит режим public',
    listed.response.status === 201 && listed.json?.visibility === 'public',
    `статус ${listed.response.status} ${listed.json?.visibility ?? ''}`,
  );

  // ------------------------------------------------ public: Public View
  {
    const anonView = await raw(`/v1/catalog/${projectCId}`);
    check(
      'Public View анониму: тизер без описания',
      anonView.response.status === 200 &&
        anonView.json?.id === projectCId &&
        typeof anonView.json?.title === 'string' &&
        !('description' in (anonView.json ?? {})),
      `статус ${anonView.response.status}`,
    );
    const stranger = await founderB.client.call(`/v1/projects/${projectCId}/investor-view`);
    check(
      'Investor View чужому основателю: профиль публичный, материалы закрыты',
      stranger.response.status === 200 &&
        stranger.json?.access?.profile === 'public' &&
        stranger.json?.access?.materials === null &&
        stranger.json?.materials === null,
      `статус ${stranger.response.status} ${JSON.stringify(stranger.json?.access ?? null)}`,
    );

    const previewPublic = await founderA.client.call(
      `/v1/projects/${projectCId}/view-preview?audience=public`,
    );
    check(
      'предпросмотр владельца для анонима: режим и аудитория названы явно',
      previewPublic.response.status === 200 &&
        previewPublic.json?.audienceSummary?.mode === 'public' &&
        previewPublic.json?.audienceSummary?.anonymous === true &&
        previewPublic.json?.audienceSummary?.investors === 'never' &&
        previewPublic.json?.view?.access?.materials === null,
      `статус ${previewPublic.response.status} ${JSON.stringify(previewPublic.json?.audienceSummary ?? null)}`,
    );
    const previewInvestors = await founderA.client.call(
      `/v1/projects/${projectCId}/view-preview?audience=investors`,
    );
    check(
      'предпросмотр для инвестора без разрешения совпадает с анонимом: профиль public, материалов нет',
      previewInvestors.response.status === 200 &&
        previewInvestors.json?.view?.access?.profile === 'public' &&
        previewInvestors.json?.view?.access?.materials === null &&
        previewInvestors.json?.view?.materials === null,
      `статус ${previewInvestors.response.status} ${JSON.stringify(previewInvestors.json?.view?.access ?? null)}`,
    );
    const previewByStranger = await founderB.client.call(
      `/v1/projects/${projectCId}/view-preview?audience=public`,
    );
    check(
      'предпросмотр чужого проекта запрещён',
      previewByStranger.response.status === 403,
      `статус ${previewByStranger.response.status}`,
    );
  }

  // ------------------------------------------------------- материалы
  // Материал закрыт по умолчанию; отметка «инвесторам» в режиме public его
  // наружу не открывает — материалы видит только получатель разрешения.
  const link = await founderA.client.call(`/v1/projects/${projectCId}/materials/link`, {
    method: 'POST',
    body: { url: 'https://example.com/product-modes' },
  });
  const materialId = link.json?.id;
  const marked = await founderA.client.call(
    `/v1/projects/${projectCId}/materials/${materialId}/visibility`,
    { method: 'PUT', body: { visibility: 'investors' } },
  );
  check(
    'материал закрыт по умолчанию, отметка «инвесторам» ставится владельцем',
    link.response.status === 201 &&
      link.json?.visibility === 'private' &&
      marked.response.status === 200 &&
      marked.json?.visibility === 'investors',
    `${link.response.status} ${link.json?.visibility} ${marked.response.status}`,
  );
  const publicMark = await founderA.client.call(
    `/v1/projects/${projectCId}/materials/${materialId}/visibility`,
    { method: 'PUT', body: { visibility: 'public' } },
  );
  check(
    'отметка public для материала не принимается',
    publicMark.response.status === 400,
    `${publicMark.response.status}`,
  );
  {
    const afterMark = await investor.client.call(`/v1/projects/${projectCId}/investor-view`);
    check(
      'отмеченный материал инвестору без разрешения не открыт',
      afterMark.response.status === 200 &&
        afterMark.json?.access?.materials === null &&
        afterMark.json?.materials === null,
      `${afterMark.response.status} ${JSON.stringify(afterMark.json?.access ?? null)}`,
    );
  }

  // ------------------------------------------- registered_investors
  {
    const registered = await founderA.client.call(`/v1/projects/${projectCId}/visibility`, {
      method: 'PUT',
      body: { visibility: 'registered_investors' },
    });
    const anonRegistered = await raw(`/v1/catalog/${projectCId}`);
    const investorRegistered = await investor.client.call(
      `/v1/projects/${projectCId}/investor-view`,
    );
    const previewRegistered = await founderA.client.call(
      `/v1/projects/${projectCId}/view-preview?audience=investors`,
    );
    check(
      'режим registered_investors: листинг остаётся, анониму и инвестору — 404',
      registered.response.status === 200 &&
        registered.json?.visibility === 'registered_investors' &&
        registered.json?.listingStatus === 'listed' &&
        anonRegistered.response.status === 404 &&
        investorRegistered.response.status === 404,
      `${registered.response.status} ${registered.json?.visibility} ${anonRegistered.response.status} ${investorRegistered.response.status}`,
    );
    check(
      'предпросмотр registered_investors: инвестор не видит ничего',
      previewRegistered.response.status === 200 &&
        previewRegistered.json?.view === null &&
        previewRegistered.json?.audienceSummary?.investors === 'never',
      `${previewRegistered.response.status} ${previewRegistered.json?.audienceSummary?.investors}`,
    );
  }

  // --------------------------------------------- selected_investors
  {
    const selected = await founderA.client.call(`/v1/projects/${projectCId}/visibility`, {
      method: 'PUT',
      body: { visibility: 'selected_investors' },
    });
    check(
      'режим «выбранные инвесторы» ставится действием владельца',
      selected.response.status === 200 && selected.json?.visibility === 'selected_investors',
      `статус ${selected.response.status} ${selected.json?.visibility ?? ''}`,
    );
    // Посторонний без разрешения не узнаёт даже о существовании проекта:
    // ни названия, ни 403 — только 404.
    const strangerSelected = await founderB.client.call(`/v1/projects/${projectCId}/investor-view`);
    const investorSelected = await investor.client.call(`/v1/projects/${projectCId}/investor-view`);
    const anonSelected = await raw(`/v1/catalog/${projectCId}`);
    check(
      'selected_investors без разрешения: посторонний, инвестор и аноним получают 404 без названия',
      strangerSelected.response.status === 404 &&
        investorSelected.response.status === 404 &&
        anonSelected.response.status === 404 &&
        !JSON.stringify(strangerSelected.json ?? '').includes('Режимы видимости'),
      `${strangerSelected.response.status} ${investorSelected.response.status} ${anonSelected.response.status}`,
    );
    const preview = await founderA.client.call(
      `/v1/projects/${projectCId}/view-preview?audience=investors`,
    );
    check(
      'предпросмотр selected_investors: инвесторы — только выбранные, вида «вообще» нет',
      preview.response.status === 200 &&
        preview.json?.view === null &&
        preview.json?.audienceSummary?.investors === 'selected',
      `${preview.response.status} ${preview.json?.audienceSummary?.investors}`,
    );

    const granted = await founderA.client.call(`/v1/projects/${projectCId}/access/grants`, {
      method: 'POST',
      body: { email: investor.email, permissions: ['profile', 'materials'] },
    });
    const grantedView = await investor.client.call(`/v1/projects/${projectCId}/investor-view`);
    check(
      'личное разрешение открывает проект получателю: профиль и отмеченные материалы',
      (granted.response.status === 201 || granted.response.status === 200) &&
        grantedView.response.status === 200 &&
        grantedView.json?.grant !== null &&
        grantedView.json?.access?.profile === 'investors' &&
        grantedView.json?.access?.materials === 'investors' &&
        (grantedView.json?.materials ?? []).some((m) => m.id === materialId),
      `${granted.response.status} ${grantedView.response.status} ${JSON.stringify(grantedView.json?.access ?? null)}`,
    );
    const otherInvestor = await founderB.client.call(`/v1/projects/${projectCId}/investor-view`);
    check(
      'разрешение одному не открывает проект другим',
      otherInvestor.response.status === 404,
      `${otherInvestor.response.status}`,
    );
    const revoked = await founderA.client.call(
      `/v1/projects/${projectCId}/access/grants/${granted.json?.id}`,
      { method: 'DELETE' },
    );
    const afterRevoke = await investor.client.call(`/v1/projects/${projectCId}/investor-view`);
    check(
      'отзыв разрешения снова закрывает проект',
      revoked.response.status === 204 && afterRevoke.response.status === 404,
      `${revoked.response.status} ${afterRevoke.response.status}`,
    );
  }

  // ------------------------------------------------------ исключения
  // Исключённый зритель не видит проект и в режиме public: ни Investor View,
  // ни карточки в каталоге, ни строки в списке.
  {
    await founderA.client.call(`/v1/projects/${projectCId}/visibility`, {
      method: 'PUT',
      body: { visibility: 'public' },
    });
    const excluded = await founderA.client.call(`/v1/projects/${projectCId}/access/exclusions`, {
      method: 'POST',
      body: { email: investor.email },
    });
    const excludedView = await investor.client.call(`/v1/projects/${projectCId}/investor-view`);
    const excludedItem = await investor.client.call(`/v1/catalog/${projectCId}`);
    const excludedList = await investor.client.call('/v1/catalog?limit=50');
    check(
      'исключённый инвестор: Investor View 404, карточка каталога 404, в списке нет',
      (excluded.response.status === 201 || excluded.response.status === 200) &&
        excludedView.response.status === 404 &&
        excludedItem.response.status === 404 &&
        !(excludedList.json?.items ?? []).some((i) => i.id === projectCId),
      `${excluded.response.status} ${excludedView.response.status} ${excludedItem.response.status}`,
    );
    const lifted = await founderA.client.call(
      `/v1/projects/${projectCId}/access/exclusions/${excluded.json?.id}`,
      { method: 'DELETE' },
    );
    const restoredView = await investor.client.call(`/v1/projects/${projectCId}/investor-view`);
    check(
      'снятое исключение возвращает доступ режима',
      lifted.response.status === 204 && restoredView.response.status === 200,
      `${lifted.response.status} ${restoredView.response.status}`,
    );
  }

  // ------------------------------------------------ несколько ролей
  // Чужой основатель с ролью инвестора на закрытом проекте не проходит ни
  // карточкой, ни кабинетными маршрутами (роль пропускает, RLS — нет).
  {
    await sql(
      `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'investor')
       ON CONFLICT DO NOTHING`,
      [founderB.userId],
    );
    await founderB.client.call('/v1/auth/login', {
      method: 'POST',
      body: { email: founderB.email, password: founderB.password },
    });
    await founderA.client.call(`/v1/projects/${projectCId}/visibility`, {
      method: 'PUT',
      body: { visibility: 'private' },
    });
    const dualNew = await founderB.client.call(`/v1/projects/${projectCId}/investor-view`);
    const dualOld = await founderB.client.call(`/v1/projects/${projectCId}`);
    const dualMaterials = await founderB.client.call(`/v1/projects/${projectCId}/materials`);
    check(
      'founder+investor на чужом private: Investor View 404, строка 404, материалы 404',
      dualNew.response.status === 404 &&
        dualOld.response.status === 404 &&
        dualMaterials.response.status === 404,
      `${dualNew.response.status} ${dualOld.response.status} ${dualMaterials.response.status}`,
    );
    await founderA.client.call(`/v1/projects/${projectCId}/visibility`, {
      method: 'PUT',
      body: { visibility: 'public' },
    });
    const dualPublicOld = await founderB.client.call(`/v1/projects/${projectCId}/materials`);
    const dualPublicNew = await founderB.client.call(`/v1/projects/${projectCId}/investor-view`);
    check(
      'founder+investor на чужом public: список материалов — 404 (маршрут только команде), Investor View — как у анонима',
      dualPublicOld.response.status === 404 &&
        dualPublicNew.response.status === 200 &&
        dualPublicNew.json?.access?.profile === 'public' &&
        dualPublicNew.json?.access?.materials === null,
      `${dualPublicOld.response.status} ${dualPublicNew.response.status} ${JSON.stringify(dualPublicNew.json?.access ?? null)}`,
    );
  }

  // Снятие листинга = режим private: анониму 404, инвестору 404, владельцу —
  // предпросмотр «никто не увидит».
  {
    await founderA.client.call(`/v1/projects/${projectCId}/listing`, { method: 'DELETE' });
    const hidden = await raw(`/v1/catalog/${projectCId}`);
    const hiddenInv = await investor.client.call(`/v1/projects/${projectCId}/investor-view`);
    const previewPrivate = await founderA.client.call(
      `/v1/projects/${projectCId}/view-preview?audience=investors`,
    );
    check(
      'режим private: Public View и Investor View — 404, предпросмотр владельцу — «никто»',
      hidden.response.status === 404 &&
        hiddenInv.response.status === 404 &&
        previewPrivate.response.status === 200 &&
        previewPrivate.json?.view === null &&
        previewPrivate.json?.audienceSummary?.investors === 'never',
      `${hidden.response.status} ${hiddenInv.response.status} ${previewPrivate.response.status} ${previewPrivate.json?.audienceSummary?.investors}`,
    );
  }
}

// ------------------------------------------------------ страна обслуживания
console.warn('\n[страна обслуживания] выбор, выключенная страна, смена');
{
  const countries = await raw('/v1/service-countries');
  check(
    'список стран обслуживания публичен',
    countries.response.status === 200 && (countries.json?.items ?? []).some((c) => c.code === 'ru'),
  );
  const setCountry = await founderA.client.call('/v1/me/service-country', {
    method: 'PUT',
    body: { code: 'ru' },
  });
  check(
    'страна обслуживания выбрана',
    setCountry.response.status === 200 && setCountry.json?.serviceCountry === 'ru',
    `статус ${setCountry.response.status}`,
  );
  const me = await founderA.client.call('/v1/auth/me');
  check('страна видна в профиле', me.json?.serviceCountry === 'ru');
  // Повторный выбор той же страны идемпотентен; смена уже установленной —
  // другая операция, переключения нет (реестр: контролируемая смена).
  const sameAgain = await founderA.client.call('/v1/me/service-country', {
    method: 'PUT',
    body: { code: 'ru' },
  });
  check('повторный выбор той же страны — без ошибки', sameAgain.response.status === 200);
  const kz = await adminClient.call('/v1/admin/service-countries', {
    method: 'POST',
    body: { code: 'kz' },
  });
  check(
    'администратор заводит страну выключенной',
    (kz.response.status === 201 && kz.json?.isActive === false) || kz.response.status === 409,
    `статус ${kz.response.status}`,
  );
  const founderAdd = await founderA.client.call('/v1/admin/service-countries', {
    method: 'POST',
    body: { code: 'by' },
  });
  check(
    'основатель не управляет странами обслуживания',
    founderAdd.response.status === 403,
    `статус ${founderAdd.response.status}`,
  );
  const toInactive = await founderA.client.call('/v1/me/service-country', {
    method: 'PUT',
    body: { code: 'kz' },
  });
  check(
    'выключенную страну выбрать нельзя',
    toInactive.response.status === 400 || toInactive.response.status === 422,
    `статус ${toInactive.response.status}`,
  );
  await adminClient.call('/v1/admin/service-countries/kz', {
    method: 'PATCH',
    body: { isActive: true },
  });
  const switchTry = await founderA.client.call('/v1/me/service-country', {
    method: 'PUT',
    body: { code: 'kz' },
  });
  check(
    'смена уже выбранной страны отклонена: свободного переключения нет',
    switchTry.response.status === 409,
    `статус ${switchTry.response.status}`,
  );
  await adminClient.call('/v1/admin/service-countries/kz', {
    method: 'PATCH',
    body: { isActive: false },
  });

  // Регистрация со страной (5.6.5): активная — принимается и видна в профиле;
  // выключенная — отказ с полем serviceCountry.
  const withCountry = await register('founder', 'country', { serviceCountry: 'ru' });
  const meCountry = await withCountry.client.call('/v1/auth/me');
  check(
    'регистрация со страной обслуживания: страна в профиле',
    meCountry.json?.serviceCountry === 'ru',
    `${meCountry.json?.serviceCountry}`,
  );
  const inactive = await makeClient().call('/v1/auth/register', {
    method: 'POST',
    body: {
      email: `lab-inactive-${suffix}@test.local`,
      password: `Pw-${crypto.randomUUID()}`,
      displayName: 'Тест выключенной страны',
      role: 'founder',
      locale: 'ru-RU',
      consents: CONSENTS,
      serviceCountry: 'kz',
    },
  });
  check(
    'регистрация с выключенной страной отклонена с указанием поля',
    (inactive.response.status === 400 || inactive.response.status === 422) &&
      JSON.stringify(inactive.json ?? '').includes('serviceCountry'),
    `статус ${inactive.response.status}`,
  );
}

console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено.\n`);
await pool.end();
if (failed > 0) process.exitCode = 1;
