#!/usr/bin/env node
/**
 * Группа функций «Файлы» на стенде (блок 4, 4.11).
 *
 *   node scripts/probe-availability.mjs
 *
 * Ядро стенда должно проверять хранилище часто — запускать его с
 * AVAILABILITY_PROBE_INTERVAL_MS=2000 (проба сама этого не меняет).
 *
 * Запись отказывает по-настоящему: у ключа приложения в Garage на время пробы снимается право
 * записи, чтение остаётся. Сценарии:
 *   1. связанный: запись недоступна, чтение работает — карточка проекта и список материалов
 *      открываются, готовый материал читается, состояние ранее начатой загрузки выясняется,
 *      новая загрузка отклонена `group_unavailable` с той же причиной, что в /v1/features;
 *      готовность ядра не снята;
 *   2. ручное «только чтение»: зависимость исправна, но запись закрыта; эксплуатация видит оба
 *      факта; наружу — безопасный код, не заметка; снятие открывает запись.
 * Право записи возвращается при любом исходе; свои проекты проба убирает.
 */
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';

import { garageSetKeyPermissions } from './lib/garage-admin.mjs';
import { CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of existsSync(join(ROOT, '.env'))
  ? readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
  : []) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq > 0) process.env[trimmed.slice(0, eq).trim()] ??= trimmed.slice(eq + 1).trim();
}
const BASE = process.env.CORE_URL ?? CORE_URL;
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'ul_csrf';
const BUCKET = process.env.S3_BUCKET;
const KEY_ID = process.env.S3_ACCESS_KEY_ID;
const INTERNAL = `http://127.0.0.1:${process.env.CORE_INTERNAL_PORT ?? 4400}`;

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else failed += 1;
  console.warn(`  ${condition ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function makeClient() {
  const state = { session: null, csrf: null };
  return {
    async call(path, { method = 'GET', body } = {}) {
      const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (method !== 'GET' && state.csrf) {
        headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
      }
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      for (const cookie of r.headers.getSetCookie?.() ?? []) {
        const pair = cookie.split(';')[0];
        if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
        if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
      }
      const raw = Buffer.from(await r.arrayBuffer());
      let json = null;
      try {
        json = JSON.parse(raw.toString('utf8'));
      } catch {
        // не JSON — содержимое файла
      }
      return { status: r.status, json, raw };
    },
  };
}
const blindIndex = (email) =>
  createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));
async function register(label, admin = false) {
  const email = `av-${label}-${Date.now() % 1e9}@test.local`;
  const password = `Pw-${randomUUID()}`;
  let client = makeClient();
  await client.call('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: `AV ${label}`,
      role: 'founder',
      locale: 'ru-RU',
      consents: CONSENTS,
    },
  });
  const [u] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [blindIndex(email)]);
  if (admin) {
    await sql(
      "INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING",
      [u.id],
    );
    client = makeClient();
    await client.call('/v1/auth/login', { method: 'POST', body: { email, password } });
  }
  return { client, userId: u.id };
}
const files = async (client) => (await client.call('/v1/features')).json?.groups?.files;
async function waitFor(client, predicate, label) {
  for (let i = 0; i < 120; i += 1) {
    const s = await files(client);
    if (s && predicate(s)) return s;
    await sleep(1000);
  }
  console.warn(`  (не дождались: ${label})`);
  return files(client);
}
async function uploadPdf(client, projectId, label) {
  const bytes = Buffer.from(`%PDF-1.4 AV ${label} ${randomUUID()}`, 'utf8');
  const t = await client.call(`/v1/projects/${projectId}/materials/upload`, {
    method: 'POST',
    body: {
      type: 'deck',
      fileName: `deck-${label}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: bytes.length,
    },
  });
  return { ticket: t, bytes };
}

console.warn('\n=== ГРУППА «ФАЙЛЫ» (4.11) ===\n');
// Обстановка: экземпляры прежних запусков, снятые без штатной остановки (taskkill), не
// отмечены остановленными и по правилу сведения дают «неизвестно» вместо отказа. Отмечаем
// только те, чья остановка ДОКАЗАНА: экземпляр этой машины (`<машина>-<pid>-<метка>`), процесса
// которого больше нет. Давнее молчание само по себе остановкой не считается.
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const known = await sql(
  'SELECT DISTINCT instance FROM availability.observations WHERE NOT stopped',
);
const gone = known
  .map((r) => r.instance)
  .filter((instance) => {
    const m = instance.match(/^(.*)-(\d+)-[0-9a-f]{8}$/);
    return m && m[1] === hostname() && !pidAlive(Number(m[2]));
  });
if (gone.length > 0) {
  await sql('UPDATE availability.observations SET stopped = true WHERE instance = ANY($1)', [gone]);
}
console.warn(`  (отмечено остановленными — процесса нет: ${gone.length})`);
const owner = await register('owner');
const admin = await register('admin', true);
const taxonomy = await (await fetch(`${BASE}/v1/taxonomy`)).json();
const created = await owner.client.call('/v1/projects', {
  method: 'POST',
  body: {
    title: `AV ${Date.now() % 1e9}`,
    stage: 'mvp',
    taxonomyId: (taxonomy.items ?? taxonomy)[0].id,
    investmentAsk: '1000000.00',
    askCurrency: 'RUB',
  },
});
const projectId = created.json?.id;
let denied = false;
try {
  check(
    'исходно «Файлы» доступны',
    (await waitFor(owner.client, (s) => s.state === 'available', 'доступно')).state === 'available',
  );

  // Готовый материал — до отказа, чтобы проверить чтение при недоступной записи.
  const ready = await uploadPdf(owner.client, projectId, 'ready');
  const form = new FormData();
  for (const [k, v] of Object.entries(ready.ticket.json.formFields)) form.append(k, v);
  form.append('file', new Blob([ready.bytes], { type: 'application/pdf' }), 'deck.pdf');
  await fetch(ready.ticket.json.uploadUrl, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const fin = await owner.client.call(
    `/v1/projects/${projectId}/materials/${ready.ticket.json.materialId}/finalize`,
    { method: 'POST' },
  );
  check(
    'готовый материал загружен до отказа',
    fin.json?.uploadState === 'ready',
    `HTTP ${fin.status} ${fin.json?.uploadState}`,
  );
  // Начатая загрузка: билет выдан, файл ещё не пришёл.
  const started = await uploadPdf(owner.client, projectId, 'started');
  const startedId = started.ticket.json?.materialId;
  check('начатая загрузка: билет выдан', Boolean(startedId));

  console.warn('[1] Запись недоступна, чтение работает');
  await garageSetKeyPermissions(BUCKET, KEY_ID, { write: true }, false);
  denied = true;
  const s1 = await waitFor(owner.client, (s) => !s.write.allowed, 'запись недоступна');
  check(
    '/v1/features: только чтение, причина — отказ зависимости',
    s1.state === 'read_only' && s1.read.allowed && s1.write.reason === 'dependency_failure',
    JSON.stringify(s1),
  );
  const card = await owner.client.call(`/v1/projects/${projectId}`);
  check('карточка проекта открывается', card.status === 200);
  const list = await owner.client.call(`/v1/projects/${projectId}/materials`);
  check(
    'список материалов открывается',
    list.status === 200 && Array.isArray(list.json?.items ?? list.json),
  );
  const content = await owner.client.call(
    `/v1/projects/${projectId}/materials/${ready.ticket.json.materialId}/content`,
  );
  check(
    'готовый материал читается',
    content.status === 200 && content.raw.toString('utf8') === ready.bytes.toString('utf8'),
    `HTTP ${content.status}`,
  );
  const op = await owner.client.call(`/v1/me/operations/material_upload/${startedId}`);
  check(
    'состояние ранее начатой загрузки выясняется',
    op.status === 200 && op.json?.state === 'pending',
    `HTTP ${op.status} ${op.json?.state}`,
  );
  const fresh = await uploadPdf(owner.client, projectId, 'new');
  const err = fresh.ticket.json;
  check(
    'новая загрузка отклонена group_unavailable',
    fresh.ticket.status === 503 && err?.code === 'group_unavailable',
    `HTTP ${fresh.ticket.status} ${err?.code}`,
  );
  check(
    'причина в ответе ядра совпадает с /v1/features',
    err?.errors?.[0]?.path === 'files.write' && err?.errors?.[0]?.message === s1.write.reason,
    JSON.stringify(err?.errors),
  );
  const ready1 = await (await fetch(`${INTERNAL}/ready`)).json().catch(() => null);
  check(
    'готовность ядра не снята, группа видна в /ready',
    ready1?.ready === true && ready1?.groups?.files === 'read_only',
    JSON.stringify(ready1?.groups),
  );

  await garageSetKeyPermissions(BUCKET, KEY_ID, { write: true }, true);
  denied = false;
  const back = await waitFor(owner.client, (s) => s.write.allowed, 'запись вернулась');
  check('после восстановления запись снова разрешена', back.state === 'available');

  console.warn('[2] Ручное «только чтение»');
  const note = `плановые работы ${randomUUID().slice(0, 6)}`;
  const set = await admin.client.call('/v1/admin/availability/files', {
    method: 'PUT',
    body: { mode: 'read_only', reasonCode: 'maintenance', note },
  });
  check('ограничение введено', set.status === 200, `HTTP ${set.status}`);
  const s2 = await waitFor(owner.client, (s) => !s.write.allowed, 'ограничение видно');
  check(
    'запись закрыта вручную, причина — безопасный код',
    s2.write.reason === 'manual_restriction' && s2.read.allowed,
  );
  const pub = JSON.stringify(await (await fetch(`${BASE}/v1/features`)).json());
  check('заметка сотрудника наружу не отдаётся', !pub.includes(note));
  await sleep(4500);
  const ops = (await admin.client.call('/v1/admin/availability')).json?.items?.[0];
  check(
    'эксплуатация видит оба факта: хранилище исправно и ограничение действует',
    ops?.dependency?.write === 'ok' &&
      ops?.restriction?.mode === 'read_only' &&
      ops?.status?.write?.allowed === false,
    JSON.stringify({ dep: ops?.dependency, r: ops?.restriction?.mode }),
  );
  const blocked = await uploadPdf(owner.client, projectId, 'manual');
  check(
    'новая загрузка при ручном ограничении отклонена',
    blocked.ticket.status === 503 &&
      blocked.ticket.json?.errors?.[0]?.message === 'manual_restriction',
  );
  const notAdmin = await owner.client.call('/v1/admin/availability/files/clear', {
    method: 'POST',
    body: { note: 'попытка' },
  });
  check('снять ограничение без права нельзя', notAdmin.status === 403, `HTTP ${notAdmin.status}`);
  const cleared = await admin.client.call('/v1/admin/availability/files/clear', {
    method: 'POST',
    body: { note: 'работы завершены' },
  });
  check('ограничение снято отдельным действием', cleared.status === 200);
  const s3 = await waitFor(owner.client, (s) => s.write.allowed, 'запись открыта');
  check('запись снова разрешена', s3.state === 'available');
  const [{ n }] = await sql(
    "SELECT count(*)::int AS n FROM audit.events WHERE verb LIKE 'ops.function_restriction.%' AND actor_id = $1",
    [admin.userId],
  );
  check('введение и снятие — в журнале действий', n === 2, `записей ${n}`);
} finally {
  if (denied)
    await garageSetKeyPermissions(BUCKET, KEY_ID, { write: true }, true).catch(() => undefined);
  await sql("DELETE FROM availability.restrictions WHERE group_id = 'files'").catch(
    () => undefined,
  );
  if (projectId) {
    await sql(
      'DELETE FROM lab.material_upload_attempts WHERE material_id IN (SELECT id FROM lab.project_materials WHERE project_id = $1)',
      [projectId],
    );
    await sql(
      'DELETE FROM comms.operation_notices WHERE operation_id IN (SELECT id FROM lab.project_materials WHERE project_id = $1)',
      [projectId],
    );
    await sql('DELETE FROM lab.project_materials WHERE project_id = $1', [projectId]);
    await sql('DELETE FROM lab.founders_projects WHERE project_id = $1', [projectId]);
    await sql('DELETE FROM lab.projects WHERE id = $1', [projectId]);
  }
  await sql('DELETE FROM identity.user_roles WHERE user_id = $1', [admin.userId]);
  await pool.end();
}
console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exit(failed > 0 ? 1 : 0);
