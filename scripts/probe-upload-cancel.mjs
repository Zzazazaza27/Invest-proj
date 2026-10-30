#!/usr/bin/env node
/**
 * Отмена загрузки и длительные операции пользователя (2.1-W04; блок 1 1.5,
 * 2.1.2, 3.3) — приёмка фактом на ядре, БД и MinIO стенда.
 *
 * Что проверяется:
 *   A. отмена идущей загрузки: «отменено», запись и временный ключ на месте,
 *      место в квоте освобождено, событие в журнале;
 *   B. поздний файл после отмены не публикуется — ни завершением из браузера,
 *      ни сверкой;
 *   C. гонка отмены с публикацией: отмена снимает аренду, публикация под
 *      прежней арендой не проходит; при одновременном запуске — ровно один
 *      итог, «готово» или «отменено», и он согласован с данными;
 *   D. отмена после «готово» — ответ «готово», ничего не меняется;
 *   E. права: операция видна только инициатору с действующими правами на
 *      проект — участник проекта не видит, не отмечает и не отменяет чужую;
 *      потерявший доступ не видит и свою;
 *   F. окончательная ошибка: видна проверке как неотмеченная, после отметки
 *      показа не возвращается (повторная отметка ничего не меняет), причина
 *      остаётся в списке загрузок проекта; отметка идущей операции — отказ.
 *
 * Функцию завершения и сверку прогон вызывает из сборки ядра — тот же код,
 * что в процессе. Ядро стенда при этом тоже сверяет раз в минуту: проверки
 * рассчитаны на то, что работу мог выполнить любой из них.
 *
 * Запуск: node scripts/probe-upload-cancel.mjs (нужны core, PostgreSQL, MinIO
 * и собранный core). Прогон убирает за собой проект, материалы, попытки и
 * отметки; объекты в хранилище остаются (удаление — не дело этой работы).
 */
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

process.on('unhandledRejection', (reason) => {
  console.error('ПРОГОН ОБОРВАН (unhandledRejection):', reason);
  process.exit(1);
});

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

const DIST = join(ROOT, 'apps/core/dist');
if (!existsSync(join(DIST, 'lab/upload-operations.service.js'))) {
  console.error(
    'нет apps/core/dist/lab/upload-operations.service.js — сначала npm run build -w apps/core',
  );
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { Database } = require(join(DIST, 'db/unit-of-work.js'));
const { S3Service } = require(join(DIST, 'storage/s3.service.js'));
const { AuditRepository } = require(join(DIST, 'audit/audit.repository.js'));
const { MaterialUploadsService } = require(join(DIST, 'lab/material-uploads.service.js'));
const { claimLeases, completeUnderLease } = require(join(DIST, 'background/lease.js'));

const db = new Database();
const s3 = new S3Service();
const uploads = new MaterialUploadsService(db, s3, new AuditRepository(db), { register() {} });
const completion = uploads.completion;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
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
        signal: AbortSignal.timeout(30_000),
      });
      for (const cookie of response.headers.getSetCookie?.() ?? []) {
        const pair = cookie.split(';')[0];
        if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
        if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
      }
      const json = await response.json().catch(() => null);
      return { status: response.status, json };
    },
  };
}

async function uploadByTicket(ticket, bytes) {
  const form = new FormData();
  for (const [key, value] of Object.entries(ticket.formFields)) form.append(key, value);
  form.append('file', new Blob([bytes], { type: ticket.formFields['Content-Type'] }), 'deck.pdf');
  const response = await fetch(ticket.uploadUrl, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  return response.status;
}

const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

async function registerFounder(label) {
  const email = `w04-${label}-${Date.now() % 1e9}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const client = makeClient();
  await client.call('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: `W04 ${label}`,
      role: 'founder',
      locale: 'ru-RU',
      consents: CONSENTS,
    },
  });
  const [user] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
    blindIndex(email),
  ]);
  return { client, userId: user?.id, email, password };
}

/** Администратор: роль выдаётся в БД, затем новый вход — роли берутся при входе. */
async function registerAdmin(label) {
  const user = await registerFounder(label);
  await sql(
    "INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING",
    [user.userId],
  );
  const client = makeClient();
  await client.call('/v1/auth/login', {
    method: 'POST',
    body: { email: user.email, password: user.password },
  });
  return { ...user, client };
}

const row = async (id) =>
  (
    await sql(
      `SELECT upload_state, upload_key, s3_key, uploaded_at, lease_id, cancelled_at, cancelled_by,
              upload_file_name
         FROM lab.project_materials WHERE id = $1`,
      [id],
    )
  )[0];
const published = async (id) =>
  (
    await sql(
      `SELECT count(*)::int AS n FROM lab.material_upload_attempts
        WHERE material_id = $1 AND state = 'published'`,
      [id],
    )
  )[0].n;
const counters = async (projectId) =>
  (
    await sql(
      'SELECT total::int AS total, pending::int AS pending FROM lab.material_counters($1)',
      [projectId],
    )
  )[0];
const due = (id) =>
  sql('UPDATE lab.project_materials SET next_check_at = now() WHERE id = $1', [id]);

console.warn('\n=== ОТМЕНА ЗАГРУЗКИ И ОПЕРАЦИИ ПОЛЬЗОВАТЕЛЯ (W04) ===\n');

const owner = await registerFounder('owner');
const partner = await registerFounder('partner');
const admin = await registerAdmin('admin');
const taxonomy = await fetch(`${BASE}/v1/taxonomy`, { signal: AbortSignal.timeout(10_000) })
  .then((r) => r.json())
  .then((b) => b.items?.[0]?.id ?? null);
const created = await owner.client.call('/v1/projects', {
  method: 'POST',
  body: {
    title: `W04 отмена ${Date.now() % 1e9}`,
    stage: 'mvp',
    taxonomyId: taxonomy,
    investmentAsk: '1000000.00',
    askCurrency: 'RUB',
  },
});
const projectId = created.json?.id;
check('проект создан', created.status === 201 && Boolean(projectId), `HTTP ${created.status}`);
await sql(
  `INSERT INTO lab.founders_projects (project_id, user_id, role) VALUES ($1, $2, 'cofounder')`,
  [projectId, partner.userId],
);

const pdf = (label) => Buffer.from(`%PDF-1.4 W04 ${label} ${randomUUID()}`, 'utf8');
async function ticket(bytes, label, client = owner.client) {
  const r = await client.call(`/v1/projects/${projectId}/materials/upload`, {
    method: 'POST',
    body: {
      type: 'deck',
      fileName: `deck-${label}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: bytes.length,
    },
  });
  return r.json;
}
const cancel = (materialId, client = owner.client) =>
  client.call(`/v1/projects/${projectId}/materials/${materialId}/cancel`, { method: 'POST' });
const finalize = (materialId) =>
  owner.client.call(`/v1/projects/${projectId}/materials/${materialId}/finalize`, {
    method: 'POST',
  });
const ops = async (client) => (await client.call('/v1/me/operations')).json?.items ?? [];

try {
  // A. Отмена идущей загрузки.
  console.warn('▸ A. Отмена идущей загрузки');
  const quota0 = await counters(projectId);
  const a = await ticket(pdf('A'), 'A');
  const quota1 = await counters(projectId);
  check(
    'форма заняла место в квоте',
    quota1.total === quota0.total + 1 && quota1.pending === quota0.pending + 1,
  );
  check('имя файла сохранено', (await row(a.materialId)).upload_file_name === 'deck-A.pdf');
  check(
    'идущая загрузка видна проверке операций',
    (await ops(owner.client)).some((op) => op.id === a.materialId && op.state === 'pending'),
  );
  const cancelA = await cancel(a.materialId);
  const rowA = await row(a.materialId);
  check(
    'ответ — «отменено»',
    cancelA.status === 200 && cancelA.json?.uploadState === 'cancelled',
    `HTTP ${cancelA.status} ${cancelA.json?.uploadState}`,
  );
  check(
    'запись осталась: «отменено», автор и время, временный ключ на месте',
    rowA?.upload_state === 'cancelled' &&
      rowA.cancelled_by === owner.userId &&
      rowA.cancelled_at !== null &&
      Boolean(rowA.upload_key) &&
      rowA.lease_id === null,
  );
  const quota2 = await counters(projectId);
  check(
    'место в квоте освобождено',
    quota2.total === quota0.total && quota2.pending === quota0.pending,
  );
  const [eventA] = await sql(
    `SELECT actor_id FROM audit.events
      WHERE verb = 'lab.material.upload_cancelled' AND context_jsonb->>'materialId' = $1`,
    [a.materialId],
  );
  check('событие отмены в журнале от имени автора', eventA?.actor_id === owner.userId);
  check(
    'отменённая не видна проверке операций',
    !(await ops(owner.client)).some((op) => op.id === a.materialId),
  );
  const again = await cancel(a.materialId);
  check('повторная отмена — то же «отменено»', again.json?.uploadState === 'cancelled');

  // B. Поздний файл после отмены.
  console.warn('▸ B. Поздний файл после отмены');
  const bytesB = pdf('B');
  const b = await ticket(bytesB, 'B');
  await cancel(b.materialId);
  check(
    'форма ещё принимает файл (хранилище не знает об отмене)',
    [200, 204].includes(await uploadByTicket(b, bytesB)),
  );
  const fin = await finalize(b.materialId);
  check(
    'завершение из браузера — «отменено», не «готово»',
    fin.json?.uploadState === 'cancelled',
    fin.json?.uploadState,
  );
  await due(b.materialId).catch(() => undefined);
  await uploads.reconcile(new AbortController().signal);
  const rowB = await row(b.materialId);
  check(
    'сверка не опубликовала поздний файл',
    rowB.upload_state === 'cancelled' && rowB.s3_key === null && rowB.uploaded_at === null,
  );
  check('опубликованных попыток нет', (await published(b.materialId)) === 0);
  const materialsB =
    (await owner.client.call(`/v1/projects/${projectId}/materials`)).json?.items ?? [];
  check('в материалах проекта его нет', !materialsB.some((m) => m.id === b.materialId));

  // C. Гонка отмены с публикацией.
  console.warn('▸ C. Гонка отмены с публикацией');
  const bytesC = pdf('C1');
  const c1 = await ticket(bytesC, 'C1');
  await uploadByTicket(c1, bytesC);
  // Исполнитель захватил аренду и дошёл до публикации — между этим отмена.
  const [lease] = await db.asServiceRole('app_maintenance', { traceId: 'w04-c1' }, (tx) =>
    claimLeases(tx, {
      table: 'lab.project_materials',
      where: `id = $1 AND upload_state = 'pending'`,
      params: [c1.materialId],
      limit: 1,
      seconds: 120,
    }),
  );
  check('исполнитель держит аренду', Boolean(lease));
  const cancelC1 = await cancel(c1.materialId);
  check('отмена прошла при занятой аренде', cancelC1.json?.uploadState === 'cancelled');
  const lateCommit = await db.asServiceRole('app_maintenance', { traceId: 'w04-c1' }, (tx) =>
    completeUnderLease(tx, {
      table: 'lab.project_materials',
      lease,
      set: `upload_state = 'ready', uploaded_at = now(), s3_key = upload_key || '/final', size_bytes = 1`,
    }),
  );
  check('публикация под прежней арендой не прошла', lateCommit === false);
  check('итог — «отменено»', (await row(c1.materialId)).upload_state === 'cancelled');

  // Одновременный запуск: настоящая функция завершения против отмены по API.
  // Отмена приходит с разной задержкой — от «сразу» до «завершение почти
  // закончилось», чтобы в прогоне встречались оба исхода.
  const RACE_DELAYS_MS = [0, 20, 60, 120, 250, 500];
  let ready = 0;
  let cancelled = 0;
  let consistent = true;
  for (let i = 0; i < 6; i += 1) {
    const bytes = pdf(`C-${i}`);
    const t = await ticket(bytes, `C-${i}`);
    await uploadByTicket(t, bytes);
    const [, cancelResult] = await Promise.all([
      completion.complete(t.materialId, {
        executor: 'browser',
        actorId: owner.userId,
        traceId: `w04-c-${i}`,
      }),
      new Promise((resolve) => setTimeout(resolve, RACE_DELAYS_MS[i])).then(() =>
        cancel(t.materialId),
      ),
    ]);
    const r = await row(t.materialId);
    const pub = await published(t.materialId);
    if (r.upload_state === 'ready') {
      ready += 1;
      consistent &&=
        pub === 1 && r.cancelled_at === null && cancelResult.json?.uploadState === 'ready';
    } else if (r.upload_state === 'cancelled') {
      cancelled += 1;
      consistent &&=
        pub === 0 && r.s3_key === null && cancelResult.json?.uploadState === 'cancelled';
    } else {
      consistent = false;
    }
  }
  check(
    'каждая гонка — ровно один итог, согласованный с данными и ответом отмены',
    consistent && ready + cancelled === 6,
    `готово ${ready}, отменено ${cancelled}`,
  );

  // D. Отмена после «готово».
  console.warn('▸ D. Отмена после «готово»');
  const bytesD = pdf('D');
  const d = await ticket(bytesD, 'D');
  await uploadByTicket(d, bytesD);
  await finalize(d.materialId);
  const cancelD = await cancel(d.materialId);
  const rowD = await row(d.materialId);
  check('ответ — «готово»', cancelD.json?.uploadState === 'ready', cancelD.json?.uploadState);
  check('материал не изменился', rowD.upload_state === 'ready' && rowD.cancelled_at === null);

  // E. Права.
  console.warn('▸ E. Права: инициатор и действующий доступ');
  const e = await ticket(pdf('E'), 'E');
  check(
    'участник проекта не видит чужую операцию в проверке',
    !(await ops(partner.client)).some((op) => op.id === e.materialId),
  );
  const peek = await partner.client.call(`/v1/me/operations/material_upload/${e.materialId}`);
  check('участник не читает чужую операцию', peek.status === 404, `HTTP ${peek.status}`);
  const partnerList =
    (await partner.client.call(`/v1/projects/${projectId}/material-uploads`)).json?.items ?? [];
  check(
    'в загрузках проекта у участника её нет',
    !partnerList.some((op) => op.id === e.materialId),
  );
  const partnerCancel = await cancel(e.materialId, partner.client);
  check(
    'участник не отменяет чужую загрузку',
    partnerCancel.status === 404,
    `HTTP ${partnerCancel.status}`,
  );
  check('загрузка по-прежнему идёт', (await row(e.materialId)).upload_state === 'pending');

  // Администратор по правам видит чужие незавершённые загрузки — здесь
  // держит только условие инициатора: чужая ошибка не его уведомление.
  const adminMe = await admin.client.call('/v1/auth/me');
  check(
    'администратор вошёл с ролью admin',
    adminMe.json?.roles?.includes('admin'),
    String(adminMe.json?.roles),
  );
  check(
    'администратор не видит чужую операцию в проверке',
    !(await ops(admin.client)).some((op) => op.id === e.materialId),
  );
  const adminPeek = await admin.client.call(`/v1/me/operations/material_upload/${e.materialId}`);
  check(
    'администратор не читает чужую как свою операцию',
    adminPeek.status === 404,
    `HTTP ${adminPeek.status}`,
  );
  const adminCancel = await cancel(e.materialId, admin.client);
  check(
    'администратор не отменяет чужую загрузку',
    adminCancel.status === 404,
    `HTTP ${adminCancel.status}`,
  );

  // Загрузка участника, затем участник теряет доступ.
  const own = await ticket(pdf('E2'), 'E2', partner.client);
  check(
    'своя загрузка участнику видна',
    (await ops(partner.client)).some((op) => op.id === own.materialId),
  );
  await sql('DELETE FROM lab.founders_projects WHERE project_id = $1 AND user_id = $2', [
    projectId,
    partner.userId,
  ]);
  check(
    'без доступа к проекту не видна и своя',
    !(await ops(partner.client)).some((op) => op.id === own.materialId),
  );
  const lostCancel = await cancel(own.materialId, partner.client);
  check(
    'без доступа своя загрузка не отменяется',
    lostCancel.status === 404,
    `HTTP ${lostCancel.status}`,
  );

  // F. Окончательная ошибка и отметка показа.
  console.warn('▸ F. Окончательная ошибка и отметка показа');
  const html = Buffer.from('<html>не презентация</html>', 'utf8');
  const f = await ticket(html, 'F');
  await uploadByTicket(f, html);
  const doneF = await finalize(f.materialId);
  check('загрузка не принята', doneF.json?.uploadState === 'rejected');
  const opF = (await ops(owner.client)).find((op) => op.id === f.materialId);
  check(
    'проверка видит неотмеченную ошибку с причиной',
    opF?.noticePending === true && Boolean(opF?.reason),
    opF?.reason ?? '',
  );
  const partnerNotice = await partner.client.call(
    `/v1/me/operations/material_upload/${f.materialId}/notice`,
    { method: 'POST' },
  );
  check(
    'чужой показ отметить нельзя',
    partnerNotice.status === 404,
    `HTTP ${partnerNotice.status}`,
  );
  const n1 = await owner.client.call(`/v1/me/operations/material_upload/${f.materialId}/notice`, {
    method: 'POST',
  });
  const n2 = await owner.client.call(`/v1/me/operations/material_upload/${f.materialId}/notice`, {
    method: 'POST',
  });
  check(
    'отметка показа принята, повторная ничего не меняет',
    n1.status === 200 && n2.status === 200,
  );
  const [{ n: noticeRows }] = await sql(
    `SELECT count(*)::int AS n FROM comms.operation_notices WHERE operation_id = $1`,
    [f.materialId],
  );
  check('одна отметка на пару «операция — пользователь»', noticeRows === 1);
  check(
    'после отметки проверка её не возвращает',
    !(await ops(owner.client)).some((op) => op.id === f.materialId),
  );
  const listF =
    (await owner.client.call(`/v1/projects/${projectId}/material-uploads`)).json?.items ?? [];
  const inCard = listF.find((op) => op.id === f.materialId);
  check(
    'причина остаётся в загрузках проекта',
    inCard?.state === 'rejected' && Boolean(inCard?.reason) && inCard?.noticePending === false,
  );
  const pendingNotice = await owner.client.call(
    `/v1/me/operations/material_upload/${e.materialId}/notice`,
    { method: 'POST' },
  );
  check(
    'идущую операцию отметить нельзя',
    pendingNotice.status === 409,
    `HTTP ${pendingNotice.status}`,
  );

  // G. История отказов не вытесняет идущую загрузку (замечание Тэнка при
  // приёмке W04). Старая идущая — `e` выше; после неё 25 более новых отказов.
  console.warn('▸ G. Старая идущая загрузка и 25 новых отказов');
  await sql(
    `INSERT INTO lab.project_materials
       (id, project_id, type, version, upload_key, upload_state, upload_state_reason,
        upload_state_changed_at, uploaded_by, created_at, upload_file_name)
     SELECT public.uuid_generate_v7(), $1::uuid, 'doc', 100 + g,
            'projects/' || $1::text || '/materials/doc/w04-g-' || g || '/upload', 'rejected',
            'проба истории', now() + make_interval(secs => g), $2,
            now() + make_interval(secs => g), 'отказ-' || g || '.pdf'
       FROM generate_series(1, 25) AS g`,
    [projectId, owner.userId],
  );
  const listG =
    (await owner.client.call(`/v1/projects/${projectId}/material-uploads`)).json?.items ?? [];
  check(
    'идущая загрузка в списке проекта, несмотря на 25 более новых отказов',
    listG.some((op) => op.id === e.materialId && op.state === 'pending'),
  );
  check(
    'история ограничена 20 последними',
    listG.filter((op) => op.state !== 'pending').length === 20,
    `${listG.filter((op) => op.state !== 'pending').length}`,
  );
  check('идущие — первыми', listG[0]?.state === 'pending');
  const opsG = await ops(owner.client);
  check(
    'идущая загрузка и в общей проверке',
    opsG.some((op) => op.id === e.materialId && op.state === 'pending'),
  );
  const pollG = await owner.client.call(`/v1/me/operations/material_upload/${e.materialId}`);
  check('опрос идущей работает', pollG.json?.state === 'pending');
  const cancelG = await cancel(e.materialId);
  check('и её можно отменить', cancelG.json?.uploadState === 'cancelled');
} finally {
  if (projectId) {
    await sql(
      `DELETE FROM comms.operation_notices
        WHERE operation_id IN (SELECT id FROM lab.project_materials WHERE project_id = $1)`,
      [projectId],
    );
    await sql(
      `DELETE FROM lab.material_upload_attempts
        WHERE material_id IN (SELECT id FROM lab.project_materials WHERE project_id = $1)`,
      [projectId],
    );
    await sql('DELETE FROM lab.project_materials WHERE project_id = $1', [projectId]);
    await sql('DELETE FROM lab.founders_projects WHERE project_id = $1', [projectId]);
    await sql('DELETE FROM lab.projects WHERE id = $1', [projectId]);
  }
  for (const user of [owner, partner, admin]) {
    if (user.userId) await sql('DELETE FROM identity.user_roles WHERE user_id = $1', [user.userId]);
  }
  await pool.end();
  await db.onModuleDestroy();
}

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exit(failed > 0 ? 1 : 0);
