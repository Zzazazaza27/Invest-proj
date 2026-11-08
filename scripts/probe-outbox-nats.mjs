#!/usr/bin/env node
/**
 * Публикатор outbox и доставки вебхуков при отказах (блок 1, 1.3.6; блок 2, 2.4 и 2.6; M160).
 *
 *   node scripts/probe-outbox-nats.mjs      (ядро стенда остановлено: его публикатор не мешает)
 *
 * Узкие сценарии на настоящей БД стенда:
 *   1. долгий отказ брокера: попытки событий не расходуются, захват пачки освобождается сразу,
 *      публикатор на паузе; после возврата брокера каждое событие опубликовано один раз;
 *   2. подтверждение потеряно после того, как брокер принял сообщение (настоящий NATS,
 *      изолированный стрим с окном дедупликации 2 с): повтор внутри окна — дубль отсечён,
 *      после окна — второе сообщение с тем же Nats-Msg-Id и eventId; событие не потеряно,
 *      попытки не расходуются;
 *   3. потеря аренды посреди пачки: проход прекращается, чужие строки не трогаются,
 *      остальные события не публикуются этим исполнителем;
 *   4. ошибка самого события: попытка засчитана, следующее событие той же пачки опубликовано;
 *   5. доставка вебхука: потеря аренды останавливает проход, оставшаяся строка освобождена.
 * Очередь стенда на время пробы откладывается и возвращается; свои строки проба убирает.
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'nats';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of existsSync(join(ROOT, '.env'))
  ? readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
  : []) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq > 0) process.env[trimmed.slice(0, eq).trim()] ??= trimmed.slice(eq + 1).trim();
}

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else failed += 1;
  console.warn(`  ${condition ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// Адрес намеренно по http: проверяется, работает ли СВОЁ ядро стенда на петлевом интерфейсе
// этой машины; TLS к собственному процессу на 127.0.0.1 ничего не защищает.
// nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
const alive = await fetch('http://127.0.0.1:4300/v1/health', { signal: AbortSignal.timeout(2000) })
  .then(() => true)
  .catch(() => false);
if (alive) {
  console.error('ядро стенда работает: его публикатор заберёт события пробы. Остановите ядро.');
  process.exit(2);
}

const DIST = join(ROOT, 'apps/core/dist');
const require = createRequire(import.meta.url);
const { Database } = require(join(DIST, 'db/unit-of-work.js'));
const { OutboxPublisherService } = require(join(DIST, 'events/publisher.service.js'));
const { NatsClient } = require(join(DIST, 'events/nats.client.js'));
const { WebhookDeliveryService } = require(join(DIST, 'events/webhook-delivery.service.js'));
const { CryptoService } = require(join(DIST, 'crypto/crypto.service.js'));

const db = new Database();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 3 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;
const RUN = randomUUID().slice(0, 8);
const mine = [];

async function addEvent(subject) {
  const id = randomUUID();
  await sql(
    `INSERT INTO audit.outbox_events
       (id, aggregate_type, aggregate_id, event_type, payload_jsonb, nats_subject,
        aggregate_version, message_key)
     VALUES ($1, 'probe', $2, 'probe.outbox', '{}'::jsonb, $3, 1, $4)`,
    [id, randomUUID(), subject, `probe-${RUN}`],
  );
  mine.push(id);
  return id;
}
const row = async (id) =>
  (
    await sql(
      'SELECT attempts, published_at, lease_id, next_attempt_at > now() AS deferred FROM audit.outbox_events WHERE id = $1',
      [id],
    )
  )[0];

/** Ненастоящий брокер: что делать с публикацией, решает `mode`. */
function fakeNats() {
  const calls = [];
  const fake = {
    enabled: true,
    mode: 'ok',
    onPublish: null,
    calls,
    async publish(subject, payload, options) {
      calls.push(options.messageId);
      if (fake.onPublish) await fake.onPublish(options.messageId);
      if (fake.mode === 'broker')
        throw Object.assign(new Error('отказ брокера'), { kind: 'broker' });
      if (fake.mode === 'event') {
        fake.mode = 'ok';
        throw Object.assign(new Error('слишком большое событие'), { kind: 'event' });
      }
      return calls.length;
    },
    classifyPublishFailure: (error) => error.kind,
    streamStatus: async () => null,
  };
  return fake;
}
const jobs = { register() {} };

// Очередь стенда откладывается на время пробы: иначе проба опубликовала бы чужие события.
const parked = await sql(
  `UPDATE audit.outbox_events SET next_attempt_at = next_attempt_at + interval '1 day'
    WHERE published_at IS NULL RETURNING id`,
);
const parkedDeliveries = await sql(
  `UPDATE integration.webhook_deliveries
      SET next_retry_at = coalesce(next_retry_at, now()) + interval '1 day'
    WHERE status IN ('queued', 'failed') RETURNING id`,
);

console.warn('\n=== ПУБЛИКАТОР OUTBOX И ДОСТАВКИ ПРИ ОТКАЗАХ ===\n');
const cleanup = { stream: null, nc: null, endpoint: null, account: null, deliveries: [] };
try {
  console.warn('[1] Долгий отказ брокера');
  {
    const nats = fakeNats();
    const pub = new OutboxPublisherService(db, nats, jobs);
    const ids = [await addEvent('probe.x'), await addEvent('probe.x'), await addEvent('probe.x')];
    nats.mode = 'broker';
    let releasedEveryPass = true;
    for (let pass = 0; pass < 12; pass += 1) {
      pub.pausedUntil = 0; // пауза проверяется отдельно ниже; здесь — 12 «циклов» отказа
      await pub.runOnce();
      for (const id of ids) if ((await row(id)).lease_id !== null) releasedEveryPass = false;
    }
    const rows = await Promise.all(ids.map(row));
    check(
      '12 проходов при отказе — ни одной попытки не засчитано',
      rows.every((r) => r.attempts === 0),
      rows.map((r) => r.attempts).join('/'),
    );
    check('захват пачки освобождается сразу на каждом проходе', releasedEveryPass);
    check(
      'ничего не отмечено опубликованным',
      rows.every((r) => r.published_at === null),
    );
    check(
      'в каждом проходе публикатор остановился на первом событии',
      nats.calls.length === 12,
      `вызовов ${nats.calls.length}`,
    );
    const before = nats.calls.length;
    await pub.runOnce();
    check('на паузе пачка не берётся и брокер не дёргается', nats.calls.length === before);
    nats.mode = 'ok';
    nats.calls.length = 0;
    pub.pausedUntil = 0;
    await pub.runOnce();
    const after = await Promise.all(ids.map(row));
    check(
      'после возврата брокера все опубликованы',
      after.every((r) => r.published_at !== null),
    );
    check(
      'каждое — ровно один раз',
      ids.every((id) => nats.calls.filter((c) => c === id).length === 1),
      nats.calls.length + ' вызовов',
    );
    check(
      'попытки так и не расходовались',
      after.every((r) => r.attempts === 0),
    );
  }

  console.warn('[2] Подтверждение потеряно после принятия брокером (настоящий NATS)');
  {
    const stream = `RKPROBE_${RUN}`;
    const subject = `rkprobe.${RUN}.event`;
    const nc = await connect({
      servers: process.env.NATS_URL || 'nats://127.0.0.1:4222',
      user: process.env.NATS_USER || undefined,
      pass: process.env.NATS_PASSWORD || undefined,
      timeout: 5000,
    });
    cleanup.nc = nc;
    const jsm = await nc.jetstreamManager();
    await jsm.streams.add({
      name: stream,
      subjects: [`rkprobe.${RUN}.>`],
      storage: 'memory',
      duplicate_window: 2 * 1_000_000_000,
    });
    cleanup.stream = stream;
    const real = new NatsClient();
    let loseNextAck = false;
    const wrapped = {
      enabled: true,
      // Сообщение принято брокером, подтверждение до публикатора не дошло.
      async publish(s, payload, options) {
        const seq = await real.publish(s, payload, options);
        if (loseNextAck) {
          loseNextAck = false;
          throw Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' });
        }
        return seq;
      },
      classifyPublishFailure: (error) => real.classifyPublishFailure(error),
      streamStatus: async () => null,
    };
    const pub = new OutboxPublisherService(db, wrapped, jobs);
    const messages = async () => Number((await jsm.streams.info(stream)).state.messages);

    const inside = await addEvent(subject);
    loseNextAck = true;
    await pub.runOnce();
    const r1 = await row(inside);
    check(
      'после потери подтверждения: не опубликовано, попытка не засчитана',
      r1.published_at === null && r1.attempts === 0,
      JSON.stringify(r1),
    );
    check('брокер сообщение принял', (await messages()) === 1);
    pub.pausedUntil = 0;
    await pub.runOnce();
    check('повтор внутри окна — тем же Msg-Id, дубль отсечён', (await messages()) === 1);
    check('событие отмечено опубликованным', (await row(inside)).published_at !== null);

    const outside = await addEvent(subject);
    loseNextAck = true;
    await pub.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 2600));
    pub.pausedUntil = 0;
    await pub.runOnce();
    const total = await messages();
    check(
      'повтор после окна — второе сообщение допустимо, событие не потеряно',
      total === 3,
      `сообщений ${total}`,
    );
    const got = [];
    for (let seq = 2; seq <= total; seq += 1) {
      const m = await jsm.streams.getMessage(stream, { seq });
      got.push({
        msgId: m.header?.get('Nats-Msg-Id'),
        eventId: JSON.parse(new TextDecoder().decode(m.data)).eventId,
      });
    }
    check(
      'у обоих сообщений один Nats-Msg-Id и eventId — получатель отсечёт повтор',
      got.length === 2 && got.every((g) => g.msgId === outside && g.eventId === outside),
      JSON.stringify(got),
    );
    const r2 = await row(outside);
    check(
      'в outbox — опубликовано один раз, попыток 0',
      r2.published_at !== null && r2.attempts === 0,
    );
    await real.onModuleDestroy();
  }

  console.warn('[3] Потеря аренды посреди пачки');
  {
    const nats = fakeNats();
    const pub = new OutboxPublisherService(db, nats, jobs);
    const ids = [await addEvent('probe.x'), await addEvent('probe.x'), await addEvent('probe.x')];
    const stolen = randomUUID();
    // Пока первое событие публикуется, вся пачка уходит другому исполнителю.
    nats.onPublish = async () => {
      nats.onPublish = null;
      await sql(
        `UPDATE audit.outbox_events SET lease_id = $2, lease_until = now() + interval '1 minute'
          WHERE id = ANY($1::uuid[])`,
        [ids, stolen],
      );
    };
    await pub.runOnce();
    const rows = await Promise.all(ids.map(row));
    check(
      'брокер вызван только для первого события',
      nats.calls.length === 1,
      `вызовов ${nats.calls.length}`,
    );
    check('отметки «опубликовано» по чужому захвату нет', rows[0].published_at === null);
    check(
      'строки нового владельца не освобождены и не тронуты',
      rows.every((r) => r.lease_id === stolen && r.attempts === 0),
    );
  }

  console.warn('[4] Ошибка самого события');
  {
    const nats = fakeNats();
    const pub = new OutboxPublisherService(db, nats, jobs);
    const bad = await addEvent('probe.x');
    const good = await addEvent('probe.x');
    nats.mode = 'event';
    await pub.runOnce();
    const b = await row(bad);
    const g = await row(good);
    check(
      'попытка засчитана, повтор отложен, захват снят',
      b.attempts === 1 && b.deferred && b.lease_id === null,
      JSON.stringify(b),
    );
    check('следующее событие той же пачки опубликовано', g.published_at !== null);
  }

  console.warn('[5] Доставка вебхука: потеря аренды');
  if (process.env.DATABASE_URL_APP_INTEGRATION) {
    const [user] = await sql('SELECT id FROM identity.users ORDER BY created_at LIMIT 1');
    const account = randomUUID();
    await sql(
      `INSERT INTO integration.service_accounts
         (id, client_id, name, client_secret_hash, mtls_cert_fingerprint, scopes, created_by)
       VALUES ($1, $2, 'probe', 'x', 'x', ARRAY['webhooks:manage'], $3)`,
      [account, `probe-${RUN}`, user.id],
    );
    cleanup.account = account;
    const endpoint = randomUUID();
    await sql(
      `INSERT INTO integration.webhook_endpoints
         (id, service_account_id, url, subscribed_verbs, secret_ciphertext, secret_kms_key_id,
          secret_fingerprint)
       VALUES ($1, $2, 'https://example.com/hook', ARRAY['probe.outbox'], '\\x00', 'probe', '\\x00')`,
      [endpoint, account],
    );
    cleanup.endpoint = endpoint;
    // Пара (адрес, событие) уникальна: на каждую доставку — своё событие.
    const d = [randomUUID(), randomUUID(), randomUUID()];
    for (const [i, id] of d.entries()) {
      await sql(
        `INSERT INTO integration.webhook_deliveries (id, endpoint_id, event_id, created_at)
         VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
        [id, endpoint, await addEvent('probe.x'), i],
      );
    }
    cleanup.deliveries = d;
    const svc = new WebhookDeliveryService(db, new CryptoService(), jobs);
    const original = svc.renewLease.bind(svc);
    let renewals = 0;
    svc.renewLease = async (traceId, item) => {
      renewals += 1;
      if (renewals === 1) {
        await sql(`UPDATE integration.webhook_deliveries SET lease_id = $2 WHERE id = $1`, [
          d[1],
          randomUUID(),
        ]);
      }
      return original(traceId, item);
    };
    await svc.runOnce();
    const st = await sql(
      'SELECT id, status, lease_id FROM integration.webhook_deliveries WHERE id = ANY($1::uuid[])',
      [d],
    );
    const by = Object.fromEntries(st.map((x) => [x.id, x]));
    check(
      'первая доставка обработана (перехват контура)',
      by[d[0]]?.status === 'withheld',
      by[d[0]]?.status,
    );
    check(
      'на потерянной аренде проход остановлен: вторая не обработана',
      by[d[1]]?.status === 'queued',
    );
    check(
      'третья не тронута и освобождена сразу',
      by[d[2]]?.status === 'queued' && by[d[2]]?.lease_id === null,
      JSON.stringify(by[d[2]]),
    );
  } else {
    console.warn('  (интеграционный контур не настроен — сценарий пропущен, это не пройдено)');
  }
} finally {
  if (cleanup.stream) {
    const jsm = await cleanup.nc.jetstreamManager();
    await jsm.streams.delete(cleanup.stream).catch(() => undefined);
  }
  await cleanup.nc?.drain().catch(() => undefined);
  if (cleanup.deliveries.length) {
    await sql('DELETE FROM integration.webhook_deliveries WHERE id = ANY($1::uuid[])', [
      cleanup.deliveries,
    ]);
  }
  if (cleanup.endpoint)
    await sql('DELETE FROM integration.webhook_endpoints WHERE id = $1', [cleanup.endpoint]);
  if (cleanup.account)
    await sql('DELETE FROM integration.service_accounts WHERE id = $1', [cleanup.account]);
  await sql('DELETE FROM audit.outbox_events WHERE id = ANY($1::uuid[])', [mine]);
  await sql(
    `UPDATE audit.outbox_events SET next_attempt_at = next_attempt_at - interval '1 day'
      WHERE id = ANY($1::uuid[])`,
    [parked.map((r) => r.id)],
  );
  await sql(
    `UPDATE integration.webhook_deliveries SET next_retry_at = next_retry_at - interval '1 day'
      WHERE id = ANY($1::uuid[])`,
    [parkedDeliveries.map((r) => r.id)],
  );
  await pool.end();
  await db.onModuleDestroy?.();
}

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exit(failed > 0 ? 1 : 0);
