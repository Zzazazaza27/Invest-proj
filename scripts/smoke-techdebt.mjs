#!/usr/bin/env node
/**
 * Живой прогон закрытого техдолга.
 *
 * Проверяется ровно то, что было объявлено закрытым, и на границах, а не «в
 * среднем»: рецензент видит материалы НАЗНАЧЕННОГО проекта и не видит чужие;
 * этап проекта двигается на один шаг и не перепрыгивает; квота этапа держится,
 * а золотой билет её проходит и гасится ровно один раз; шаблон уведомления с
 * персональным плейсхолдером не сохраняется; счета и начисления отдаются
 * маршрутом, а не 404; организатор не может под видом смены этапа переписать
 * чужую заявку.
 *
 * Запуск: node scripts/smoke-techdebt.mjs (нужны БД и core на 4300)
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
  const email = `td-${tag}-${suffix}@test.local`;
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
    await client.call('/v1/auth/login', { method: 'POST', body: { email, password } });
  }
  return { client, email, password, userId: row.id };
}

console.warn('\n=== ЖИВОЙ ПРОГОН: ЗАКРЫТЫЙ ТЕХДОЛГ ===\n');

const founder = await register('f');
const organizer = await register('org', 'organizer');
const admin = await register('adm', 'admin');
const reviewer = await register('rev', 'expert');
const otherExpert = await register('rev2', 'expert');

for (const person of [reviewer, otherExpert]) {
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
           'Сезон техдолга', now() - interval '1 day', now() + interval '60 days', 'review')
   RETURNING id, number`,
);

const [taxonomy] = await sql(`SELECT id FROM lab.project_taxonomy WHERE slug = 'fintech'`);

/** Проект в сезоне на заданном этапе, с владельцем и одним материалом. */
async function makeProject(title, status, ownerId) {
  const [project] = await sql(
    `INSERT INTO lab.projects (id, taxonomy_id, season_id, title, stage, status, investment_ask)
     VALUES (public.uuid_generate_v7(), $1, $2, $3, 'growth', $4, 5000000)
     RETURNING id`,
    [taxonomy.id, season.id, title, status],
  );
  await sql(
    `INSERT INTO lab.founders_projects (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [project.id, ownerId],
  );
  await sql(
    `INSERT INTO lab.project_materials (id, project_id, type, version, url, parse_status, uploaded_by)
     VALUES (public.uuid_generate_v7(), $1, 'product_link', 1, 'https://example.com/product',
             'not_required', $2)`,
    [project.id, ownerId],
  );
  await sql(
    `INSERT INTO lab.project_versions (id, project_id, season_id, version_no, snapshot_jsonb)
     VALUES (public.uuid_generate_v7(), $1, $2, 1, '{"title":"снимок"}'::jsonb)`,
    [project.id, season.id],
  );
  return project.id;
}

const assigned = await makeProject('Проект рецензента', 'expert_review', founder.userId);
const foreign = await makeProject('Чужой проект', 'expert_review', founder.userId);

await sql(
  `INSERT INTO experts.expert_assignments
     (id, project_id, expert_id, season_id, status, due_at, assigned_reason)
   VALUES (public.uuid_generate_v7(), $1, $2, $3, 'accepted', now() + interval '7 days',
           'manual')`,
  [assigned, reviewer.userId, season.id],
);

// ------------------------------------------- 1. материалы и версии рецензенту
console.warn('--- доступ рецензента к материалам ---');

{
  const { response, json } = await reviewer.client.call(`/v1/projects/${assigned}/materials`);
  check(
    'рецензент видит материалы назначенного проекта',
    response.status === 200 && (json?.items?.length ?? 0) === 1,
    `${response.status}, материалов ${json?.items?.length ?? 0}`,
  );
}
{
  const { response, json } = await reviewer.client.call(`/v1/projects/${assigned}/versions`);
  check(
    'рецензент видит историю подач',
    response.status === 200 && (json?.items?.length ?? 0) === 1,
    `${response.status}, версий ${json?.items?.length ?? 0}`,
  );
}
{
  const { response, json } = await reviewer.client.call(`/v1/projects/${foreign}/materials`);
  // 5.7.5: недоступный проект — 404, а не пустой список (маршрут не намекает
  // на существование проекта).
  check(
    'материалы ЧУЖОГО проекта рецензенту не видны',
    response.status === 404 && (json?.items?.length ?? 0) === 0,
    `${response.status}, материалов ${json?.items?.length ?? 0}`,
  );
}
{
  const { response, json } = await otherExpert.client.call(`/v1/projects/${assigned}/materials`);
  check(
    'эксперт без назначения материалов не видит',
    response.status === 404 && (json?.items?.length ?? 0) === 0,
    `${response.status}, материалов ${json?.items?.length ?? 0}`,
  );
}
{
  // Материал остаётся только для чтения: рецензент не соавтор заявки.
  const { response } = await reviewer.client.call(`/v1/projects/${assigned}/materials/link`, {
    method: 'POST',
    body: { url: 'https://evil.example.com/inject' },
  });
  check(
    'рецензент не может добавить материал в чужой проект',
    response.status === 403,
    `HTTP ${response.status}`,
  );
}

// ------------------------------------------------------ 2. этапы и расписание
console.warn('\n--- этапы сезона ---');

{
  const { response, json } = await admin.client.call(`/v1/seasons/${season.id}/funnel`, {
    method: 'POST',
    body: { quotas: { bootcamp: 1 }, schedule: {} },
  });
  check(
    'организатор задаёт квоту буткемпа',
    response.status === 201 || response.status === 200,
    `HTTP ${response.status} ${JSON.stringify(json?.quotas ?? {})}`,
  );
}
{
  const { response, json } = await admin.client.call(
    `/v1/seasons/${season.id}/projects/${assigned}/stage`,
    { method: 'POST', body: { status: 'graduated', reason: 'попытка перепрыгнуть этапы' } },
  );
  check(
    'перепрыгнуть этапы нельзя',
    response.status === 409 || response.status === 422,
    `HTTP ${response.status} ${json?.code ?? ''}`,
  );
}
{
  const { response, json } = await admin.client.call(
    `/v1/seasons/${season.id}/projects/${assigned}/stage`,
    { method: 'POST', body: { status: 'bootcamp', reason: 'прошёл экспертизу' } },
  );
  check(
    'проект переведён на буткемп',
    response.status === 201 || response.status === 200,
    `HTTP ${response.status} → ${json?.to ?? ''}`,
  );
  check('золотой билет при этом не гасился', json?.goldenTicketRedeemed === false);
}
{
  const { response, json } = await admin.client.call(
    `/v1/seasons/${season.id}/projects/${foreign}/stage`,
    { method: 'POST', body: { status: 'bootcamp', reason: 'второй в квоте на одно место' } },
  );
  check(
    'квота этапа держится',
    response.status === 409 || response.status === 429 || response.status === 422,
    `HTTP ${response.status} ${json?.code ?? ''}`,
  );
}

// ------------------------------------------------- 3. золотой билет и погашение
console.warn('\n--- золотой билет ---');

{
  const { response } = await admin.client.call(`/v1/seasons/${season.id}/golden-tickets`, {
    method: 'POST',
    body: { projectId: foreign, reason: 'решение организатора' },
  });
  check(
    'билет выдан',
    response.status === 201 || response.status === 200,
    `HTTP ${response.status}`,
  );
}
{
  const { response, json } = await admin.client.call(
    `/v1/seasons/${season.id}/projects/${foreign}/stage`,
    {
      method: 'POST',
      body: { status: 'bootcamp', reason: 'проход по билету', useGoldenTicket: true },
    },
  );
  check(
    'билет проводит мимо квоты',
    (response.status === 201 || response.status === 200) && json?.goldenTicketRedeemed === true,
    `HTTP ${response.status}, погашен=${json?.goldenTicketRedeemed}`,
  );
}
{
  const [ticket] = await sql(
    `SELECT used_at FROM seasons.golden_tickets WHERE project_id = $1 AND season_id = $2`,
    [foreign, season.id],
  );
  check('в БД проставлен used_at', ticket?.used_at !== null, String(ticket?.used_at ?? 'null'));
}
{
  // Повторное погашение закрыто триггером: билет одноразовый.
  let blocked = false;
  try {
    await sql(
      `UPDATE seasons.golden_tickets SET used_at = NULL WHERE project_id = $1 AND season_id = $2`,
      [foreign, season.id],
    );
  } catch (error) {
    blocked = error.code === '42501';
  }
  check('снять отметку погашения нельзя даже владельцу БД', blocked);
}

// ------------------------------------- 4. организатор не переписывает заявку
console.warn('\n--- граница прав организатора ---');

{
  const before = await sql('SELECT title FROM lab.projects WHERE id = $1', [assigned]);
  const { response } = await organizer.client.call(`/v1/projects/${assigned}`, {
    method: 'PATCH',
    body: { title: 'Переписано организатором' },
  });
  const after = await sql('SELECT title FROM lab.projects WHERE id = $1', [assigned]);
  check(
    'организатор не может переписать заявку',
    response.status >= 400 && after[0].title === before[0].title,
    `HTTP ${response.status}, title=${after[0].title}`,
  );
}

// --------------------------------------------- 5. шаблоны уведомлений в админке
console.warn('\n--- админский API шаблонов ---');

const templateCode = `test.techdebt_${suffix}`;
{
  const { response, json } = await admin.client.call('/v1/admin/notification-templates', {
    method: 'POST',
    body: {
      code: templateCode,
      channel: 'push',
      locale: 'ru-RU',
      titleTemplate: 'Проверка',
      bodyTemplate: 'Проект «{{project_title}}» перешёл на новый этап.',
      fallbackChain: ['email'],
      isCritical: false,
    },
  });
  check(
    'шаблон сохранён версией 1',
    (response.status === 201 || response.status === 200) && json?.version === 1,
    `HTTP ${response.status}, версия ${json?.version}`,
  );
}
{
  const { json } = await admin.client.call('/v1/admin/notification-templates', {
    method: 'POST',
    body: {
      code: templateCode,
      channel: 'push',
      locale: 'ru-RU',
      bodyTemplate: 'Новый текст про «{{project_title}}».',
      fallbackChain: [],
      isCritical: false,
    },
  });
  check(
    'правка создаёт версию 2, а не переписывает первую',
    json?.version === 2,
    `версия ${json?.version}`,
  );
  const active = await sql(
    `SELECT count(*)::int AS n FROM comms.notification_templates
      WHERE code = $1 AND channel = 'push' AND locale = 'ru-RU' AND is_active`,
    [templateCode],
  );
  check('активная версия ровно одна', active[0].n === 1, `активных ${active[0].n}`);
}
{
  const { response, json } = await admin.client.call('/v1/admin/notification-templates', {
    method: 'POST',
    body: {
      code: `${templateCode}_pdn`,
      channel: 'email',
      locale: 'ru-RU',
      bodyTemplate: 'Здравствуйте, {{full_name}}! Ваш телефон {{phone}} подтверждён.',
      fallbackChain: [],
      isCritical: false,
    },
  });
  check(
    'шаблон с персональным плейсхолдером отклонён',
    response.status === 400 || response.status === 422,
    `HTTP ${response.status} ${json?.code ?? ''}`,
  );
}
{
  const { response } = await organizer.client.call('/v1/admin/notification-templates');
  check('организатору шаблоны недоступны', response.status === 403, `HTTP ${response.status}`);
}

// ------------------------------------------------- 6. счета и начисления
console.warn('\n--- счета и начисления ---');

{
  const { response, json } = await founder.client.call('/v1/billing/invoices');
  check(
    'GET /billing/invoices отвечает контрактом, а не 404',
    response.status === 200 && Array.isArray(json?.items),
    `HTTP ${response.status}`,
  );
}
{
  const { response, json } = await founder.client.call('/v1/billing/accruals');
  check(
    'GET /billing/accruals отвечает контрактом',
    response.status === 200 && Array.isArray(json?.items),
    `HTTP ${response.status}`,
  );
}
{
  const { response } = await raw('/v1/billing/invoices');
  check('счета анонимно недоступны', response.status === 401, `HTTP ${response.status}`);
}

// ------------------------------------------------- 7. описание API с маршрутами
console.warn('\n--- описание API ---');

{
  // Описание отдаётся только по сессии — анониму 404, чтобы карта маршрутов не
  // доставалась одним запросом. Поэтому запрашиваем как вошедший пользователь;
  // отдельная проверка ниже убеждается, что анониму оно закрыто.
  const anon = await raw('/v1/openapi.json');
  check(
    'описание API закрыто анониму',
    anon.response.status === 404,
    `без сессии: ${anon.response.status}`,
  );

  const { response, json } = await founder.client.call('/v1/openapi.json');
  const paths = Object.keys(json?.paths ?? {});
  check(
    'в описании есть перечень маршрутов',
    response.status === 200 && paths.length > 50,
    `путей ${paths.length}, маршрутов ${json?.['x-routes-total'] ?? 0}`,
  );
  const withoutSecurity = [];
  for (const [path, operations] of Object.entries(json?.paths ?? {})) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!('security' in operation)) withoutSecurity.push(`${method} ${path}`);
    }
  }
  check(
    'у каждого маршрута объявлен способ доступа',
    withoutSecurity.length === 0,
    withoutSecurity.slice(0, 3).join(', '),
  );
  const stage = json?.paths?.['/v1/seasons/{id}/projects/{projectId}/stage']?.post;
  check(
    'новый маршрут этапа попал в описание с ролями',
    Array.isArray(stage?.['x-required-roles']) && stage['x-required-roles'].includes('organizer'),
    JSON.stringify(stage?.['x-required-roles'] ?? null),
  );
}

// ------------------------------------------- 8. проекция вознаграждения
console.warn('\n--- проекция вознаграждения ---');

{
  // С 5.9.3 начисление создаётся на КАЖДЫЙ подтверждённый транш, а проекция
  // остаётся по сделке: наружу отдаётся накопленный итог. Поэтому строк
  // проекции столько же, сколько договоров с начислениями, а суммы должны
  // сходиться с суммой начислений — вот это и проверяется.
  const [coverage] = await sql(
    `SELECT count(*)::int AS deals FROM (
       SELECT DISTINCT agreement_id FROM billing.commission_accruals) a`,
  );
  const [projection] = await sql(`SELECT count(*)::int AS n FROM integration.deal_commissions`);
  check(
    'проекция покрывает все сделки с начислениями',
    projection.n === coverage.deals,
    `проекция ${projection.n}, сделок ${coverage.deals}`,
  );

  const mismatched = await sql(
    `SELECT p.agreement_id
       FROM integration.deal_commissions p
       JOIN (SELECT agreement_id,
                    sum(base_amount) AS base,
                    sum(investor_fee_amount) AS inv,
                    sum(issuer_fee_amount) AS iss
               FROM billing.commission_accruals GROUP BY agreement_id) a
         ON a.agreement_id = p.agreement_id
      WHERE p.base_amount <> a.base
         OR p.investor_fee_amount <> a.inv
         OR p.issuer_fee_amount <> a.iss`,
  );
  check(
    'суммы проекции сходятся с начислениями по сделке',
    mismatched.length === 0,
    `расхождений ${mismatched.length}`,
  );
}
{
  // Записать в проекцию можно только триггером биллинга: политики INSERT нет.
  let denied = false;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL_APP_INTEGRATION });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO integration.deal_commissions
         (agreement_id, accrual_id, base_amount, investor_fee_amount, issuer_fee_amount, accrued_at)
       VALUES (public.uuid_generate_v7(), public.uuid_generate_v7(), 1, 0, 0, now())`,
    );
  } catch (error) {
    denied = error.code === '42501';
  } finally {
    await client.end().catch(() => {});
  }
  check('интеграционная роль не пишет в проекцию', denied);
}

await pool.end();

console.warn(`\n=== ИТОГ: ${passed} проверок пройдено, ${failed} провалено ===\n`);
process.exit(failed > 0 ? 1 : 0);
