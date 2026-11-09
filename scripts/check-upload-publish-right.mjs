#!/usr/bin/env node
/**
 * Право автора перед публикацией загрузки (блок 10, вопрос 3; Тэнк 09.11; M174).
 *
 *   node scripts/check-upload-publish-right.mjs     (стенд http://127.0.0.1/, база fifth-postgres)
 *
 * Основатель публикует один материал и бросает второй (файл в хранилище, подтверждения из
 * браузера нет). Администратор приостанавливает основателя. Фоновая сверка не публикует
 * брошенный материал — «отклонён: права нет»; опубликованный раньше остаётся. Затем
 * учётная запись восстанавливается (уборка).
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { registerProbeUser, startProbeRun } from './lib/probe-run.mjs';

const BASE = process.env.FIFTH_BASE ?? 'http://127.0.0.1';
let failed = 0;
let passed = 0;
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
function demoPassword() {
  const env = readFileSync('.env', 'utf8');
  for (const key of ['DEMO_USER_PASSWORD', 'DEV_TEST_USER_PASSWORD']) {
    const m = env.match(new RegExp(`^${key}=(.*)$`, 'm'));
    if (m?.[1]) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('нет DEMO_USER_PASSWORD в .env');
}
function client() {
  const jar = new Map();
  async function call(path, { method = 'GET', body, key = false } = {}) {
    const headers = { 'X-Fifth-Origin': 'render_check' };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const csrf = [...jar].find(([k]) => /csrf/i.test(k))?.[1];
    if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
    if (key) headers['Idempotency-Key'] = randomUUID();
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    for (const cookie of r.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(';');
      const eq = pair.indexOf('=');
      jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* не JSON */
    }
    return { status: r.status, json, text };
  }
  return { call };
}
async function login(email, password) {
  const c = client();
  const r = await c.call('/v1/auth/login', { method: 'POST', body: { email, password } });
  if (r.status !== 200 && r.status !== 201) throw new Error(`вход ${email}: HTTP ${r.status}`);
  return c;
}
function sql(query) {
  const r = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      'fifth-postgres',
      'sh',
      '-c',
      'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d fifth_element -At -v ON_ERROR_STOP=1',
    ],
    { input: query, encoding: 'utf8', timeout: 60_000 },
  );
  if (r.status !== 0) throw new Error(`база: ${(r.stderr ?? '').trim().slice(-300)}`);
  return r.stdout.trim();
}
async function upload(c, projectId, finalize) {
  const ticket = await c.call(`/v1/projects/${projectId}/materials/upload`, {
    method: 'POST',
    body: { type: 'deck', fileName: 'deck.pdf', contentType: 'application/pdf', sizeBytes: 64 },
  });
  const id = ticket.json?.materialId;
  const form = new FormData();
  for (const [k, v] of Object.entries(ticket.json?.formFields ?? {})) form.append(k, v);
  form.append('file', new Blob([Buffer.from('%PDF-1.4 право автора')]), 'deck.pdf');
  const put = await fetch(ticket.json?.uploadUrl, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!id || put.status >= 400)
    throw new Error(`загрузка: билет ${ticket.status}, файл ${put.status}`);
  if (finalize)
    await c.call(`/v1/projects/${projectId}/materials/${id}/finalize`, { method: 'POST' });
  return id;
}
const stateOf = (id) =>
  sql(
    `SELECT upload_state || '|' || coalesce(upload_state_reason, '') FROM lab.project_materials WHERE id = '${id}';`,
  );

console.log('\n=== ПРАВО АВТОРА ПЕРЕД ПУБЛИКАЦИЕЙ ЗАГРУЗКИ (M174) ===\n');
const run = await startProbeRun('CHK-UPLOAD-PUBLISH-RIGHT');
let ok = false;
let admin = null;
let userId = null;
try {
  const who = await registerProbeUser(run, { role: 'founder', label: 'publish-right' });
  const c = await login(who.email, who.password);
  userId = (await c.call('/v1/auth/me')).json?.id;
  admin = await login('demo-admin@fifth.local', demoPassword());
  const taxonomy = await c.call('/v1/taxonomy');
  const project = await c.call('/v1/projects', {
    method: 'POST',
    key: true,
    body: {
      title: 'Проект права автора',
      stage: 'mvp',
      taxonomyId: taxonomy.json?.items?.[0]?.id,
      investmentAsk: '1000000',
      askCurrency: 'RUB',
    },
  });
  const projectId = project.json?.id;
  if (!projectId) throw new Error(`проект: HTTP ${project.status}`);

  const published = await upload(c, projectId, true);
  check('материал, подтверждённый браузером, опубликован', stateOf(published).startsWith('ready|'));
  const abandoned = await upload(c, projectId, false);
  check('второй брошен браузером — ожидает', stateOf(abandoned).startsWith('pending|'));

  const suspend = await admin.call(`/v1/admin/users/${userId}/status`, {
    method: 'PATCH',
    body: { action: 'suspend', reason: 'проверка права автора' },
  });
  check('администратор приостановил автора', suspend.status === 200, `HTTP ${suspend.status}`);

  let state = '';
  for (let i = 0; i < 40; i += 1) {
    await sleep(5000);
    state = stateOf(abandoned);
    if (!state.startsWith('pending|')) break;
  }
  check(
    'сверка не опубликовала: материал отклонён, причина — права',
    state.startsWith('rejected|') && /прав/.test(state),
    state,
  );
  check('опубликованный раньше не отменён', stateOf(published).startsWith('ready|'));
  const added = sql(
    `SELECT count(*) FROM audit.events WHERE verb = 'lab.material.added' AND context_jsonb->>'materialId' = '${abandoned}';`,
  );
  check('событие публикации для отклонённого не записано', added === '0', `событий ${added}`);
  ok = failed === 0;
} catch (error) {
  failed += 1;
  console.log(`  FAIL  прогон прерван — ${error.message}`);
} finally {
  if (admin && userId) {
    await admin
      .call(`/v1/admin/users/${userId}/status`, {
        method: 'PATCH',
        body: { action: 'restore', reason: 'уборка проверки права автора' },
      })
      .catch(() => undefined);
  }
  await run.finish(ok);
}
console.log(`\nИТОГО: ${passed} пройдено, ${failed} провалено`);
process.exit(failed === 0 ? 0 : 1);
