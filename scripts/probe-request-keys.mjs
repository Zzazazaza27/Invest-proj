#!/usr/bin/env node
/**
 * Ключи повтора изменяющих операций (блок 2, 2.6, первый пакет; M159).
 *
 *   node scripts/probe-request-keys.mjs
 *
 * Узкие сценарии на запущенном ядре со своими участниками:
 *   * потерянный ответ: повтор с тем же ключом даёт прежний результат, второго объекта нет —
 *     создание проекта, ссылка-материал, обращение, сообщение в обращении;
 *   * тот же ключ с другим содержимым или другим объектом — конфликт без изменения;
 *   * два одновременных запроса с одним ключом — одно изменение;
 *   * отзыв прав перед повтором — прежний результат не выдаётся;
 *   * ошибка с откатом транзакции не оставляет ключа: тот же ключ потом работает;
 *   * просроченный ключ — явный отказ, новой работы нет;
 *   * письмо в ящик поддержки при повторе второй раз не уходит.
 * Убирает за собой проекты, обращения и ключи; учётки и записи аудита остаются, как у
 * остальных проб.
 */
import pg from 'pg';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const MAIL_DIR = join(ROOT, process.env.MAIL_OUTBOX_DIR ?? 'var/mail');

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else failed += 1;
  console.warn(`  ${condition ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;
const newKey = () => randomBytes(18).toString('base64url');

function blindIndex(email) {
  return createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
}

function makeClient() {
  const state = { session: null, csrf: null };
  return {
    async call(path, { method = 'GET', body, key } = {}) {
      const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (key) headers['Idempotency-Key'] = key;
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

const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

async function registerFounder(label) {
  const email = `rk-${label}-${Date.now() % 1e9}@test.local`;
  const client = makeClient();
  await client.call('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password: `Pw-${randomUUID()}`,
      displayName: `RK ${label}`,
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

const mailCount = () => (existsSync(MAIL_DIR) ? readdirSync(MAIL_DIR).length : 0);

console.warn('\n=== КЛЮЧИ ПОВТОРА (2.6, первый пакет) ===\n');
const owner = await registerFounder('owner');
const other = await registerFounder('other');
check('участники заведены', Boolean(owner.userId && other.userId));
const taxonomy = await fetch(`${BASE}/v1/taxonomy`, { signal: AbortSignal.timeout(10_000) })
  .then((r) => r.json())
  .then((j) => (j.items ?? j)[0]?.id);
const title = `RK проект ${Date.now() % 1e9}`;
const projectBody = {
  title,
  stage: 'mvp',
  taxonomyId: taxonomy,
  investmentAsk: '1000000.00',
  askCurrency: 'RUB',
};
const projectIds = new Set();
const ticketIds = new Set();

try {
  console.warn('[1] Создание проекта');
  const k1 = newKey();
  const first = await owner.client.call('/v1/projects', {
    method: 'POST',
    body: projectBody,
    key: k1,
  });
  projectIds.add(first.json?.id);
  check('создан', first.status === 201 && Boolean(first.json?.id), `HTTP ${first.status}`);
  // Ответ «потерян»: клиент повторяет с тем же ключом.
  const again = await owner.client.call('/v1/projects', {
    method: 'POST',
    body: projectBody,
    key: k1,
  });
  check(
    'повтор с тем же ключом — тот же проект',
    again.json?.id === first.json?.id,
    `HTTP ${again.status}`,
  );
  const [{ n }] = await sql('SELECT count(*)::int AS n FROM lab.projects WHERE title = $1', [
    title,
  ]);
  check('второго проекта нет', n === 1, `проектов ${n}`);
  const changed = await owner.client.call('/v1/projects', {
    method: 'POST',
    body: { ...projectBody, title: `${title} другое` },
    key: k1,
  });
  check(
    'тот же ключ, другое содержимое — конфликт',
    changed.json?.code === 'idempotency_key_reused',
    `HTTP ${changed.status} ${changed.json?.code}`,
  );
  const [{ m }] = await sql('SELECT count(*)::int AS m FROM lab.projects WHERE title LIKE $1', [
    `${title}%`,
  ]);
  check('конфликт ничего не создал', m === 1);
  const foreign = await other.client.call('/v1/projects', {
    method: 'POST',
    body: projectBody,
    key: k1,
  });
  if (foreign.json?.id) projectIds.add(foreign.json.id);
  check(
    'тот же ключ у другого участника — его собственная работа, не чужой результат',
    foreign.status === 201 && foreign.json?.id !== first.json?.id,
    `HTTP ${foreign.status}`,
  );

  console.warn('[2a] Первая транзакция ещё не завершилась');
  {
    // Ключ занят незавершённой транзакцией дольше, чем второй запрос ждёт блокировку.
    const k = newKey();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `INSERT INTO requests.idempotency_keys
           (actor_id, operation, key, object_id, request_hash, result_id, expires_at)
         VALUES ($1, 'lab.project.create', $2, NULL, $3, $4, now() + interval '7 days')`,
        [owner.userId, k, randomBytes(32), randomUUID()],
      );
      const busy = await owner.client.call('/v1/projects', {
        method: 'POST',
        body: projectBody,
        key: k,
      });
      check(
        'ответ «выполняется», без второй работы',
        busy.json?.code === 'operation_in_progress',
        `HTTP ${busy.status} ${busy.json?.code}`,
      );
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    const freed = await owner.client.call('/v1/projects', {
      method: 'POST',
      body: { ...projectBody, title: `${title} после отката` },
      key: k,
    });
    if (freed.json?.id) projectIds.add(freed.json.id);
    check(
      'после отката первой транзакции ключ не заблокирован навсегда',
      freed.status === 201,
      `HTTP ${freed.status}`,
    );
  }

  console.warn('[2] Одновременные запросы с одним ключом');
  const k2 = newKey();
  const raceTitle = `${title} гонка`;
  const race = await Promise.all(
    [0, 1, 2].map(() =>
      owner.client.call('/v1/projects', {
        method: 'POST',
        body: { ...projectBody, title: raceTitle },
        key: k2,
      }),
    ),
  );
  for (const r of race) if (r.json?.id) projectIds.add(r.json.id);
  const [{ r: raced }] = await sql('SELECT count(*)::int AS r FROM lab.projects WHERE title = $1', [
    raceTitle,
  ]);
  check(
    'три одновременных запроса — один проект',
    raced === 1,
    `проектов ${raced}, ответы ${race.map((x) => x.status).join('/')}`,
  );
  check(
    'каждый ответ — тот же проект или «выполняется»',
    race.every(
      (x) =>
        (x.status === 201 && x.json?.id === race.find((y) => y.json?.id)?.json?.id) ||
        x.json?.code === 'operation_in_progress',
    ),
  );

  console.warn('[3] Отзыв прав перед повтором');
  await sql('DELETE FROM lab.founders_projects WHERE project_id = $1 AND user_id = $2', [
    first.json?.id,
    owner.userId,
  ]);
  const revoked = await owner.client.call('/v1/projects', {
    method: 'POST',
    body: projectBody,
    key: k1,
  });
  check(
    'после отзыва прежний результат не выдан',
    revoked.status === 404 && !revoked.json?.id,
    `HTTP ${revoked.status}`,
  );
  await sql(
    "INSERT INTO lab.founders_projects (project_id, user_id, role) VALUES ($1, $2, 'owner')",
    [first.json?.id, owner.userId],
  );

  console.warn('[4] Ссылка-материал');
  const projectId = first.json?.id;
  const k3 = newKey();
  const link = { url: `https://example.com/rk-${Date.now()}` };
  const l1 = await owner.client.call(`/v1/projects/${projectId}/materials/link`, {
    method: 'POST',
    body: link,
    key: k3,
  });
  const l2 = await owner.client.call(`/v1/projects/${projectId}/materials/link`, {
    method: 'POST',
    body: link,
    key: k3,
  });
  check(
    'повтор ссылки — тот же материал',
    l1.json?.id && l2.json?.id === l1.json?.id,
    `HTTP ${l1.status}/${l2.status}`,
  );
  const [{ c }] = await sql(
    'SELECT count(*)::int AS c FROM lab.project_materials WHERE project_id = $1 AND url = $2',
    [projectId, link.url],
  );
  check('материал один', c === 1, `материалов ${c}`);
  const otherProject = foreign.json?.id;
  const crossed = await owner.client.call(`/v1/projects/${otherProject}/materials/link`, {
    method: 'POST',
    body: link,
    key: k3,
  });
  check(
    'тот же ключ для другого проекта — не прежний результат',
    crossed.status === 409 && crossed.json?.code === 'idempotency_key_reused',
    `HTTP ${crossed.status} ${crossed.json?.code}`,
  );

  console.warn('[5] Ошибка с откатом не оставляет ключа');
  const k4 = newKey();
  const denied = await owner.client.call(`/v1/projects/${otherProject}/materials/link`, {
    method: 'POST',
    body: link,
    key: k4,
  });
  check('чужой проект — отказ', denied.status === 404, `HTTP ${denied.status}`);
  const [{ left }] = await sql(
    'SELECT count(*)::int AS left FROM requests.idempotency_keys WHERE key = $1',
    [k4],
  );
  check('после отката строки ключа нет', left === 0);
  const after = await owner.client.call(`/v1/projects/${otherProject}/materials/link`, {
    method: 'POST',
    body: link,
    key: k4,
  });
  check(
    'тот же ключ после отката не «занят»: снова обычный отказ, а не «выполняется»',
    after.status === 404,
    `HTTP ${after.status} ${after.json?.code}`,
  );

  console.warn('[6] Обращение и сообщение');
  const k5 = newKey();
  const ticketBody = {
    kind: 'support',
    subject: `RK ${Date.now() % 1e9}`,
    body: 'Проверка ключа повтора',
  };
  const mailBefore = mailCount();
  const t1 = await owner.client.call('/v1/support/tickets', {
    method: 'POST',
    body: ticketBody,
    key: k5,
  });
  ticketIds.add(t1.json?.id);
  const mailAfterFirst = mailCount();
  const t2 = await owner.client.call('/v1/support/tickets', {
    method: 'POST',
    body: ticketBody,
    key: k5,
  });
  check(
    'повтор обращения — то же обращение',
    t1.json?.id && t2.json?.id === t1.json?.id,
    `HTTP ${t1.status}/${t2.status}`,
  );
  check(
    'письмо в ящик поддержки при повторе не ушло второй раз',
    mailCount() === mailAfterFirst,
    `писем было ${mailBefore}, стало ${mailAfterFirst} → ${mailCount()}`,
  );
  const k6 = newKey();
  const msg = { body: 'Сообщение с ключом' };
  const m1 = await owner.client.call(`/v1/support/tickets/${t1.json?.id}/messages`, {
    method: 'POST',
    body: msg,
    key: k6,
  });
  const m2 = await owner.client.call(`/v1/support/tickets/${t1.json?.id}/messages`, {
    method: 'POST',
    body: msg,
    key: k6,
  });
  check(
    'повтор сообщения — то же сообщение',
    m1.json?.id && m2.json?.id === m1.json?.id,
    `HTTP ${m1.status}/${m2.status}`,
  );
  const [{ mc }] = await sql(
    'SELECT count(*)::int AS mc FROM comms.support_messages WHERE ticket_id = $1 AND body = $2',
    [t1.json?.id, msg.body],
  );
  check('сообщение одно', mc === 1, `сообщений ${mc}`);

  console.warn('[7] Окно повтора истекло');
  await sql(
    "UPDATE requests.idempotency_keys SET expires_at = now() - interval '1 second' WHERE key = $1",
    [k6],
  );
  const late = await owner.client.call(`/v1/support/tickets/${t1.json?.id}/messages`, {
    method: 'POST',
    body: msg,
    key: k6,
  });
  check(
    'просроченный ключ — явный отказ',
    late.json?.code === 'idempotency_key_expired',
    `HTTP ${late.status} ${late.json?.code}`,
  );
  const [{ mc2 }] = await sql(
    'SELECT count(*)::int AS mc2 FROM comms.support_messages WHERE ticket_id = $1 AND body = $2',
    [t1.json?.id, msg.body],
  );
  check('новой работы нет', mc2 === 1);

  console.warn('[8] Неверный ключ');
  const bad = await owner.client.call('/v1/projects', {
    method: 'POST',
    body: projectBody,
    key: 'short',
  });
  check(
    'неверный ключ — отказ, а не молчаливая работа без защиты',
    bad.status === 400,
    `HTTP ${bad.status}`,
  );

  console.warn('[9] Исход по ключу без повтора работы');
  {
    const state = (who, op, k) => who.client.call(`/v1/me/requests/${op}/${k}`);
    const done = await state(owner, 'lab.project.create', k1);
    check(
      'выполненная — «done» и тот же проект',
      done.json?.state === 'done' && done.json?.resultId === first.json?.id,
      `HTTP ${done.status} ${JSON.stringify(done.json)}`,
    );
    const never = newKey();
    const absent = await state(owner, 'lab.project.create', never);
    check(
      'неизвестный ключ — «не дошла»',
      absent.json?.state === 'absent',
      `HTTP ${absent.status}`,
    );
    const [{ left: probeLeft }] = await sql(
      'SELECT count(*)::int AS left FROM requests.idempotency_keys WHERE key = $1',
      [never],
    );
    check('проверка ничего не записала', probeLeft === 0);
    const foreignState = await state(other, 'lab.project.create', k1);
    check(
      'чужой ключ — «не дошла», без чужого результата',
      foreignState.json?.state === 'absent' || foreignState.json?.resultId !== first.json?.id,
      JSON.stringify(foreignState.json),
    );
    const k = newKey();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `INSERT INTO requests.idempotency_keys
           (actor_id, operation, key, object_id, request_hash, result_id, expires_at)
         VALUES ($1, 'lab.project.create', $2, NULL, $3, $4, now() + interval '7 days')`,
        [owner.userId, k, randomBytes(32), randomUUID()],
      );
      const busy = await state(owner, 'lab.project.create', k);
      check(
        'идущая — «выполняется»',
        busy.json?.code === 'operation_in_progress',
        `HTTP ${busy.status} ${busy.json?.code}`,
      );
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    const wrongOp = await state(owner, 'billing.pay', k1);
    check('чужая операция — отказ', wrongOp.status === 400, `HTTP ${wrongOp.status}`);
  }
} finally {
  const users = [owner.userId, other.userId].filter(Boolean);
  for (const id of projectIds) {
    if (!id) continue;
    await sql('DELETE FROM lab.project_materials WHERE project_id = $1', [id]);
    await sql('DELETE FROM lab.founders_projects WHERE project_id = $1', [id]);
    await sql('DELETE FROM lab.projects WHERE id = $1', [id]);
  }
  for (const id of ticketIds) {
    if (!id) continue;
    await sql('DELETE FROM comms.support_messages WHERE ticket_id = $1', [id]);
    await sql('DELETE FROM comms.support_tickets WHERE id = $1', [id]);
  }
  await sql('DELETE FROM requests.idempotency_keys WHERE actor_id = ANY($1::uuid[])', [users]);
  await pool.end();
}

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exit(failed > 0 ? 1 : 0);
