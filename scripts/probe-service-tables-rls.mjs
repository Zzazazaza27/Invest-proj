#!/usr/bin/env node
/**
 * Матрица доступа к служебным таблицам после M166 (выпуск W13–W21).
 *
 *   FIFTH_ENTRY=web node scripts/probe-service-tables-rls.mjs
 *
 * Настоящая БД стенда. Роли — через `SET LOCAL ROLE` из подключения владельца, контекст —
 * теми же GUC, что ставит ядро (`app.current_user_id`, `app.current_roles`):
 *   * пользовательский контекст app_backend: наблюдения и очередь не читает, не меняет,
 *     прямой записи в очередь нет; постановка — только функцией, повтор не перезаписывает,
 *     откат исходной транзакции убирает письмо;
 *   * служебный контекст app_backend (`system`): читает и меняет обе таблицы;
 *   * app_readonly: читает обе таблицы, не меняет; функцию не вызывает;
 *   * функция: без PUBLIC, неизвестный источник — отказ;
 *   * сквозной путь: обращение в поддержку через HTTP ставит копию, отправщик ядра её
 *     принимает (MAIL_TRANSPORT=file); наблюдения доступности обновляются служебной задачей.
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_BASE_URL, CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of existsSync(join(ROOT, '.env'))
  ? readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
  : []) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq > 0) process.env[t.slice(0, eq).trim()] ??= t.slice(eq + 1).trim();
}

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else failed += 1;
  console.warn(`  ${condition ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
const owner = async (text, params = []) => (await pool.query(text, params)).rows;
const FN = 'comms.enqueue_service_mail($1, $2, $3, $4, $5, $6, $7)';
const RECIPIENT = `m166-${Date.now()}@test.local`;

/** Выполнить fn в транзакции под ролью и контекстом; commit=false — откатить. */
async function as(role, roles, fn, { commit = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [
      roles === 'system' ? '' : randomUUID(),
    ]);
    await client.query(`SELECT set_config('app.current_roles', $1, true)`, [roles]);
    const out = await fn(client);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    return { error: error.code ?? String(error.message) };
  } finally {
    client.release();
  }
}
/** Ожидаемый отказ — код ошибки, иначе null. */
const refused = async (role, roles, sql, params = []) => {
  const r = await as(role, roles, (c) => c.query(sql, params).then(() => ({ ok: true })));
  return r.error ?? null;
};
const enqueueArgs = (sourceId, body = 'проба M166') => [
  randomUUID(),
  'support.message.added',
  sourceId,
  RECIPIENT,
  'Проба M166',
  body,
  `<m166-${randomUUID()}@test.local>`,
];

console.warn('\n=== СЛУЖЕБНЫЕ ТАБЛИЦЫ ПОСЛЕ M166 ===\n');
const sources = [];
try {
  const [{ n: obsTotal }] = await owner('SELECT count(*)::int AS n FROM availability.observations');
  check('наблюдения есть (служебная задача ядра пишет)', obsTotal > 0, String(obsTotal));

  console.warn('[1] Постановка функцией в пользовательском контексте');
  const s1 = randomUUID();
  sources.push(s1);
  const put = await as(
    'app_backend',
    'founder',
    (c) => c.query(`SELECT ${FN} AS queued`, enqueueArgs(s1)).then((r) => r.rows[0].queued),
    { commit: true },
  );
  check('поставлено — true, содержимого в ответе нет', put === true, JSON.stringify(put));
  const again = await as(
    'app_backend',
    'founder',
    (c) =>
      c.query(`SELECT ${FN} AS queued`, enqueueArgs(s1, 'ПОДМЕНА')).then((r) => r.rows[0].queued),
    { commit: true },
  );
  const [row1] = await owner(
    'SELECT body, count(*) OVER ()::int AS n FROM comms.mail_queue WHERE source_type = $1 AND source_id = $2',
    ['support.message.added', s1],
  );
  check(
    'повтор того же события — false, письмо одно, содержимое прежнее',
    again === false && row1?.n === 1 && row1?.body === 'проба M166',
    `${JSON.stringify(again)} / ${row1?.body}`,
  );
  const s2 = randomUUID();
  sources.push(s2);
  const rolled = await as('app_backend', 'founder', async (c) => {
    await c.query(`SELECT ${FN}`, enqueueArgs(s2));
    return true;
  }); // commit=false: исходная транзакция откатывается
  const [{ n: afterRollback }] = await owner(
    'SELECT count(*)::int AS n FROM comms.mail_queue WHERE source_id = $1',
    [s2],
  );
  check('откат исходной транзакции убирает письмо', rolled === true && afterRollback === 0);
  const badSource = await refused('app_backend', 'founder', `SELECT ${FN}`, [
    randomUUID(),
    'evil.source',
    randomUUID(),
    RECIPIENT,
    'x',
    'x',
    `<m166-${randomUUID()}@test.local>`,
  ]);
  check('неизвестный источник — отказ 22023', badSource === '22023', String(badSource));

  console.warn('[2] Пользовательский контекст app_backend');
  const userSees = await as('app_backend', 'founder', async (c) => ({
    obs: (await c.query('SELECT count(*)::int AS n FROM availability.observations')).rows[0].n,
    queue: (await c.query('SELECT count(*)::int AS n FROM comms.mail_queue')).rows[0].n,
  }));
  check('не читает наблюдения', userSees.obs === 0, JSON.stringify(userSees));
  check('не читает очередь', userSees.queue === 0);
  const userUpd = await as('app_backend', 'founder', async (c) => ({
    obs: (await c.query('UPDATE availability.observations SET stopped = stopped')).rowCount,
    queue: (await c.query('UPDATE comms.mail_queue SET attempts = attempts')).rowCount,
  }));
  check(
    'не меняет ни одной строки',
    userUpd.obs === 0 && userUpd.queue === 0,
    JSON.stringify(userUpd),
  );
  check(
    'не вставляет наблюдение — 42501',
    (await refused(
      'app_backend',
      'founder',
      `INSERT INTO availability.observations (instance, group_id, mode, ok, reason, observed_at, valid_until)
       VALUES ('m166-probe', 'files', 'read', true, 'ok', now(), now())`,
    )) === '42501',
  );
  check(
    'прямой записи в очередь нет — 42501',
    (await refused(
      'app_backend',
      'founder',
      `INSERT INTO comms.mail_queue (id, source_type, source_id, recipient, subject, body, message_id)
       VALUES ($1, 'support.message.added', $2, $3, 'x', 'x', $4)`,
      [randomUUID(), randomUUID(), RECIPIENT, `<m166-${randomUUID()}@test.local>`],
    )) === '42501',
  );
  const anonSees = await as('app_backend', '', async (c) => ({
    queue: (await c.query('SELECT count(*)::int AS n FROM comms.mail_queue')).rows[0].n,
  }));
  check('анонимный контекст тоже не читает очередь', anonSees.queue === 0);

  console.warn('[3] Служебный контекст app_backend');
  const sys = await as('app_backend', 'system', async (c) => ({
    obs: (await c.query('SELECT count(*)::int AS n FROM availability.observations')).rows[0].n,
    queue: (
      await c.query('SELECT count(*)::int AS n FROM comms.mail_queue WHERE source_id = $1', [s1])
    ).rows[0].n,
    upd: (
      await c.query(
        'UPDATE comms.mail_queue SET next_attempt_at = next_attempt_at WHERE source_id = $1',
        [s1],
      )
    ).rowCount,
    obsUpd: (await c.query('UPDATE availability.observations SET stopped = stopped')).rowCount,
  }));
  check(
    'читает и меняет наблюдения и очередь',
    sys.obs === obsTotal && sys.queue === 1 && sys.upd === 1 && sys.obsUpd === obsTotal,
    JSON.stringify(sys),
  );
  check(
    'прямая запись в очередь и здесь закрыта — только функцией',
    (await refused(
      'app_backend',
      'system',
      `INSERT INTO comms.mail_queue (id, source_type, source_id, recipient, subject, body, message_id)
       VALUES ($1, 'support.message.added', $2, $3, 'x', 'x', $4)`,
      [randomUUID(), randomUUID(), RECIPIENT, `<m166-${randomUUID()}@test.local>`],
    )) === '42501',
  );

  console.warn('[4] app_readonly');
  const ro = await as('app_readonly', '', async (c) => ({
    obs: (await c.query('SELECT count(*)::int AS n FROM availability.observations')).rows[0].n,
    queue: (
      await c.query('SELECT count(*)::int AS n FROM comms.mail_queue WHERE source_id = $1', [s1])
    ).rows[0].n,
  }));
  check(
    'читает наблюдения и очередь (как до M166)',
    ro.obs === obsTotal && ro.queue === 1,
    JSON.stringify(ro),
  );
  check(
    'не меняет очередь — 42501',
    (await refused('app_readonly', '', 'UPDATE comms.mail_queue SET attempts = attempts')) ===
      '42501',
  );
  check(
    'не вызывает функцию — 42501',
    (await refused('app_readonly', '', `SELECT ${FN}`, enqueueArgs(randomUUID()))) === '42501',
  );
  const [priv] = await owner(
    `SELECT has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
            has_function_privilege('app_backend', p.oid, 'EXECUTE') AS backend,
            p.prosecdef AS definer, p.proconfig::text AS config
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'comms' AND p.proname = 'enqueue_service_mail'`,
  );
  check(
    'функция: без PUBLIC, EXECUTE у app_backend, SECURITY DEFINER, search_path закреплён',
    priv && !priv.pub && priv.backend && priv.definer && /search_path=/.test(priv.config ?? ''),
    JSON.stringify(priv),
  );

  console.warn('[5] Сквозной путь: HTTP → очередь → отправщик; наблюдения');
  const before = new Date();
  const reg = await fetch(`${API_BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(CORE_URL).origin },
    body: JSON.stringify({
      email: `m166-${Date.now()}@test.local`,
      password: `Pw-${randomUUID()}`,
      displayName: 'M166 проба',
      role: 'founder',
      locale: 'ru-RU',
      consents: ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
        kind,
        version: 'v1',
        locale: 'ru-RU',
      })),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const pairs = (reg.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]);
  const csrf = pairs
    .find((p) => /csrf/i.test(p.split('=')[0]))
    ?.split('=')
    .slice(1)
    .join('=');
  const ticket = await fetch(`${API_BASE_URL}/support/tickets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: new URL(CORE_URL).origin,
      Cookie: pairs.join('; '),
      'X-CSRF-Token': csrf ?? '',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({ kind: 'support', subject: 'Проба M166', body: 'Проба очереди M166' }),
    signal: AbortSignal.timeout(15_000),
  });
  const ticketId = (await ticket.json().catch(() => ({})))?.id;
  check(
    'обращение через HTTP принято',
    ticket.status < 300 && Boolean(ticketId),
    `HTTP ${ticket.status}`,
  );
  if (ticketId) sources.push(ticketId);
  let state = null;
  for (let i = 0; i < 40 && state !== 'accepted'; i += 1) {
    const [r] = await owner(
      `SELECT state FROM comms.mail_queue WHERE source_type = 'support.ticket.opened' AND source_id = $1`,
      [ticketId],
    );
    state = r?.state ?? null;
    if (state !== 'accepted') await sleep(1_000);
  }
  check(
    'копия поставлена в транзакции обращения и принята отправщиком',
    state === 'accepted',
    String(state),
  );
  // Интервал служебной задачи — AVAILABILITY_PROBE_INTERVAL_MS (по умолчанию 30 с).
  let fresh = 0;
  for (let i = 0; i < 45 && fresh === 0; i += 1) {
    [{ fresh }] = await owner(
      'SELECT count(*)::int AS fresh FROM availability.observations WHERE observed_at >= $1',
      [before],
    );
    if (fresh === 0) await sleep(1_000);
  }
  check('служебная задача по-прежнему обновляет наблюдения', fresh > 0, String(fresh));
} finally {
  await owner('DELETE FROM comms.mail_queue WHERE recipient = $1', [RECIPIENT]).catch(
    () => undefined,
  );
  await pool.end();
}

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===`);
process.exit(failed === 0 ? 0 : 1);
