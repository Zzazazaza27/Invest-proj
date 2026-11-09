#!/usr/bin/env node
/**
 * Контекст автора в журнале на живом стенде (блок 10, задание 1;
 * docs/architecture/b10-actor-context.md).
 *
 *   node scripts/check-actor-context.mjs        (стенд http://127.0.0.1/, база fifth-postgres)
 *
 * Одновременно: два основателя меняют свои проекты, администратор — чужой проект,
 * фоновая сверка завершает загрузку, брошенную браузером. Затем по базе: у каждой записи
 * свой автор и своя операция, ничего не смешалось; до входа — аноним; действие над собой —
 * `user`; фон — система с инициатором из сохранённого происхождения; цепочка цела.
 *
 * Участники — свои, заведены через учёт прогона (probe-run) и убираются успешным прогоном.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { registerProbeUser, startProbeRun } from './lib/probe-run.mjs';

const BASE = process.env.FIFTH_BASE ?? 'http://127.0.0.1';
const started = new Date(Date.now() - 2000).toISOString();
let failed = 0;
let passed = 0;
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Пароль демонстрационного администратора — из .env стенда, наружу не выводится. */
function demoPassword() {
  const env = readFileSync('.env', 'utf8');
  for (const key of ['DEMO_USER_PASSWORD', 'DEV_TEST_USER_PASSWORD']) {
    const m = env.match(new RegExp(`^${key}=(.*)$`, 'm'));
    if (m?.[1]) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('нет DEMO_USER_PASSWORD в .env — комплект не загружен');
}

function client() {
  const jar = new Map();
  async function call(path, { method = 'GET', body, key = false } = {}) {
    const headers = { 'X-Fifth-Origin': 'render_check' };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const csrf = [...jar].find(([k]) => /csrf/i.test(k))?.[1];
    if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
    if (key) headers['Idempotency-Key'] = key === true ? randomUUID() : key;
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(';');
      const eq = pair.indexOf('=');
      jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* не JSON */
    }
    return { status: response.status, json, text };
  }
  return { call };
}

async function login(email, password) {
  const c = client();
  const r = await c.call('/v1/auth/login', { method: 'POST', body: { email, password } });
  if (r.status !== 200 && r.status !== 201) throw new Error(`вход ${email}: HTTP ${r.status}`);
  return c;
}

/** Запрос к базе стенда; учётные данные берутся внутри контейнера и не выводятся. */
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
const events = (where) =>
  JSON.parse(
    sql(`SELECT coalesce(json_agg(json_build_object(
           'verb', verb, 'actorId', actor_id, 'actorRole', actor_role,
           'subjectId', subject_id, 'traceId', trace_id, 'actor', context_jsonb->'actor')
           ORDER BY ts), '[]') FROM audit.events WHERE ts >= '${started}' AND ${where};`) || '[]',
  );

async function createProject(c, title) {
  const taxonomy = await c.call('/v1/taxonomy');
  const r = await c.call('/v1/projects', {
    method: 'POST',
    key: true,
    body: {
      title,
      stage: 'mvp',
      taxonomyId: taxonomy.json?.items?.[0]?.id,
      investmentAsk: '1000000',
      askCurrency: 'RUB',
    },
  });
  if (!r.json?.id) throw new Error(`проект: HTTP ${r.status} ${r.text.slice(0, 160)}`);
  return r.json.id;
}

console.log('\n=== КОНТЕКСТ АВТОРА В ЖУРНАЛЕ (блок 10) ===\n');
const run = await startProbeRun('CHK-ACTOR-CONTEXT');
let ok = false;
try {
  // --- до входа
  console.log('▸ До входа');
  const a = await registerProbeUser(run, { role: 'founder', label: 'actor-a' });
  const b = await registerProbeUser(run, { role: 'founder', label: 'actor-b' });
  const bad = await client().call('/v1/auth/login', {
    method: 'POST',
    body: { email: a.email, password: 'wrong-password-123' },
  });
  check('неудачный вход отказан', bad.status === 401, `HTTP ${bad.status}`);

  const ca = await login(a.email, a.password);
  const cb = await login(b.email, b.password);
  const admin = await login('demo-admin@fifth.local', demoPassword());
  const idA = (await ca.call('/v1/auth/me')).json?.id;
  const idB = (await cb.call('/v1/auth/me')).json?.id;
  if (!idA || !idB) throw new Error('нет идентификаторов участников');

  const pa = await createProject(ca, 'Проект A контекста автора');
  const pb = await createProject(cb, 'Проект B контекста автора');

  // --- повтор защищённой операции тем же ключом: та же операция, другой запрос
  console.log('▸ Повтор тем же ключом');
  const retryKey = randomUUID();
  const taxonomy = await cb.call('/v1/taxonomy');
  const body = {
    title: 'Проект B2 повтор',
    stage: 'mvp',
    taxonomyId: taxonomy.json?.items?.[0]?.id,
    investmentAsk: '1000000',
    askCurrency: 'RUB',
  };
  const first = await cb.call('/v1/projects', { method: 'POST', key: retryKey, body });
  const again = await cb.call('/v1/projects', { method: 'POST', key: retryKey, body });
  check(
    'повтор тем же ключом — тот же проект',
    first.json?.id && again.json?.id === first.json.id,
    `${first.status}/${again.status}`,
  );
  const pb2 = first.json?.id;

  // --- загрузка, брошенная браузером: её завершит фоновая сверка
  console.log('▸ Одновременно: два основателя, администратор, фоновая сверка');
  const ticket = await ca.call(`/v1/projects/${pa}/materials/upload`, {
    method: 'POST',
    body: { type: 'deck', fileName: 'deck.pdf', contentType: 'application/pdf', sizeBytes: 64 },
  });
  const materialId = ticket.json?.materialId;
  const form = new FormData();
  for (const [k, v] of Object.entries(ticket.json?.formFields ?? {})) form.append(k, v);
  form.append('file', new Blob([Buffer.from('%PDF-1.4 материал контекста автора')]), 'deck.pdf');
  const put = await fetch(ticket.json?.uploadUrl, { method: 'POST', body: form });
  check('файл в хранилище, подтверждения из браузера нет', put.status < 400 && !!materialId, `HTTP ${put.status}`);

  const N = 8;
  const edits = (c, project, who) =>
    Array.from({ length: N }, (_, i) =>
      c.call(`/v1/projects/${project}`, {
        method: 'PATCH',
        body: { tagline: `${who} правка ${i}` },
      }),
    );
  const results = await Promise.all([
    ...edits(ca, pa, 'A'),
    ...edits(cb, pb, 'B'),
    ...Array.from({ length: 3 }, (_, i) =>
      admin.call(`/v1/projects/${pa}`, { method: 'PATCH', body: { tagline: `админ правка ${i}` } }),
    ),
    ca.call('/v1/me/profile', { method: 'PATCH', body: { displayName: 'Прогон автор A' } }),
  ]);
  check(
    'все правки приняты',
    results.every((r) => r.status === 200),
    results.filter((r) => r.status !== 200).map((r) => `${r.status} ${r.text.slice(0, 80)}`).join('; '),
  );

  // Сверка подхватывает загрузку не раньше чем через минуту (next_check_at).
  let ready = false;
  for (let i = 0; i < 40 && !ready; i += 1) {
    await sleep(5000);
    ready =
      sql(`SELECT upload_state FROM lab.project_materials WHERE id = '${materialId}';`) === 'ready';
  }
  check('фоновая сверка завершила загрузку', ready);

  // --- журнал
  console.log('▸ Журнал');
  const reg = events(`verb = 'identity.user.registered' AND subject_id IN ('${idA}', '${idB}')`);
  check(
    'регистрация: автор — аноним, учётная запись — предмет',
    reg.length === 2 &&
      reg.every((e) => e.actorId === null && e.actorRole === 'anonymous' && e.actor?.kind === 'anonymous'),
    JSON.stringify(reg.map((e) => [e.actorRole, e.actor?.kind])),
  );
  const fail = events(`verb = 'identity.login.failed' AND subject_id = '${idA}'`);
  check(
    'неудачный вход: аноним, не владелец учётной записи',
    fail.length === 1 && fail[0].actorId === null && fail[0].actor?.kind === 'anonymous',
    JSON.stringify(fail.map((e) => [e.actorId, e.actorRole])),
  );

  const upd = events(`verb = 'lab.project.updated' AND subject_id IN ('${pa}', '${pb}')`);
  const byA = upd.filter((e) => e.actorId === idA);
  const byB = upd.filter((e) => e.actorId === idB);
  const byAdmin = upd.filter((e) => e.actorId !== idA && e.actorId !== idB);
  check(
    'правки основателей: автор — свой, проект — свой, основание — участник',
    byA.length === N &&
      byB.length === N &&
      byA.every((e) => e.subjectId === pa) &&
      byB.every((e) => e.subjectId === pb) &&
      [...byA, ...byB].every(
        (e) => e.actorRole === 'founder' && e.actor?.basis?.[0]?.check === 'member' && e.actor.userId === e.actorId,
      ),
    `A ${byA.length}, B ${byB.length}`,
  );
  const ops = new Set([...byA, ...byB, ...byAdmin].map((e) => e.actor?.operationId));
  check('у каждого запроса своя операция', ops.size === byA.length + byB.length + byAdmin.length, `${ops.size}`);
  check(
    'запрос в контексте = trace события',
    upd.every((e) => e.actor?.requestId === e.traceId),
  );
  check(
    'администратор над чужим проектом: роль admin по пройденной проверке',
    byAdmin.length === 3 &&
      byAdmin.every(
        (e) => e.subjectId === pa && e.actorRole === 'admin' && e.actor?.basis?.[0]?.role === 'admin',
      ),
    JSON.stringify(byAdmin.map((e) => [e.actorRole, e.actor?.basis])),
  );

  const self = events(`verb = 'identity.user.profile_updated' AND actor_id = '${idA}'`);
  check(
    'действие над собой: роль user, основание self',
    self.length === 1 && self[0].actorRole === 'user' && self[0].actor?.basis?.[0]?.check === 'self',
    JSON.stringify(self.map((e) => [e.actorRole, e.actor?.basis])),
  );

  const added = events(`verb = 'lab.material.added' AND subject_id = '${pa}' AND context_jsonb->>'materialId' = '${materialId}'`);
  const origin = JSON.parse(sql(`SELECT upload_origin FROM lab.project_materials WHERE id = '${materialId}';`) || 'null');
  check(
    'фон: автор — система, задача и попытка отдельно, инициатор — A',
    added.length === 1 &&
      added[0].actorId === null &&
      added[0].actor?.kind === 'system' &&
      added[0].actor?.job?.name === 'uploads.reconcile' &&
      added[0].actor?.initiator?.userId === idA,
    JSON.stringify(added.map((e) => e.actor)),
  );
  check(
    'операция фона — та же, что у запроса загрузки',
    added.length === 1 && origin?.operationId && added[0].actor?.operationId === origin.operationId,
  );

  const created = events(`verb = 'lab.project.created' AND subject_id = '${pb2}'`);
  const keyOp = sql(
    `SELECT operation_id FROM requests.idempotency_keys WHERE key = '${retryKey}';`,
  );
  check(
    'операция повтора сохранена с ключом и совпадает с записью журнала; событие одно',
    created.length === 1 && keyOp && created[0].actor?.operationId === keyOp,
    `событий ${created.length}, ключ ${keyOp || 'нет'}`,
  );

  const all = events('true');
  check(
    'все новые записи несут контекст автора',
    all.length > 0 && all.every((e) => e.actor?.v === 1),
    `без контекста: ${all.filter((e) => !e.actor).map((e) => e.verb).join(', ')}`,
  );
  const broken = sql(`SELECT count(*) FROM audit.verify_event_chain('${started}');`);
  check('цепочка журнала цела', broken === '0', `разрывов: ${broken}`);
  ok = failed === 0;
} catch (error) {
  failed += 1;
  console.log(`  FAIL  прогон прерван — ${error.message}`);
} finally {
  await run.finish(ok);
}
console.log(`\nИТОГО: ${passed} пройдено, ${failed} провалено`);
process.exit(failed === 0 ? 0 : 1);
