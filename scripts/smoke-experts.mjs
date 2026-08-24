#!/usr/bin/env node
/**
 * Живой прогон Ф8: экспертный совет, сезонный рейтинг, уведомления.
 *
 * Проверяется главное: рецензию пишет только назначенный эксперт и только по
 * принятому назначению; заявленный конфликт интересов физически блокирует
 * назначение; решение по проекту фиксирует человек и не принимается при
 * расхождении оценок без третьего рецензента; лимит золотых билетов держится
 * под конкуренцией; уведомление не утекает чужому пользователю.
 *
 * Запуск: node scripts/smoke-experts.mjs (нужны поднятая БД и core на 4300)
 */
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const BASE = CORE_URL;
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
  const response = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
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

const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));
const suffix = `${Date.now() % 1e9}`;

function blindIndex(email) {
  return createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
}

async function register(tag, extraRole = null) {
  const client = makeClient();
  const email = `exp-${tag}-${suffix}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const { response, json } = await client.call('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: `Тест ${tag}`,
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
    // Роль выдана после входа — сессия должна быть перевыпущена.
    await client.call('/v1/auth/login', { method: 'POST', body: { email, password } });
  }
  return { client, email, password, userId: row.id };
}

const RUBRIC = { team: 8, product: 8, strategy: 8, legal: 8, finmodel: 8, scalability: 8 };
const LOW_RUBRIC = { team: 1, product: 1, strategy: 1, legal: 2, finmodel: 2, scalability: 2 };

console.warn('\n=== ЖИВОЙ ПРОГОН: ЭКСПЕРТИЗА, СЕЗОН, УВЕДОМЛЕНИЯ ===\n');

const founder = await register('f');
const organizer = await register('org', 'organizer');
const expert1 = await register('e1', 'expert');
const expert2 = await register('e2', 'expert');
const expert3 = await register('e3', 'expert');
const outsider = await register('out');

for (const person of [expert1, expert2, expert3]) {
  await sql(
    `INSERT INTO experts.experts (user_id, expertise_tags, capacity_per_week, is_public)
     VALUES ($1, ARRAY['fintech'], 5, true) ON CONFLICT (user_id) DO NOTHING`,
    [person.userId],
  );
}

const [season] = await sql(
  `INSERT INTO seasons.seasons (id, number, title, starts_at, ends_at, status)
   VALUES (public.uuid_generate_v7(),
           (SELECT coalesce(max(number), 0) + 1 FROM seasons.seasons),
           'Сезон прогона', now() - interval '1 day', now() + interval '60 days', 'review')
   RETURNING id, number`,
);

const [taxonomy] = await sql(`SELECT id FROM lab.project_taxonomy WHERE slug = 'fintech'`);
const [project] = await sql(
  `INSERT INTO lab.projects (id, taxonomy_id, season_id, title, stage, status, investment_ask,
                             required_plan_id)
   VALUES (public.uuid_generate_v7(), $1, $2, 'Проект экспертизы', 'growth', 'expert_review',
           5000000, billing.resolve_founder_plan(5000000))
   RETURNING id`,
  [taxonomy.id, season.id],
);
await sql(
  `INSERT INTO lab.founders_projects (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
  [project.id, founder.userId],
);
await sql(
  `INSERT INTO scoring.irs_scores (id, project_id, value) VALUES (public.uuid_generate_v7(), $1, 71.5)`,
  [project.id],
);

const dueAt = new Date(Date.now() + 7 * 86_400_000).toISOString();

// ---------------------------------------------------------------- назначения
console.warn('\n[1] Назначения');
{
  const { response } = await expert1.client.call('/v1/experts/assignments', {
    method: 'POST',
    body: { projectId: project.id, expertIds: [expert1.userId], dueAt, reason: 'manual' },
  });
  check('эксперт не может назначить сам себя', response.status === 403, `HTTP ${response.status}`);
}
{
  const { response } = await organizer.client.call('/v1/experts/assignments', {
    method: 'POST',
    body: { projectId: project.id, expertIds: [expert1.userId], dueAt, reason: 'past' },
  });
  check(
    'неизвестная причина назначения отвергается',
    response.status === 400,
    `HTTP ${response.status}`,
  );
}

let assignment1;
let assignment2;
{
  const { response, json } = await organizer.client.call('/v1/experts/assignments', {
    method: 'POST',
    body: {
      projectId: project.id,
      expertIds: [expert1.userId, expert2.userId],
      dueAt,
      reason: 'auto_taxonomy',
    },
  });
  check(
    'организатор назначает рецензентов',
    response.status === 201 || response.status === 200,
    `HTTP ${response.status}`,
  );
  const items = json?.items ?? [];
  assignment1 = items.find((a) => a.projectId === project.id);
  assignment2 = items[1];
  check('назначено ровно два рецензента', items.length === 2, `получено ${items.length}`);
}
{
  const { response } = await organizer.client.call('/v1/experts/assignments', {
    method: 'POST',
    body: { projectId: project.id, expertIds: [expert1.userId], dueAt, reason: 'manual' },
  });
  check(
    'повторное активное назначение того же эксперта отклонено',
    response.status === 409,
    `HTTP ${response.status}`,
  );
}
{
  const rows = await sql(
    `SELECT count(*)::int AS n FROM comms.notifications
      WHERE user_id = $1 AND template_code = 'expert.assignment.created'`,
    [expert1.userId],
  );
  check('уведомление о назначении поставлено в очередь', rows[0].n === 1, `строк: ${rows[0].n}`);
}
{
  const rows = await sql(
    `SELECT channel FROM comms.notifications WHERE user_id = $1
        AND template_code = 'expert.assignment.created'`,
    [expert1.userId],
  );
  check(
    'запасной канал не получил отдельной строки очереди',
    rows.length === 1 && rows[0].channel === 'push',
    `каналы: ${rows.map((r) => r.channel).join(',')}`,
  );
}

// ------------------------------------------------------------------ рецензии
console.warn('\n[2] Рецензии');
{
  const { response } = await expert1.client.call('/v1/experts/reviews', {
    method: 'POST',
    body: { assignmentId: assignment1.id, rubricScores: RUBRIC, recommendation: 'pass' },
  });
  check(
    'рецензия по непринятому назначению отклонена',
    response.status === 409,
    `HTTP ${response.status}`,
  );
}
for (const [person, assignment] of [
  [expert1, assignment1],
  [expert2, assignment2],
]) {
  const { response } = await person.client.call(
    `/v1/experts/assignments/${assignment.id}/decision`,
    {
      method: 'POST',
      body: { decision: 'accepted' },
    },
  );
  check(
    `назначение принято экспертом ${assignment === assignment1 ? '1' : '2'}`,
    response.status === 200 || response.status === 201,
    `HTTP ${response.status}`,
  );
}
{
  const { response } = await expert2.client.call('/v1/experts/reviews', {
    method: 'POST',
    body: { assignmentId: assignment1.id, rubricScores: RUBRIC, recommendation: 'pass' },
  });
  check(
    'эксперт не может писать рецензию по чужому назначению',
    response.status === 404,
    `HTTP ${response.status}`,
  );
}
{
  const { response } = await expert1.client.call('/v1/experts/reviews', {
    method: 'POST',
    body: { assignmentId: assignment1.id, rubricScores: RUBRIC, recommendation: 'pass' },
  });
  check(
    'рецензия принята',
    response.status === 200 || response.status === 201,
    `HTTP ${response.status}`,
  );
}
{
  const { response } = await expert1.client.call('/v1/experts/reviews', {
    method: 'POST',
    body: { assignmentId: assignment1.id, rubricScores: RUBRIC, recommendation: 'fail' },
  });
  check(
    'повторная рецензия по тому же назначению отклонена',
    response.status === 409,
    `HTTP ${response.status}`,
  );
}
{
  const [row] = await sql(`SELECT status FROM experts.expert_assignments WHERE id = $1`, [
    assignment1.id,
  ]);
  check('назначение закрыто вместе с рецензией', row.status === 'completed', row.status);
}

// ----------------------------------------------------------------- консенсус
console.warn('\n[3] Консенсус');
{
  const { response } = await organizer.client.call('/v1/experts/consensus', {
    method: 'POST',
    body: { projectId: project.id, finalDecision: 'pass' },
  });
  check(
    'решение по одной рецензии не принимается',
    response.status === 409,
    `HTTP ${response.status}`,
  );
}
{
  const { response } = await expert2.client.call('/v1/experts/reviews', {
    method: 'POST',
    // Причина обязательна с M064: отрицательный исход без объяснения не даёт
    // организатору основания для решения, а автору — понимания, что править.
    body: {
      assignmentId: assignment2.id,
      rubricScores: LOW_RUBRIC,
      recommendation: 'fail',
      comment: 'Юнит-экономика не сходится: CAC выше LTV на горизонте 18 месяцев.',
    },
  });
  check(
    'вторая рецензия принята',
    response.status === 200 || response.status === 201,
    `HTTP ${response.status}`,
  );
}
{
  const { response, json } = await organizer.client.call(
    `/v1/experts/projects/${project.id}/reviews`,
  );
  check('организатор видит обе рецензии', json?.items?.length === 2, `HTTP ${response.status}`);
  check(
    'расхождение посчитано',
    typeof json?.discrepancyScore === 'number',
    `значение: ${json?.discrepancyScore}`,
  );
}
{
  const { response } = await expert1.client.call(`/v1/experts/projects/${project.id}/reviews`);
  check('эксперт не читает сводку рецензий', response.status === 403, `HTTP ${response.status}`);
}
{
  const { response, json } = await organizer.client.call('/v1/experts/consensus', {
    method: 'POST',
    body: { projectId: project.id, finalDecision: 'pass' },
  });
  check(
    'решение при расхождении выше порога требует третьего рецензента',
    response.status === 409,
    `HTTP ${response.status} ${json?.detail ?? ''}`,
  );
}
{
  const { response, json } = await organizer.client.call('/v1/experts/consensus', {
    method: 'POST',
    body: { projectId: project.id, finalDecision: 'needs_review', thirdReviewerId: expert3.userId },
  });
  check(
    'решение с третьим рецензентом принято',
    response.status === 200 || response.status === 201,
    `HTTP ${response.status}`,
  );
  check(
    'расхождение сохранено в записи решения',
    json?.discrepancyScore !== null,
    `значение: ${json?.discrepancyScore}`,
  );
  const [row] = await sql(`SELECT decided_by FROM experts.review_consensus WHERE project_id = $1`, [
    project.id,
  ]);
  check('решение подписано человеком из контекста запроса', row.decided_by === organizer.userId);
}
{
  // Агрегат решения — сам консенсус, поэтому и в журнале, и в outbox запись
  // ищется по его идентификатору, а не по проекту.
  const [consensus] = await sql(`SELECT id FROM experts.review_consensus WHERE project_id = $1`, [
    project.id,
  ]);
  const [journal] = await sql(
    `SELECT count(*)::int AS n FROM audit.events
      WHERE verb = 'lab.consensus.decided' AND subject_id = $1`,
    [consensus.id],
  );
  const [outbox] = await sql(
    `SELECT count(*)::int AS n FROM audit.outbox_events
      WHERE event_type = 'lab.consensus.decided' AND aggregate_id = $1`,
    [consensus.id],
  );
  check(
    'решение записано в журнал и в outbox одной транзакцией',
    journal.n === 1 && outbox.n === 1,
    `журнал: ${journal.n}, outbox: ${outbox.n}`,
  );
}
{
  const rows = await sql(
    `SELECT count(*)::int AS n FROM comms.notifications
      WHERE user_id = $1 AND template_code = 'expert.consensus.decided'`,
    [founder.userId],
  );
  check('основатель уведомлён о решении', rows[0].n === 1, `строк: ${rows[0].n}`);
}

// ----------------------------------------------------------------- конфликты
console.warn('\n[4] Конфликт интересов');
let conflictId;
{
  const { response, json } = await expert3.client.call('/v1/experts/conflicts', {
    method: 'POST',
    body: { projectId: project.id, description: 'Работал советником этого проекта в 2025 году' },
  });
  check(
    'эксперт заявляет конфликт',
    response.status === 200 || response.status === 201,
    `HTTP ${response.status}`,
  );
  conflictId = json?.id;
}
{
  const { response } = await organizer.client.call('/v1/experts/assignments', {
    method: 'POST',
    body: { projectId: project.id, expertIds: [expert3.userId], dueAt, reason: 'third_reviewer' },
  });
  check(
    'неразрешённый конфликт блокирует назначение',
    response.status === 409,
    `HTTP ${response.status}`,
  );
}
{
  const { response } = await expert1.client.call(`/v1/experts/conflicts/${conflictId}/resolution`, {
    method: 'POST',
    body: { resolution: 'approved_with_disclosure' },
  });
  check('эксперт не разрешает конфликт сам', response.status === 403, `HTTP ${response.status}`);
}
{
  const { response } = await organizer.client.call(
    `/v1/experts/conflicts/${conflictId}/resolution`,
    {
      method: 'POST',
      body: { resolution: 'approved_with_disclosure' },
    },
  );
  check(
    'комплаенс разрешает конфликт',
    response.status === 200 || response.status === 201,
    `HTTP ${response.status}`,
  );
}
{
  const { response } = await organizer.client.call('/v1/experts/assignments', {
    method: 'POST',
    body: { projectId: project.id, expertIds: [expert3.userId], dueAt, reason: 'third_reviewer' },
  });
  check(
    'после раскрытия конфликта назначение проходит',
    response.status === 200 || response.status === 201,
    `HTTP ${response.status}`,
  );
}

// -------------------------------------------------------------------- сезоны
console.warn('\n[5] Рейтинг и золотые билеты');
{
  const { response } = await expert1.client.call(`/v1/seasons/${season.id}/rating/refresh`, {
    method: 'POST',
  });
  check('эксперт не пересчитывает рейтинг', response.status === 403, `HTTP ${response.status}`);
}
{
  const { response, json } = await organizer.client.call(
    `/v1/seasons/${season.id}/rating/refresh`,
    {
      method: 'POST',
    },
  );
  check(
    'организатор пересчитывает рейтинг',
    response.status === 200 || response.status === 201,
    `HTTP ${response.status} ${json?.detail ?? ''}`,
  );
}
{
  const { response, json } = await raw(`/v1/seasons/${season.id}/rating`);
  check('рейтинг читается анонимно', response.status === 200, `HTTP ${response.status}`);
  const entry = (json?.items ?? []).find((i) => i.projectId === project.id);
  check('проект попал в рейтинг с фактическим IRS', entry?.irs === 71.5, `значение: ${entry?.irs}`);
}
{
  const { response } = await organizer.client.call(`/v1/seasons/${season.id}/golden-tickets`, {
    method: 'POST',
    body: { projectId: project.id, reason: 'Победитель зрительского голосования сезона' },
  });
  check(
    'золотой билет выдан',
    response.status === 200 || response.status === 201,
    `HTTP ${response.status}`,
  );
}
{
  const { response } = await organizer.client.call(`/v1/seasons/${season.id}/golden-tickets`, {
    method: 'POST',
    body: { projectId: project.id, reason: 'Повторная выдача тому же проекту' },
  });
  check(
    'второй билет тому же проекту отклонён',
    response.status === 409,
    `HTTP ${response.status}`,
  );
}
{
  // Лимит выдающего — два билета за сезон. Второй проект укладывается, третий — нет.
  const extra = [];
  for (let i = 0; i < 2; i += 1) {
    const [row] = await sql(
      `INSERT INTO lab.projects (id, taxonomy_id, season_id, title, stage, status, investment_ask,
                                 required_plan_id)
       VALUES (public.uuid_generate_v7(), $1, $2, $3, 'growth', 'expert_review', 5000000,
               billing.resolve_founder_plan(5000000))
       RETURNING id`,
      [taxonomy.id, season.id, `Проект лимита ${i}`],
    );
    extra.push(row.id);
  }
  const second = await organizer.client.call(`/v1/seasons/${season.id}/golden-tickets`, {
    method: 'POST',
    body: { projectId: extra[0], reason: 'Второй билет в пределах лимита сезона' },
  });
  check(
    'второй билет организатора проходит',
    second.response.status < 400,
    `HTTP ${second.response.status}`,
  );
  const third = await organizer.client.call(`/v1/seasons/${season.id}/golden-tickets`, {
    method: 'POST',
    body: { projectId: extra[1], reason: 'Третий билет сверх лимита сезона' },
  });
  check(
    'третий билет отклонён лимитом',
    third.response.status === 422,
    `HTTP ${third.response.status}`,
  );
}

// --------------------------------------------------------------- уведомления
console.warn('\n[6] Уведомления');
{
  const { response, json } = await expert1.client.call('/v1/notifications');
  check(
    'эксперт видит свою ленту',
    response.status === 200 && (json?.items?.length ?? 0) >= 1,
    `HTTP ${response.status}, строк: ${json?.items?.length}`,
  );
}
{
  const { json } = await outsider.client.call('/v1/notifications');
  check(
    'посторонний не видит чужих уведомлений',
    (json?.items?.length ?? 0) === 0,
    `строк: ${json?.items?.length}`,
  );
}
let deviceId;
{
  const token = `tok-${randomUUID()}`;
  const first = await expert1.client.call('/v1/notifications/devices', {
    method: 'POST',
    body: { platform: 'ios', pushProvider: 'apns', pushToken: token, deviceName: 'iPhone прогона' },
  });
  check(
    'устройство зарегистрировано',
    first.response.status < 400,
    `HTTP ${first.response.status}`,
  );
  deviceId = first.json?.id;
  check('push-токен не возвращается наружу', first.json?.pushToken === undefined);

  const again = await expert1.client.call('/v1/notifications/devices', {
    method: 'POST',
    body: { platform: 'ios', pushProvider: 'apns', pushToken: token, deviceName: 'iPhone прогона' },
  });
  check(
    'повторная регистрация идемпотентна',
    again.json?.id === deviceId,
    `HTTP ${again.response.status}`,
  );

  const stolen = await expert2.client.call('/v1/notifications/devices', {
    method: 'POST',
    body: { platform: 'ios', pushProvider: 'apns', pushToken: token },
  });
  check(
    'чужой push-токен не переназначается',
    stolen.response.status === 409,
    `HTTP ${stolen.response.status}`,
  );
}
{
  const { response } = await expert2.client.call(`/v1/notifications/devices/${deviceId}`, {
    method: 'DELETE',
  });
  check('чужое устройство не отзывается', response.status === 404, `HTTP ${response.status}`);
}
{
  const { response } = await expert1.client.call(`/v1/notifications/devices/${deviceId}`, {
    method: 'DELETE',
  });
  check('своё устройство отзывается', response.status < 400, `HTTP ${response.status}`);
}
{
  const { response } = await expert1.client.call('/v1/notifications/preferences', {
    method: 'PUT',
    body: { items: [{ channel: 'email', topic: 'security', enabled: false }] },
  });
  check(
    'уведомления безопасности отключить нельзя',
    response.status === 400,
    `HTTP ${response.status}`,
  );
}
{
  const { response, json } = await expert1.client.call('/v1/notifications/preferences', {
    method: 'PUT',
    body: { items: [{ channel: 'email', topic: 'marketing', enabled: false }] },
  });
  check(
    'маркетинговые уведомления отключаются',
    response.status < 400 &&
      json?.items?.some((i) => i.topic === 'marketing' && i.enabled === false),
    `HTTP ${response.status}`,
  );
}
{
  const rows = await sql(
    `SELECT payload_jsonb FROM comms.notifications WHERE user_id = $1 LIMIT 5`,
    [expert1.userId],
  );
  const keys = rows.flatMap((r) => Object.keys(r.payload_jsonb));
  const leaking = keys.filter((k) => /email|phone|passport|token|secret/i.test(k));
  check(
    'в очереди уведомлений нет ПДн и секретов',
    leaking.length === 0,
    `подозрительные ключи: ${leaking.join(',') || 'нет'}`,
  );
}

// -------------------------------------------------- рабочая зона эксперта (M064)
//
// Проверяется то, чего в workflow не хватало по ТЗ №8: причина при
// отрицательном исходе, внутренние заметки, пересмотр результата и история
// рассмотрения.
//
// Раздел работает на СВОЁМ проекте и своём назначении: разделы выше опираются
// на состояние своих фикстур (сколько рецензий подано, принято ли решение), и
// переиспользование чужого назначения красит их по неверной причине.
console.warn('\n[7] Рабочая зона эксперта');

const [wsProject] = await sql(
  `INSERT INTO lab.projects (id, taxonomy_id, season_id, title, stage, status, investment_ask,
                             required_plan_id)
   VALUES (public.uuid_generate_v7(), $1, $2, 'Проект рабочей зоны', 'mvp', 'expert_review',
           3000000, billing.resolve_founder_plan(3000000))
   RETURNING id`,
  [taxonomy.id, season.id],
);
await sql(
  `INSERT INTO lab.founders_projects (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
  [wsProject.id, founder.userId],
);

let wsAssignment;
{
  const { response, json } = await organizer.client.call('/v1/experts/assignments', {
    method: 'POST',
    body: { projectId: wsProject.id, expertIds: [expert3.userId], dueAt, reason: 'manual' },
  });
  check('назначение для рабочей зоны создано', response.status === 201, `HTTP ${response.status}`);
  wsAssignment = (json?.items ?? [])[0];
  await expert3.client.call(`/v1/experts/assignments/${wsAssignment.id}/decision`, {
    method: 'POST',
    body: { decision: 'accepted' },
  });
}

// --- причина при отрицательном исходе обязательна
{
  const { response } = await expert3.client.call('/v1/experts/reviews', {
    method: 'POST',
    body: { assignmentId: wsAssignment.id, rubricScores: RUBRIC, recommendation: 'needs_review' },
  });
  check('доработка без причины отвергнута', response.status === 400, `HTTP ${response.status}`);
}
{
  const { response } = await expert3.client.call('/v1/experts/reviews', {
    method: 'POST',
    body: {
      assignmentId: wsAssignment.id,
      rubricScores: RUBRIC,
      recommendation: 'needs_review',
      comment: 'Нет финансовой модели на 3 года и не раскрыта структура владения.',
    },
  });
  check('доработка с причиной принята', response.status === 201, `HTTP ${response.status}`);
}
{
  const [row] = await sql(`SELECT comment FROM experts.expert_reviews WHERE assignment_id = $1`, [
    wsAssignment.id,
  ]);
  check(
    'причина доработки сохранена',
    (row?.comment ?? '').includes('финансовой модели'),
    (row?.comment ?? '').slice(0, 40),
  );
}

// --- внутренние заметки
{
  const { response, json } = await expert3.client.call(
    `/v1/experts/assignments/${wsAssignment.id}/notes`,
    { method: 'POST', body: { body: 'Запросил у организатора доступ к финмодели.' } },
  );
  check('заметка сохранена', response.status === 201, `HTTP ${response.status}`);
  check('заметка вернулась с моментом', typeof json?.createdAt === 'string', json?.createdAt);
}
{
  const { json } = await expert3.client.call(`/v1/experts/assignments/${wsAssignment.id}/notes`);
  check('своя заметка видна автору', (json?.items ?? []).length === 1, `${(json?.items ?? []).length}`);
}
{
  const { json } = await expert1.client.call(`/v1/experts/assignments/${wsAssignment.id}/notes`);
  // Чужое назначение политикой не видно — список пуст, а не отказ: сам факт
  // существования чужого назначения тоже не подтверждается.
  check('чужие заметки не видны', (json?.items ?? []).length === 0, `${(json?.items ?? []).length}`);
}
{
  const { response } = await expert1.client.call(
    `/v1/experts/assignments/${wsAssignment.id}/notes`,
    { method: 'POST', body: { body: 'Заметка в чужое рассмотрение' } },
  );
  check('в чужое рассмотрение не написать', response.status === 404, `HTTP ${response.status}`);
}
{
  const { response } = await outsider.client.call(
    `/v1/experts/assignments/${wsAssignment.id}/notes`,
    { method: 'POST', body: { body: 'Посторонний' } },
  );
  check('посторонний без роли эксперта — 403', response.status === 403, `HTTP ${response.status}`);
}
{
  const [row] = await sql(
    `SELECT count(*)::int AS n FROM audit.events
      WHERE verb = 'lab.expert.note_added' AND subject_id = $1`,
    [wsAssignment.id],
  );
  check('заметка попала в журнал', row.n === 1, `записей: ${row.n}`);
  const [text] = await sql(
    `SELECT count(*)::int AS n FROM audit.events
      WHERE verb = 'lab.expert.note_added' AND context_jsonb::text ILIKE '%финмодели%'`,
  );
  // Текст заметки в журнал не кладётся: журнал хеш-сцеплен, оттуда потом
  // ничего не убрать.
  check('текста заметки в журнале нет', text.n === 0, `записей: ${text.n}`);
}

// --- пересмотр результата до решения
{
  const { response, json } = await expert3.client.call(
    `/v1/experts/assignments/${wsAssignment.id}/review`,
    { method: 'PATCH', body: { rubricScores: RUBRIC, recommendation: 'pass' } },
  );
  check('пересмотр принят до решения', response.status === 200, `HTTP ${response.status}`);
  check('рекомендация изменилась', json?.recommendation === 'pass', String(json?.recommendation));
}
{
  // ВТОРОЙ пересмотр подряд. Проверка появилась по факту падения: версия
  // агрегата в событии стояла константой, и второй пересмотр нарушал
  // уникальность (agg_type, agg_id, agg_version, event_type) в outbox — 409
  // вместо 200. То же касалось и второй заметки.
  const { response, json } = await expert3.client.call(
    `/v1/experts/assignments/${wsAssignment.id}/review`,
    {
      method: 'PATCH',
      body: {
        rubricScores: RUBRIC,
        recommendation: 'needs_review',
        comment: 'После уточнения: доработать раздел про структуру владения.',
      },
    },
  );
  check('второй пересмотр подряд принят', response.status === 200, `HTTP ${response.status}`);
  check('рекомендация снова изменилась', json?.recommendation === 'needs_review');
  // Возврат к предыдущему исходу — чтобы дальнейшие проверки шли от известного
  // состояния.
  await expert3.client.call(`/v1/experts/assignments/${wsAssignment.id}/review`, {
    method: 'PATCH',
    body: { rubricScores: RUBRIC, recommendation: 'pass' },
  });
}
{
  const { response } = await expert3.client.call(
    `/v1/experts/assignments/${wsAssignment.id}/notes`,
    { method: 'POST', body: { body: 'Финмодель получена, считаю заново.' } },
  );
  check('вторая заметка подряд принята', response.status === 201, `HTTP ${response.status}`);
}
{
  const { response } = await expert1.client.call(
    `/v1/experts/assignments/${wsAssignment.id}/review`,
    { method: 'PATCH', body: { rubricScores: RUBRIC, recommendation: 'fail', comment: 'Чужая' } },
  );
  check('чужую рецензию не пересмотреть', response.status === 404, `HTTP ${response.status}`);
}
{
  const [row] = await sql(`SELECT status FROM experts.expert_assignments WHERE id = $1`, [
    wsAssignment.id,
  ]);
  check('пересмотр не открывает назначение заново', row.status === 'completed', row.status);
}
{
  const [row] = await sql(
    `SELECT count(*)::int AS n FROM audit.events
      WHERE verb = 'lab.expert.review_revised' AND subject_id = $1`,
    [wsAssignment.id],
  );
  // Три пересмотра: первый, второй подряд и возврат к прежнему исходу. Каждый
  // обязан оставить СВОЮ запись — именно это и ломала константная версия
  // агрегата, гасившая второе событие.
  check('каждый пересмотр попал в журнал', row.n === 3, `записей: ${row.n}`);
}

// --- история рассмотрения
{
  const { response, json } = await expert3.client.call(
    `/v1/experts/assignments/${wsAssignment.id}/history`,
  );
  check('история отдаётся', response.status === 200, `HTTP ${response.status}`);
  const verbs = (json?.items ?? []).map((item) => item.verb);
  check(
    'в истории есть назначение — видно и чужое действие по своему назначению',
    verbs.includes('lab.expert.assigned'),
    verbs.join(', ').slice(0, 100),
  );
  check('в истории есть подача рецензии', verbs.includes('lab.expert.review_submitted'));
  check('в истории есть пересмотр', verbs.includes('lab.expert.review_revised'));
  check(
    'история упорядочена по времени',
    (json?.items ?? []).every(
      (item, i, all) => i === 0 || Date.parse(item.at) >= Date.parse(all[i - 1].at),
    ),
  );
  const details = JSON.stringify((json?.items ?? []).map((item) => item.details));
  check(
    'в истории нет рубричных оценок и идентификаторов людей',
    !/team|product|scalability|expertId|actorId/.test(details),
    details.slice(0, 90),
  );
}
{
  const { json } = await expert1.client.call(`/v1/experts/assignments/${wsAssignment.id}/history`);
  check(
    'история чужого назначения пуста',
    (json?.items ?? []).length === 0,
    `${(json?.items ?? []).length}`,
  );
}
{
  const { json } = await expert3.client.call('/v1/experts/assignments');
  const mine = (json?.items ?? []).find((item) => item.id === wsAssignment.id);
  check('в назначении виден этап проекта', mine?.projectStatus === 'expert_review', mine?.projectStatus);
  check('видно, что рецензия подана', mine?.reviewSubmitted === true);
  check('пересмотр пока разрешён', mine?.revisable === true);
}

// --- после решения окно пересмотра закрывается
{
  // Решение принимается не менее чем по двум рецензиям — это правило раздела
  // «Консенсус», и его надо соблюсти, а не обойти: без второй рецензии
  // консенсуса нет, и проверка «после решения пересмотр закрыт» была бы
  // зелёной по неверной причине (поймано прогоном: 409 на решении и всё равно
  // 409 на пересмотре).
  const { json: second } = await organizer.client.call('/v1/experts/assignments', {
    method: 'POST',
    body: { projectId: wsProject.id, expertIds: [expert2.userId], dueAt, reason: 'manual' },
  });
  const secondAssignment = (second?.items ?? [])[0];
  await expert2.client.call(`/v1/experts/assignments/${secondAssignment.id}/decision`, {
    method: 'POST',
    body: { decision: 'accepted' },
  });
  await expert2.client.call('/v1/experts/reviews', {
    method: 'POST',
    body: { assignmentId: secondAssignment.id, rubricScores: RUBRIC, recommendation: 'pass' },
  });

  const { response } = await organizer.client.call('/v1/experts/consensus', {
    method: 'POST',
    body: { projectId: wsProject.id, finalDecision: 'needs_review' },
  });
  // Позитивный контроль: решение обязано пройти, иначе следующая проверка была
  // бы зелёной просто потому, что решения нет.
  check('организатор принял решение', response.status === 201, `HTTP ${response.status}`);
}
{
  const { response } = await expert3.client.call(
    `/v1/experts/assignments/${wsAssignment.id}/review`,
    {
      method: 'PATCH',
      body: { rubricScores: RUBRIC, recommendation: 'fail', comment: 'Передумал после решения' },
    },
  );
  check(
    'после решения пересмотр закрыт',
    response.status === 403 || response.status === 409,
    `HTTP ${response.status}`,
  );
  const [row] = await sql(
    `SELECT recommendation FROM experts.expert_reviews WHERE assignment_id = $1`,
    [wsAssignment.id],
  );
  check('рецензия осталась прежней', row.recommendation === 'pass', row.recommendation);
}
{
  const { json } = await expert3.client.call('/v1/experts/assignments');
  const mine = (json?.items ?? []).find((item) => item.id === wsAssignment.id);
  // Кабинет обязан ЗНАТЬ о закрытии окна, а не выяснять его отказом на кнопке.
  check('кабинет знает, что пересмотр закрыт', mine?.revisable === false, String(mine?.revisable));
}

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
await pool.end();
process.exit(failed > 0 ? 1 : 0);
