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

// Положение сезонного контура читается тем же публичным маршрутом, что и
// кабинеты: подача «в сезон» и публичные сезонные выдачи есть только при
// включённом флаге (M088).
const seasonsOn = (await raw('/v1/features')).json?.flags?.['seasons.enabled'] === true;

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
  const { response, json } = await raw('/v1/seasons/current');
  // Сезоны отложены (M088): метроном отвечает анониму пустым сезоном при
  // любом состоянии воронки; при включённом флаге — текущим сезоном.
  check(
    seasonsOn
      ? 'текущий сезон публичен'
      : 'сезоны отложены: метроном отвечает анониму пустым сезоном',
    response.status === 200 && (seasonsOn ? Boolean(json?.season?.id) : json?.season === null),
    `статус ${response.status} ${json?.season?.status ?? 'нет сезона'}`,
  );
}
{
  const { response, json } = await founderA.client.call(`/v1/projects/${projectId}/submit`, {
    method: 'POST',
  });
  check(
    seasonsOn ? 'подача при закрытом приёме отвергнута' : 'сезоны отложены: подача в сезон закрыта',
    seasonsOn
      ? response.status === 409 && json?.code === 'state_transition_not_allowed'
      : response.status === 503 && json?.code === 'feature_disabled',
    `статус ${response.status} ${json?.code ?? ''}`,
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
if (seasonsOn) {
  const { response, json } = await founderA.client.call(`/v1/projects/${projectId}/submit`, {
    method: 'POST',
  });
  check(
    'заявка подана',
    response.status === 201 || response.status === 200,
    `статус ${response.status}`,
  );
  check('создана первая версия', json?.versionNo === 1, `версия ${json?.versionNo}`);
  const again = await founderA.client.call(`/v1/projects/${projectId}/submit`, {
    method: 'POST',
  });
  check(
    'повторная подача создаёт новую версию',
    again.json?.versionNo === 2,
    `версия ${again.json?.versionNo}`,
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
} else {
  // Подача «в сезон» закрыта и при открытом приёме: путь основателя — мастер
  // заявки без сезона (проверяется ниже, в блоке v2).
  const { response, json } = await founderA.client.call(`/v1/projects/${projectId}/submit`, {
    method: 'POST',
  });
  check(
    'сезоны отложены: подача в сезон закрыта и при открытом приёме',
    response.status === 503 && json?.code === 'feature_disabled',
    `статус ${response.status} ${json?.code ?? ''}`,
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
  // С 5.6.3 сумма и предмет финансирования — у раунда: подаче профиля они
  // не мешают; мешают только обязательные вопросы разделов профиля.
  check(
    'подача без обязательных вопросов профиля невозможна; сумма и предмет подаче не мешают',
    got.json?.submission?.canSubmit === false &&
      !missing.includes('investmentAsk') &&
      !missing.includes('fundingScope') &&
      !missing.includes('fundingScopeNote') &&
      missing.some((m) => m.startsWith('answers.')),
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
      answers: { problem_statement: 'Долгое ожидание машины' },
    },
  });
  check(
    'автосохранение принимает частичное тело и отдаёт готовность',
    patched.response.status === 200 && typeof patched.json?.readiness?.percent === 'number',
    `статус ${patched.response.status} ${patched.json?.code ?? ''}`,
  );
  const stillMissing = (patched.json?.submission?.missing ?? []).map((m) => m.path);
  check(
    'без обязательных вопросов формы подача закрыта, ключи названы',
    patched.json?.submission?.canSubmit === false &&
      stillMissing.includes('answers.founders') &&
      !stillMissing.includes('answers.problem_statement'),
    stillMissing.join(','),
  );
  const badAnswer = await founderA.client.call(`/v1/applications/${appId}`, {
    method: 'PATCH',
    body: { answers: { founded_year: 'в прошлом году' } },
  });
  check(
    'ответ неверного типа отвергается по форме версии',
    badAnswer.response.status === 400 || badAnswer.response.status === 422,
    `статус ${badAnswer.response.status}`,
  );

  // 5.6.0: подтверждение чужим или несуществующим материалом — ошибка у поля.
  const foreignEvidence = await founderA.client.call(`/v1/applications/${appId}`, {
    method: 'PATCH',
    body: { evidence: { problem_statement: ['01a0a50c-0000-7000-8000-00000000ffff'] } },
  });
  check(
    'подтверждение чужим материалом отвергается с адресом поля',
    (foreignEvidence.response.status === 400 || foreignEvidence.response.status === 422) &&
      JSON.stringify(foreignEvidence.json ?? '').includes('evidence.problem_statement'),
    `статус ${foreignEvidence.response.status}`,
  );

  const overCap = await founderA.client.call(`/v1/applications/${appId}`, {
    method: 'PATCH',
    body: { investmentAsk: '5000000.01' },
  });
  check(
    'сумма выше прежнего потолка политики сохраняется и подаче профиля не мешает (сумма — у раунда)',
    overCap.response.status === 200 &&
      !(overCap.json?.submission?.missing ?? []).some((m) => m.path === 'investmentAsk'),
  );
  await founderA.client.call(`/v1/applications/${appId}`, {
    method: 'PATCH',
    body: { investmentAsk: '800000.00' },
  });

  const premature = await founderA.client.call(`/v1/applications/${appId}/submit`, {
    method: 'POST',
  });
  check(
    'подача без обязательных вопросов отвергается с перечнем',
    (premature.response.status === 400 || premature.response.status === 422) &&
      JSON.stringify(premature.json ?? '').includes('answers.'),
    `статус ${premature.response.status}`,
  );
  const formForFill = await founderA.client.call(`/v1/applications/${appId}/form`);
  const answers = {};
  for (const section of formForFill.json?.sections ?? []) {
    for (const q of section.questions) {
      if (q.state !== 'mandatory' || q.coreField) continue;
      answers[q.key] =
        q.type === 'number'
          ? 1
          : q.type === 'money'
            ? '100.00'
            : q.type === 'select'
              ? q.options?.[0]?.code
              : q.type === 'multiselect'
                ? [q.options?.[0]?.code]
                : q.type === 'boolean'
                  ? true
                  : q.type === 'url'
                    ? 'https://example.com'
                    : q.type === 'date'
                      ? '2026-01-01'
                      : q.type === 'material_ref'
                        ? []
                        : 'Ответ для дымового прогона';
    }
  }
  const filled = await founderA.client.call(`/v1/applications/${appId}`, {
    method: 'PATCH',
    body: { answers },
  });
  check(
    'после заполнения обязательных вопросов подача открыта',
    filled.response.status === 200 &&
      filled.json?.submission?.canSubmit === true &&
      filled.json?.readiness?.canSubmit === true &&
      filled.json?.readiness?.percent > 0,
    `статус ${filled.response.status} готовность ${filled.json?.readiness?.percent}% ${JSON.stringify(filled.json?.submission?.missing ?? '').slice(0, 200)}`,
  );

  const submitted = await founderA.client.call(`/v1/applications/${appId}/submit`, {
    method: 'POST',
  });
  check(
    'снимок версии хранит версию весов и процент готовности',
    submitted.json?.readinessConfigVersion >= 1 &&
      typeof submitted.json?.completenessPct === 'number' &&
      submitted.json?.completenessPct === filled.json?.readiness?.percent,
    `весов v${submitted.json?.readinessConfigVersion} ${submitted.json?.completenessPct}%`,
  );
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
  // При отложенных сезонах подача v1 закрыта, поэтому поданных заявок одна
  // (мастер v2); при включённых — две.
  check(
    seasonsOn ? 'в списке две открытые заявки' : 'в списке поданная заявка мастера',
    (after.json?.items ?? []).filter((a) => a.status === 'submitted').length >= (seasonsOn ? 2 : 1),
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
      newVersion > activeBefore &&
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
  // Подача v1 («в сезон») закрыта при отложенных сезонах — в журнале тогда
  // подача мастера v2 (subject — заявка, не проект): проверяется отдельно.
  if (seasonsOn) {
    check('подача заявки попала в журнал', verbs.includes('lab.project.submitted'));
  } else {
    const appSubmits = await sql(
      `SELECT count(*)::int AS n FROM audit.events e
        JOIN lab.investment_applications a ON a.id = e.subject_id
       WHERE a.project_id = $1 AND e.verb = 'lab.application.submitted'`,
      [projectId],
    );
    check('подача заявки мастером попала в журнал', (appSubmits[0]?.n ?? 0) >= 1);
  }
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

// ------------------------------------------------------------ раунды (5.6.3)
console.warn('\n[раунды] профиль без раунда, черновик, открытие, пауза, основание');
{
  const project = await founderA.client.call('/v1/projects', {
    method: 'POST',
    body: {
      title: `Раунд ${suffix}`,
      tagline: 'Проверка раундов',
      stage: 'idea',
      taxonomyId: (await sql("SELECT id FROM lab.project_taxonomy WHERE slug = 'ai'"))[0].id,
      investmentAsk: '1000000.00',
      askCurrency: 'RUB',
    },
  });
  const projectId = project.json?.id;
  check(
    'проект для раундов создан',
    project.response.status === 201,
    `статус ${project.response.status}`,
  );

  const limits = await founderA.client.call('/v1/projects/limits');
  check(
    'лимит проектов аккаунта отдаётся с источником; 0 — безлимит',
    limits.response.status === 200 &&
      limits.json?.source === 'application_policy' &&
      (limits.json?.projects?.limit === 0 ? limits.json?.projects?.remaining === null : true),
    JSON.stringify(limits.json?.projects),
  );

  const apps = await founderA.client.call(`/v1/projects/${projectId}/applications`);
  check(
    'анкета старой формы не занимает место в лимите анкет',
    apps.json?.limits?.applications?.used === 0,
    `used=${apps.json?.limits?.applications?.used}`,
  );

  const app = await founderA.client.call(`/v1/projects/${projectId}/applications`, {
    method: 'POST',
    body: {},
  });
  const appId = app.json?.id;
  const form = await founderA.client.call(`/v1/applications/${appId}/form`);
  const profileMandatory = (form.json?.sections ?? [])
    .filter((s) => s.scope !== 'round')
    .flatMap((s) => s.questions.filter((q) => q.state === 'mandatory' && !q.coreField));
  const answers = {};
  for (const q of profileMandatory) {
    answers[q.key] =
      q.type === 'select'
        ? q.options?.[0]?.code
        : q.type === 'number'
          ? 1
          : q.type === 'multiselect'
            ? [q.options?.[0]?.code]
            : 'ответ для проверки';
  }
  await founderA.client.call(`/v1/applications/${appId}`, { method: 'PATCH', body: { answers } });
  const submitted = await founderA.client.call(`/v1/applications/${appId}/submit`, {
    method: 'POST',
  });
  check(
    'профиль подан без суммы и предмета финансирования',
    submitted.response.status === 201 || submitted.response.status === 200,
    `статус ${submitted.response.status} ${JSON.stringify(submitted.json?.errors ?? submitted.json?.detail ?? '')}`,
  );
  const versionId = submitted.json?.id;

  const draft = await founderA.client.call(`/v1/projects/${projectId}/rounds`, {
    method: 'POST',
    body: {},
  });
  const roundId = draft.json?.round?.id;
  check(
    'черновик раунда создан с готовностью',
    draft.response.status === 201 && draft.json?.readiness?.canOpen === false,
    `статус ${draft.response.status}`,
  );
  const again = await founderA.client.call(`/v1/projects/${projectId}/rounds`, {
    method: 'POST',
    body: {},
  });
  check('повторный вызов возвращает тот же черновик', again.json?.round?.id === roundId);

  const tooEarly = await founderA.client.call(`/v1/rounds/${roundId}/open`, { method: 'POST' });
  check(
    'открыть незаполненный раунд нельзя, перечень назван',
    tooEarly.response.status === 400 || tooEarly.response.status === 422,
    `статус ${tooEarly.response.status}`,
  );

  const roundForm = (form.json?.sections ?? []).filter((s) => s.scope === 'round');
  const roundAnswers = {};
  for (const q of roundForm.flatMap((s) =>
    s.questions.filter((x) => x.state === 'mandatory' && !x.coreField),
  )) {
    roundAnswers[q.key] = 'ответ раунда';
  }
  const filled = await founderA.client.call(`/v1/rounds/${roundId}`, {
    method: 'PATCH',
    body: {
      target: '3000000.00',
      currency: 'RUB',
      fundingScope: 'project',
      investorMode: 'multiple',
      answers: roundAnswers,
    },
  });
  check(
    'раунд заполнен',
    filled.response.status === 200,
    `статус ${filled.response.status} ${JSON.stringify(filled.json?.errors ?? '')}`,
  );
  const badCurrency = await founderA.client.call(`/v1/rounds/${roundId}`, {
    method: 'PATCH',
    body: { currency: 'KZT' },
  });
  const basis = await founderA.client.call(`/v1/rounds/${roundId}/basis`, {
    method: 'PUT',
    body: { applicationVersionId: versionId, reason: 'основание — поданная версия' },
  });
  check(
    'основание — поданная версия профиля',
    basis.response.status === 200,
    `статус ${basis.response.status}`,
  );
  // Страна обслуживания — явный выбор аккаунта: без неё раунд не открывается.
  const noCountry = await founderA.client.call(`/v1/rounds/${roundId}/open`, { method: 'POST' });
  check(
    'без страны обслуживания раунд не открывается, поле названо',
    (noCountry.response.status === 400 || noCountry.response.status === 422) &&
      JSON.stringify(noCountry.json ?? '').includes('serviceCountry'),
    `статус ${noCountry.response.status}`,
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
  const openKzt = await founderA.client.call(`/v1/rounds/${roundId}/open`, { method: 'POST' });
  check(
    'валюта вне условий страны не даёт открыть раунд',
    badCurrency.response.status === 200 &&
      (openKzt.response.status === 400 || openKzt.response.status === 422) &&
      JSON.stringify(openKzt.json ?? '').includes('currency'),
    `статус ${openKzt.response.status}`,
  );
  await founderA.client.call(`/v1/rounds/${roundId}`, {
    method: 'PATCH',
    body: { currency: 'RUB' },
  });
  const opened = await founderA.client.call(`/v1/rounds/${roundId}/open`, { method: 'POST' });
  check(
    'раунд открыт: страна и версия условий зафиксированы',
    opened.response.status === 201 &&
      opened.json?.round?.status === 'open' &&
      opened.json?.round?.serviceCountry === 'ru' &&
      opened.json?.round?.policyVersion >= 1,
    `статус ${opened.response.status} ${JSON.stringify(opened.json?.errors ?? opened.json?.round?.status ?? '')}`,
  );
  const projectAfter = await founderA.client.call(`/v1/projects/${projectId}`);
  check(
    'сумма проекта — из открытого раунда (кеш)',
    projectAfter.json?.investmentAsk === '3000000.00',
    `${projectAfter.json?.investmentAsk}`,
  );

  // ---------------------------------------- видимость суммы раунда (M085)
  console.warn('\n[видимость раунда] настройка поля × доступ к объекту × аудитория');
  // До листинга проект закрыт для анонима и инвестора при любой настройке.
  {
    const anonBefore = await raw(`/v1/catalog/${projectId}`);
    check(
      'неопубликованный проект: тизера нет, настройка поля доступ не расширяет',
      anonBefore.response.status === 404,
      `статус ${anonBefore.response.status}`,
    );
  }
  await grantFounderSubscription(founderA.userId, projectId);
  await founderA.client.call(`/v1/projects/${projectId}/listing`, { method: 'POST' });
  {
    const anon = await raw(`/v1/catalog/${projectId}`);
    check(
      'стартовая настройка: анониму сумма и состояние раунда не раскрываются',
      anon.response.status === 200 &&
        anon.json?.raising === 'undisclosed' &&
        anon.json?.investmentAsk === null,
      `${anon.json?.raising} ${anon.json?.investmentAsk}`,
    );
    const filtered = await raw('/v1/catalog?askMin=2999999&askMax=3000001');
    const sorted = await raw('/v1/catalog?sort=ask_desc&limit=100');
    check(
      'скрытую сумму нельзя определить фильтром или сортировкой по сумме',
      !(filtered.json?.items ?? []).some((i) => i.id === projectId) &&
        !(sorted.json?.items ?? []).some((i) => i.id === projectId),
    );
    const asInvestor = await investor.client.call(`/v1/catalog/${projectId}`);
    check(
      'инвестор с членством видит состояние и сумму (уровень investors)',
      asInvestor.json?.raising === 'open' && asInvestor.json?.investmentAsk === '3000000.00',
      `${asInvestor.json?.raising} ${asInvestor.json?.investmentAsk}`,
    );
    const card = await investor.client.call(`/v1/projects/${projectId}`);
    check(
      'карточка инвестору — та же проекция раунда',
      card.json?.raising === 'open' && card.json?.investmentAsk === '3000000.00',
      `${card.json?.raising} ${card.json?.investmentAsk}`,
    );
    const asPublic = await founderA.client.call(
      `/v1/applications/${appId}/preview?audience=public`,
    );
    const asInvestors = await founderA.client.call(
      `/v1/applications/${appId}/preview?audience=investors`,
    );
    check(
      'предпросмотр владельцу: аноним — закрыто, инвестор — сумма; по тем же правилам',
      asPublic.json?.audience === 'public' &&
        asPublic.json?.round?.raising === 'undisclosed' &&
        asPublic.json?.round?.investmentAsk === null &&
        asInvestors.json?.round?.raising === 'open' &&
        asInvestors.json?.round?.investmentAsk === '3000000.00' &&
        asInvestors.json?.round?.askCurrency === 'RUB',
      `${asPublic.json?.round?.raising} / ${asInvestors.json?.round?.raising}`,
    );
    const foreignPreview = await founderB.client.call(
      `/v1/applications/${appId}/preview?audience=investors`,
    );
    check(
      'чужой предпросмотр недоступен',
      foreignPreview.response.status === 403 || foreignPreview.response.status === 404,
      `статус ${foreignPreview.response.status}`,
    );
  }
  // Администратор открывает группу публично — конфигурацией, не кодом.
  const setRoundVisibility = async (visibility, reason, statusVisibility = visibility) => {
    const draft = await adminClient.call('/v1/admin/application-forms/draft');
    const config = draft.json?.config;
    for (const q of config?.questions ?? []) {
      if (['investment_ask', 'funding_scope', 'funding_scope_note'].includes(q.key)) {
        q.visibility = visibility;
      }
    }
    config.disclosure = { ...(config.disclosure ?? {}), raising_status: statusVisibility };
    await adminClient.call('/v1/admin/application-forms/draft', {
      method: 'PUT',
      body: { config },
    });
    return adminClient.call('/v1/admin/application-forms/draft/publish', {
      method: 'POST',
      body: { reason },
    });
  };
  {
    const published = await setRoundVisibility('public', 'дымовой прогон: сумма раунда публично');
    check(
      'публикация версии с public — обычная публикация конфигурации',
      published.response.status === 201 && published.json?.isActive === true,
      `статус ${published.response.status}`,
    );
    // Раунд открыт на прежней версии условий: расширение публичности его не
    // касается (M086) — ни в каталоге, ни в предпросмотре.
    const anon = await raw(`/v1/catalog/${projectId}`);
    check(
      'расширение investors → public не раскрывает уже открытый раунд',
      anon.json?.raising === 'undisclosed' && anon.json?.investmentAsk === null,
      `${anon.json?.raising} ${anon.json?.investmentAsk}`,
    );
    const asPublic = await founderA.client.call(
      `/v1/applications/${appId}/preview?audience=public`,
    );
    check(
      'предпросмотр для анонима у открытого раунда остаётся закрытым',
      asPublic.json?.round?.raising === 'undisclosed',
    );
    // Раунд, открытый ПОСЛЕ публикации, — по новой версии: публичен.
    const projectC = await founderA.client.call('/v1/projects', {
      method: 'POST',
      body: {
        title: `Раунд после публикации ${suffix}`,
        tagline: 'Проверка версии условий',
        stage: 'idea',
        taxonomyId: (await sql("SELECT id FROM lab.project_taxonomy WHERE slug = 'ai'"))[0].id,
        investmentAsk: '1000000.00',
        askCurrency: 'RUB',
      },
    });
    const projectCId = projectC.json?.id;
    const appC = await founderA.client.call(`/v1/projects/${projectCId}/applications`, {
      method: 'POST',
      body: {},
    });
    await founderA.client.call(`/v1/applications/${appC.json?.id}`, {
      method: 'PATCH',
      body: { stage: 'idea', answers },
    });
    const submittedC = await founderA.client.call(`/v1/applications/${appC.json?.id}/submit`, {
      method: 'POST',
    });
    const roundC = await founderA.client.call(`/v1/projects/${projectCId}/rounds`, {
      method: 'POST',
      body: { applicationVersionId: submittedC.json?.id },
    });
    await founderA.client.call(`/v1/rounds/${roundC.json?.round?.id}`, {
      method: 'PATCH',
      body: {
        target: '2500000.00',
        currency: 'RUB',
        fundingScope: 'project',
        answers: roundAnswers,
      },
    });
    const openedC = await founderA.client.call(`/v1/rounds/${roundC.json?.round?.id}/open`, {
      method: 'POST',
    });
    await grantFounderSubscription(founderA.userId, projectCId);
    await founderA.client.call(`/v1/projects/${projectCId}/listing`, { method: 'POST' });
    const anonC = await raw(`/v1/catalog/${projectCId}`);
    check(
      'раунд, открытый после публикации public, виден анониму с суммой',
      openedC.response.status === 201 &&
        anonC.json?.raising === 'open' &&
        anonC.json?.investmentAsk === '2500000.00',
      `${openedC.response.status} ${anonC.json?.raising} ${anonC.json?.investmentAsk}`,
    );
    const filtered = await raw('/v1/catalog?askMin=2499999&askMax=2500001');
    check(
      'публичная сумма участвует в фильтре по сумме',
      (filtered.json?.items ?? []).some((i) => i.id === projectCId),
    );
    // Статус отдельно от суммы: ограничение суммы действует сразу, статус остаётся.
    const statusOnly = await setRoundVisibility(
      'investors',
      'дымовой прогон: сумма инвесторам, состояние публично',
      'public',
    );
    const anonStatus = await raw(`/v1/catalog/${projectCId}`);
    check(
      'состояние показывается публично при скрытой сумме; ограничение суммы — сразу',
      statusOnly.response.status === 201 &&
        anonStatus.json?.raising === 'open' &&
        anonStatus.json?.investmentAsk === null,
      `${anonStatus.json?.raising} ${anonStatus.json?.investmentAsk}`,
    );
    const investorC = await investor.client.call(`/v1/catalog/${projectCId}`);
    check(
      'инвестору при этом сумма видна',
      investorC.json?.raising === 'open' && investorC.json?.investmentAsk === '2500000.00',
    );
    const restored = await setRoundVisibility(
      'investors',
      'дымовой прогон: откат видимости суммы к investors',
    );
    const anonAfter = await raw(`/v1/catalog/${projectCId}`);
    check(
      'откат настройки снова закрывает состояние анониму',
      restored.response.status === 201 && anonAfter.json?.raising === 'undisclosed',
      `статус ${restored.response.status} ${anonAfter.json?.raising}`,
    );

    // ------------------------------------------- 5.7.2: Public View, Investor View
    // Согласие владельца на снимок пока ставится напрямую (действия владельца —
    // 5.7.3): снимок — версия, поданная выше мастером; условия — её версия формы.
    {
      const [disclosed] = await sql(
        `UPDATE lab.projects p
          SET disclosed_version_id = v.id, disclosure_form_version = v.schema_version,
              disclosed_at = now(), disclosed_by = $2
         FROM lab.project_versions v
        WHERE p.id = $1 AND v.id = $3
        RETURNING v.schema_version`,
        [projectCId, founderA.userId, submittedC.json?.id],
      );
      const anonView = await raw(`/v1/catalog/${projectCId}`);
      const anonQuestions = (anonView.json?.sections ?? []).flatMap((s) => s.questions);
      check(
        'Public View: анониму — только ответы с эффективной видимостью public',
        anonView.response.status === 200 &&
          anonView.json?.profileAudience === 'public' &&
          anonView.json?.schemaVersion === disclosed?.schema_version &&
          anonQuestions.length > 0 &&
          anonQuestions.every((q) => q.visibility === 'public'),
        `статус ${anonView.response.status}, вопросов ${anonQuestions.length}, аудитория ${anonView.json?.profileAudience}`,
      );
      check(
        'Public View совместим с тизером: id, название, состояние привлечения на месте',
        anonView.json?.id === projectCId &&
          typeof anonView.json?.title === 'string' &&
          typeof anonView.json?.raising === 'string',
      );
      const investorView = await investor.client.call(`/v1/projects/${projectCId}/investor-view`);
      const investorQuestions = (investorView.json?.sections ?? []).flatMap((s) => s.questions);
      check(
        'Investor View: допущенному инвестору — профиль уровня investors, блоки по разрешениям',
        investorView.response.status === 200 &&
          investorView.json?.access?.profile === 'investors' &&
          investorView.json?.access?.round === 'investors' &&
          investorView.json?.access?.materials === 'investors' &&
          investorQuestions.length >= anonQuestions.length &&
          investorView.json?.withheld <= anonView.json?.withheld &&
          Array.isArray(investorView.json?.materials) &&
          investorView.json?.passport === null,
        `статус ${investorView.response.status}, вопросов ${investorQuestions.length}/${anonQuestions.length}, скрыто ${investorView.json?.withheld}/${anonView.json?.withheld}`,
      );
      check(
        'Investor View: поле описания на месте (у проекта прогона пустое) и раунд с суммой инвестору',
        investorView.json?.description !== undefined &&
          investorView.json?.round?.raising === 'open' &&
          investorView.json?.round?.investmentAsk === '2500000.00',
        `${investorView.json?.round?.raising} ${investorView.json?.round?.investmentAsk}`,
      );
      const stranger = await founderB.client.call(`/v1/projects/${projectCId}/investor-view`);
      check(
        'Investor View чужому основателю без допуска: тизер есть, профиль и материалы закрыты',
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
        'предпросмотр владельца: аудитория, режим и согласие названы явно',
        previewPublic.response.status === 200 &&
          previewPublic.json?.audienceSummary?.mode === 'public' &&
          previewPublic.json?.audienceSummary?.anonymous === true &&
          previewPublic.json?.consent?.formVersion === disclosed?.schema_version &&
          typeof previewPublic.json?.consent?.activeFormVersion === 'number' &&
          Array.isArray(previewPublic.json?.pending?.profile) &&
          Array.isArray(previewPublic.json?.pending?.round) &&
          (previewPublic.json?.view?.sections ?? [])
            .flatMap((s) => s.questions)
            .every((q) => q.visibility === 'public'),
        `статус ${previewPublic.response.status} ${JSON.stringify(previewPublic.json?.audienceSummary ?? null)}`,
      );
      const previewByStranger = await founderB.client.call(
        `/v1/projects/${projectCId}/view-preview?audience=public`,
      );
      check(
        'предпросмотр чужого проекта запрещён',
        previewByStranger.response.status === 403,
        `статус ${previewByStranger.response.status}`,
      );
      const openPreview = await founderA.client.call(
        `/v1/rounds/${roundC.json?.round?.id}/open-preview`,
      );
      check(
        'предпросмотр раунда: проекции для обеих аудиторий по активной версии',
        openPreview.response.status === 200 &&
          typeof openPreview.json?.activeFormVersion === 'number' &&
          openPreview.json?.investors?.raising === 'open' &&
          openPreview.json?.investors?.investmentAsk === '2500000.00' &&
          ['open', 'undisclosed'].includes(openPreview.json?.public?.raising) &&
          Array.isArray(openPreview.json?.warnings) &&
          !openPreview.json.warnings.includes('private_project'),
        `статус ${openPreview.response.status} ${JSON.stringify(openPreview.json?.public ?? null)}`,
      );

      // Снятие листинга = режим private: анониму 404, инвестору 404, владельцу —
      // предпросмотр с предупреждением «никто не увидит».
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
      await founderA.client.call(`/v1/projects/${projectCId}/listing`, { method: 'POST' });
    }
  }

  const second = await founderA.client.call(`/v1/projects/${projectId}/rounds`, {
    method: 'POST',
    body: {},
  });
  const secondId = second.json?.round?.id;
  await founderA.client.call(`/v1/rounds/${secondId}`, {
    method: 'PATCH',
    body: { target: '1000000.00', currency: 'RUB', fundingScope: 'project', answers: roundAnswers },
  });
  await founderA.client.call(`/v1/rounds/${secondId}/basis`, {
    method: 'PUT',
    body: { applicationVersionId: versionId, reason: 'второй' },
  });
  const secondOpen = await founderA.client.call(`/v1/rounds/${secondId}/open`, { method: 'POST' });
  check(
    'второй незавершённый раунд на проект невозможен',
    secondOpen.response.status === 409,
    `статус ${secondOpen.response.status}`,
  );

  const paused = await founderA.client.call(`/v1/rounds/${roundId}/pause`, { method: 'POST' });
  check('пауза: привлечение приостановлено', paused.json?.round?.status === 'paused');
  const stillBlocked = await founderA.client.call(`/v1/rounds/${secondId}/open`, {
    method: 'POST',
  });
  check(
    'пауза место не освобождает',
    stillBlocked.response.status === 409,
    `статус ${stillBlocked.response.status}`,
  );
  const resumed = await founderA.client.call(`/v1/rounds/${roundId}/resume`, { method: 'POST' });
  check(
    'возобновление тем же раундом',
    resumed.json?.round?.id === roundId && resumed.json?.round?.status === 'open',
  );

  const history = await founderA.client.call(`/v1/rounds/${roundId}/basis-history`);
  check('история оснований ведётся', (history.json?.items ?? []).length >= 1);

  const closed = await founderA.client.call(`/v1/rounds/${roundId}/close`, {
    method: 'POST',
    body: { closeReason: 'withdrawn' },
  });
  check(
    'закрытие с причиной',
    closed.json?.round?.status === 'closed' && closed.json?.round?.closeReason === 'withdrawn',
  );
  const cancelSecond = await founderA.client.call(`/v1/rounds/${secondId}/cancel`, {
    method: 'POST',
  });
  check('черновик отменён', cancelSecond.json?.round?.status === 'cancelled');

  const countries = await raw('/v1/service-countries');
  check(
    'список стран обслуживания публичен',
    countries.response.status === 200 && (countries.json?.items ?? []).some((c) => c.code === 'ru'),
  );
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
  {
    const withCountry = await register('founder', 'country', { serviceCountry: 'ru' });
    const me = await withCountry.client.call('/v1/auth/me');
    check(
      'регистрация со страной обслуживания: страна в профиле',
      me.json?.serviceCountry === 'ru',
      `${me.json?.serviceCountry}`,
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

  const policy = await founderA.client.call('/v1/service-countries/ru/policy');
  check(
    'условия страны читает вошедший; бесплатная граница выключена',
    policy.response.status === 200 && policy.json?.config?.freeAttraction?.enabled === false,
  );
}

console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено.\n`);
await pool.end();
if (failed > 0) process.exitCode = 1;
