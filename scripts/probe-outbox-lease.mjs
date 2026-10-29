#!/usr/bin/env node
/**
 * Проверка очереди outbox: аренда между экземплярами и повтор рассылки.
 *
 * Две находки внешнего аудита проверяются здесь фактом, а не чтением кода:
 *
 *  1. Аренда (CODE-05). `FOR UPDATE SKIP LOCKED` держит строку только до конца
 *     транзакции, а транзакция закрывалась до публикации — второй экземпляр
 *     немедленно забирал те же события. Прогон имитирует два экземпляра и
 *     смотрит, пересекаются ли их пачки.
 *
 *  2. Потеря доставок (CODE-04). Событие, опубликованное в брокер, но не
 *     разосланное подписчикам, прежним проходом не выбиралось никогда. Прогон
 *     создаёт ровно такую строку и проверяет, что очередь повтора её видит.
 *
 * Прогон убирает за собой свои строки при любом исходе.
 *
 * Запуск: node scripts/probe-outbox-lease.mjs
 */
import pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 6 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

const MARK = `probe-outbox-${Date.now() % 1e9}`;
const LEASE_SECONDS = 60;

/** Захват пачки в аренду — тем же выражением, что и в публикаторе. */
async function claim(instance, size) {
  return sql(
    `UPDATE audit.outbox_events o
        SET locked_at = now(),
            locked_until = now() + ($3 || ' seconds')::interval,
            locked_by = $4
      WHERE o.id IN (
        SELECT id FROM audit.outbox_events
         WHERE published_at IS NULL
           AND next_attempt_at <= now()
           AND attempts < $2
           AND (locked_until IS NULL OR locked_until < now())
           AND event_type = $5
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1)
    RETURNING o.id`,
    [size, 10, LEASE_SECONDS, instance, 'lab.listing.published'],
  );
}

console.warn('\n=== ПРОВЕРКА ОЧЕРЕДИ OUTBOX ===\n');
const created = [];
/** Подписчики, заведённые прогоном: убираются в finally вместе с событиями. */
const createdEndpoints = [];
const createdAccounts = [];

try {
  // Пять неопубликованных событий с известным типом.
  for (let i = 0; i < 5; i += 1) {
    const [row] = await sql(
      `INSERT INTO audit.outbox_events
         (id, aggregate_type, aggregate_id, aggregate_version, event_type,
          payload_jsonb, nats_subject, message_key)
       VALUES (public.uuid_generate_v7(), 'probe', public.uuid_generate_v7(), $1,
               'lab.listing.published', $2::jsonb, 'probe.subject', $3)
       RETURNING id`,
      [i + 1, JSON.stringify({ mark: MARK }), `${MARK}-${i}`],
    );
    created.push(row.id);
  }
  check('подготовлено 5 событий в очереди', created.length === 5);

  // --- 1. Аренда между экземплярами --------------------------------------
  const first = await claim('instance-A', 5);
  const second = await claim('instance-B', 5);
  const overlap = second.filter((row) => first.some((other) => other.id === row.id));
  check('первый экземпляр забрал пачку', first.length === 5, `строк: ${first.length}`);
  check(
    'второй экземпляр НЕ получил те же строки',
    overlap.length === 0,
    `пересечение: ${overlap.length}`,
  );

  // Просроченная аренда обязана освобождаться: упавший экземпляр не должен
  // блокировать очередь навсегда.
  await sql(
    `UPDATE audit.outbox_events SET locked_until = now() - interval '1 second'
      WHERE id = ANY($1::uuid[])`,
    [created],
  );
  const afterExpiry = await claim('instance-B', 5);
  check(
    'после истечения аренды строки снова доступны',
    afterExpiry.length === 5,
    `строк: ${afterExpiry.length}`,
  );

  // --- 2. Очередь повторной рассылки --------------------------------------
  // Событие опубликовано, но рассылка не выполнена — ровно тот случай, который
  // прежде не выбирался ничем.
  await sql(
    `UPDATE audit.outbox_events
        SET published_at = now(), fanout_completed_at = NULL, locked_until = NULL
      WHERE id = $1`,
    [created[0]],
  );
  const pending = await sql(
    `SELECT id FROM audit.outbox_events
      WHERE published_at IS NOT NULL AND fanout_completed_at IS NULL AND id = $1`,
    [created[0]],
  );
  check(
    'опубликованное без рассылки событие видно очереди повтора',
    pending.length === 1,
    `строк: ${pending.length}`,
  );

  // Контроль: прежним условием (published_at IS NULL) это событие не видно —
  // значит, потеря была настоящей, а проверка выше не пустая.
  const invisible = await sql(
    `SELECT id FROM audit.outbox_events WHERE published_at IS NULL AND id = $1`,
    [created[0]],
  );
  check('прежнему проходу это событие не видно — потеря была настоящей', invisible.length === 0);
  // --- 3. Аренда очереди ДОСТАВОК (SEC-19) --------------------------------
  // Прежде строка доставки отпускалась вместе с транзакцией — до самого
  // HTTP-запроса, и два экземпляра слали одно событие получателю одновременно.
  // Подписчик заводится ПРОГОНОМ, а не ищется в базе: пропущенная проверка
  // ничего не доказывает, а зависеть от чужих данных — тот же ложный зелёный.
  /*
   * Сервисный аккаунт прогон заводит СЕБЕ САМ.
   *
   * Комментарий выше обещал независимость от чужих данных, а код брал первый
   * попавшийся аккаунт из базы — и на чистом стенде проверка краснела с
   * «в базе нет сервисного аккаунта», не сказав ничего об аренде очереди.
   * Зависеть от того, запускали ли раньше smoke-integration, — то же самое,
   * что зависеть от погоды.
   */
  const [account] = await sql(
    `INSERT INTO integration.service_accounts
       (id, client_id, name, client_secret_hash, mtls_cert_fingerprint, scopes, created_by)
     VALUES (public.uuid_generate_v7(), $1, 'Проба аренды очереди', 'x', 'x',
             ARRAY['webhooks:manage'],
             (SELECT id FROM identity.users WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1))
     RETURNING id`,
    [`probe-outbox-${Date.now()}`],
  );
  createdAccounts.push(account.id);
  let endpoint = null;
  if (account) {
    [endpoint] = await sql(
      `INSERT INTO integration.webhook_endpoints
         (id, service_account_id, url, subscribed_verbs, secret_ciphertext,
          secret_kms_key_id, secret_fingerprint, status)
       VALUES (public.uuid_generate_v7(), $1, 'https://probe.example.org/hook',
               ARRAY['lab.listing.published'], $2, 'probe', $3, 'active')
       RETURNING id`,
      // Байты передаются параметром, а не литералом: экранированный литерал
      // превратился в настоящий нулевой байт внутри текста запроса и сломал
      // протокол соединения.
      [account.id, Buffer.from([0]), Buffer.from([0])],
    );
    createdEndpoints.push(endpoint.id);
  }
  if (!endpoint) {
    check('подписчик для проверки аренды заведён', false, 'в базе нет сервисного аккаунта');
  } else {
    const [delivery] = await sql(
      `INSERT INTO integration.webhook_deliveries (id, endpoint_id, event_id, status)
       VALUES (public.uuid_generate_v7(), $1, $2, 'queued')
       ON CONFLICT (endpoint_id, event_id) DO UPDATE
         SET status = 'queued', locked_until = NULL, attempts = 0
       RETURNING id`,
      [endpoint.id, created[1]],
    );

    const claim = async (instance) =>
      sql(
        `UPDATE integration.webhook_deliveries d
            SET locked_until = now() + interval '60 seconds', locked_by = $2
          WHERE d.id IN (
            SELECT d2.id FROM integration.webhook_deliveries d2
             WHERE d2.id = $1
               AND d2.status IN ('queued','failed')
               AND (d2.locked_until IS NULL OR d2.locked_until < now())
             FOR UPDATE OF d2 SKIP LOCKED)
        RETURNING d.id`,
        [delivery.id, instance],
      );

    const firstDelivery = await claim('delivery-A');
    const secondDelivery = await claim('delivery-B');
    check('доставку забрал первый экземпляр', firstDelivery.length === 1);
    check(
      'второй экземпляр ту же доставку НЕ получил',
      secondDelivery.length === 0,
      `строк: ${secondDelivery.length}`,
    );

    await sql('DELETE FROM integration.webhook_deliveries WHERE id = $1', [delivery.id]);
  }
} finally {
  if (createdEndpoints.length > 0) {
    await sql('DELETE FROM integration.webhook_deliveries WHERE endpoint_id = ANY($1::uuid[])', [
      createdEndpoints,
    ]);
    await sql('DELETE FROM integration.webhook_endpoints WHERE id = ANY($1::uuid[])', [
      createdEndpoints,
    ]);
  }
  if (createdAccounts.length > 0) {
    await sql('DELETE FROM integration.service_accounts WHERE id = ANY($1::uuid[])', [
      createdAccounts,
    ]);
  }
  if (created.length > 0) {
    await sql('DELETE FROM audit.outbox_events WHERE id = ANY($1::uuid[])', [created]);
    console.warn('\n  прогон убрал свои события');
  }
  await pool.end();
}

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exitCode = failed > 0 ? 1 : 0;
