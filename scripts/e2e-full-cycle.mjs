#!/usr/bin/env node
/**
 * Сквозной сценарий платформы: путь проекта через все роли.
 *
 * Каждая фаза проверяла свой кусок; здесь проверяется, что куски складываются в
 * одну работающую цепочку и что данные ОДНОЙ роли доходят до другой ровно так,
 * как задумано:
 *
 *   основатель подал заявку
 *   → организатор открыл сезон и назначил рецензентов
 *   → эксперты приняли назначения и сдали рецензии
 *   → организатор зафиксировал решение (человек, а не модель)
 *   → рейтинг пересчитан, проект выпущен
 *   → внешняя система увидела выпускника через Integration API
 *   → событие ушло в outbox
 *
 * Отдельно проверяется, что цепочка НЕ пропускает того, кого не должна:
 * посторонний не видит чужой проект, эксперт не решает за организатора,
 * внешняя система не получает персональных данных.
 *
 * Запуск: node scripts/e2e-full-cycle.mjs (нужны БД и core на 4300)
 */
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const BASE = process.env.CORE_URL ?? 'http://127.0.0.1:4300';
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'ul_csrf';

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

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

async function raw(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* не JSON */
  }
  return { response, json };
}

function makeClient() {
  const state = { session: null, csrf: null };
  async function call(path, { method = 'GET', body } = {}) {
    const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) {
      headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
    }
    const result = await raw(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of result.response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(';')[0];
      if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
      if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
    }
    return result;
  }
  return { call };
}

const suffix = `${Date.now() % 1e9}`;
const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

function blindIndex(email) {
  return createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
}

async function register(tag, extraRole = null) {
  const client = makeClient();
  const email = `e2e-${tag}-${suffix}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const { response, json } = await client.call('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: `E2E ${tag}`,
      role: 'founder',
      locale: 'ru-RU',
      consents: CONSENTS,
    },
  });
  if (response.status >= 400) throw new Error(`регистрация ${tag}: ${JSON.stringify(json)}`);
  const [row] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
    blindIndex(email),
  ]);
  if (extraRole) {
    await sql(
      `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [row.id, extraRole],
    );
    await client.call('/v1/auth/login', { method: 'POST', body: { email, password } });
  }
  return { client, email, password, userId: row.id };
}

console.warn('\n=== СКВОЗНОЙ СЦЕНАРИЙ ПЛАТФОРМЫ ===\n');

// ------------------------------------------------------------- участники
console.warn('[1] Участники и сезон');
const founder = await register('founder');
const organizer = await register('organizer', 'organizer');
const expertA = await register('expert-a', 'expert');
const expertB = await register('expert-b', 'expert');
const outsider = await register('outsider');

for (const person of [expertA, expertB]) {
  await sql(
    `INSERT INTO experts.experts (user_id, expertise_tags) VALUES ($1, ARRAY['fintech'])
     ON CONFLICT (user_id) DO NOTHING`,
    [person.userId],
  );
}
check('участники созданы', true, 'основатель, организатор, два эксперта, посторонний');

const [season] = await sql(
  `INSERT INTO seasons.seasons (id, number, title, starts_at, ends_at, status)
   VALUES (public.uuid_generate_v7(),
           (SELECT coalesce(max(number), 0) + 1 FROM seasons.seasons),
           'Сквозной сезон', now() - interval '1 day', now() + interval '60 days', 'draft')
   RETURNING id, number`,
);
{
  const { response } = await organizer.client.call(`/v1/seasons/${season.id}/status`, {
    method: 'POST',
    body: { status: 'applications_open' },
  });
  check('организатор открыл приём заявок', response.status < 400, `HTTP ${response.status}`);
}
{
  // Основатель не может управлять сезоном — это не его роль.
  const { response } = await founder.client.call(`/v1/seasons/${season.id}/status`, {
    method: 'POST',
    body: { status: 'review' },
  });
  check('основатель не управляет сезоном', response.status === 403, `HTTP ${response.status}`);
}

// -------------------------------------------------------------- заявка
console.warn('\n[2] Заявка основателя');
const [taxonomy] = await sql(`SELECT id FROM lab.project_taxonomy WHERE slug = 'fintech'`);
let projectId;
{
  const { response, json } = await founder.client.call('/v1/projects', {
    method: 'POST',
    body: {
      title: `Сквозной проект ${suffix}`,
      tagline: 'Проверка полного цикла платформы',
      stage: 'growth',
      taxonomyId: taxonomy.id,
      investmentAsk: '5000000.00',
      askCurrency: 'RUB',
    },
  });
  check('проект создан', response.status < 400, `HTTP ${response.status}`);
  projectId = json?.id;
}
{
  const { response, json } = await founder.client.call(`/v1/projects/${projectId}/submit`, {
    method: 'POST',
  });
  check('заявка подана в сезон', response.status < 400, `HTTP ${response.status}`);
  check('создан неизменяемый снимок версии', json?.versionNo === 1, `версия ${json?.versionNo}`);
}
{
  const { json } = await outsider.client.call('/v1/projects');
  check(
    'посторонний не видит чужой проект',
    !(json?.items ?? []).some((p) => p.id === projectId),
    `проектов у постороннего: ${json?.items?.length ?? 0}`,
  );
}

// ------------------------------------------------------------- экспертиза
console.warn('\n[3] Экспертиза');
await sql(`UPDATE lab.projects SET status = 'expert_review' WHERE id = $1`, [projectId]);
const dueAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
{
  const { response, json } = await organizer.client.call('/v1/experts/assignments', {
    method: 'POST',
    body: {
      projectId,
      expertIds: [expertA.userId, expertB.userId],
      dueAt,
      reason: 'auto_taxonomy',
    },
  });
  check('организатор назначил двух рецензентов', response.status < 400, `HTTP ${response.status}`);
  check(
    'назначено ровно два рецензента',
    (json?.items ?? []).length === 2,
    `назначений: ${(json?.items ?? []).length}`,
  );
}
{
  // Эксперт не может назначать — назначение это решение организатора.
  const { response } = await expertA.client.call('/v1/experts/assignments', {
    method: 'POST',
    body: { projectId, expertIds: [expertA.userId], dueAt, reason: 'manual' },
  });
  check('эксперт не назначает рецензентов', response.status === 403, `HTTP ${response.status}`);
}

const RUBRIC_HIGH = { team: 8, product: 8, strategy: 8, legal: 8, finmodel: 8, scalability: 8 };
const RUBRIC_MID = { team: 7, product: 7, strategy: 6, legal: 7, finmodel: 6, scalability: 7 };

for (const [person, rubric, label] of [
  [expertA, RUBRIC_HIGH, 'A'],
  [expertB, RUBRIC_MID, 'B'],
]) {
  const mine = await person.client.call('/v1/experts/assignments');
  const assignment = (mine.json?.items ?? [])[0];
  check(
    `эксперт ${label} видит своё назначение`,
    assignment !== undefined,
    `назначений: ${mine.json?.items?.length ?? 0}`,
  );

  const decided = await person.client.call(`/v1/experts/assignments/${assignment.id}/decision`, {
    method: 'POST',
    body: { decision: 'accepted' },
  });
  check(
    `эксперт ${label} принял назначение`,
    decided.response.status < 400,
    `HTTP ${decided.response.status}`,
  );

  const review = await person.client.call('/v1/experts/reviews', {
    method: 'POST',
    body: { assignmentId: assignment.id, rubricScores: rubric, recommendation: 'pass' },
  });
  check(
    `эксперт ${label} сдал рецензию`,
    review.response.status < 400,
    `HTTP ${review.response.status}`,
  );
}

{
  const { json } = await organizer.client.call(`/v1/experts/projects/${projectId}/reviews`);
  check(
    'организатор видит обе рецензии',
    json?.items?.length === 2,
    `рецензий: ${json?.items?.length}`,
  );
  check(
    'расхождение оценок посчитано',
    typeof json?.discrepancyScore === 'number',
    `разброс ${json?.discrepancyScore}`,
  );
}
{
  // Решение принимает человек — эксперт этого сделать не может.
  const { response } = await expertA.client.call('/v1/experts/consensus', {
    method: 'POST',
    body: { projectId, finalDecision: 'pass' },
  });
  check(
    'эксперт не фиксирует решение за организатора',
    response.status === 403,
    `HTTP ${response.status}`,
  );
}
{
  const { response, json } = await organizer.client.call('/v1/experts/consensus', {
    method: 'POST',
    body: { projectId, finalDecision: 'pass' },
  });
  check('организатор зафиксировал решение', response.status < 400, `HTTP ${response.status}`);
  const [row] = await sql('SELECT decided_by FROM experts.review_consensus WHERE project_id = $1', [
    projectId,
  ]);
  check('решение подписано человеком из контекста', row?.decided_by === organizer.userId);
  check('расхождение сохранено в записи', json?.discrepancyScore !== undefined);
}

// -------------------------------------------------------------- выпуск
console.warn('\n[4] Выпуск и рейтинг');
await sql(
  `INSERT INTO scoring.irs_scores (id, project_id, value)
   VALUES (public.uuid_generate_v7(), $1, 77.50)`,
  [projectId],
);
await sql(`UPDATE lab.projects SET status = 'graduated' WHERE id = $1`, [projectId]);
{
  const [row] = await sql('SELECT graduated_at FROM lab.projects WHERE id = $1', [projectId]);
  check('момент выпуска проставлен триггером', row.graduated_at !== null);
}
{
  const { response } = await organizer.client.call(`/v1/seasons/${season.id}/rating/refresh`, {
    method: 'POST',
  });
  check('рейтинг сезона пересчитан', response.status < 400, `HTTP ${response.status}`);
}
{
  const { response, json } = await raw(`/v1/seasons/${season.id}/rating`);
  const entry = (json?.items ?? []).find((item) => item.projectId === projectId);
  check(
    'выпускник попал в публичный рейтинг',
    entry?.irs === 77.5,
    `HTTP ${response.status}, IRS ${entry?.irs}`,
  );
}

// ------------------------------------------------------ внешняя система
console.warn('\n[5] Внешняя система через Integration API');
const admin = await register('admin', 'admin');
const clientId = `e2e-capital-${suffix}`;
let token;
{
  const { json } = await admin.client.call('/v1/admin/service-accounts', {
    method: 'POST',
    body: {
      name: 'E2E Capital',
      clientId,
      scopes: ['graduates:read', 'passport:read', 'seasons:read'],
      mtlsCertFingerprint: 'e'.repeat(64),
    },
  });
  const tokenResponse = await raw('/v1/integration/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret: json.clientSecret }),
  });
  token = tokenResponse.json?.accessToken;
  check('внешняя система получила токен', typeof token === 'string');
}
{
  const { response, json } = await raw('/v1/integration/graduates?limit=50', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const graduate = (json?.items ?? []).find((item) => item.projectId === projectId);
  check('выпускник виден внешней системе', graduate !== undefined, `HTTP ${response.status}`);
  check('IRS передан внешней системе', graduate?.irs === 77.5, `IRS ${graduate?.irs}`);

  const serialized = JSON.stringify(json);
  const leaked = serialized.match(/@test\.local|email|phone|userId|founder/i);
  check(
    'в выдаче внешней системе нет персональных данных',
    leaked === null,
    `найдено: ${leaked?.[0] ?? 'нет'}`,
  );
}
{
  // Скоупа на сделки у клиента нет — и он его не получит.
  const { response } = await raw('/v1/integration/deals', {
    headers: { Authorization: `Bearer ${token}` },
  });
  check(
    'без скоупа deals:read доступа к сделкам нет',
    response.status === 403,
    `HTTP ${response.status}`,
  );
}

// --------------------------------------------------------------- события
console.warn('\n[6] События');
{
  const rows = await sql(
    // Приведение обязательно: aggregate_id — UUID, а значение из jsonb —
    // текст, и сравнивать их напрямую PostgreSQL отказывается.
    `SELECT event_type, published_at FROM audit.outbox_events
      WHERE aggregate_id = $1::uuid OR payload_jsonb->>'projectId' = $1::text
      ORDER BY created_at`,
    [projectId],
  );
  check('события проекта попали в outbox', rows.length > 0, `событий: ${rows.length}`);

  // Публикатор работает по интервалу, а не синхронно с доменной операцией — в
  // этом весь смысл transactional outbox. Проверять сразу после действия
  // значит проверять скорость таймера, а не работу публикации: ждём с
  // таймаутом, иначе результат зависит от того, чья очередь подошла первой.
  let published = 0;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const [row] = await sql(
      `SELECT count(*)::int AS n FROM audit.outbox_events
        WHERE (aggregate_id = $1::uuid OR payload_jsonb->>'projectId' = $1::text)
          AND published_at IS NOT NULL`,
      [projectId],
    );
    published = row.n;
    if (published > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  check(
    'события опубликованы в брокер',
    published > 0,
    `опубликовано ${published} из ${rows.length}`,
  );
}
{
  const [chain] = await sql(`SELECT count(*)::int AS broken FROM audit.verify_event_chain(NULL)`);
  check('hash-chain журнала цел', chain.broken === 0, `нарушений: ${chain.broken}`);
}

// ------------------------------------------------------------ уведомления
console.warn('\n[7] Уведомления');
{
  const rows = await sql(`SELECT template_code FROM comms.notifications WHERE user_id = $1`, [
    expertA.userId,
  ]);
  check(
    'эксперт получил уведомление о назначении',
    rows.some((row) => row.template_code === 'expert.assignment.created'),
    `уведомлений: ${rows.length}`,
  );

  const founderRows = await sql(
    `SELECT template_code FROM comms.notifications WHERE user_id = $1`,
    [founder.userId],
  );
  check(
    'основатель уведомлён о решении',
    founderRows.some((row) => row.template_code === 'expert.consensus.decided'),
    `уведомлений: ${founderRows.length}`,
  );
}

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
await pool.end();
process.exit(failed > 0 ? 1 : 0);
