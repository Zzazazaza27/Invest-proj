#!/usr/bin/env node
/**
 * Живой прогон фазы «KYC и проекты».
 *
 * Проверяет ФАКТИЧЕСКОЕ поведение запущенного core: изоляцию чужих проектов,
 * условия публикации листинга, границу публичного каталога, подписанную
 * загрузку в реальное хранилище и барьеры комплаенса. Это доказательство фазы;
 * без вывода этого скрипта «работает» говорить нельзя (RULES.md §2).
 *
 * Часть предусловий создаётся напрямую в БД — и только та, для которой ещё нет
 * API: роль администратора (её выдаёт не приложение, а оператор) и подписки
 * (биллинг — следующая фаза). Всё остальное идёт строго через HTTP, как ходил
 * бы настоящий клиент.
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
  application_name: 'unicorn-smoke-lab',
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

async function register(role, tag) {
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
  check('тариф резолвлен сервером', Boolean(json?.requiredPlanId), json?.requiredPlanId ?? 'нет');
  check(
    'проект создан как черновик',
    json?.status === 'draft' && json?.listingStatus === 'not_listed',
  );

  const [plan] = await sql('SELECT code FROM billing.subscription_plans WHERE id = $1', [
    json?.requiredPlanId,
  ]);
  check('запросу 5 млн ₽ соответствует тариф founder_t2', plan?.code === 'founder_t2', plan?.code);
}
{
  const { response, json } = await founderA.client.call('/v1/projects', {
    method: 'POST',
    body: {
      title: 'Попытка назначить тариф',
      stage: 'idea',
      taxonomyId: (await sql(`SELECT id FROM lab.project_taxonomy WHERE slug = 'ai'`))[0].id,
      investmentAsk: '900000000.00',
      askCurrency: 'RUB',
      requiredPlanId: (
        await sql(`SELECT id FROM billing.subscription_plans WHERE code='founder_t1'`)
      )[0].id,
    },
  });
  check(
    'клиент не может назначить себе тариф: поле отвергнуто',
    response.status === 400 && json?.code === 'validation_failed',
    `статус ${response.status}`,
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
  const { response } = await investor.client.call(`/v1/projects/${projectId}`);
  check(
    'инвестор без подписки не видит непубличную карточку',
    response.status === 404,
    `статус ${response.status}`,
  );
}

// -------------------------------------------------------------------- сезон
// Предусловие: прогон заводит СВОЙ сезон в статусе draft и делает его текущим.
//
// Раньше здесь сбрасывался в draft любой открытый сезон и бралcя тот, что
// вернёт `/seasons/current`. Это ставило прогон в зависимость от состояния,
// оставленного другими прогонами: сезон в статусе `review` (его создаёт
// прогон экспертизы) становится текущим, а открыть приём заявок из `review`
// статусная машина не даёт — и семь проверок падали не потому, что сломан
// код. Свой сезон убирает эту связь: односторонность машины по-прежнему
// проверяется, но на предсказуемом входе.
// Чужие открытые сезоны гасятся временно и ВОЗВРАЩАЮТСЯ в конце прогона.
//
// Без возврата прогон ломал стенд: сезон `Стенд · сезон` оставался в `draft`,
// подача заявки из кабинета основателя отвечала 409 «Приём заявок закрыт», а
// следующий `dev-stand.mjs` заводил ещё один сезон — по одному на каждый
// прогон. Прогон обязан оставлять окружение таким, каким его застал.
const suspendedSeasons = await sql(
  `SELECT id FROM seasons.seasons WHERE status = 'applications_open'`,
);
await sql(`UPDATE seasons.seasons SET status = 'draft' WHERE status = 'applications_open'`);

/**
 * Возврат чужих сезонов в приём.
 *
 * Вызывается в конце прогона. Если прогон упал раньше — сезоны останутся в
 * `draft`; лечится повторным `node scripts/dev-stand.mjs`. Оборачивать весь
 * скрипт в try/finally ради этого не стали: упавший прогон и так требует
 * разбора, а тихое восстановление скрыло бы, на чём он упал.
 */
async function restoreSuspendedSeasons() {
  if (suspendedSeasons.length === 0) return;
  await sql(`UPDATE seasons.seasons SET status = 'applications_open' WHERE id = ANY($1::uuid[])`, [
    suspendedSeasons.map((row) => row.id),
  ]);
}

let seasonId;
{
  const [row] = await sql(
    `INSERT INTO seasons.seasons (id, number, title, starts_at, ends_at, status)
     VALUES (public.uuid_generate_v7(),
             (SELECT coalesce(max(number), 0) + 1 FROM seasons.seasons),
             'Сезон прогона lab', now() - interval '1 day', now() + interval '60 days', 'draft')
     RETURNING id`,
  );
  seasonId = row.id;
  const { json } = await raw('/v1/seasons/current');
  // Публичность метронома проверяется отдельно от того, какой сезон текущий:
  // маршрут обязан отвечать анониму в любом состоянии воронки.
  check('текущий сезон публичен', Boolean(json?.season?.id), json?.season?.status ?? 'нет сезона');
}
{
  const { response, json } = await founderA.client.call(`/v1/projects/${projectId}/submit`, {
    method: 'POST',
  });
  check(
    'подача при закрытом приёме отвергнута',
    response.status === 409 && json?.code === 'state_transition_not_allowed',
    `статус ${response.status}`,
  );
}
{
  const { response } = await founderA.client.call(`/v1/seasons/${seasonId}/status`, {
    method: 'POST',
    body: { status: 'applications_open' },
  });
  check('основатель не может открыть сезон', response.status === 403, `статус ${response.status}`);
}
{
  const { response, json } = await adminClient.call(`/v1/seasons/${seasonId}/status`, {
    method: 'POST',
    body: { status: 'applications_open' },
  });
  check(
    'администратор открыл приём заявок',
    response.status === 201 || response.status === 200,
    `статус ${response.status} ${json?.status ?? ''}`,
  );
}
{
  const { response, json } = await adminClient.call(`/v1/seasons/${seasonId}/status`, {
    method: 'POST',
    body: { status: 'draft' },
  });
  check(
    'возврат сезона в черновик запрещён статусной машиной',
    response.status === 409,
    `статус ${response.status} ${json?.code ?? ''}`,
  );
}
{
  const { response, json } = await founderA.client.call(`/v1/projects/${projectId}/submit`, {
    method: 'POST',
  });
  check(
    'заявка подана',
    response.status === 201 || response.status === 200,
    `статус ${response.status}`,
  );
  check('создана первая версия', json?.versionNo === 1, `версия ${json?.versionNo}`);
}
{
  const { json } = await founderA.client.call(`/v1/projects/${projectId}/submit`, {
    method: 'POST',
  });
  check(
    'повторная подача создаёт новую версию',
    json?.versionNo === 2,
    `версия ${json?.versionNo}`,
  );

  const versions = await sql('SELECT id FROM lab.project_versions WHERE project_id = $1', [
    projectId,
  ]);
  check('снимки заявок накапливаются', versions.length === 2, `версий ${versions.length}`);
  const failedUpdate = await pool
    .query('UPDATE lab.project_versions SET version_no = 99 WHERE project_id = $1', [projectId])
    .then(() => null)
    .catch((error) => error);
  check(
    'снимок заявки неизменяем',
    failedUpdate !== null,
    failedUpdate?.message?.slice(0, 60) ?? '',
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

// --------------------------------------- листинг: платёжный барьер по флагу
// С M071 барьер основателя — флаг billing.listing_requires_subscription, по
// умолчанию выключенный: подача и листинг бесплатны (план 0.2 §0а, §2.9.2).
// Проверяется та ветка, в которой находится стенд, и печатается, какая именно;
// доступ инвестора от флага не зависит и проверяется ниже как прежде.
const { json: features } = await raw('/v1/features');
const barrierOn = features?.flags?.['billing.listing_requires_subscription'] === true;
console.log(
  `  ·     платёжный барьер основателя: ${barrierOn ? 'ВКЛЮЧЁН' : 'выключен'} — проверяю эту ветку`,
);
{
  const { response, json } = await founderA.client.call(`/v1/projects/${projectId}/listing`, {
    method: 'POST',
  });
  if (barrierOn) {
    check(
      'публикация без активной подписки отклонена (барьер включён)',
      response.status === 403 && json?.code === 'subscription_required',
      `статус ${response.status} ${json?.code ?? ''}`,
    );
  } else {
    check(
      'публикация без подписки разрешена (барьер выключен)',
      response.status === 201 || response.status === 200,
      `статус ${response.status} ${json?.code ?? ''}`,
    );
    check(
      'статус листинга — listed без подписки',
      json?.listingStatus === 'listed',
      json?.listingStatus ?? '',
    );
  }
}

// Подписка — контур следующей фазы; создаём её как предусловие напрямую в БД.
async function grantFounderSubscription(userId, project) {
  await sql(
    `INSERT INTO billing.subscriptions
       (id, user_id, plan_id, project_id, price_snapshot, terms_version, status, current_period_end)
     SELECT public.uuid_generate_v7(), $1, p.required_plan_id, $2, sp.price, 'v1', 'active',
            now() + interval '30 days'
       FROM lab.projects p
       JOIN billing.subscription_plans sp ON sp.id = p.required_plan_id
      WHERE p.id = $2`,
    [userId, project],
  );
}

await grantFounderSubscription(founderA.userId, projectId);

{
  const { response, json } = await founderA.client.call(`/v1/projects/${projectId}/listing`, {
    method: 'POST',
  });
  check(
    'листинг опубликован',
    response.status === 201 || response.status === 200,
    `статус ${response.status}`,
  );
  check('статус листинга — listed', json?.listingStatus === 'listed', json?.listingStatus ?? '');
  check('дата публикации проставлена', Boolean(json?.listedAt));
}
{
  // При включённом барьере рост запроса сверх оплаченного тарифа обязан ломать
  // публикацию; при выключенном — проходит, и сумма возвращается, чтобы
  // проверки каталога ниже не зависели от ветки.
  const { response, json } = await founderA.client.call(`/v1/projects/${projectId}`, {
    method: 'PATCH',
    body: { investmentAsk: '80000000.00' },
  });
  const [row] = await sql('SELECT investment_ask::text AS ask FROM lab.projects WHERE id = $1', [
    projectId,
  ]);
  if (barrierOn) {
    check(
      'рост запроса сверх тарифа блокирует опубликованный листинг (барьер включён)',
      response.status === 403 || response.status === 422,
      `статус ${response.status} ${json?.code ?? ''}`,
    );
    check('сумма запроса не изменилась после отката', row?.ask === '5000000.00', row?.ask ?? '');
  } else {
    check(
      'рост запроса у опубликованного проекта проходит (барьер выключен)',
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
  const { json } = await raw('/v1/catalog?askMin=100000000');
  check('фильтр по сумме отсекает листинг', !(json?.items ?? []).some((i) => i.id === projectId));
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
  await grantFounderSubscription(founderA.userId, secondProjectId);
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

// ---------------------------------------------------- инвестор с подпиской
{
  await sql(
    `INSERT INTO billing.subscriptions
       (id, user_id, plan_id, price_snapshot, terms_version, status, current_period_end)
     SELECT public.uuid_generate_v7(), $1, sp.id, sp.price, 'v1', 'active', now() + interval '30 days'
       FROM billing.subscription_plans sp
      WHERE sp.code = 'investor_membership'`,
    [investor.userId],
  );
  const { response, json } = await investor.client.call(`/v1/projects/${projectId}`);
  check(
    'инвестор с подпиской видит полную карточку',
    response.status === 200,
    `статус ${response.status}`,
  );
  check('полная карточка содержит описание', typeof json?.description === 'string');
  check('IRS честно отсутствует до скоринга', json?.irs === null);
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

// ------------------------------------------------- заявки v2 (M071, этап 2)
// Заявка отдельно от проекта: несколько заявок, черновик без суммы, подача
// без сезона, лимиты по политике, проекция максимума в проект, архив
// освобождает место. Старый путь выше уже подал текущую заявку проекта.
{
  const before = await founderA.client.call(`/v1/projects/${projectId}/applications`);
  check(
    'список заявок проекта отвечает',
    before.response.status === 200,
    `статус ${before.response.status}`,
  );
  check('у проекта есть заявка из переноса', (before.json?.items?.length ?? 0) >= 1);
  const remainingBefore = before.json?.limits?.applications?.remaining;
  check('остаток по политике отдаётся до создания', typeof remainingBefore === 'number');

  const created = await founderA.client.call(`/v1/projects/${projectId}/applications`, {
    method: 'POST',
    body: { title: 'Запуск Taxi', fundingScope: 'direction' },
  });
  check(
    'черновик заявки создан без суммы',
    created.response.status === 201 && created.json?.investmentAsk === null,
    `статус ${created.response.status} ${created.json?.code ?? ''}`,
  );
  const appId = created.json?.id;

  const got = await founderA.client.call(`/v1/applications/${appId}`);
  const missing = (got.json?.submission?.missing ?? []).map((m) => m.path);
  check(
    'подача без суммы и уточнения невозможна, причины названы',
    got.json?.submission?.canSubmit === false &&
      missing.includes('investmentAsk') &&
      missing.includes('fundingScopeNote'),
    missing.join(','),
  );

  const early = await founderA.client.call(`/v1/applications/${appId}/submit`, { method: 'POST' });
  check(
    'преждевременная подача отвергнута валидацией',
    early.response.status === 422 || early.response.status === 400,
    `статус ${early.response.status} ${early.json?.code ?? ''}`,
  );

  const patched = await founderA.client.call(`/v1/applications/${appId}`, {
    method: 'PATCH',
    body: {
      investmentAsk: '800000.00',
      fundingScopeNote: 'Такси в Казани',
      answers: { problem: 'Долгое ожидание машины' },
    },
  });
  check(
    'автосохранение принимает частичное тело',
    patched.response.status === 200 && patched.json?.submission?.canSubmit === true,
    `статус ${patched.response.status} ${patched.json?.code ?? ''}`,
  );

  const overCap = await founderA.client.call(`/v1/applications/${appId}`, {
    method: 'PATCH',
    body: { investmentAsk: '5000000.01' },
  });
  check(
    'сумма выше потолка политики сохраняется, но подать нельзя',
    overCap.response.status === 200 && overCap.json?.submission?.canSubmit === false,
  );
  await founderA.client.call(`/v1/applications/${appId}`, {
    method: 'PATCH',
    body: { investmentAsk: '800000.00' },
  });

  const submitted = await founderA.client.call(`/v1/applications/${appId}/submit`, {
    method: 'POST',
  });
  check(
    'подача заявки без сезона создаёт версию',
    submitted.response.status === 201 &&
      submitted.json?.seasonId === null &&
      submitted.json?.applicationId === appId,
    `статус ${submitted.response.status} ${submitted.json?.code ?? ''}`,
  );

  const [proj] = await sql(
    'SELECT investment_ask::text AS ask, current_application_id FROM lab.projects WHERE id = $1',
    [projectId],
  );
  check(
    'проекция: сумма проекта = максимум по открытым заявкам',
    proj?.ask === '5000000.00',
    proj?.ask ?? '',
  );
  check('проекция: текущая заявка — последняя поданная', proj?.current_application_id === appId);

  const after = await founderA.client.call(`/v1/projects/${projectId}/applications`);
  check(
    'остаток уменьшился на одну заявку',
    after.json?.limits?.applications?.remaining === remainingBefore - 1,
    `${after.json?.limits?.applications?.remaining}`,
  );
  check(
    'в списке две открытые заявки',
    (after.json?.items ?? []).filter((a) => a.status === 'submitted').length >= 2,
  );

  const archived = await founderA.client.call(`/v1/applications/${appId}/archive`, {
    method: 'POST',
  });
  check(
    'заявка архивирована',
    archived.response.status === 201 && archived.json?.status === 'archived',
    `статус ${archived.response.status}`,
  );
  const final = await founderA.client.call(`/v1/projects/${projectId}/applications`);
  check(
    'архив освобождает место',
    final.json?.limits?.applications?.remaining === remainingBefore,
    `${final.json?.limits?.applications?.remaining}`,
  );
  const [proj2] = await sql('SELECT current_application_id FROM lab.projects WHERE id = $1', [
    projectId,
  ]);
  check(
    'проекция после архива указывает на другую заявку',
    Boolean(proj2?.current_application_id) && proj2?.current_application_id !== appId,
  );
}

// ------------------------------------------- форма и версии (M073, этап 3)
// Форма заявки собирается из версии, записанной в самой заявке; админка
// правит единственный черновик, публикует версии и откатывает активацией
// прежней. Прогон оставляет в истории одну новую опубликованную версию и
// возвращает активной прежнюю — история версий на стенде растёт на одну
// строку за прогон, это ожидаемо.
{
  const forForm = await founderA.client.call(`/v1/projects/${projectId}/applications`, {
    method: 'POST',
    body: { title: 'Форма по версии' },
  });
  const appId = forForm.json?.id;
  check(
    'заявка для проверки формы создана',
    forForm.response.status === 201 && Boolean(appId),
    `статус ${forForm.response.status}`,
  );
  const form = await founderA.client.call(`/v1/applications/${appId}/form`);
  check(
    'форма заявки отвечает по её версии',
    form.response.status === 200 && (form.json?.schemaVersion ?? 0) >= 1,
    `статус ${form.response.status} v${form.json?.schemaVersion}`,
  );
  const keys = (form.json?.sections ?? []).flatMap((s) => s.questions.map((q) => q.key));
  check(
    'форма содержит разделы, системные и содержательные вопросы',
    (form.json?.sections?.length ?? 0) >= 2 &&
      keys.includes('investment_ask') &&
      keys.includes('problem_statement'),
    `разделов ${form.json?.sections?.length ?? 0}`,
  );
  check('скрытые для всех стадий вопросы не показываются', !keys.includes('mrr'));
  const english = await founderA.client.call(`/v1/applications/${appId}/form?locale=en-US`);
  check(
    'на языке без переводов берётся запасной текст, пропуски перечислены',
    english.response.status === 200 && (english.json?.missing?.length ?? 0) > 0,
    `статус ${english.response.status}`,
  );
  const stranger = await founderB.client.call(`/v1/applications/${appId}/form`);
  check(
    'форму чужой заявки не видно',
    stranger.response.status === 404,
    `статус ${stranger.response.status}`,
  );

  const versions = await adminClient.call('/v1/admin/application-forms');
  const activeBefore = versions.json?.activeVersion;
  check(
    'админка видит активную версию конфигурации',
    versions.response.status === 200 && typeof activeBefore === 'number',
    `статус ${versions.response.status}`,
  );
  const draft = await adminClient.call('/v1/admin/application-forms/draft');
  check(
    'черновик создаётся из активной версии',
    draft.response.status === 200 && draft.json?.status === 'draft',
    `статус ${draft.response.status} ${draft.json?.code ?? ''}`,
  );

  const config = draft.json?.config ?? { questions: [] };
  const website = config.questions.find((q) => q.key === 'website_url');
  if (website) website.stages.idea = 'hidden';
  const saved = await adminClient.call('/v1/admin/application-forms/draft', {
    method: 'PUT',
    body: { config },
  });
  check(
    'черновик сохраняется с изменённым состоянием вопроса',
    saved.response.status === 200,
    `статус ${saved.response.status} ${saved.json?.code ?? ''} ${JSON.stringify(saved.json?.fieldErrors ?? '').slice(0, 300)}`,
  );

  const preview = await adminClient.call('/v1/admin/application-forms/draft/preview?stage=idea');
  const previewKeys = (preview.json?.sections ?? []).flatMap((s) => s.questions.map((q) => q.key));
  check(
    'предпросмотр черновика показывает изменение до публикации',
    preview.response.status === 200 &&
      previewKeys.length > 0 &&
      !previewKeys.includes('website_url'),
    `статус ${preview.response.status}`,
  );

  const broken = structuredClone(config);
  broken.questions = broken.questions.filter((q) => q.key !== 'why_now');
  const rejected = await adminClient.call('/v1/admin/application-forms/draft', {
    method: 'PUT',
    body: { config: broken },
  });
  check(
    'удаление опубликованного ключа отвергается с перечнем',
    (rejected.response.status === 422 || rejected.response.status === 400) &&
      JSON.stringify(rejected.json ?? '').includes('why_now'),
    `статус ${rejected.response.status}`,
  );

  const published = await adminClient.call('/v1/admin/application-forms/draft/publish', {
    method: 'POST',
    body: { reason: 'дымовой прогон: скрыт website_url на стадии идеи' },
  });
  const newVersion = published.json?.version;
  check(
    'публикация даёт следующий номер и активирует версию',
    published.response.status === 201 &&
      newVersion === activeBefore + 1 &&
      published.json?.isActive === true,
    `статус ${published.response.status} ${published.json?.code ?? ''}`,
  );

  const formAfter = await founderA.client.call(`/v1/applications/${appId}/form`);
  check(
    'существующая заявка осталась на своей версии после публикации',
    formAfter.json?.schemaVersion === form.json?.schemaVersion,
    `v${formAfter.json?.schemaVersion}`,
  );

  const fresh = await founderA.client.call(`/v1/projects/${projectId}/applications`, {
    method: 'POST',
    body: { title: 'Проверка версии конфигурации' },
  });
  check(
    'новая заявка создаётся на новой версии',
    fresh.response.status === 201 && fresh.json?.schemaVersion === newVersion,
    `статус ${fresh.response.status} v${fresh.json?.schemaVersion}`,
  );
  if (fresh.json?.id) {
    await founderA.client.call(`/v1/applications/${fresh.json.id}/archive`, { method: 'POST' });
  }

  const rolledBack = await adminClient.call(
    `/v1/admin/application-forms/${activeBefore}/activate`,
    { method: 'POST', body: { reason: 'дымовой прогон: откат к прежней версии' } },
  );
  check(
    'откат активирует прежнюю версию',
    rolledBack.response.status === 201 &&
      rolledBack.json?.version === activeBefore &&
      rolledBack.json?.isActive === true,
    `статус ${rolledBack.response.status} ${rolledBack.json?.code ?? ''}`,
  );
  const again = await adminClient.call(`/v1/admin/application-forms/${activeBefore}/activate`, {
    method: 'POST',
    body: { reason: 'повторная активация' },
  });
  check(
    'повторная активация активной версии — конфликт',
    again.response.status === 409,
    `статус ${again.response.status}`,
  );
  await founderA.client.call(`/v1/applications/${appId}/archive`, { method: 'POST' });
  const founderForbidden = await founderA.client.call('/v1/admin/application-forms/draft');
  check(
    'основателю черновик конфигурации недоступен',
    founderForbidden.response.status === 403,
    `статус ${founderForbidden.response.status}`,
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
  check('подача заявки попала в журнал', verbs.includes('lab.project.submitted'));
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

// ------------------------------------------- согласия на публичный контур (Ф50)
//
// До Ф50 этих маршрутов не существовало: клиент их звал, ядро отвечало 404.
// Здесь проверяется не «ручка отвечает 200», а четыре свойства, ради которых
// она написана: чужой проект недоступен, документ берётся с сервера, повтор не
// переписывает прежнее согласие, отзыв называет срок удаления проекции.
let consentId = null;
const activeDoc = (
  await sql(
    `SELECT version, encode(body_sha256, 'hex') AS sha
       FROM identity.consent_templates
      WHERE kind = 'pdn_biometric' AND locale = 'ru-RU' AND superseded_at IS NULL`,
  )
)[0];
check(
  'документ согласия на публичность опубликован',
  Boolean(activeDoc),
  activeDoc?.version ?? 'нет',
);

{
  const { response } = await founderB.client.call('/v1/publication-consents', {
    method: 'POST',
    body: {
      projectId,
      scope: 'episode_selection',
      disclosedFields: ['project_title'],
      documentVersion: activeDoc?.version ?? 'v1',
    },
  });
  // 404, а не 403: иначе ответ подтверждает существование чужого проекта.
  check('чужой проект: согласие не выдаётся', response.status === 404, `статус ${response.status}`);
}

{
  const { response, json } = await founderA.client.call('/v1/publication-consents', {
    method: 'POST',
    body: {
      projectId,
      scope: 'episode_selection',
      disclosedFields: ['project_title'],
      documentVersion: '1.0.0',
    },
  });
  check(
    'недействующая версия документа: 400, а не 500',
    response.status === 400,
    `статус ${response.status}`,
  );
  // Проверяется именно поле ошибки, а не всё тело: 'v1' встречается в ответе и
  // по другим поводам, и совпадение по всему JSON зеленело бы по неверной
  // причине. Клиенту нужна ПОДСКАЗКА, что подставить вместо неверной версии.
  // Поле ответа называется `errors`: наружу уходит problem+json (RFC 9457), а
  // не внутренняя форма ошибки.
  const versionError = (json?.errors ?? []).find((e) => e.path === 'documentVersion');
  check(
    'ответ называет действующую версию в поле documentVersion',
    Boolean(versionError?.message?.includes(`действует ${activeDoc?.version}`)),
    versionError?.message ?? JSON.stringify(json ?? {}).slice(0, 160),
  );
}

{
  const { response } = await founderA.client.call('/v1/publication-consents', {
    method: 'POST',
    body: {
      projectId,
      scope: 'episode_selection',
      disclosedFields: ['passport_scan'],
      documentVersion: activeDoc?.version ?? 'v1',
    },
  });
  check(
    'поле вне словаря раскрытия отвергнуто',
    response.status === 400,
    `статус ${response.status}`,
  );
}

{
  const { response, json } = await founderA.client.call('/v1/publication-consents', {
    method: 'POST',
    body: {
      projectId,
      scope: 'episode_selection',
      disclosedFields: ['project_title', 'founder_photo'],
      documentVersion: activeDoc?.version ?? 'v1',
    },
  });
  consentId = json?.id ?? null;
  check(
    'согласие на публикацию выдано',
    response.status === 201 || response.status === 200,
    `статус ${response.status}`,
  );
  check(
    'отпечаток документа взят с сервера, а не из тела запроса',
    json?.documentSha256 === activeDoc?.sha,
    `${String(json?.documentSha256).slice(0, 16)}… против ${String(activeDoc?.sha).slice(0, 16)}…`,
  );
  check(
    'раскрываемые поля сохранены как переданы',
    JSON.stringify(json?.disclosedFields) === JSON.stringify(['project_title', 'founder_photo']),
    JSON.stringify(json?.disclosedFields),
  );
  check('действующее согласие без даты отзыва', json?.revokedAt === null, String(json?.revokedAt));
}

{
  const { response } = await founderA.client.call('/v1/publication-consents', {
    method: 'POST',
    body: {
      projectId,
      scope: 'episode_selection',
      disclosedFields: ['project_title'],
      documentVersion: activeDoc?.version ?? 'v1',
    },
  });
  // Повтор не переписывает прежнее согласие: у него своя дата и своя версия
  // документа, и подмена стёрла бы доказательство принятого.
  check(
    'повторное согласие на ту же область — 409',
    response.status === 409,
    `статус ${response.status}`,
  );
}

{
  const rows = await sql(
    `SELECT scope, granted_at FROM integration.active_publication_consent($1, 'episode_selection')`,
    [projectId],
  );
  check('медиаконтур видит действующее согласие', rows.length === 1, `строк ${rows.length}`);
}

{
  const { response, json } = await founderA.client.call('/v1/publication-consents');
  check('список согласий доступен автору', response.status === 200, `статус ${response.status}`);
  check(
    'выданное согласие есть в списке',
    (json?.items ?? []).some((item) => item.id === consentId),
    `записей ${json?.items?.length ?? 0}`,
  );
}

{
  const { response, json } = await founderA.client.call(`/v1/publication-consents/${consentId}`, {
    method: 'DELETE',
  });
  check('согласие отозвано', response.status === 200, `статус ${response.status}`);
  const deadlineGap =
    json?.revokedAt && json?.deletionDeadline
      ? (Date.parse(json.deletionDeadline) - Date.parse(json.revokedAt)) / 60000
      : null;
  check(
    'крайний срок удаления проекции — 15 минут от отзыва',
    deadlineGap === 15,
    `${deadlineGap} мин`,
  );
}

{
  const rows = await sql(
    `SELECT scope FROM integration.active_publication_consent($1, 'episode_selection')`,
    [projectId],
  );
  check('после отзыва медиаконтур не видит согласия', rows.length === 0, `строк ${rows.length}`);
}

{
  const { response } = await founderA.client.call(`/v1/publication-consents/${consentId}`, {
    method: 'DELETE',
  });
  check(
    'повторный отзыв не является ошибкой',
    response.status === 200,
    `статус ${response.status}`,
  );
  const events = await sql(
    `SELECT event_type, count(*)::int AS n FROM audit.outbox_events
      WHERE aggregate_id = $1 GROUP BY event_type ORDER BY event_type`,
    [consentId],
  );
  const revoked = events.find((e) => e.event_type === 'lab.consent.publication_revoked');
  const granted = events.find((e) => e.event_type === 'lab.consent.publication_granted');
  check('выдача попала в outbox', granted?.n === 1, `записей ${granted?.n ?? 0}`);
  // Второе событие отзыва запустило бы у потребителя новый пятнадцатиминутный
  // срок удаления того, что он уже удалил.
  check(
    'повтор отзыва не публикует второе событие',
    revoked?.n === 1,
    `записей ${revoked?.n ?? 0}`,
  );
}

// Свой сезон прогон оставляет как есть — он одноразовый; а вот чужие
// возвращает в то состояние, в котором застал.
await restoreSuspendedSeasons();

console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено.\n`);
await pool.end();
if (failed > 0) process.exitCode = 1;
