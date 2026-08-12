#!/usr/bin/env node
/**
 * Выгрузка журнала событий в холодное хранилище.
 *
 * Закрывает эксплуатационный пункт: «архив событий старше 90 дней уезжает в
 * холодное хранилище отдельной процедурой». Процедура — эта.
 *
 * Три решения, каждое со своей причиной.
 *
 * 1. **Только копирование, без удаления.** Срок хранения журнала оператора
 *    инвестиционной платформы определяется законом и Правилами платформы, а не
 *    удобством эксплуатации. Скрипт, умеющий удалять события, рано или поздно
 *    удалит их «для чистоты» — поэтому он этого не умеет вовсе.
 *
 * 2. **Отдельная процедура, а не задача ядра.** Выгрузка требует доступа ко
 *    ВСЕМУ журналу; давать такое право приложению незачем. Скрипт работает
 *    подключением владельца схем, как и миграции.
 *
 * 3. **Сверка цепочки до выгрузки.** Копия, снятая с повреждённой hash-chain,
 *    доказательством целостности не является — и в реестре помечается
 *    `chain_intact = false`, а не выглядит полноценным архивом.
 *
 * Прогон идемпотентен по ключу объекта: повторная выгрузка того же диапазона
 * упирается в UNIQUE и честно отказывает, а не создаёт вторую копию молча.
 *
 * Запуск:
 *   node scripts/archive-events.mjs                  # события старше 90 дней
 *   node scripts/archive-events.mjs --days 0         # всё, что старше «сейчас»
 *   node scripts/archive-events.mjs --dry-run        # посчитать, ничего не писать
 */
import pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

process.on('unhandledRejection', (reason) => {
  console.error('ВЫГРУЗКА ОБОРВАНА (unhandledRejection):', reason);
  process.exit(1);
});

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

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? Number(process.argv[index + 1]) : fallback;
}

const RETENTION_DAYS = arg('days', 90);
const DRY_RUN = process.argv.includes('--dry-run');
/** Сколько событий читается за раз: выгрузка не должна держать всё в памяти. */
const BATCH = 5_000;

const { S3Service, putObject, sha256Hex } = await import(
  new URL('../apps/core/dist/storage/s3.service.js', import.meta.url).href
);
const s3 = new S3Service();
if (!s3.isConfigured) {
  console.error('Хранилище не настроено: выгружать некуда.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

console.warn('\n=== ВЫГРУЗКА ЖУРНАЛА СОБЫТИЙ В ХОЛОДНОЕ ХРАНИЛИЩЕ ===\n');
console.warn(`порог: события старше ${RETENTION_DAYS} дней${DRY_RUN ? ' · сухой прогон' : ''}`);

const [{ boundary }] = await sql(`SELECT (now() - ($1 || ' days')::interval) AS boundary`, [
  String(RETENTION_DAYS),
]);

// Что уже выгружено: диапазон начинается там, где закончился прошлый архив.
// Иначе каждая выгрузка копировала бы всё с начала времён.
const [{ last_end: lastEnd }] = await sql(
  `SELECT coalesce(max(period_end), to_timestamp(0)) AS last_end FROM audit.event_archives`,
);

// Реестр утверждает, что копия существует. Проверяем это, а не верим записи:
// объект мог быть удалён из хранилища, и тогда «выгружено» — ложь, которую без
// проверки никто не заметит. Восстанавливаем ту же копию из журнала.
const [previous] = await sql(
  `SELECT object_key, period_start, period_end, sha256
     FROM audit.event_archives ORDER BY exported_at DESC LIMIT 1`,
);
if (previous) {
  const head = await s3.headObject(previous.object_key);
  if (!head.exists) {
    console.warn(`  ВНИМАНИЕ  объект прошлой выгрузки отсутствует: ${previous.object_key}`);
    const restored = await collectRange(previous.period_start, previous.period_end);
    const restoredDigest = sha256Hex(restored.body);
    if (restoredDigest !== previous.sha256) {
      // Тот же диапазон журнала обязан дать тот же файл. Расхождение означает,
      // что append-only журнал изменился, — это находка, а не повод перезаписать.
      console.error(
        'Восстановленная копия НЕ совпала с отпечатком из реестра: ' +
          `${restoredDigest} против ${previous.sha256}. Журнал изменился — разбирайтесь вручную.`,
      );
      process.exit(1);
    }
    if (DRY_RUN) {
      console.warn('  сухой прогон: восстановление объекта пропущено');
    } else {
      await putObject({
        key: previous.object_key,
        body: restored.body,
        contentType: 'application/x-ndjson',
      });
      console.warn('  OK    объект восстановлен из журнала, отпечаток совпал');
    }
  }
}

const [counts] = await sql(
  `SELECT count(*)::bigint AS total, min(ts) AS first_ts, max(ts) AS last_ts
     FROM audit.events WHERE ts > $1 AND ts <= $2`,
  [lastEnd, boundary],
);
const total = Number(counts.total);
console.warn(
  `к выгрузке: ${total} событий в диапазоне ` +
    `(${new Date(lastEnd).toISOString()} … ${new Date(boundary).toISOString()}]`,
);

if (total === 0) {
  console.warn('\nВыгружать нечего: в диапазоне нет событий.\n');
  await pool.end();
  process.exit(0);
}

// Сверка цепочки ДО выгрузки: копия с повреждённой цепочки архивом не является.
const broken = await sql('SELECT broken_event_id FROM audit.verify_event_chain($1)', [lastEnd]);
const chainIntact = broken.length === 0;
console.warn(
  chainIntact
    ? '  OK    hash-chain цела на момент выгрузки'
    : `  ВНИМАНИЕ  цепочка повреждена (${broken.length} разрывов) — архив будет помечен`,
);

// Ключ строится из диапазона: по нему видно, что внутри, без чтения файла.
const objectKey =
  `archive/audit-events/${new Date(boundary).toISOString().slice(0, 10)}/` +
  `events-${new Date(lastEnd).getTime()}-${new Date(boundary).getTime()}.jsonl`;

/**
 * Собрать события диапазона `(from, to]` в строки JSONL.
 *
 * Отдельной функцией, потому что тот же сбор нужен восстановлению утраченной
 * копии — и он обязан давать БАЙТ В БАЙТ тот же файл, иначе сверка отпечатка
 * ничего не доказывает.
 */
async function collectRange(from, to) {
  const lines = [];
  let firstEventId = null;
  let lastEventId = null;
  let offsetTs = from;
  let offsetId = '00000000-0000-0000-0000-000000000000';

  for (;;) {
    // Keyset по (ts, id) — тот же порядок, что и у первичного ключа: OFFSET на
    // сотнях тысяч строк превращает выгрузку в квадратичную.
    const batch = await sql(
      `SELECT id, ts, verb, actor_id, actor_role, subject_type, subject_id,
              context_jsonb, trace_id, encode(prev_hash, 'hex') AS prev_hash,
              encode(row_hash, 'hex') AS row_hash
         FROM audit.events
        WHERE ts <= $3 AND (ts, id) > ($1, $2)
        ORDER BY ts, id
        LIMIT ${BATCH}`,
      [offsetTs, offsetId, to],
    );
    if (batch.length === 0) break;

    for (const row of batch) {
      firstEventId ??= row.id;
      lastEventId = row.id;
      lines.push(
        JSON.stringify({
          id: row.id,
          ts: row.ts.toISOString(),
          verb: row.verb,
          actorId: row.actor_id,
          actorRole: row.actor_role,
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          context: row.context_jsonb,
          traceId: row.trace_id,
          prevHash: row.prev_hash,
          rowHash: row.row_hash,
        }),
      );
    }
    const tail = batch[batch.length - 1];
    offsetTs = tail.ts;
    offsetId = tail.id;
    if (batch.length < BATCH) break;
  }

  return { lines, firstEventId, lastEventId, body: Buffer.from(`${lines.join('\n')}\n`, 'utf8') };
}

const collected = await collectRange(lastEnd, boundary);
const lines = collected.lines;
const firstEventId = collected.firstEventId;
const lastEventId = collected.lastEventId;
const body = collected.body;
const digest = sha256Hex(body);
console.warn(
  `  собрано строк: ${lines.length}, размер ${body.length} байт, sha256 ${digest.slice(0, 16)}…`,
);

if (DRY_RUN) {
  console.warn('\nСухой прогон: в хранилище и в реестр ничего не записано.\n');
  await pool.end();
  process.exit(0);
}

await putObject({ key: objectKey, body, contentType: 'application/x-ndjson' });

// «Записано» подтверждается чтением обратно, а не кодом ответа: хранилище
// может принять запрос и сохранить не то (проверено на политике бакета).
const head = await s3.headObject(objectKey);
if (!head.exists || head.sizeBytes !== body.length) {
  console.error(
    `Объект в хранилище не совпал с выгруженным: exists=${head.exists}, ` +
      `size=${head.sizeBytes} против ${body.length}`,
  );
  process.exit(1);
}
console.warn(`  OK    объект в хранилище: ${objectKey} (${head.sizeBytes} байт)`);

await sql(
  `INSERT INTO audit.event_archives
     (period_start, period_end, object_key, event_count, sha256,
      first_event_id, last_event_id, chain_intact)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [lastEnd, boundary, objectKey, lines.length, digest, firstEventId, lastEventId, chainIntact],
);
console.warn('  OK    запись в реестре выгрузок создана');

console.warn(
  `\nВыгружено ${lines.length} событий. События в журнале НЕ удалены: ` +
    'выгрузка только копирует.\n',
);
await pool.end();
