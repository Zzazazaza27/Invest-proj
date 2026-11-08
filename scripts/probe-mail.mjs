#!/usr/bin/env node
/**
 * Группа функций «Почта» на стенде (блок 4, 4.11; пакет 4 раздела 01).
 *
 *   node scripts/probe-mail.mjs
 *
 * Проба поднимает поддельный SMTP-релей на петле и перезапускает ядро стенда с отправкой на
 * него (MAIL_TRANSPORT=smtp, plain на 127.0.0.1). В конце ядро возвращается к обычной
 * настройке стенда (`stand:up --no-build --restart-core`). Режимы релея:
 *   accept — 250 после DATA («принято релеем»);
 *   temp   — вход проходит, MAIL FROM получает 421 («точно не ушло», по вине канала);
 *   drop   — текст принят, соединение рвётся без ответа («неизвестно»);
 *   hold   — текст принят, 250 через 3 с (окно, в которое проба останавливает ядро);
 *   down   — соединение рвётся сразу (проверка транспорта не проходит).
 *
 * Сценарии:
 *   1. «Забыли пароль»: для существующего и отсутствующего адреса одинаковы код и тело ответа
 *      при всех трёх исходах SMTP, при повторе тем же ключом, при чужом ключе и при закрытой
 *      группе; повтор тем же ключом второго письма не отправляет;
 *   2. релей принял письмо, ядро остановлено до записи исхода: повтор тем же ключом после
 *      перезапуска письма не отправляет; по истечении срока отметка — «неизвестно»;
 *   3. обращение принято при недоступной почте; копия ждёт без расхода попыток и уходит
 *      один раз после восстановления и перезапуска;
 *   4. неизвестный исход копии — один повтор с прежним Message-ID, затем окончательно;
 *      перезапуск третьей отправки не даёт;
 *   5. остановка ядра во время отправки копии считается неизвестным исходом в БД;
 *   6. уведомление о регистрации — в очереди и уходит;
 *   7. повтор обращения тем же ключом второй копии не ставит.
 */
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { hostname } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL } from './lib/ports.mjs';
import { portOwner, stopTree } from './lib/stand-processes.mjs';

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
const CORE_PORT = Number(new URL(BASE).port || 4300);
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'ul_csrf';
const INBOX = `inbox-probe-${Date.now() % 1e6}@fifth.local`;

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

// ------------------------------------------------------------ поддельный релей
const relay = { mode: 'accept', messages: [] };
const server = createServer((socket) => {
  if (relay.mode === 'down') {
    socket.destroy();
    return;
  }
  const mode = relay.mode;
  let inData = false;
  let buf = '';
  let to = null;
  let data = [];
  socket.on('error', () => undefined);
  socket.write('220 probe ESMTP\r\n');
  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (inData) {
        if (line !== '.') {
          data.push(line);
          continue;
        }
        inData = false;
        const header = data.find((l) => /^Message-ID:/i.test(l)) ?? '';
        relay.messages.push({
          to,
          messageId: header.replace(/^Message-ID:\s*<?/i, '').replace(/>$/, ''),
          at: Date.now(),
        });
        data = [];
        if (mode === 'drop') socket.destroy();
        else if (mode === 'hold') setTimeout(() => socket.write('250 queued\r\n'), 3000);
        else socket.write('250 queued\r\n');
        continue;
      }
      const cmd = line.split(' ')[0].toUpperCase();
      if (cmd === 'EHLO') socket.write('250-probe\r\n250 8BITMIME\r\n');
      else if (cmd === 'MAIL') socket.write(mode === 'temp' ? '421 try later\r\n' : '250 ok\r\n');
      else if (cmd === 'RCPT') {
        to = line.replace(/^RCPT TO:<|>$/gi, '').toLowerCase();
        socket.write('250 ok\r\n');
      } else if (cmd === 'DATA') {
        inData = true;
        socket.write('354 go\r\n');
      } else if (cmd === 'QUIT') socket.end('221 bye\r\n');
      else socket.write('250 ok\r\n');
    }
  });
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const RELAY_PORT = server.address().port;
const to = (address) => relay.messages.filter((m) => m.to === address.toLowerCase());
const withId = (id) => relay.messages.filter((m) => m.messageId === id);

// ---------------------------------------------------------------- ядро стенда
const CORE_ENV = {
  MAIL_TRANSPORT: 'smtp',
  MAIL_SMTP_HOST: '127.0.0.1',
  MAIL_SMTP_PORT: String(RELAY_PORT),
  MAIL_SMTP_SECURITY: 'plain',
  MAIL_SMTP_USER: '',
  MAIL_SMTP_PASSWORD: '',
  MAIL_SMTP_TIMEOUT_MS: '2000',
  MAIL_QUEUE_POLL_MS: '1000',
  AVAILABILITY_PROBE_INTERVAL_MS: '2000',
  AVAILABILITY_FRESH_MS: '6000',
  SUPPORT_INBOX_EMAIL: INBOX,
  NOTIFY_INBOX_ON_REGISTRATION: 'true',
};
function stopCore() {
  const pid = portOwner(CORE_PORT);
  if (pid) stopTree(pid);
}
async function startCore() {
  stopCore();
  await sleep(800);
  spawnSync(process.execPath, [join(ROOT, 'scripts/dev-core.mjs'), '--detached'], {
    cwd: ROOT,
    env: { ...process.env, ...CORE_ENV },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i += 1) {
    const ok = await fetch(`${BASE}/v1/health`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) {
      await retireDeadInstances();
      return;
    }
    await sleep(1000);
  }
  throw new Error('ядро не поднялось');
}

/**
 * Обстановка: экземпляры, снятые пробой без штатной остановки, не отмечены остановленными, и
 * их последнее «исправно» живёт до конца окна актуальности (предел обнаружения, принят).
 * Отмечаем только доказанно остановленные: экземпляр этой машины, процесса которого нет.
 */
async function retireDeadInstances() {
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === 'EPERM';
    }
  };
  const rows = await sql(
    'SELECT DISTINCT instance FROM availability.observations WHERE NOT stopped',
  );
  const gone = rows
    .map((r) => r.instance)
    .filter((instance) => {
      const m = instance.match(/^(.*)-(\d+)-[0-9a-f]{8}$/);
      return m && m[1] === hostname() && !alive(Number(m[2]));
    });
  if (gone.length > 0) {
    await sql('UPDATE availability.observations SET stopped = true WHERE instance = ANY($1)', [
      gone,
    ]);
  }
}

/** Локальное решение ядра по «Почте» (/ready) — от него зависят запросы. */
const INTERNAL = `http://127.0.0.1:${process.env.CORE_INTERNAL_PORT ?? 4400}`;
const localMail = async () =>
  (
    await fetch(`${INTERNAL}/ready`)
      .then((r) => r.json())
      .catch(() => null)
  )?.groups?.mail;

// ------------------------------------------------------------------ клиенты
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
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // не JSON
      }
      return { status: r.status, json };
    },
  };
}
const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));
const created = { users: [], dispatchKeys: [] };
async function register(label) {
  const email = `mail-${label}-${Date.now() % 1e9}@test.local`;
  const client = makeClient();
  const r = await client.call('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password: `Pw-${randomUUID()}`,
      displayName: `MAIL ${label}`,
      role: 'founder',
      locale: 'ru-RU',
      consents: CONSENTS,
    },
  });
  const userId = r.json?.userId ?? null;
  created.users.push(userId);
  return { client, email, userId };
}
const anon = makeClient();
const key = () => randomUUID().replaceAll('-', '');
async function forgot(email, k) {
  created.dispatchKeys.push(k);
  return anon.call('/v1/auth/password/forgot', { method: 'POST', body: { email }, key: k });
}
/** Ответ без сквозного идентификатора запроса: он разный у любых двух запросов. */
const shape = (r) => {
  const body = r.json && typeof r.json === 'object' ? { ...r.json } : r.json;
  if (body && typeof body === 'object') {
    delete body.traceId;
    delete body.instance;
  }
  return JSON.stringify({ status: r.status, body });
};
const dispatchRow = async (k) =>
  (
    await sql(
      `SELECT state FROM comms.mail_dispatches WHERE purpose = 'password_reset' AND key_hash = $1`,
      [createHash('sha256').update(`mail-dispatch:password_reset:${k}`).digest()],
    )
  )[0];
const queueRow = async (source, id) =>
  (
    await sql(
      `SELECT state, attempts, unknown_count, message_id, body FROM comms.mail_queue
        WHERE source_type = $1 AND source_id = $2`,
      [source, id],
    )
  )[0];
async function waitFor(fn, ms = 20_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  return fn();
}
const mailState = async () => (await anon.call('/v1/features')).json?.groups?.mail;
async function openTicket(user, subject, k) {
  return user.client.call('/v1/support/tickets', {
    method: 'POST',
    body: { kind: 'support', subject, body: `Проба почты: ${subject}` },
    key: k,
  });
}

console.warn('\n=== ГРУППА «ПОЧТА» (4.11) ===\n');
const tickets = [];
try {
  await startCore();
  const ready = await waitFor(async () => (await mailState())?.state === 'available');
  check('группа «Почта» доступна при исправном релее', ready);

  console.warn('[1] «Забыли пароль»: одинаково для существующего и отсутствующего адреса');
  const u1 = await register('u1');
  const nobody = `nobody-${Date.now() % 1e9}@test.local`;
  const expect = { accept: 1, temp: 0, drop: 1 };
  for (const mode of ['accept', 'temp', 'drop']) {
    relay.mode = mode;
    const before = to(u1.email).length;
    const kE = key();
    const kN = key();
    const rE = await forgot(u1.email, kE);
    const rN = await forgot(nobody, kN);
    check(`${mode}: код и тело одинаковы`, shape(rE) === shape(rN), `${shape(rE)} / ${shape(rN)}`);
    await sleep(2500);
    const again = [await forgot(u1.email, kE), await forgot(nobody, kN)];
    check(
      `${mode}: повтор тем же ключом — тот же ответ`,
      again.every((r) => shape(r) === shape(rE)),
    );
    await sleep(2500);
    const got = to(u1.email).length - before;
    check(
      `${mode}: писем принято релеем — ${expect[mode]}, повтор второго не отправил`,
      got === expect[mode],
      `получено ${got}`,
    );
  }
  check('отсутствующему адресу писем нет', to(nobody).length === 0);
  relay.mode = 'accept';
  const kReuse = key();
  const kReuse2 = key();
  await forgot(u1.email, kReuse);
  await forgot(nobody, kReuse2);
  const reE = await forgot(`other-${u1.email}`, kReuse);
  const reN = await forgot(`other-${nobody}`, kReuse2);
  check(
    'тот же ключ для другого адреса — одинаковый отказ',
    shape(reE) === shape(reN) && reE.status === 409,
    shape(reE),
  );
  relay.mode = 'down';
  const closed = await waitFor(
    async () =>
      (await localMail()) !== 'available' && (await mailState())?.write?.allowed === false,
  );
  check('релей недоступен — отправка закрыта в /v1/features', Boolean(closed));
  const gE = await forgot(u1.email, key());
  const gN = await forgot(nobody, key());
  check(
    'закрытая группа — одинаковый group_unavailable для обоих адресов',
    shape(gE) === shape(gN) && gE.json?.code === 'group_unavailable',
    shape(gE),
  );

  check(
    'текст отказа — про письма, причина — код',
    gE.json?.detail === 'Отправка писем сейчас недоступна' &&
      gE.json?.errors?.[0]?.path === 'mail.write',
    gE.json?.detail,
  );
  console.warn('[2] Релей принял письмо, ядро остановлено до записи исхода');
  relay.mode = 'accept';
  await waitFor(async () => (await localMail()) === 'available');
  const u2 = await register('u2');
  relay.mode = 'hold';
  const kCrash = key();
  // При регистрации уходит письмо подтверждения адреса — счёт ведётся от него.
  const base2 = to(u2.email).length;
  await forgot(u2.email, kCrash);
  const held = await waitFor(async () => to(u2.email).length === base2 + 1, 10_000);
  stopCore();
  check('релей получил письмо, ядро остановлено до ответа 250', held);
  check('отметка начала устойчива: «started»', (await dispatchRow(kCrash))?.state === 'started');
  relay.mode = 'accept';
  await startCore();
  await waitFor(async () => (await localMail()) === 'available');
  const r2 = await forgot(u2.email, kCrash);
  await sleep(3000);
  check(
    'повтор тем же ключом после перезапуска — 202, письма заново нет',
    r2.status === 202 && to(u2.email).length === base2 + 1,
    `писем ${to(u2.email).length - base2}`,
  );
  await sql(
    `UPDATE comms.mail_dispatches SET started_until = now() - interval '1 second'
      WHERE key_hash = $1 AND state = 'started'`,
    [createHash('sha256').update(`mail-dispatch:password_reset:${kCrash}`).digest()],
  );
  await forgot(u2.email, kCrash);
  await sleep(2000);
  check(
    'после срока незавершённая отправка — «неизвестно», письма нет',
    (await dispatchRow(kCrash))?.state === 'unknown' && to(u2.email).length === base2 + 1,
  );

  console.warn('[3] Обращение при недоступной почте, восстановление после перезапуска');
  const u3 = await register('u3');
  await waitFor(
    async () => (await queueRow('identity.user.registered', u3.userId))?.state === 'accepted',
  );
  relay.mode = 'down';
  await waitFor(async () => (await localMail()) !== 'available');
  const t1 = await openTicket(u3, 'при недоступной почте');
  tickets.push(t1.json?.id);
  check(
    'обращение принято при недоступной почте',
    t1.status === 201 && Boolean(t1.json?.id),
    `HTTP ${t1.status}`,
  );
  await sleep(6000);
  const q1 = await queueRow('support.ticket.opened', t1.json?.id);
  check(
    'копия ждёт: попытки не расходуются',
    q1?.state === 'pending' && q1.attempts === 0 && q1.unknown_count === 0,
    JSON.stringify(q1 && { s: q1.state, a: q1.attempts, u: q1.unknown_count }),
  );
  relay.mode = 'accept';
  await startCore();
  const q1done = await waitFor(
    async () => (await queueRow('support.ticket.opened', t1.json?.id))?.state === 'accepted',
  );
  const q1row = await queueRow('support.ticket.opened', t1.json?.id);
  check(
    'после восстановления и перезапуска копия ушла один раз',
    Boolean(q1done) && withId(q1row.message_id).length === 1,
    `копий ${withId(q1row?.message_id).length}`,
  );
  check('текст копии после «принято релеем» не хранится', q1row?.body === '');

  console.warn('[4] Неизвестный исход копии: один повтор с прежним Message-ID');
  relay.mode = 'drop';
  const t2 = await openTicket(u3, 'неизвестный исход');
  tickets.push(t2.json?.id);
  const q2a = await waitFor(async () => {
    const row = await queueRow('support.ticket.opened', t2.json?.id);
    return row?.unknown_count === 1 ? row : null;
  });
  check(
    'первый неизвестный исход — повтор разрешён',
    q2a?.state === 'pending',
    JSON.stringify(q2a && { s: q2a.state, u: q2a.unknown_count }),
  );
  await sql(
    `UPDATE comms.mail_queue SET next_attempt_at = now() WHERE source_type = 'support.ticket.opened' AND source_id = $1`,
    [t2.json?.id],
  );
  const q2b = await waitFor(async () => {
    const row = await queueRow('support.ticket.opened', t2.json?.id);
    return row?.state === 'unknown' ? row : null;
  });
  check('второй неизвестный исход — окончательно «неизвестно»', q2b?.unknown_count === 2);
  check(
    'две копии с одним Message-ID (лишняя копия допустима)',
    q2b && withId(q2b.message_id).length === 2,
    `копий ${q2b && withId(q2b.message_id).length}`,
  );
  relay.mode = 'accept';
  await startCore();
  await sleep(5000);
  check(
    'после перезапуска третьей отправки нет',
    q2b &&
      withId(q2b.message_id).length === 2 &&
      (await queueRow('support.ticket.opened', t2.json?.id))?.state === 'unknown',
  );

  console.warn('[5] Остановка ядра во время отправки копии');
  relay.mode = 'hold';
  const t3 = await openTicket(u3, 'остановка во время отправки');
  tickets.push(t3.json?.id);
  const q3 = await waitFor(async () => {
    const row = await queueRow('support.ticket.opened', t3.json?.id);
    return row && withId(row.message_id).length === 1 ? row : null;
  });
  stopCore();
  check('ядро остановлено, копия у релея, строка «sending»', q3?.state === 'sending', q3?.state);
  relay.mode = 'accept';
  await startCore();
  const q3done = await waitFor(async () => {
    const row = await queueRow('support.ticket.opened', t3.json?.id);
    return row?.state === 'accepted' ? row : null;
    // Аренда прерванной отправки держится окно SMTP-диалога (здесь 50 с): раньше строку не
    // забрать — прежний исполнитель мог быть ещё жив.
  }, 80_000);
  check(
    'прерванная отправка засчитана неизвестной (в БД), один повтор принят',
    q3done?.unknown_count === 1 && withId(q3done.message_id).length === 2,
    JSON.stringify(q3done && { u: q3done.unknown_count, n: withId(q3done.message_id).length }),
  );

  console.warn('[6–7] Регистрация и повтор обращения');
  check(
    'уведомление о регистрации поставлено и принято релеем',
    (await queueRow('identity.user.registered', u3.userId))?.state === 'accepted',
  );
  const kT = key();
  const t4 = await openTicket(u3, 'повтор тем же ключом', kT);
  const t4b = await openTicket(u3, 'повтор тем же ключом', kT);
  tickets.push(t4.json?.id);
  const n4 = await sql(
    `SELECT count(*)::int AS n FROM comms.mail_queue WHERE source_type = 'support.ticket.opened' AND source_id = $1`,
    [t4.json?.id],
  );
  check(
    'повтор обращения — то же обращение, одна копия в очереди',
    t4b.json?.id === t4.json?.id && n4[0].n === 1,
  );
} finally {
  relay.mode = 'accept';
  const ids = tickets.filter(Boolean);
  await sql(`DELETE FROM comms.mail_queue WHERE recipient = $1`, [INBOX]).catch(() => undefined);
  if (ids.length > 0) {
    await sql('DELETE FROM comms.support_messages WHERE ticket_id = ANY($1)', [ids]).catch(
      () => undefined,
    );
    await sql('DELETE FROM comms.support_tickets WHERE id = ANY($1)', [ids]).catch(() => undefined);
  }
  for (const k of created.dispatchKeys) {
    await sql(`DELETE FROM comms.mail_dispatches WHERE key_hash = $1`, [
      createHash('sha256').update(`mail-dispatch:password_reset:${k}`).digest(),
    ]).catch(() => undefined);
  }
  stopCore();
  await sleep(800);
  spawnSync('npm', ['run', '-s', 'stand:up', '--', '--no-build', '--restart-core'], {
    cwd: ROOT,
    stdio: 'ignore',
    shell: true,
  });
  server.close();
  await pool.end();
}
console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exit(failed > 0 ? 1 : 0);
