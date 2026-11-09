#!/usr/bin/env node
/**
 * Сон пустых очередей и пробуждение по сигналу M175: задержка доставки (Тэнк 10.11).
 *
 *   node scripts/check-queue-wake.mjs     (стенд http://127.0.0.1/, служебный порт 4400, база fifth-postgres)
 *
 * Меряет фактическую задержку, а не обещает её:
 *  1. первое событие outbox после простоя (опрос спит 10 с) — будится сигналом;
 *  2. письмо в очереди почты после простоя;
 *  3. потерянный сигнал: соединение слушателя обрывается (pg_terminate_backend) — событие
 *     всё равно публикуется не позже паузы сна, слушатель переподключается, следующее
 *     событие снова быстрое.
 * Задержка — по времени базы: created_at → published_at / accepted_at.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { registerProbeUser, startProbeRun } from './lib/probe-run.mjs';

const BASE = process.env.FIFTH_BASE ?? 'http://127.0.0.1';
const INTERNAL = process.env.FIFTH_INTERNAL ?? 'http://127.0.0.1:4400';
const IDLE_MAX_MS = Number(process.env.QUEUE_IDLE_MAX_MS ?? 10_000);
const FAST_MS = 2_000;
let failed = 0;
let passed = 0;
const results = [];
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
  async function call(path, { method = 'GET', body } = {}) {
    const headers = { 'X-Fifth-Origin': 'render_check' };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const csrf = [...jar].find(([k]) => /csrf/i.test(k))?.[1];
    if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
    if (method !== 'GET') headers['Idempotency-Key'] = randomUUID();
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
    return { status: r.status, json, retryAfter: Number(r.headers.get('retry-after') ?? 0) };
  }
  return { call };
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
      'psql -U "$POSTGRES_USER" -d fifth_element -At -v ON_ERROR_STOP=1',
    ],
    { input: query, encoding: 'utf8', timeout: 60_000 },
  );
  if (r.status !== 0) throw new Error(`база: ${(r.stderr ?? '').trim().slice(-300)}`);
  return r.stdout.trim();
}
async function job(name) {
  const r = await fetch(`${INTERNAL}/jobs`, { signal: AbortSignal.timeout(5_000) });
  const body = await r.json();
  return (body.jobs ?? body).find((j) => j.name === name);
}
/** Ждать, пока задача уснёт на полную паузу: проверяется именно первая работа после простоя. */
async function untilAsleep(name) {
  for (let i = 0; i < 60; i += 1) {
    const j = await job(name);
    if (j?.phase === 'sleeping' && j.sleepMs >= IDLE_MAX_MS) return j;
    await sleep(500);
  }
  throw new Error(`${name} не уснул`);
}
async function untilSet(query, limitMs) {
  const until = Date.now() + limitMs;
  for (;;) {
    const v = sql(query);
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(100);
  }
}
const listenerPids = () =>
  sql(
    "SELECT string_agg(pid::text, ',') FROM pg_stat_activity WHERE application_name = 'fifth-core-queue-wake';",
  );

console.log('\n=== СОН ПУСТЫХ ОЧЕРЕДЕЙ И ПРОБУЖДЕНИЕ (M175) ===\n');
const run = await startProbeRun('CHK-QUEUE-WAKE');
let ok = false;
try {
  check('слушатель сигнала подключён', !!listenerPids(), listenerPids());
  const admin = client();
  const login = await admin.call('/v1/auth/login', {
    method: 'POST',
    body: { email: 'demo-admin@fifth.local', password: demoPassword() },
  });
  if (login.status !== 200 && login.status !== 201) throw new Error(`вход: ${login.status}`);
  const who = await registerProbeUser(run, { role: 'founder', label: 'queue-wake' });
  const self = client();
  await self.call('/v1/auth/login', {
    method: 'POST',
    body: { email: who.email, password: who.password },
  });
  const userId = (await self.call('/v1/auth/me')).json?.id;
  if (!userId) throw new Error('нет id участника');

  const roleEvent = async (method, label) => {
    await untilAsleep('outbox.publish');
    const path =
      method === 'POST'
        ? `/v1/admin/users/${userId}/roles`
        : `/v1/admin/users/${userId}/roles/investor`;
    const r = await admin.call(path, {
      method,
      body: method === 'POST' ? { role: 'investor' } : undefined,
    });
    if (r.status >= 300) throw new Error(`${label}: HTTP ${r.status}`);
    const verb = method === 'POST' ? 'identity.role.granted' : 'identity.role.revoked';
    const ms = await untilSet(
      `SELECT round(extract(epoch FROM published_at - created_at) * 1000) FROM audit.outbox_events
        WHERE aggregate_id = '${userId}' AND event_type = '${verb}' AND published_at IS NOT NULL
        ORDER BY created_at DESC LIMIT 1;`,
      IDLE_MAX_MS + 5_000,
    );
    return ms === null ? null : Number(ms);
  };

  // 1. Первое событие после простоя.
  const first = await roleEvent('POST', 'выдача роли');
  results.push({ case: 'outbox после простоя', ms: first });
  check(
    `outbox: первое событие после сна ${IDLE_MAX_MS} мс опубликовано быстро`,
    first !== null && first < FAST_MS,
    `${first} мс`,
  );

  // 2. Письмо после простоя.
  // Обращение в поддержку ставит служебное письмо в очередь почты (comms.mail_queue).
  // Смена роли выше отозвала сессию участника — входим заново.
  await self.call('/v1/auth/login', {
    method: 'POST',
    body: { email: who.email, password: who.password },
  });
  await untilAsleep('mail.queue.send');
  const since = sql('SELECT now();');
  const ticket = await self.call('/v1/support/tickets', {
    method: 'POST',
    body: { kind: 'support', subject: 'Проверка сна очереди почты', body: 'CHK-QUEUE-WAKE' },
  });
  const mailMs = await untilSet(
    `SELECT round(extract(epoch FROM accepted_at - created_at) * 1000) FROM comms.mail_queue
      WHERE source_type = 'support.ticket.opened' AND created_at >= '${since}' AND accepted_at IS NOT NULL
      ORDER BY created_at LIMIT 1;`,
    IDLE_MAX_MS + 10_000,
  );
  const forgot = ticket;
  results.push({ case: 'почта после простоя', ms: mailMs === null ? null : Number(mailMs) });
  check(
    'почта: письмо после сна принято быстро',
    forgot.status < 300 && mailMs !== null && Number(mailMs) < FAST_MS,
    `HTTP ${forgot.status}, ${mailMs} мс`,
  );

  // 3. Потерянный сигнал.
  await untilAsleep('outbox.publish');
  sql(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'fifth-core-queue-wake';",
  );
  const lost = await roleEvent('DELETE', 'снятие роли');
  results.push({ case: 'outbox при потерянном сигнале', ms: lost });
  check(
    'потерянный сигнал: событие всё равно опубликовано не позже паузы сна',
    lost !== null && lost <= IDLE_MAX_MS + 1_500,
    `${lost} мс`,
  );
  let back = '';
  for (let i = 0; i < 40 && !back; i += 1) {
    await sleep(500);
    back = listenerPids();
  }
  check('слушатель переподключился', !!back, back);
  const after = await roleEvent('POST', 'повторная выдача');
  results.push({ case: 'outbox после переподключения', ms: after });
  check('после переподключения снова быстро', after !== null && after < FAST_MS, `${after} мс`);
  ok = failed === 0;
} catch (error) {
  failed += 1;
  console.log(`  FAIL  прогон прерван — ${error.message}`);
} finally {
  await run.finish(ok);
}
console.log(`\nЗадержки: ${JSON.stringify(results)}`);
console.log(`ИТОГО: ${passed} пройдено, ${failed} провалено`);
process.exit(failed === 0 ? 0 : 1);
