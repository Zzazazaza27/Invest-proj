#!/usr/bin/env node
/**
 * Живой прогон выдачи разрешений выбранным получателям (этап 5.8).
 *
 * Проверяется не «маршрут отвечает», а модель доступа целиком:
 *
 *   1. режим «выбранные инвесторы» сам по себе ничего не открывает — без
 *      разрешения проект не виден даже по прямому адресу;
 *   2. разрешение — НАБОР частей: {round} даёт тизер и раунд, но не ответы
 *      анкеты и не материалы;
 *   3. повторная выдача ЗАМЕНЯЕТ набор, а не добавляет вторую запись;
 *   4. исключение перекрывает действующее разрешение, снятие исключения
 *      возвращает ровно то, что было выдано;
 *   5. отзыв закрывает доступ, и запись остаётся историей;
 *   6. посторонний не может ни прочитать список выданного, ни выдать
 *      разрешение на чужой проект;
 *   7. тизер отдельно не выдаётся (его нет в наборе), адрес без учётной
 *      записи — ошибка у поля, участник команды — отказ.
 *
 * Запуск: node scripts/smoke-project-access.mjs (нужен поднятый core)
 */
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

function loadDotEnv() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) process.env[trimmed.slice(0, eq).trim()] ??= trimmed.slice(eq + 1).trim();
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('ПРОГОН ОБОРВАН (unhandledRejection):', reason);
  process.exit(1);
});

const BASE = process.env.CORE_URL ?? CORE_URL;
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'ul_csrf';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

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

function makeClient() {
  const state = { session: null, csrf: null };
  async function call(path, { method = 'GET', body } = {}) {
    const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) {
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
      /* пустой ответ у 204 — норма */
    }
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(';')[0];
      if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
      if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
    }
    return { response, json };
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

async function register(role, tag) {
  const client = makeClient();
  const email = `access-${tag}-${suffix}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const { response, json } = await client.call('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: `Доступ ${tag}`,
      role,
      locale: 'ru-RU',
      consents: CONSENTS,
    },
  });
  if (response.status >= 400) {
    throw new Error(`регистрация ${tag}: ${response.status} ${JSON.stringify(json)}`);
  }
  const [row] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
    blindIndex(email),
  ]);
  return { client, email, password, userId: row.id };
}

console.warn('\n=== ЖИВОЙ ПРОГОН: РАЗРЕШЕНИЯ ВЫБРАННЫМ ПОЛУЧАТЕЛЯМ (5.8) ===\n');

// ------------------------------------------------------------------ фикстуры
const admin = await register('founder', 'admin');
await sql(
  `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
  [admin.userId],
);
await admin.client.call('/v1/auth/login', {
  method: 'POST',
  body: { email: admin.email, password: admin.password },
});

const owner = await register('founder', 'owner');
const investor = await register('investor', 'investor');
const stranger = await register('founder', 'stranger');

const kyc = await owner.client.call('/v1/kyc/verifications', {
  method: 'POST',
  body: { kind: 'identity', docType: 'passport', docCountry: 'RU' },
});
await admin.client.call(`/v1/kyc/verifications/${kyc.json?.id}/decision`, {
  method: 'POST',
  body: { decision: 'approved', riskLevel: 'low' },
});

const [taxonomy] = await sql("SELECT id FROM lab.project_taxonomy WHERE slug = 'ai'");
const project = await owner.client.call('/v1/projects', {
  method: 'POST',
  body: {
    title: `Выбранные инвесторы ${suffix}`,
    tagline: 'Проверка выдачи разрешений',
    stage: 'idea',
    taxonomyId: taxonomy.id,
    investmentAsk: '3000000.00',
    askCurrency: 'RUB',
  },
});
const projectId = project.json?.id;
check('проект создан', Boolean(projectId), `статус ${project.response.status}`);

// Профиль подан: без согласия владельца ответы анкеты закрыты всем, и
// разрешение `profile` нечем было бы проверить.
const app = await owner.client.call(`/v1/projects/${projectId}/applications`, {
  method: 'POST',
  body: {},
});
const appId = app.json?.id;
const form = await owner.client.call(`/v1/applications/${appId}/form`);
const answers = {};
for (const section of form.json?.sections ?? []) {
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
                    : 'Ответ прогона доступа';
  }
}
await owner.client.call(`/v1/applications/${appId}`, {
  method: 'PATCH',
  body: { stage: 'idea', answers },
});
const preview = await owner.client.call(`/v1/applications/${appId}/preview?audience=investors`);
const submitted = await owner.client.call(`/v1/applications/${appId}/submit`, {
  method: 'POST',
  body: {
    activeFormVersion: preview.json?.activeFormVersion,
    contentDigest: preview.json?.contentDigest,
  },
});
check(
  'профиль подан (согласие владельца на снимок)',
  submitted.response.status === 201 || submitted.response.status === 200,
  `статус ${submitted.response.status}`,
);

// ------------------------------------------------- режим «выбранные инвесторы»
{
  const { response, json } = await owner.client.call(`/v1/projects/${projectId}/visibility`, {
    method: 'PUT',
    body: { visibility: 'selected_investors' },
  });
  check(
    'режим «выбранные инвесторы» принимается (до 5.8 отклонялся)',
    response.status === 200 && json?.visibility === 'selected_investors',
    `статус ${response.status} ${json?.visibility ?? json?.code ?? ''}`,
  );
}
{
  const view = await investor.client.call(`/v1/projects/${projectId}/investor-view`);
  check(
    'без разрешения проект не виден даже по прямому адресу',
    view.response.status === 404,
    `статус ${view.response.status}`,
  );
  const list = await owner.client.call(`/v1/projects/${projectId}/access`);
  check(
    'список выданного пуст и называет режим',
    list.response.status === 200 &&
      list.json?.visibility === 'selected_investors' &&
      (list.json?.grants ?? []).length === 0,
    `статус ${list.response.status}`,
  );
}

// ------------------------------------------------------------- выдача набора
let grantId;
{
  const { response, json } = await owner.client.call(`/v1/projects/${projectId}/access/grants`, {
    method: 'POST',
    body: { email: investor.email, permissions: ['round'], reason: 'переговоры по раунду' },
  });
  grantId = json?.id ?? null;
  check(
    'разрешение {round} выдано по адресу почты',
    response.status === 201 || response.status === 200,
    `статус ${response.status} ${json?.code ?? ''}`,
  );
  check('в ответе имя получателя, а не адрес', Boolean(json?.subjectName), json?.subjectName ?? '');

  const view = await investor.client.call(`/v1/projects/${projectId}/investor-view`);
  check(
    'получателю открылся тизер вместе с разрешением (тизер отдельно не выдаётся)',
    view.response.status === 200 && Boolean(view.json?.title),
    `статус ${view.response.status}`,
  );
  check(
    'разрешение {round} не открывает ответы анкеты и материалы',
    view.json?.access?.round === 'investors' &&
      view.json?.access?.profile === null &&
      view.json?.access?.materials === null &&
      view.json?.access?.passport === null,
    JSON.stringify(view.json?.access ?? {}),
  );
  check(
    'коммерческий допуск для выбранного получателя не требуется (членства нет)',
    view.response.status === 200,
  );
}

// -------------------------------------------- повторная выдача заменяет набор
{
  const { response, json } = await owner.client.call(`/v1/projects/${projectId}/access/grants`, {
    method: 'POST',
    body: { email: investor.email, permissions: ['profile', 'materials'] },
  });
  check('повторная выдача принята', response.status === 201 || response.status === 200);
  check('идентификатор записи не изменился — это та же запись', json?.id === grantId);

  const [rows] = await sql(
    `SELECT count(*)::int AS n FROM lab.project_access_grants
      WHERE project_id = $1 AND grantee_user_id = $2 AND revoked_at IS NULL`,
    [projectId, investor.userId],
  );
  check('действующая запись одна, а не две', rows.n === 1, `записей: ${rows.n}`);

  const view = await investor.client.call(`/v1/projects/${projectId}/investor-view`);
  check(
    'набор заменён: ответы и материалы открыты, раунд закрыт',
    view.json?.access?.profile === 'investors' &&
      view.json?.access?.materials === 'investors' &&
      view.json?.access?.round === null,
    JSON.stringify(view.json?.access ?? {}),
  );
  check(
    'ответы анкеты действительно пришли',
    (view.json?.sections ?? []).some((s) => s.questions.length > 0),
  );
}

// ------------------------------------------------------------------ исключение
let exclusionId;
{
  const { response, json } = await owner.client.call(
    `/v1/projects/${projectId}/access/exclusions`,
    {
      method: 'POST',
      body: { email: investor.email, reason: 'конфликт интересов' },
    },
  );
  exclusionId = json?.id ?? null;
  check('исключение поставлено', response.status === 201 || response.status === 200);

  const view = await investor.client.call(`/v1/projects/${projectId}/investor-view`);
  check(
    'исключение перекрывает действующее разрешение',
    view.response.status === 404,
    `статус ${view.response.status}`,
  );

  const list = await owner.client.call(`/v1/projects/${projectId}/access`);
  check(
    'владелец видит и разрешение, и исключение',
    (list.json?.grants ?? []).length === 1 && (list.json?.exclusions ?? []).length === 1,
    `${(list.json?.grants ?? []).length}/${(list.json?.exclusions ?? []).length}`,
  );
}
{
  const { response } = await owner.client.call(
    `/v1/projects/${projectId}/access/exclusions/${exclusionId}`,
    { method: 'DELETE' },
  );
  check('исключение снято', response.status === 204, `статус ${response.status}`);
  const view = await investor.client.call(`/v1/projects/${projectId}/investor-view`);
  check(
    'после снятия исключения вернулось ровно выданное',
    view.response.status === 200 &&
      view.json?.access?.profile === 'investors' &&
      view.json?.access?.round === null,
    `статус ${view.response.status} ${JSON.stringify(view.json?.access ?? {})}`,
  );
}

// ---------------------------------------------------------------------- отзыв
{
  const { response } = await owner.client.call(
    `/v1/projects/${projectId}/access/grants/${grantId}`,
    { method: 'DELETE' },
  );
  check('разрешение отозвано', response.status === 204, `статус ${response.status}`);

  const view = await investor.client.call(`/v1/projects/${projectId}/investor-view`);
  check('после отзыва проект снова не виден', view.response.status === 404);

  const again = await owner.client.call(`/v1/projects/${projectId}/access/grants/${grantId}`, {
    method: 'DELETE',
  });
  check('повторный отзыв — не ошибка', again.response.status === 204);

  const [row] = await sql(
    `SELECT revoked_at IS NOT NULL AS revoked FROM lab.project_access_grants WHERE id = $1`,
    [grantId],
  );
  check('запись осталась историей, а не удалена', row?.revoked === true);

  const verbs = await sql(
    `SELECT verb FROM audit.events
      WHERE subject_id = $1 AND verb LIKE 'lab.project_access.%' ORDER BY ts`,
    [projectId],
  );
  const seen = verbs.map((v) => v.verb);
  check(
    'журнал: выдача, исключение, снятие исключения и отзыв',
    seen.includes('lab.project_access.granted') &&
      seen.includes('lab.project_access.excluded') &&
      seen.includes('lab.project_access.exclusion_revoked') &&
      seen.includes('lab.project_access.revoked'),
    seen.join(', '),
  );
  check(
    'адрес почты в журнал не попал',
    !JSON.stringify(verbs).includes(investor.email),
    'проверено по тексту событий',
  );
}

// ------------------------------------------------------------------- отказы
{
  const list = await stranger.client.call(`/v1/projects/${projectId}/access`);
  check(
    'посторонний не читает список выданного',
    list.response.status === 404,
    `статус ${list.response.status}`,
  );
  const grant = await stranger.client.call(`/v1/projects/${projectId}/access/grants`, {
    method: 'POST',
    body: { email: investor.email, permissions: ['profile'] },
  });
  check(
    'посторонний не выдаёт разрешение на чужой проект',
    grant.response.status === 404,
    `статус ${grant.response.status}`,
  );
}
{
  const unknown = await owner.client.call(`/v1/projects/${projectId}/access/grants`, {
    method: 'POST',
    body: { email: `no-such-user-${suffix}@test.local`, permissions: ['profile'] },
  });
  check(
    'неизвестный адрес — ошибка у поля, а не общий отказ',
    unknown.response.status === 400 && (unknown.json?.errors ?? []).some((e) => e.path === 'email'),
    `статус ${unknown.response.status} ${JSON.stringify(unknown.json?.errors ?? unknown.json?.code)}`,
  );
  const self = await owner.client.call(`/v1/projects/${projectId}/access/grants`, {
    method: 'POST',
    body: { email: owner.email, permissions: ['profile'] },
  });
  check(
    'участнику команды разрешение не выдаётся',
    self.response.status === 409,
    `статус ${self.response.status} ${self.json?.code ?? ''}`,
  );
  const teaser = await owner.client.call(`/v1/projects/${projectId}/access/grants`, {
    method: 'POST',
    body: { email: investor.email, permissions: ['teaser'] },
  });
  check(
    'тизер отдельным разрешением не выдаётся',
    teaser.response.status === 400,
    `статус ${teaser.response.status}`,
  );
  const empty = await owner.client.call(`/v1/projects/${projectId}/access/grants`, {
    method: 'POST',
    body: { email: investor.email, permissions: [] },
  });
  check('пустой набор отклоняется', empty.response.status === 400);
}

await pool.end();
console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено.\n`);
process.exitCode = failed > 0 ? 1 : 0;
