#!/usr/bin/env node
/**
 * Минимальный набор сценариев локального стенда.
 *
 * Заменяет прежний демонстрационный комплект (`seed-demo`) там, где нужна не
 * витрина «как будто платформа живёт год», а несколько понятных состояний, по
 * которым видно поведение продукта:
 *
 *   1. проект без раунда (профиль подан, привлечения нет);
 *   2. проект с черновиком раунда (готовится, ещё не открыт);
 *   3. проект с открытым раундом (сумма и условия зафиксированы);
 *   4. публичный проект (виден анониму тизером);
 *   5. закрытый проект (не виден никому, кроме команды);
 *   6. проект «для выбранных инвесторов»: адресное разрешение инвестору и
 *      материал, закрытый отметкой владельца.
 *
 * Данные создаются ЧЕРЕЗ API, а не вставками в таблицы: сценарий обязан
 * проходить те же проверки, что и живой пользователь (KYC владельца, согласие
 * на снимок, подтверждение отпечатка при открытии раунда). Единственные прямые
 * записи — включение флага мастера заявки и отметка материала: это настройка
 * окружения, а не действие пользователя.
 *
 * Требуется поднятое ядро и учётные записи стенда (`node scripts/dev-stand.mjs`).
 * Пароль — из `DEV_TEST_USER_PASSWORD`; в коде и в выводе его нет.
 *
 * Запуск: node scripts/seed-local-scenarios.mjs
 */
import pg from 'pg';
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

if (process.env.NODE_ENV === 'production') {
  console.error('Сценарии стенда в production не создаются.');
  process.exit(1);
}
const PASSWORD = process.env.DEV_TEST_USER_PASSWORD ?? '';
if (!PASSWORD) {
  console.error('Не задан DEV_TEST_USER_PASSWORD — учётные записи стенда не заведены.');
  process.exit(1);
}

const BASE = process.env.CORE_URL ?? CORE_URL;
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'ul_csrf';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

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
      /* пустой ответ — норма для 204 */
    }
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(';')[0];
      if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
      if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
    }
    if (response.status >= 400) {
      throw new Error(`${method} ${path} → ${response.status} ${JSON.stringify(json)}`);
    }
    return json;
  }
  return { call };
}

async function login(shortName) {
  const client = makeClient();
  await client.call('/v1/auth/login', {
    method: 'POST',
    body: { email: `${shortName}@unicorn.local`, password: PASSWORD },
  });
  return client;
}

console.warn('\n=== СЦЕНАРИИ ЛОКАЛЬНОГО СТЕНДА ===\n');

// Мастер заявки v2 — основной путь продукта с этапа 5.6: раунд, предпросмотры
// и согласие живут в нём. На чистой базе флаг выключен по умолчанию, поэтому
// включается здесь как настройка окружения.
await sql(
  `UPDATE audit.feature_flags SET enabled = true WHERE key = 'lab.ui.application_v2'
     AND enabled = false`,
);

const founder = await login('stand-founder');
const admin = await login('stand-admin');
const investor = await login('stand-investor');

// Верификация владельца: без неё открытые режимы видимости закрыты.
const kyc = await founder.call('/v1/kyc/verifications', {
  method: 'POST',
  body: { kind: 'identity', docType: 'passport', docCountry: 'RU' },
});
if (kyc.status !== 'approved') {
  await admin.call(`/v1/kyc/verifications/${kyc.id}/decision`, {
    method: 'POST',
    body: { decision: 'approved', riskLevel: 'low' },
  });
}
console.warn('  владелец проверен (KYC одобрен администратором)');

const [{ id: taxonomyId }] = await sql(
  `SELECT id FROM lab.project_taxonomy WHERE slug = 'fintech' LIMIT 1`,
);

/**
 * Создаёт проект и подаёт профиль: подача — это и есть согласие на снимок.
 * Повторный запуск не плодит проекты: сценарий с таким названием пропускается.
 * Удалить проект начисто нельзя (версии заявки и журнал append-only), поэтому
 * идемпотентность обеспечивается здесь, а не уборкой после.
 */
async function createProjectWithProfile(title, tagline, ask) {
  const existing = await sql(`SELECT id FROM lab.projects WHERE title = $1 LIMIT 1`, [title]);
  if (existing.length > 0) {
    console.warn(`  · «${title}» уже есть — пропускаю`);
    return null;
  }
  const project = await founder.call('/v1/projects', {
    method: 'POST',
    body: {
      title,
      tagline,
      stage: 'mvp',
      taxonomyId,
      investmentAsk: ask,
      askCurrency: 'RUB',
      geoCountry: 'RU',
    },
  });
  const application = await founder.call(`/v1/projects/${project.id}/applications`, {
    method: 'POST',
    body: {},
  });
  const form = await founder.call(`/v1/applications/${application.id}/form`);
  const answers = {};
  for (const section of form.sections) {
    for (const question of section.questions) {
      if (question.state !== 'mandatory' || question.coreField) continue;
      answers[question.key] = answerFor(question);
    }
  }
  await founder.call(`/v1/applications/${application.id}`, {
    method: 'PATCH',
    body: { stage: 'mvp', answers },
  });
  const preview = await founder.call(
    `/v1/applications/${application.id}/preview?audience=investors`,
  );
  const version = await founder.call(`/v1/applications/${application.id}/submit`, {
    method: 'POST',
    body: { activeFormVersion: preview.activeFormVersion, contentDigest: preview.contentDigest },
  });
  return { project, application, version };
}

function answerFor(question) {
  switch (question.type) {
    case 'number':
      return 3;
    case 'money':
      return '1500000.00';
    case 'select':
      return question.options?.[0]?.code;
    case 'multiselect':
      return [question.options?.[0]?.code];
    case 'boolean':
      return true;
    case 'url':
      return 'https://example.com/product';
    case 'date':
      return '2026-01-01';
    case 'material_ref':
      return [];
    default:
      return 'Ответ стенда: заполнено для демонстрации сценария.';
  }
}

/** Черновик раунда с заполненными параметрами; открытие — отдельным шагом. */
async function prepareRound(projectId, versionId, target) {
  const created = await founder.call(`/v1/projects/${projectId}/rounds`, {
    method: 'POST',
    body: { applicationVersionId: versionId },
  });
  const roundId = created.round.id;
  // Вопросы разделов раунда берём из формы заявки-основания: у раунда свои
  // разделы (scope=round), и обязательные из них нужно заполнить до открытия.
  const application = await founder.call(`/v1/projects/${projectId}/applications`);
  const current = application.items?.[0];
  const form = current
    ? await founder.call(`/v1/applications/${current.id}/form`)
    : { sections: [] };
  const answers = {};
  for (const section of form.sections ?? []) {
    if (section.scope !== 'round') continue;
    for (const question of section.questions) {
      if (question.state !== 'mandatory' || question.coreField) continue;
      answers[question.key] = answerFor(question);
    }
  }
  await founder.call(`/v1/rounds/${roundId}`, {
    method: 'PATCH',
    body: {
      target,
      currency: 'RUB',
      fundingScope: 'project',
      investorMode: 'multiple',
      answers,
    },
  });
  return roundId;
}

// Страна обслуживания выбирается один раз на аккаунт — до открытия раунда.
await founder
  .call('/v1/me/service-country', { method: 'PUT', body: { code: 'ru' } })
  .catch((error) =>
    console.warn(`  страна обслуживания уже выбрана: ${error.message.slice(0, 60)}`),
  );

// ---------------------------------------------------------------- сценарии
const made = [];

{
  const made1 = await createProjectWithProfile(
    'Стенд · профиль без привлечения',
    'Проект живёт без раунда: карточка есть, привлечения нет',
    '2000000.00',
  );
  if (made1) {
    await founder.call(`/v1/projects/${made1.project.id}/visibility`, {
      method: 'PUT',
      body: { visibility: 'registered_investors' },
    });
    made.push(`профиль без раунда — ${made1.project.title}`);
  }
}

{
  const made2 = await createProjectWithProfile(
    'Стенд · черновик раунда',
    'Раунд готовится: параметры заполнены, открытия не было',
    '3000000.00',
  );
  if (made2) {
    await prepareRound(made2.project.id, made2.version.id, '3000000.00');
    await founder.call(`/v1/projects/${made2.project.id}/visibility`, {
      method: 'PUT',
      body: { visibility: 'registered_investors' },
    });
    made.push(`черновик раунда — ${made2.project.title}`);
  }
}

{
  const made3 = await createProjectWithProfile(
    'Стенд · открытый раунд',
    'Привлечение идёт: сумма и условия зафиксированы при открытии',
    '5000000.00',
  );
  if (made3) {
    const roundId = await prepareRound(made3.project.id, made3.version.id, '5000000.00');
    const preview = await founder.call(`/v1/rounds/${roundId}/open-preview`);
    await founder.call(`/v1/rounds/${roundId}/open`, {
      method: 'POST',
      body: {
        confirmDisclosureVersion: preview.activeFormVersion,
        contentDigest: preview.contentDigest,
      },
    });
    await founder.call(`/v1/projects/${made3.project.id}/visibility`, {
      method: 'PUT',
      body: { visibility: 'public' },
    });
    made.push(`открытый раунд, публичный режим — ${made3.project.title}`);
  }
}

{
  const made4 = await createProjectWithProfile(
    'Стенд · закрытый проект',
    'Виден только команде: режим «только команда»',
    '1000000.00',
  );
  if (made4) made.push(`закрытый проект — ${made4.project.title}`);
}

{
  const made5 = await createProjectWithProfile(
    'Стенд · выбранные инвесторы',
    'Доступ выдан адресно; один материал закрыт отметкой владельца',
    '4000000.00',
  );
  if (made5) {
    // Материал остаётся закрытым: отметка «показывать инвесторам» — отдельное
    // решение владельца, и в этом сценарии оно НЕ принято.
    await founder.call(`/v1/projects/${made5.project.id}/materials/link`, {
      method: 'POST',
      body: { projectId: made5.project.id, url: 'https://example.com/demo' },
    });
    await founder.call(`/v1/projects/${made5.project.id}/visibility`, {
      method: 'PUT',
      body: { visibility: 'selected_investors' },
    });
    await founder.call(`/v1/projects/${made5.project.id}/access/grants`, {
      method: 'POST',
      body: {
        email: 'stand-investor@unicorn.local',
        permissions: ['profile', 'round'],
        reason: 'сценарий стенда: адресный доступ',
      },
    });
    made.push(`выбранные инвесторы + закрытый материал — ${made5.project.title}`);
  }
}

// Инвестор без членства — второй вариант доступа: роль есть, подписки нет.
{
  const email = 'stand-investor-free@unicorn.local';
  {
    const client = makeClient();
    await client
      .call('/v1/auth/register', {
        method: 'POST',
        body: {
          email,
          password: PASSWORD,
          displayName: 'Инвестор без членства',
          role: 'investor',
          locale: 'ru-RU',
          consents: ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
            kind,
            version: 'v1',
            locale: 'ru-RU',
          })),
        },
      })
      .catch(() => console.warn('  инвестор без членства уже существует — пропускаю'));
  }
}

const investorProjects = await investor.call('/v1/catalog');
console.warn('\nСоздано:');
for (const line of made) console.warn(`  · ${line}`);
console.warn(`\nВ каталоге инвестору видно проектов: ${investorProjects.items.length}`);
console.warn('Учётные записи: stand-founder, stand-investor, stand-investor-free, stand-admin.');
console.warn('Пароль — DEV_TEST_USER_PASSWORD из .env (в выводе не печатается).\n');

await pool.end();
