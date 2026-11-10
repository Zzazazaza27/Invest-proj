#!/usr/bin/env node
/**
 * Границы контура наружу: проверяется поведение, а не настройка.
 *
 * Зачем именно так. «В базе нет рабочих данных» защитой от внешнего действия
 * не является: подписчик с настоящим адресом получит настоящий POST от
 * любого события — в том числе заведённого проверкой. Поэтому здесь не
 * сверяются переменные окружения (это было бы проверкой самой себя), а
 * ставится настоящая доставка в очередь и смотрится, что с ней стало.
 *
 * Адрес подписчика нарочно недостижимый (`https://example.invalid/...`):
 *  - контур перехватывает → `withheld`, попыток ноль. Наружу не ходили.
 *  - контур выпускает → `failed`, попытка есть. Значит ходили.
 * Разница видна без ловли трафика.
 *
 * Прогон убирает за собой: заведённые подписчик и доставка удаляются.
 *
 *   node scripts/check-outbound-boundaries.mjs
 */
import pg from 'pg';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
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
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

let passed = 0;
const defects = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.warn(`  ok    ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    defects.push(name);
    console.error(`  ДЕФЕКТ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
await client.connect();

console.warn('\n=== ГРАНИЦЫ КОНТУРА НАРУЖУ ===\n');

// ------------------------------------------------ каналы, которые уже закрыты
check(
  'почта не уходит через релей',
  (process.env.MAIL_TRANSPORT ?? 'none') !== 'smtp',
  `MAIL_TRANSPORT=${process.env.MAIL_TRANSPORT ?? 'none'}`,
);

// ------------------------------------------------------- настоящая доставка
const suffix = Date.now().toString().slice(-8);
const accountId = randomUUID();
const endpointId = randomUUID();
const deliveryId = randomUUID();
let outboxId = null;

try {
  // Служебная учётка заводится минимально пригодной: проверяется доставка, а
  // не выдача токенов. Автор нужен по схеме — берём любого администратора.
  const { rows: admins } = await client.query(
    `SELECT u.id FROM identity.users u
       JOIN identity.user_roles r ON r.user_id = u.id AND r.role = 'admin'
      WHERE u.deleted_at IS NULL LIMIT 1`,
  );
  if (admins.length === 0) throw new Error('в базе нет администратора — некому числиться автором');
  await client.query(
    `INSERT INTO integration.service_accounts
       (id, client_id, name, client_secret_hash, mtls_cert_fingerprint, scopes, status, created_by)
     VALUES ($1, $2, $3, $4, $5, ARRAY['webhooks:manage'], 'active', $6)`,
    [
      accountId,
      `boundary-check-${suffix}`,
      `boundary-check-${suffix}`,
      createHash('sha256').update(randomBytes(32)).digest('hex'),
      createHash('sha256').update(randomBytes(32)).digest('hex'),
      admins[0].id,
    ],
  );

  // Секрет подписи настоящий, но доставка до подписи не дойдёт: перехват
  // стоит раньше, чем расшифровка секрета.
  const secret = randomBytes(32);
  await client.query(
    `INSERT INTO integration.webhook_endpoints
       (id, service_account_id, url, subscribed_verbs, secret_ciphertext,
        secret_kms_key_id, secret_fingerprint, status)
     VALUES ($1, $2, $3, ARRAY['project.published'], $4, 'local/webhook_secrets/v1', $5, 'active')`,
    [
      endpointId,
      accountId,
      `https://example.invalid/boundary-${suffix}`,
      secret,
      createHash('sha256').update(secret).digest(),
    ],
  );

  // Событие — только носитель доставки: сразу опубликовано и разослано, иначе издатель шлёт
  // его в NATS (прежде — по теме `unicorn.*` вне потока, до исчерпания попыток; W32 10.11).
  const { rows: outbox } = await client.query(
    `INSERT INTO audit.outbox_events
       (id, aggregate_type, aggregate_id, aggregate_version, event_type,
        payload_jsonb, nats_subject, schema_version, message_key,
        published_at, fanout_completed_at)
     VALUES (public.uuid_generate_v7(), 'project', public.uuid_generate_v7(), 1,
             'project.published', $1::jsonb, 'project.published', 1, $2, now(), now())
     RETURNING id`,
    [JSON.stringify({ check: 'outbound-boundaries', suffix }), `boundary-${suffix}`],
  );
  outboxId = outbox[0].id;

  await client.query(
    `INSERT INTO integration.webhook_deliveries (id, endpoint_id, event_id, status)
     VALUES ($1, $2, $3, 'queued')`,
    [deliveryId, endpointId, outboxId],
  );
  check('доставка поставлена в очередь', true, `подписчик example.invalid`);

  // Ждём прохода доставщика: интервал по умолчанию 2 с, берём с запасом.
  let row = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { rows } = await client.query(
      `SELECT status, attempts, withheld_reason, response_code
         FROM integration.webhook_deliveries WHERE id = $1`,
      [deliveryId],
    );
    row = rows[0] ?? null;
    if (row && row.status !== 'queued') break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  if (!row || row.status === 'queued') {
    check('доставку обработал контур', false, 'состояние не изменилось за 30 с — ядро работает?');
  } else {
    check(
      'наружу не ушло: доставка перехвачена',
      row.status === 'withheld',
      `status=${row.status}`,
    );
    check('попытка обращения не засчитана', row.attempts === 0, `attempts=${row.attempts}`);
    check('причина перехвата записана', Boolean(row.withheld_reason), row.withheld_reason ?? '');
    check(
      'ответа снаружи не было',
      row.response_code === null,
      `response_code=${String(row.response_code)}`,
    );
  }

  // Перехваченная доставка не должна попасть обратно в очередь на повтор:
  // иначе она будет ходить по кругу и шуметь в отчётах об интеграциях.
  const { rows: queued } = await client.query(
    `SELECT count(*)::int AS n FROM integration.webhook_deliveries
      WHERE id = $1 AND status IN ('queued','failed') `,
    [deliveryId],
  );
  check('перехваченная доставка не стоит в очереди на повтор', queued[0].n === 0);
} catch (error) {
  check('прогон выполнен', false, error instanceof Error ? error.message : String(error));
} finally {
  await client.query('DELETE FROM integration.webhook_deliveries WHERE id = $1', [deliveryId]);
  await client.query('DELETE FROM integration.webhook_endpoints WHERE id = $1', [endpointId]);
  await client.query('DELETE FROM integration.service_accounts WHERE id = $1', [accountId]);
  if (outboxId) await client.query('DELETE FROM audit.outbox_events WHERE id = $1', [outboxId]);
  await client.end();
}

console.warn(`\nпройдено: ${passed}, дефектов: ${defects.length}\n`);
process.exit(defects.length === 0 ? 0 : 1);
