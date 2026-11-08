#!/usr/bin/env node
/**
 * Контур доставки группы «События» (4.11, пакет 5): пауза по получателю и проба.
 *
 *   npm run build -w apps/core && node scripts/probe-webhook-delivery.mjs
 *
 * Настоящая служба доставки (`apps/core/dist`), настоящая БД стенда и аренда; подставлен
 * только исходящий HTTP — наружу ничего не уходит, защита от SSRF не ослабляется (адреса
 * подписок — `*.probe.test`, их «разрешение» даёт подставной транспорт). На время пробы ядро
 * стенда останавливается (иначе его доставка забрала бы строки пробы), в конце —
 * `stand:up --no-build --restart-core`.
 *
 * Проверяется:
 *   1. отказ узла A: одна доставка расходует попытку, остальные доставки A ждут без попыток,
 *      узел B в том же проходе получает свои;
 *   2. пауза узла переживает перезапуск (новый экземпляр службы A не трогает);
 *   3. по истечении паузы — одна проба на два одновременных исполнителя; отказ пробы
 *      удваивает паузу, расходуется попытка только пробы;
 *   4. успех пробы снимает паузу, остальные доставки A уходят;
 *   5. три подписки на один адрес — один узел;
 *   6. предполагаемый общий сбой (три узла) — пауза, затем одна проба;
 *   7. размыкатель брокера открыт — доставка идёт (контуры независимы).
 */
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
Object.assign(process.env, {
  WEBHOOK_DELIVERY_MODE: 'live',
  WEBHOOK_DESTINATION_PAUSE_S: '2',
  WEBHOOK_DESTINATION_PAUSE_MAX_S: '8',
  WEBHOOK_EGRESS_PAUSE_MS: '1500',
  // Короткая аренда доставки (предел 3 с + 10 с) — сценарий «запрос пересекает срок».
  WEBHOOK_TIMEOUT_MS: '1000',
  WEBHOOK_DNS_RETRY_S: '1',
});
const DIST = join(ROOT, 'apps/core/dist');
if (!existsSync(join(DIST, 'events/webhook-delivery.service.js'))) {
  console.error('Нет apps/core/dist — сначала npm run build -w apps/core');
  process.exit(2);
}
const { WebhookDeliveryService } = await import(
  pathToFileURL(join(DIST, 'events/webhook-delivery.service.js')).href
);
const health = await import(pathToFileURL(join(DIST, 'events/events-health.js')).href);

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else failed += 1;
  console.warn(`  ${condition ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });
const sql = async (text, params = []) => (await owner.query(text, params)).rows;
const integration = new pg.Pool({
  connectionString: process.env.DATABASE_URL_APP_INTEGRATION,
  max: 4,
});

/** Минимум Database, который нужен службе: транзакция от сервисной роли. */
const db = {
  async asServiceRole(role, _ctx, work) {
    const client = await integration.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query("SELECT set_config('app.current_roles', 'system', true)");
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },
};
const crypto = { openDirect: async () => Buffer.from('probe-secret') };

/** Подставной исходящий HTTP: поведение по хосту, учёт вызовов. */
const behaviour = new Map();
const delays = new Map();
const calls = [];
const inflight = new Map();
const maxInflight = new Map();
const transport = {
  resolve: async (url) => {
    const host = new URL(url).hostname;
    if (behaviour.get(host) === 'dns') {
      // Так помечает отказ резолвера настоящая проверка адреса (assertPublicDestination).
      throw Object.assign(new Error('имя не разрешается'), { dnsCode: 'EAI_AGAIN' });
    }
    return ['93.184.216.34'];
  },
  post: async (url) => {
    const host = new URL(url).hostname;
    calls.push(host);
    inflight.set(host, (inflight.get(host) ?? 0) + 1);
    maxInflight.set(host, Math.max(maxInflight.get(host) ?? 0, inflight.get(host)));
    try {
      if (delays.get(host)) await sleep(delays.get(host));
    } finally {
      inflight.set(host, inflight.get(host) - 1);
    }
    const mode = behaviour.get(host) ?? 'ok';
    if (mode === 'refuse') {
      throw Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
        deliveryPhase: 'connect',
      });
    }
    return { status: 200, body: '' };
  },
};
const make = () => {
  const svc = new WebhookDeliveryService(db, crypto, { register: () => undefined }, undefined);
  svc.transport = transport;
  return svc;
};
const callsTo = (host) => calls.filter((h) => h === host).length;

// ------------------------------------------------------------------ подготовка
const tag = randomUUID().slice(0, 8);
const hostA = `a-${tag}.probe.test`;
const hostB = `b-${tag}.probe.test`;
const created = { endpoints: [], events: [], account: null };
const helpers = {};
async function setup() {
  const [admin] = await sql(`SELECT user_id FROM identity.user_roles WHERE role = 'admin' LIMIT 1`);
  const account = randomUUID();
  await sql(
    `INSERT INTO integration.service_accounts
       (id, client_id, name, client_secret_hash, mtls_cert_fingerprint, scopes, created_by)
     VALUES ($1, $2, 'probe-webhooks', 'x', 'x', ARRAY['webhooks:manage'], $3)`,
    [account, `probe-${tag}`, admin.user_id],
  );
  created.account = account;
  const endpoint = async (url) => {
    const id = randomUUID();
    await sql(
      `INSERT INTO integration.webhook_endpoints
         (id, service_account_id, url, subscribed_verbs, secret_ciphertext, secret_kms_key_id,
          secret_fingerprint)
       VALUES ($1, $2, $3, ARRAY['probe.event'], '\\x00', 'probe', '\\x00')`,
      [id, account, url],
    );
    created.endpoints.push(id);
    return id;
  };
  const event = async () => {
    const id = randomUUID();
    await sql(
      `INSERT INTO audit.outbox_events
         (id, aggregate_type, aggregate_id, event_type, payload_jsonb, nats_subject,
          aggregate_version, message_key, published_at, fanout_completed_at)
       VALUES ($1, 'probe', $2, 'probe.event', '{}', 'probe.event', 1, $3, now(), now())`,
      [id, randomUUID(), id],
    );
    created.events.push(id);
    return id;
  };
  const delivery = async (endpointId, offsetSec) => {
    const id = randomUUID();
    await sql(
      `INSERT INTO integration.webhook_deliveries (id, endpoint_id, event_id, created_at)
       VALUES ($1, $2, $3, now() - make_interval(secs => $4))`,
      [id, endpointId, await event(), offsetSec],
    );
    return id;
  };
  helpers.endpoint = endpoint;
  helpers.delivery = delivery;
  // Три подписки на один адрес A и одна на B.
  const a1 = await endpoint(`https://${hostA}/hook`);
  const a2 = await endpoint(`https://${hostA.toUpperCase()}:443/other`);
  const a3 = await endpoint(`https://${hostA}/third?x=1`);
  const b1 = await endpoint(`https://${hostB}/hook`);
  for (const [ep, off] of [
    [a1, 60],
    [a2, 50],
    [a3, 40],
    [a1, 30],
    [b1, 20],
    [b1, 10],
  ]) {
    await delivery(ep, off);
  }
}
const deliveries = (host) =>
  sql(
    `SELECT d.status, d.attempts FROM integration.webhook_deliveries d
       JOIN integration.webhook_endpoints e ON e.id = d.endpoint_id
      WHERE e.destination = $1 ORDER BY d.created_at`,
    [`${host}:443`],
  );
const destination = async (host) =>
  (
    await sql(`SELECT * FROM integration.webhook_destinations WHERE destination = $1`, [
      `${host}:443`,
    ])
  )[0];

console.warn('\n=== ДОСТАВКА ВЕБХУКОВ: ПАУЗА ПО ПОЛУЧАТЕЛЮ (4.11) ===\n');
const corePid = portOwner(Number(process.env.CORE_PORT ?? 4300));
if (corePid) stopTree(corePid);
await sleep(800);
try {
  await setup();
  const dests = await sql(
    `SELECT DISTINCT destination FROM integration.webhook_endpoints WHERE id = ANY($1)`,
    [created.endpoints],
  );
  check(
    'три подписки на один адрес — один узел',
    dests.length === 2,
    dests.map((d) => d.destination).join(', '),
  );

  console.warn('[1] Отказ узла A');
  behaviour.set(hostA, 'refuse');
  await make().runOnce();
  const a = await deliveries(hostA);
  check(
    'A: попытку расходует одна доставка',
    a.filter((x) => x.attempts === 1).length === 1 && callsTo(hostA) === 1,
    JSON.stringify(a),
  );
  check('A: остальные три ждут без попыток', a.filter((x) => x.attempts === 0).length === 3);
  const b = await deliveries(hostB);
  check(
    'B в том же проходе получил свои',
    b.every((x) => x.status === 'delivered') && callsTo(hostB) === 2,
  );
  const pause1 = await destination(hostA);
  check(
    'узел A на паузе',
    pause1 && new Date(pause1.paused_until) > new Date(),
    pause1?.pause_seconds,
  );

  console.warn('[2] Перезапуск не снимает паузу');
  await make().runOnce();
  check('новый экземпляр службы A не трогает', callsTo(hostA) === 1);

  console.warn('[3] Одна проба на двух исполнителей');
  await sleep(2300);
  await Promise.all([make().runOnce(), make().runOnce()]);
  check('после паузы — ровно одна проба', callsTo(hostA) === 2, `вызовов A ${callsTo(hostA)}`);
  const pause2 = await destination(hostA);
  check('отказ пробы удвоил паузу', pause2?.pause_seconds === 4, pause2?.pause_seconds);
  const a2 = await deliveries(hostA);
  check(
    'расходуются попытки только пробы',
    a2.reduce((s, x) => s + x.attempts, 0) === 2 && a2.filter((x) => x.attempts === 0).length >= 2,
    JSON.stringify(a2),
  );

  console.warn('[4] Успех пробы снимает паузу');
  behaviour.set(hostA, 'ok');
  await sleep(4300);
  await make().runOnce();
  check('проба прошла, пауза снята', !(await destination(hostA)));
  await make().runOnce();
  await sql(
    `UPDATE integration.webhook_deliveries SET next_retry_at = now()
              WHERE endpoint_id = ANY($1) AND status = 'failed'`,
    [created.endpoints],
  );
  await make().runOnce();
  const a3 = await deliveries(hostA);
  check(
    'остальные доставки A ушли',
    a3.every((x) => x.status === 'delivered'),
    JSON.stringify(a3),
  );

  console.warn('[6] Предполагаемый общий сбой — пауза и одна проба');
  const monitor = health.egressMonitor();
  ['x1', 'x2', 'x3'].forEach((d) => monitor.transportFailure(`${d}.probe.test:443`));
  check('три разных узла — пауза всех доставок', monitor.gate() === 'paused');
  const ep = created.endpoints[3];
  for (let i = 0; i < 3; i += 1) {
    const ev = randomUUID();
    await sql(
      `INSERT INTO audit.outbox_events
         (id, aggregate_type, aggregate_id, event_type, payload_jsonb, nats_subject,
          aggregate_version, message_key, published_at, fanout_completed_at)
       VALUES ($1, 'probe', $2, 'probe.event', '{}', 'probe.event', 1, $3, now(), now())`,
      [ev, randomUUID(), ev],
    );
    created.events.push(ev);
    await sql(
      `INSERT INTO integration.webhook_deliveries (id, endpoint_id, event_id) VALUES ($1, $2, $3)`,
      [randomUUID(), ep, ev],
    );
  }
  const before = callsTo(hostB);
  await make().runOnce();
  check('во время паузы — ни одной доставки', callsTo(hostB) === before);
  await sleep(1700);
  await make().runOnce();
  check(
    'после паузы — одна проба, затем открыто',
    callsTo(hostB) === before + 1 && monitor.gate() === 'open',
  );

  console.warn('[7] Брокер недоступен — доставка идёт');
  for (let i = 0; i < 3; i += 1) health.brokerBreaker().record('write', false);
  await make().runOnce();
  check(
    'размыкатель брокера открыт, доставки B ушли',
    health.brokerBreaker().isOpen('write') && callsTo(hostB) === before + 3,
  );

  console.warn('[8] Временный сбой DNS на последней попытке');
  const hostC = `c-${tag}.probe.test`;
  const epC = await helpers.endpoint(`https://${hostC}/hook`);
  const dC = await helpers.delivery(epC, 5);
  await sql(
    `UPDATE integration.webhook_deliveries SET status = 'failed', attempts = 7 WHERE id = $1`,
    [dC],
  );
  behaviour.set(hostC, 'dns');
  await make().runOnce();
  const [c1] = await sql(
    'SELECT status, attempts, next_retry_at > now() AS later FROM integration.webhook_deliveries WHERE id = $1',
    [dC],
  );
  check(
    'доставка сохранена, счётчик тот же, повтор отложен',
    c1.status === 'failed' && c1.attempts === 7 && c1.later,
    JSON.stringify(c1),
  );
  check(
    'узел на паузу не поставлен, запроса не было',
    !(await destination(hostC)) && callsTo(hostC) === 0,
  );
  behaviour.delete(hostC);
  await sleep(1300);
  await make().runOnce();
  const [c2] = await sql(
    'SELECT status, attempts FROM integration.webhook_deliveries WHERE id = $1',
    [dC],
  );
  check(
    'после восстановления DNS доставка прошла',
    c2.status === 'delivered' && c2.attempts === 8,
    JSON.stringify(c2),
  );

  console.warn('[9] Проба пересекает первоначальный срок аренды');
  const lease =
    health.destinationPause &&
    (
      await import(pathToFileURL(join(DIST, 'events/webhook-delivery.service.js')).href)
    ).deliveryLeaseSeconds();
  const hostD = `d-${tag}.probe.test`;
  const hostE = `e-${tag}.probe.test`;
  const epD = await helpers.endpoint(`https://${hostD}/hook`);
  const epE = await helpers.endpoint(`https://${hostE}/hook`);
  // E — старше: в пачке перед пробой D. Три доставки E съедают почти весь срок аренды.
  for (const off of [300, 299, 298]) await helpers.delivery(epE, off);
  for (const off of [200, 199]) await helpers.delivery(epD, off);
  await sql(
    `INSERT INTO integration.webhook_destinations
       (destination, failures, pause_seconds, paused_until, last_failure_kind)
     VALUES ($1, 1, 2, now() - interval '1 second', 'transport')`,
    [`${hostD}:443`],
  );
  const eDelay = Math.floor(((lease - 3) * 1000) / 3);
  delays.set(hostE, eDelay);
  delays.set(hostD, 6000);
  const started = Date.now();
  const first = make().runOnce();
  // Ждём, пока проба D начнёт запрос, затем — до первоначального срока аренды + 1 с.
  while (callsTo(hostD) === 0 && Date.now() - started < (lease + 10) * 1000) await sleep(100);
  const dStartedAt = Date.now() - started;
  await sleep(Math.max(0, lease * 1000 + 1000 - (Date.now() - started)));
  const crossed = Date.now() - started > lease * 1000 && inflight.get(hostD) === 1;
  const dBefore = callsTo(hostD);
  await make().runOnce();
  check(
    'запрос пробы пересёк первоначальный срок аренды',
    crossed,
    `аренда ${lease} с, запрос с ${Math.round(dStartedAt / 1000)} с`,
  );
  check(
    'второй исполнитель в это время пробу не получил',
    callsTo(hostD) === dBefore && (maxInflight.get(hostD) ?? 0) === 1,
    `вызовов D ${callsTo(hostD)}, одновременно ${maxInflight.get(hostD)}`,
  );
  await first;
  delays.clear();
} finally {
  await sql(`DELETE FROM integration.webhook_destinations WHERE destination LIKE $1`, [
    `%-${tag}.probe.test:443`,
  ]).catch(() => undefined);
  if (created.endpoints.length > 0) {
    await sql(`DELETE FROM integration.webhook_deliveries WHERE endpoint_id = ANY($1)`, [
      created.endpoints,
    ]).catch(() => undefined);
    await sql(`DELETE FROM integration.webhook_endpoints WHERE id = ANY($1)`, [
      created.endpoints,
    ]).catch(() => undefined);
  }
  if (created.events.length > 0) {
    await sql(`DELETE FROM audit.outbox_events WHERE id = ANY($1)`, [created.events]).catch(
      () => undefined,
    );
  }
  if (created.account) {
    await sql(`DELETE FROM integration.service_accounts WHERE id = $1`, [created.account]).catch(
      () => undefined,
    );
  }
  await owner.end();
  await integration.end();
  spawnSync('npm', ['run', '-s', 'stand:up', '--', '--no-build', '--restart-core'], {
    cwd: ROOT,
    stdio: 'ignore',
    shell: true,
  });
}
console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exit(failed > 0 ? 1 : 0);
