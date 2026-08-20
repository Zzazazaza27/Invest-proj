#!/usr/bin/env node
/**
 * Проверка квот и подтверждения загрузки материалов.
 *
 * Находка внешнего аудита (SEC-14/CODE-10): запись материала создавалась вместе
 * с выдачей билета — до того, как файл появился в хранилище. Отменённая
 * загрузка навсегда оставляла строку, выглядящую как материал, а квоты не было
 * никакой: авторизованный пользователь мог выпускать билеты бесконечно.
 *
 * Проверяется фактом: предел незавершённых загрузок срабатывает, невыгруженный
 * материал НЕ показывается в списке, а подтверждение без объекта в хранилище
 * отвергается.
 *
 * Запуск: node scripts/probe-upload-quota.mjs
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

const BASE = process.env.CORE_URL ?? CORE_URL;
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

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

function blindIndex(email) {
  return createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
}

function makeClient() {
  const state = { session: null, csrf: null };
  return {
    async call(path, { method = 'GET', body } = {}) {
      const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (method !== 'GET' && state.csrf) {
        headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
      }
      const response = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      for (const cookie of response.headers.getSetCookie?.() ?? []) {
        const pair = cookie.split(';')[0];
        if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
        if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
      }
      let json = null;
      try {
        json = JSON.parse(await response.text());
      } catch {
        /* не JSON */
      }
      return { status: response.status, json };
    },
  };
}

const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

console.warn('\n=== ПРОВЕРКА КВОТ И ПОДТВЕРЖДЕНИЯ ЗАГРУЗКИ ===\n');

const suffix = `${Date.now() % 1e9}`;
const email = `upload-${suffix}@test.local`;
const password = `Pw-${randomUUID()}`;
const client = makeClient();

await client.call('/v1/auth/register', {
  method: 'POST',
  body: {
    email,
    password,
    displayName: 'Квота загрузок',
    role: 'founder',
    locale: 'ru-RU',
    consents: CONSENTS,
  },
});
const [user] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
  blindIndex(email),
]);

const taxonomy = await fetch(`${BASE}/v1/taxonomy`, { signal: AbortSignal.timeout(10_000) })
  .then((r) => r.json())
  .then((b) => b.items?.[0]?.id ?? null);

const created = await client.call('/v1/projects', {
  method: 'POST',
  body: {
    title: `Проект квот ${suffix}`,
    stage: 'mvp',
    taxonomyId: taxonomy,
    investmentAsk: '1000000.00',
    askCurrency: 'RUB',
  },
});
const projectId = created.json?.id;
check('проект создан', created.status === 201 && Boolean(projectId), `HTTP ${created.status}`);

/** Билет на загрузку: строка материала создаётся, файл — нет. */
async function requestTicket(index) {
  return client.call(`/v1/projects/${projectId}/materials/upload`, {
    method: 'POST',
    body: {
      type: 'deck',
      fileName: `deck-${index}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: 1024,
    },
  });
}

let firstMaterialId = null;
let limitHit = 0;
for (let i = 0; i < 8; i += 1) {
  const result = await requestTicket(i);
  if (i === 0) firstMaterialId = result.json?.materialId ?? null;
  if (result.status === 422 || result.status === 429) limitHit += 1;
}
check('предел незавершённых загрузок сработал', limitHit > 0, `отказов: ${limitHit} из 8 попыток`);

// Квота считается запросом, а вставка идёт после него: одновременные запросы
// могут пройти проверку все сразу. Предел, обходимый параллелизмом, — это не
// предел, а пожелание (SEC-14 вводился ровно против бесконтрольного роста).
{
  // Точный опыт на ГРАНИЦЕ квоты: проект доводится до предела минус один, а
  // затем идут одновременные запросы РАЗНЫХ типов.
  //
  // Оба условия обязательны. На исчерпанном пределе окно не открывается вовсе —
  // все запросы отвергаются проверкой. На одинаковом типе запросы упираются в
  // уникальность версии материала и отвергаются конфликтом РАНЬШЕ квоты. В обоих
  // случаях проверка была бы зелёной, ничего не проверив: так и вышло с первыми
  // двумя её версиями.
  const second = await client.call('/v1/projects', {
    method: 'POST',
    body: {
      title: `Проект гонки квот ${suffix}`,
      stage: 'mvp',
      taxonomyId: taxonomy,
      investmentAsk: '1000000.00',
      askCurrency: 'RUB',
    },
  });
  const raceProjectId = second.json?.id;
  const [ownerRow] = await sql(
    'SELECT user_id FROM lab.founders_projects WHERE project_id = $1 LIMIT 1',
    [raceProjectId],
  );
  // Четыре незавершённых при пределе пять. Путь их появления неважен —
  // проверяется поведение сервиса на границе.
  for (let i = 0; i < 4; i += 1) {
    await sql(
      `INSERT INTO lab.project_materials
         (id, project_id, type, version, s3_key, parse_status, uploaded_by)
       VALUES (public.uuid_generate_v7(), $1, 'doc', $2::int, 'key-' || $2::text, 'queued', $3)`,
      [raceProjectId, 100 + i, ownerRow.user_id],
    );
  }

  const parallel = await Promise.all(
    ['deck', 'video', 'doc'].map((type, i) =>
      client.call(`/v1/projects/${raceProjectId}/materials/upload`, {
        method: 'POST',
        body: {
          type,
          fileName: `race-${i}.pdf`,
          contentType: 'application/pdf',
          sizeBytes: 1024,
        },
      }),
    ),
  );
  const [{ after }] = await sql(
    `SELECT count(*)::int AS after FROM lab.project_materials
      WHERE project_id = $1 AND uploaded_at IS NULL`,
    [raceProjectId],
  );
  check(
    'параллельные запросы не обходят предел незавершённых загрузок',
    after <= 5,
    `незавершённых стало ${after} при пределе 5 (ответы: ${parallel.map((r) => r.status).join(',')})`,
  );

  await sql('DELETE FROM lab.project_materials WHERE project_id = $1', [raceProjectId]);
  await sql('DELETE FROM lab.founders_projects WHERE project_id = $1', [raceProjectId]);
  await sql('DELETE FROM lab.projects WHERE id = $1', [raceProjectId]);
}

// Невыгруженный материал не должен показываться как материал проекта.
{
  const list = await client.call(`/v1/projects/${projectId}/materials`);
  check(
    'невыгруженные материалы в списке не показываются',
    (list.json?.items?.length ?? -1) === 0,
    `материалов: ${list.json?.items?.length}`,
  );
  const [row] = await sql(
    `SELECT count(*)::int AS n FROM lab.project_materials
      WHERE project_id = $1 AND uploaded_at IS NULL`,
    [projectId],
  );
  check('в БД они при этом есть — как незавершённые', row.n > 0, `строк: ${row.n}`);
}

// Подтверждение без объекта в хранилище обязано отказать: «я загрузил» от
// клиента доказательством не является.
if (firstMaterialId) {
  const finalize = await client.call(
    `/v1/projects/${projectId}/materials/${firstMaterialId}/finalize`,
    { method: 'POST' },
  );
  check(
    'подтверждение без объекта в хранилище отвергнуто',
    finalize.status >= 400,
    `HTTP ${finalize.status} ${finalize.json?.code ?? ''}`,
  );
}

// Гонка версии ссылки на продукт (CODE-15). Версия считалась как MAX+1 без
// сериализации: два одновременных добавления получали одно и то же число, и
// второе упиралось в UNIQUE (project_id, type, version) — законное действие
// отвергалось как дубликат.
//
// Опыт ставится ровно на это: три одновременных запроса с РАЗНЫМИ адресами.
// Правильный исход — все три приняты и версии различны.
{
  const links = await Promise.all(
    ['alpha', 'beta', 'gamma'].map((tag) =>
      client.call(`/v1/projects/${projectId}/materials/link`, {
        method: 'POST',
        body: { projectId, url: `https://example.com/${tag}-${Date.now()}` },
      }),
    ),
  );
  const codes = links.map((r) => r.status).join(',');
  const accepted = links.filter((r) => r.status === 200 || r.status === 201).length;

  const versions = await sql(
    `SELECT version FROM lab.project_materials
      WHERE project_id = $1 AND type = 'product_link' ORDER BY version`,
    [projectId],
  );
  const numbers = versions.map((v) => Number(v.version));
  check('одновременные ссылки на продукт приняты все', accepted === 3, `ответы: ${codes}`);
  check(
    'версии различны и идут подряд',
    new Set(numbers).size === numbers.length && numbers.length === 3,
    `версии: ${numbers.join(',')}`,
  );
}

// Уборка: прогон не оставляет за собой ни проект, ни материалы.
await sql('DELETE FROM lab.project_materials WHERE project_id = $1', [projectId]);
await sql('DELETE FROM lab.founders_projects WHERE project_id = $1', [projectId]);
await sql('DELETE FROM lab.projects WHERE id = $1', [projectId]);
await sql('DELETE FROM identity.user_roles WHERE user_id = $1', [user.id]);
await pool.end();

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exitCode = failed > 0 ? 1 : 0;
