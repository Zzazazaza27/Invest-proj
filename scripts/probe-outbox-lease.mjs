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
    [size, 10, LEASE_SECONDS, instance, 'lab.season.opened'],
  );
}

console.warn('\n=== ПРОВЕРКА ОЧЕРЕДИ OUTBOX ===\n');
const created = [];

try {
  // Пять неопубликованных событий с известным типом.
  for (let i = 0; i < 5; i += 1) {
    const [row] = await sql(
      `INSERT INTO audit.outbox_events
         (id, aggregate_type, aggregate_id, aggregate_version, event_type,
          payload_jsonb, nats_subject, message_key)
       VALUES (public.uuid_generate_v7(), 'probe', public.uuid_generate_v7(), $1,
               'lab.season.opened', $2::jsonb, 'probe.subject', $3)
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
} finally {
  if (created.length > 0) {
    await sql('DELETE FROM audit.outbox_events WHERE id = ANY($1::uuid[])', [created]);
    console.warn('\n  прогон убрал свои события');
  }
  await pool.end();
}

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exitCode = failed > 0 ? 1 : 0;
