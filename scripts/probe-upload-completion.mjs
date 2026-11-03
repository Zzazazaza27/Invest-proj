#!/usr/bin/env node
/**
 * Завершение загрузок материалов (2.1-W03; блок 1 1.3.2–1.3.4, 3.3, 2.1.2) —
 * приёмка фактом на БД и MinIO стенда.
 *
 * Заменяет `probe-abandoned-uploads.mjs`: прежняя уборка удаляла
 * незавершённые загрузки по возрасту, с W03 удаления нет (переходное
 * правило 2.1.2), и проверяется обратное — что ничего не удаляется.
 *
 * Что проверяется:
 *   A. обычная загрузка: готовый файл — копия по НОВОМУ ключу, хеш по байтам;
 *   B. повторная отправка старой формы не меняет готовый файл;
 *   C. неверный формат — «отклонено» с причиной, без автоматических повторов;
 *   D. страница закрыта после передачи — сверка завершает сама;
 *   E. браузер и сверка одновременно — один материал, одна публикация;
 *   F. истёкший захват не подтверждает результат (с новым захватом и без);
 *   G. остановка до и после CopyObject, потерянный ответ — повтор не создаёт
 *      второй материал;
 *   H. «к сроку не получен», объект появился позже — сверка завершает;
 *   I. чужой идентификатор не даёт доступа;
 *   J. ОТКАТ: SQL прежнего кода — создание, подтверждение и удаление —
 *      отвергается БД, незавершённые загрузки целы;
 *   K. права роли обслуживания: ни проектов, ни пользователей, ни удаления,
 *      ни правки готового материала; готовый файл неизменен для всех.
 *
 * Сверку и функцию завершения прогон вызывает из сборки ядра — тот же код,
 * что работает в процессе. Ядро стенда при этом тоже сверяет раз в минуту:
 * проверки рассчитаны на то, что работу мог выполнить любой из них.
 *
 * Запуск: node scripts/probe-upload-completion.mjs (нужны core, PostgreSQL,
 * MinIO и собранный core). Прогон убирает за собой проект, материалы и
 * попытки; объекты в хранилище остаются (удаление — не дело этой работы).
 */
import pg from 'pg';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { garageSetKeyPermissions } from './lib/garage-admin.mjs';
import { CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

process.on('unhandledRejection', (reason) => {
  console.error('ПРОГОН ОБОРВАН (unhandledRejection):', reason);
  process.exit(1);
});

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

const DIST = join(ROOT, 'apps/core/dist');
if (!existsSync(join(DIST, 'storage/upload-completion.js'))) {
  console.error(
    'нет apps/core/dist/storage/upload-completion.js — сначала npm run build -w apps/core',
  );
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { Database } = require(join(DIST, 'db/unit-of-work.js'));
const { S3Service, putObject } = require(join(DIST, 'storage/s3.service.js'));
const { AuditRepository } = require(join(DIST, 'audit/audit.repository.js'));
const { MaterialUploadsService } = require(join(DIST, 'lab/material-uploads.service.js'));
const { claimLeases, completeUnderLease, renewLease } = require(join(DIST, 'background/lease.js'));

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
  const email = `w03-${label}-${Date.now() % 1e9}@test.local`;
  const client = makeClient();
  await client.call('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password: `Pw-${randomUUID()}`,
      displayName: `W03 ${label}`,
      role: 'founder',
      locale: 'ru-RU',
      consents: CONSENTS,
    },
  });
  const [user] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
    blindIndex(email),
  ]);
  return { client, userId: user?.id };
}

const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const row = async (id) =>
  (
    await sql(
      `SELECT upload_state, upload_state_reason, upload_key, s3_key, content_hash, size_bytes,
              object_received_at, not_received_at, next_check_at, lease_id, check_failures
         FROM lab.project_materials WHERE id = $1`,
      [id],
    )
  )[0];
const attempts = async (id) =>
  sql('SELECT state, final_key FROM lab.material_upload_attempts WHERE material_id = $1', [id]);
const due = (id) =>
  sql('UPDATE lab.project_materials SET next_check_at = now() WHERE id = $1', [id]);
const reconcileOnce = async () => uploads.reconcile(new AbortController().signal);

console.warn('\n=== ЗАВЕРШЕНИЕ ЗАГРУЗОК МАТЕРИАЛОВ (W03) ===\n');

const owner = await registerFounder('owner');
const stranger = await registerFounder('stranger');
const taxonomy = await fetch(`${BASE}/v1/taxonomy`, { signal: AbortSignal.timeout(10_000) })
  .then((r) => r.json())
  .then((b) => b.items?.[0]?.id ?? null);
const created = await owner.client.call('/v1/projects', {
  method: 'POST',
  body: {
    title: `W03 загрузки ${Date.now() % 1e9}`,
    stage: 'mvp',
    taxonomyId: taxonomy,
    investmentAsk: '1000000.00',
    askCurrency: 'RUB',
  },
});
const projectId = created.json?.id;
check('проект создан', created.status === 201 && Boolean(projectId), `HTTP ${created.status}`);

const pdf = (label) => Buffer.from(`%PDF-1.4 W03 ${label} ${randomUUID()}`, 'utf8');
async function ticket(bytes, index) {
  const r = await owner.client.call(`/v1/projects/${projectId}/materials/upload`, {
    method: 'POST',
    body: {
      type: 'deck',
      fileName: `deck-${index}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: bytes.length,
    },
  });
  return r.json;
}
const finalize = (materialId, client = owner.client) =>
  client.call(`/v1/projects/${projectId}/materials/${materialId}/finalize`, { method: 'POST' });

try {
  // A. Обычная загрузка.
  console.warn('▸ A. Обычная загрузка');
  const bytesA = pdf('A');
  const a = await ticket(bytesA, 'A');
  check(
    'форма выдана на временный ключ',
    (await row(a.materialId))?.upload_key?.endsWith('/upload'),
  );
  check('объект положен формой', [200, 204].includes(await uploadByTicket(a, bytesA)));
  const doneA = await finalize(a.materialId);
  check(
    'подтверждение — «готово» с материалом',
    doneA.json?.uploadState === 'ready' && doneA.json?.material?.id === a.materialId,
    `HTTP ${doneA.status} ${doneA.json?.uploadState}`,
  );
  const rowA = await row(a.materialId);
  check(
    'готовый файл — копия по новому ключу, не ключ формы',
    rowA.s3_key && rowA.s3_key !== rowA.upload_key && rowA.s3_key.includes('/final/'),
  );
  check('хеш — SHA-256 фактических байтов', rowA.content_hash === sha(bytesA));
  const attemptsA = await attempts(a.materialId);
  check(
    'одна опубликованная попытка с этим ключом',
    attemptsA.filter((x) => x.state === 'published').length === 1 &&
      attemptsA.find((x) => x.state === 'published')?.final_key === rowA.s3_key,
  );

  // B. Повторная отправка старой формы.
  console.warn('▸ B. Повторная отправка формы после «готово»');
  const other = pdf('B-подмена');
  const resend = await uploadByTicket(a, other);
  check(
    'форма ещё действует и приняла другие байты',
    [200, 204].includes(resend),
    `HTTP ${resend}`,
  );
  const againA = await finalize(a.materialId);
  const rowA2 = await row(a.materialId);
  check(
    'готовый материал не изменился',
    againA.json?.uploadState === 'ready' &&
      rowA2.s3_key === rowA.s3_key &&
      rowA2.content_hash === rowA.content_hash,
  );
  const finalDigest = await s3.readObjectDigest(rowA.s3_key, { idleMs: 10_000, totalMs: 30_000 });
  check(
    'окончательный объект содержит исходные байты',
    `sha256:${finalDigest.sha256}` === sha(bytesA),
  );
  check('новой попытки не было', (await attempts(a.materialId)).length === attemptsA.length);

  // C. Неверный формат.
  console.warn('▸ C. Неверный формат');
  const html = Buffer.from('<html>не презентация</html>', 'utf8');
  const c = await ticket(html, 'C');
  await uploadByTicket(c, html);
  const doneC = await finalize(c.materialId);
  const rowC = await row(c.materialId);
  check(
    '«отклонено» с причиной для пользователя',
    doneC.json?.uploadState === 'rejected' && Boolean(doneC.json?.reason),
    doneC.json?.reason ?? '',
  );
  check(
    'не готов и без автоматических повторов',
    rowC.s3_key === null && rowC.next_check_at === null,
  );
  await reconcileOnce();
  check('сверка отклонённый не трогает', (await row(c.materialId)).upload_state === 'rejected');

  // D. Страница закрыта после передачи.
  console.warn('▸ D. Страница закрыта — завершает сверка');
  const bytesD = pdf('D');
  const d = await ticket(bytesD, 'D');
  await uploadByTicket(d, bytesD);
  await due(d.materialId);
  await reconcileOnce();
  let rowD = await row(d.materialId);
  for (let i = 0; i < 10 && rowD.upload_state !== 'ready'; i += 1) {
    await sleep(500);
    rowD = await row(d.materialId);
  }
  check('сверка завершила загрузку без браузера', rowD.upload_state === 'ready');
  check('хеш верный', rowD.content_hash === sha(bytesD));
  const [eventD] = await sql(
    `SELECT context_jsonb AS context FROM audit.events
      WHERE verb = 'lab.material.added' AND context_jsonb->>'materialId' = $1
        AND context_jsonb->>'finalized' = 'true'`,
    [d.materialId],
  );
  check(
    'событие: исполнитель — сверка, от имени автора',
    eventD?.context?.executor === 'reconcile' && eventD?.context?.onBehalfOf === owner.userId,
  );

  // E. Браузер и сверка одновременно.
  console.warn('▸ E. Браузер и сверка одновременно');
  const bytesE = pdf('E');
  const e = await ticket(bytesE, 'E');
  await uploadByTicket(e, bytesE);
  const [browserE, reconcileE] = await Promise.all([
    finalize(e.materialId),
    completion.complete(e.materialId, { executor: 'reconcile', actorId: null, traceId: 'w03-e' }),
  ]);
  let rowE = await row(e.materialId);
  for (let i = 0; i < 10 && rowE.upload_state !== 'ready'; i += 1) {
    await sleep(500);
    rowE = await row(e.materialId);
  }
  const attemptsE = await attempts(e.materialId);
  check(
    'один материал готов, одна публикация',
    rowE.upload_state === 'ready' && attemptsE.filter((x) => x.state === 'published').length === 1,
    `браузер ${browserE.json?.uploadState}${browserE.json?.uploadState === 'pending' ? '' : ''}, сверка ${reconcileE.state}${reconcileE.busy ? ' (занято)' : ''}`,
  );
  check(
    'проигравший не объявил успех ложно',
    (browserE.json?.uploadState === 'ready') !== reconcileE.busy ||
      browserE.json?.uploadState === 'ready' ||
      reconcileE.state === 'ready',
  );

  // F. Истёкший захват.
  console.warn('▸ F. Истёкший захват не подтверждает результат');
  const bytesF = pdf('F');
  const f = await ticket(bytesF, 'F');
  await uploadByTicket(f, bytesF);
  const asMaint = (work) => db.asServiceRole('app_maintenance', { traceId: 'w03-f' }, work);
  const [stale] = await asMaint((tx) =>
    claimLeases(tx, {
      table: 'lab.project_materials',
      where: `id = $1 AND upload_state = 'pending'`,
      params: [f.materialId],
      limit: 1,
      seconds: 1,
    }),
  );
  check('первый исполнитель взял захват', Boolean(stale));
  await sleep(1_300);
  const staleNoNew = await asMaint((tx) =>
    completeUnderLease(tx, {
      table: 'lab.project_materials',
      lease: stale,
      set: `last_error = 'устаревший исполнитель'`,
    }),
  );
  check('истёкший захват без нового — отказ', staleNoNew === false);
  const outcomeF = await completion.complete(f.materialId, {
    executor: 'reconcile',
    actorId: null,
    traceId: 'w03-f',
  });
  check('второй исполнитель завершил', outcomeF.state === 'ready');
  const staleAfter = await asMaint((tx) =>
    completeUnderLease(tx, {
      table: 'lab.project_materials',
      lease: stale,
      set: `last_error = 'устаревший исполнитель'`,
    }),
  );
  const renewStale = await asMaint((tx) =>
    renewLease(tx, { table: 'lab.project_materials', lease: stale, seconds: 30 }),
  );
  check('после нового захвата прежний не подтверждает и не продлевает', !staleAfter && !renewStale);

  // G. Остановка до и после CopyObject, потерянный ответ.
  console.warn('▸ G. Остановка до и после CopyObject');
  const bytesG = pdf('G');
  const g = await ticket(bytesG, 'G');
  await uploadByTicket(g, bytesG);
  const gRow = await row(g.materialId);
  const beforeCopyKey = `${gRow.upload_key.replace(/\/upload$/, '')}/final/crash-before-${randomUUID()}`;
  const afterCopyKey = `${gRow.upload_key.replace(/\/upload$/, '')}/final/crash-after-${randomUUID()}`;
  const [crash] = await asMaint((tx) =>
    claimLeases(tx, {
      table: 'lab.project_materials',
      where: `id = $1`,
      params: [g.materialId],
      limit: 1,
      seconds: 1,
    }),
  );
  // Упал после записи попытки, до копирования.
  await sql(
    `INSERT INTO lab.material_upload_attempts (id, material_id, final_key, lease_id)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), g.materialId, beforeCopyKey, crash.leaseId],
  );
  // Упал после копирования, до публикации.
  await s3.copyObject({
    sourceKey: gRow.upload_key,
    destinationKey: afterCopyKey,
    timeoutMs: 30_000,
  });
  await sql(
    `INSERT INTO lab.material_upload_attempts (id, material_id, final_key, lease_id, state)
     VALUES ($1, $2, $3, $4, 'copied')`,
    [randomUUID(), g.materialId, afterCopyKey, crash.leaseId],
  );
  await sleep(1_300);
  const countDeck = async () =>
    (
      await sql(
        `SELECT count(*)::int AS n FROM lab.project_materials WHERE project_id = $1 AND type = 'deck'`,
        [projectId],
      )
    )[0].n;
  const materialsBeforeG = await countDeck();
  const firstG = await finalize(g.materialId);
  const lostResponseRetry = await finalize(g.materialId);
  const attemptsG = await attempts(g.materialId);
  const rowG = await row(g.materialId);
  check(
    'повтор после сбоев — один готовый материал',
    firstG.json?.uploadState === 'ready' && rowG.upload_state === 'ready',
  );
  check(
    'опубликована одна новая попытка, прежние не стали итогом',
    attemptsG.filter((x) => x.state === 'published').length === 1 &&
      rowG.s3_key !== beforeCopyKey &&
      rowG.s3_key !== afterCopyKey,
  );
  check(
    'повторный ответ (потерянный первый) — тот же результат без новой попытки',
    lostResponseRetry.json?.uploadState === 'ready' &&
      (await attempts(g.materialId)).length === attemptsG.length,
  );
  const materialsG = await countDeck();
  check(
    'второй материал не создан',
    materialsG === materialsBeforeG,
    `материалов deck: было ${materialsBeforeG}, стало ${materialsG}`,
  );

  // H. «К сроку не получен», объект появился позже.
  console.warn('▸ H. Объект появился после срока формы');
  const bytesH = pdf('H');
  const h = await ticket(bytesH, 'H');
  await sql(
    `UPDATE lab.project_materials SET upload_expires_at = now() - interval '1 minute',
            next_check_at = now() WHERE id = $1`,
    [h.materialId],
  );
  const notYet = await completion.complete(h.materialId, {
    executor: 'reconcile',
    actorId: null,
    traceId: 'w03-h',
  });
  const rowH = await row(h.materialId);
  check(
    'отметка «к сроку не получен», не неудача',
    notYet.state === 'pending' && rowH.not_received_at !== null && rowH.upload_state === 'pending',
  );
  const hFinal = await finalize(h.materialId);
  check(
    'браузер видит «загрузка ещё не завершена»',
    hFinal.json?.uploadState === 'pending' && hFinal.json?.received === false,
  );
  await putObject({ key: rowH.upload_key, body: bytesH, contentType: 'application/pdf' });
  await due(h.materialId);
  const lateH = await completion.complete(h.materialId, {
    executor: 'reconcile',
    actorId: null,
    traceId: 'w03-h',
  });
  check('поздний объект завершён сверкой', lateH.state === 'ready');

  // I. Чужой идентификатор.
  console.warn('▸ I. Чужой идентификатор');
  const bytesI = pdf('I');
  const i = await ticket(bytesI, 'I');
  await uploadByTicket(i, bytesI);
  const foreign = await finalize(i.materialId, stranger.client);
  check(
    'чужой пользователь получает 403/404',
    [403, 404].includes(foreign.status),
    `HTTP ${foreign.status}`,
  );
  check('чужой вызов не завершил загрузку', (await row(i.materialId)).upload_state === 'pending');

  // L. Неизвестный результат и эскалация. Хранилище отвечает ОТКАЗОМ, а не
  // 404: на время вызова у ключа ядра снято право чтения бакета (admin API
  // Garage) — отсутствие файла этим не подтверждается. Прежний приём (ключ
  // длиннее предела S3) работал только на MinIO: Garage такой ключ не
  // отвергает, а честно отвечает «объекта нет».
  console.warn('▸ L. Неизвестный результат, повторы и «требует вмешательства»');
  const unknownCase = async (label, setup) => {
    const bytes = pdf(label);
    const t = await ticket(bytes, label);
    await sql(`UPDATE lab.project_materials SET next_check_at = now() ${setup} WHERE id = $1`, [
      t.materialId,
    ]);
    const bucket = process.env.S3_BUCKET;
    const appKey = process.env.S3_ACCESS_KEY_ID;
    await garageSetKeyPermissions(bucket, appKey, { read: true }, false);
    let outcome;
    try {
      outcome = await completion.complete(t.materialId, {
        executor: 'reconcile',
        actorId: null,
        traceId: `w03-${label}`,
      });
    } finally {
      await garageSetKeyPermissions(bucket, appKey, { read: true }, true);
    }
    return { outcome, row: await row(t.materialId), id: t.materialId };
  };
  const first = await unknownCase('L1', '');
  const [diag] = await sql(
    `SELECT last_error, unknown_since, next_check_at > now() + interval '50 seconds' AS later
       FROM lab.project_materials WHERE id = $1`,
    [first.id],
  );
  check(
    'неизвестный результат: состояние прежнее, диагностика и повтор назначены',
    first.outcome.state === 'pending' &&
      first.row.check_failures === 1 &&
      Boolean(diag.last_error) &&
      diag.unknown_since !== null &&
      diag.later === true,
    diag.last_error ?? '',
  );
  const tenth = await unknownCase('L2', ', check_failures = 9');
  check(
    'десятая неудача подряд — «требует вмешательства» с причиной',
    tenth.row.upload_state === 'needs_attention' && Boolean(tenth.row.upload_state_reason),
    tenth.row.upload_state_reason ?? '',
  );
  const long = await unknownCase('L3', `, unknown_since = now() - interval '25 hours'`);
  check(
    'неизвестность дольше 24 ч — «требует вмешательства»',
    long.row.upload_state === 'needs_attention',
  );
  {
    const bytes = pdf('L4');
    const t = await ticket(bytes, 'L4');
    await sql(
      `UPDATE lab.project_materials SET object_received_at = now() - interval '1 hour',
              next_check_at = now() WHERE id = $1`,
      [t.materialId],
    );
    const lostObject = await completion.complete(t.materialId, {
      executor: 'reconcile',
      actorId: null,
      traceId: 'w03-l4',
    });
    check(
      'пропал ранее полученный объект — «требует вмешательства»',
      lostObject.state === 'needs_attention',
      lostObject.reason ?? '',
    );
    const shown = await finalize(t.materialId);
    check(
      'пользователю — состояние без внутренней диагностики',
      shown.json?.uploadState === 'needs_attention' && shown.json?.reason === null,
    );
  }

  // M. Настоящий сигнал остановки на живых БД и хранилище (замечание Тэнка):
  // прерывание не записывается как неудача и не публикует после себя.
  console.warn('▸ M. Остановка во время выполнения');
  // Прерванная работа держит аренду до истечения срока; сдвигаем срок в
  // прошлое (имитация истечения) и доводим загрузку следующим исполнителем —
  // заодно это освобождает лимит активных передач для следующих сценариев.
  const finishAfterStop = async (materialId) => {
    await sql(
      `UPDATE lab.project_materials SET lease_until = now() - interval '1 second'
        WHERE id = $1 AND lease_id IS NOT NULL`,
      [materialId],
    );
    return completion.complete(materialId, {
      executor: 'reconcile',
      actorId: null,
      traceId: 'w03-m-next',
    });
  };
  {
    const bytes = pdf('M1');
    const t = await ticket(bytes, 'M1');
    await uploadByTicket(t, bytes);
    const stopped = new AbortController();
    stopped.abort(new Error('остановка'));
    const pre = await completion.complete(t.materialId, {
      executor: 'reconcile',
      actorId: null,
      traceId: 'w03-m1',
      signal: stopped.signal,
    });
    const r = await row(t.materialId);
    check(
      'заранее прерванный сигнал: ни захвата, ни записи неудачи',
      pre.state === 'pending' && r.lease_id === null && r.check_failures === 0,
    );
    check(
      'следующий исполнитель довёл загрузку',
      (await finishAfterStop(t.materialId)).state === 'ready',
    );
  }
  for (const delayMs of [0, 5, 20, 60]) {
    const bytes = pdf(`M2-${delayMs}`);
    const t = await ticket(bytes, `M2-${delayMs}`);
    await uploadByTicket(t, bytes);
    const stop = new AbortController();
    setTimeout(() => stop.abort(new Error('остановка')), delayMs);
    const outcome = await completion.complete(t.materialId, {
      executor: 'reconcile',
      actorId: null,
      traceId: `w03-m2-${delayMs}`,
      signal: stop.signal,
    });
    const r = await row(t.materialId);
    const [{ published }] = await sql(
      `SELECT count(*)::int AS published FROM lab.material_upload_attempts
        WHERE material_id = $1 AND state = 'published'`,
      [t.materialId],
    );
    check(
      `прерывание через ${delayMs} мс: неудача не записана, итог согласован`,
      r.check_failures === 0 &&
        r.unknown_since === undefined &&
        (outcome.state === 'ready') === (r.upload_state === 'ready') &&
        (r.upload_state === 'ready') === (published === 1),
      `исход ${outcome.state}, в БД ${r.upload_state}, публикаций ${published}`,
    );
    if (r.upload_state !== 'ready') {
      check(
        `после прерывания через ${delayMs} мс работу завершает следующий исполнитель`,
        (await finishAfterStop(t.materialId)).state === 'ready',
      );
    }
  }

  // J. Откат: SQL прежнего кода.
  console.warn('▸ J. Откат: прежнее создание, подтверждение и удаление');
  const pendingBefore = await sql(
    `SELECT id FROM lab.project_materials WHERE project_id = $1 AND upload_state = 'pending'`,
    [projectId],
  );
  const asBackend = async (work) => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [owner.userId]);
      await c.query(`SELECT set_config('app.current_roles', 'founder', true)`);
      return await work(c);
    } catch (error) {
      return error;
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  };
  const oldCreate = await asBackend((c) =>
    c.query(
      `INSERT INTO lab.project_materials (id, project_id, type, version, s3_key, uploaded_by)
       VALUES ($1, $2, 'deck', 900, 'old-style-key', $3)`,
      [randomUUID(), projectId, owner.userId],
    ),
  );
  check(
    'прежнее создание отвергнуто',
    oldCreate instanceof Error,
    oldCreate?.constraint ?? oldCreate?.message,
  );
  const oldConfirm = await asBackend((c) =>
    c.query(
      `UPDATE lab.project_materials
          SET uploaded_at = coalesce(uploaded_at, now()), size_bytes = 1, content_hash = 'sha256:x'
        WHERE id = $1 AND project_id = $2`,
      [i.materialId, projectId],
    ),
  );
  check(
    'прежнее подтверждение отвергнуто',
    oldConfirm instanceof Error,
    oldConfirm?.constraint ?? oldConfirm?.message,
  );
  const maint = new pg.Client({ connectionString: process.env.DATABASE_URL_APP_MAINTENANCE });
  await maint.connect();
  let oldDelete = null;
  try {
    await maint.query('BEGIN');
    await maint.query('SET LOCAL ROLE app_maintenance');
    await maint.query(
      `DELETE FROM lab.project_materials
        WHERE uploaded_at IS NULL AND created_at < now() + interval '1 day'`,
    );
  } catch (error) {
    oldDelete = error;
  } finally {
    await maint.query('ROLLBACK').catch(() => undefined);
  }
  check('прежнее удаление отвергнуто', oldDelete instanceof Error, oldDelete?.message);
  const pendingAfter = await sql(
    `SELECT id FROM lab.project_materials WHERE project_id = $1 AND upload_state = 'pending'`,
    [projectId],
  );
  check(
    'незавершённые загрузки целы',
    pendingAfter.length === pendingBefore.length && pendingBefore.length > 0,
    `было ${pendingBefore.length}, стало ${pendingAfter.length}`,
  );

  // K. Права и неизменность.
  console.warn('▸ K. Права роли обслуживания и неизменность готового файла');
  const denied = async (query) => {
    try {
      await maint.query('BEGIN');
      await maint.query('SET LOCAL ROLE app_maintenance');
      await maint.query(query.text, query.params ?? []);
      const ok = query.expectZero ? false : null;
      return ok;
    } catch {
      return true;
    } finally {
      await maint.query('ROLLBACK').catch(() => undefined);
    }
  };
  check('нет чтения проектов', await denied({ text: 'SELECT count(*) FROM lab.projects' }));
  check('нет чтения пользователей', await denied({ text: 'SELECT count(*) FROM identity.users' }));
  // Готовая строка политикой UPDATE не выбирается: изменение — 0 строк.
  await maint.query('BEGIN');
  await maint.query('SET LOCAL ROLE app_maintenance');
  const touched = await maint.query(
    `UPDATE lab.project_materials SET last_error = 'попытка' WHERE id = $1`,
    [a.materialId],
  );
  await maint.query('ROLLBACK');
  check('готовую строку роль обслуживания не меняет', touched.rowCount === 0);
  await maint.end();
  let immutable = false;
  try {
    await sql(`UPDATE lab.project_materials SET s3_key = 'подмена' WHERE id = $1`, [a.materialId]);
  } catch {
    immutable = true;
  }
  check('готовый файл неизменен даже для владельца БД', immutable);
} finally {
  if (projectId) {
    await sql(
      `DELETE FROM lab.material_upload_attempts
        WHERE material_id IN (SELECT id FROM lab.project_materials WHERE project_id = $1)`,
      [projectId],
    );
    await sql('DELETE FROM lab.project_materials WHERE project_id = $1', [projectId]);
    await sql('DELETE FROM lab.founders_projects WHERE project_id = $1', [projectId]);
    await sql('DELETE FROM lab.projects WHERE id = $1', [projectId]);
  }
  for (const user of [owner, stranger]) {
    if (user.userId) await sql('DELETE FROM identity.user_roles WHERE user_id = $1', [user.userId]);
  }
  await pool.end();
  await db.onModuleDestroy();
}

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exit(failed > 0 ? 1 : 0);
