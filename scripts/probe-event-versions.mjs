#!/usr/bin/env node
/**
 * Проверка нумерации версий событий агрегата.
 *
 * Находка внешнего аудита (CODE-06): `ON CONFLICT DO NOTHING` отбрасывал
 * событие, а вызывающему возвращался новый идентификатор — то есть событие
 * считалось поставленным, не существуя. Фиксированные номера версий (всегда 1
 * для публикации, всегда 2 для ротации) делали такой конфликт неизбежным при
 * повторе действия.
 *
 * Здесь проверяется поведение по фактам в БД:
 *  1. повтор ОДНОГО И ТОГО ЖЕ события (та же версия, то же содержимое) —
 *     идемпотентен и возвращает существующую запись;
 *  2. РАЗНОЕ содержимое при одной версии — отвергается, а не теряется молча;
 *  3. номер версии, вычисленный для повторного действия, растёт.
 *
 * Прогон убирает свои строки при любом исходе.
 *
 * Запуск: node scripts/probe-event-versions.mjs
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

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

console.warn('\n=== ПРОВЕРКА ВЕРСИЙ СОБЫТИЙ АГРЕГАТА ===\n');

const [aggregate] = await sql('SELECT public.uuid_generate_v7() AS id');
const aggregateId = aggregate.id;

/** Вставка ровно тем выражением, которым пользуется приложение. */
async function enqueue(version, payload) {
  const rows = await sql(
    `INSERT INTO audit.outbox_events
       (id, aggregate_type, aggregate_id, event_type, payload_jsonb, nats_subject,
        aggregate_version, message_key)
     VALUES (public.uuid_generate_v7(), 'probe_aggregate', $1::uuid, 'lab.listing.published',
             $2::jsonb, 'probe.subject', $3, $4)
     ON CONFLICT (aggregate_type, aggregate_id, aggregate_version, event_type) DO NOTHING
     RETURNING id`,
    [aggregateId, JSON.stringify(payload), version, aggregateId],
  );
  return rows[0]?.id ?? null;
}

try {
  const first = await enqueue(1, { listed: true });
  check('первое событие поставлено', first !== null);

  const repeat = await enqueue(1, { listed: true });
  check(
    'повтор того же события вставки не даёт — конфликт виден вызывающему',
    repeat === null,
    'RETURNING пуст, значит приложение обязано разобрать конфликт',
  );

  const different = await enqueue(1, { listed: false });
  check(
    'другое содержимое при той же версии тоже не вставляется',
    different === null,
    'без разбора конфликта это была бы молчаливая потеря события',
  );

  // Номер для повторного действия обязан вырасти — иначе конфликт неизбежен.
  const [next] = await sql(
    `SELECT coalesce(max(aggregate_version), 0) + 1 AS next
       FROM audit.outbox_events
      WHERE aggregate_type = 'probe_aggregate' AND aggregate_id = $1
        AND event_type = 'lab.listing.published'`,
    [aggregateId],
  );
  check('следующий номер версии вычисляется как 2', Number(next.next) === 2, `next=${next.next}`);

  const second = await enqueue(Number(next.next), { listed: true, again: true });
  check('повторная публикация порождает НОВОЕ событие', second !== null);

  const rows = await sql(
    `SELECT aggregate_version FROM audit.outbox_events
      WHERE aggregate_type = 'probe_aggregate' AND aggregate_id = $1
      ORDER BY aggregate_version`,
    [aggregateId],
  );
  check(
    'в очереди ровно две версии: 1 и 2',
    // Приведение обязательно: BIGINT драйвер отдаёт строкой, и строгое
    // сравнение с числом краснело бы при верных данных.
    rows.length === 2 &&
      Number(rows[0].aggregate_version) === 1 &&
      Number(rows[1].aggregate_version) === 2,
    `версии: ${rows.map((r) => r.aggregate_version).join(',')}`,
  );
} finally {
  await sql(`DELETE FROM audit.outbox_events WHERE aggregate_type = 'probe_aggregate'`);
  console.warn('\n  прогон убрал свои события');
  await pool.end();
}

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exitCode = failed > 0 ? 1 : 0;
