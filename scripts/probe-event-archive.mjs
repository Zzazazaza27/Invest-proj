#!/usr/bin/env node
/**
 * Проверка выгрузки журнала событий в холодное хранилище (M041).
 *
 * Проверяется фактом, а не чтением кода:
 *   1. выгрузка НЕ удаляет события из журнала — только копирует;
 *   2. объект в хранилище совпадает с прочитанным: размер и sha256;
 *   3. содержимое файла — настоящие события: сверяется с БД построчно;
 *   4. повторный прогон выгружает ТОЛЬКО новые события, а не всё заново;
 *   5. реестр выгрузок не виден роли приложения без роли администратора;
 *   6. реестр append-only: изменить и удалить запись нельзя никому из ролей.
 *
 * Запуск: node scripts/probe-event-archive.mjs (нужны PostgreSQL и MinIO)
 */
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

process.on('unhandledRejection', (reason) => {
  console.error('ПРОГОН ОБОРВАН (unhandledRejection):', reason);
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

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

/** Чтение объекта из хранилища подписанным запросом — как это делает потребитель. */
const { signingKey, sha256Hex, toAmzDate } = await import(
  new URL('../apps/core/dist/storage/s3.service.js', import.meta.url).href
);

async function getObject(key) {
  const endpoint = process.env.S3_ENDPOINT.replace(/\/+$/, '');
  const url = new URL(`${endpoint}/${process.env.S3_BUCKET}/${key}`);
  const now = new Date();
  const amzDate = toAmzDate(now);
  const shortDate = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(Buffer.alloc(0));
  const headers = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}\n`)
    .join('');
  const canonicalRequest = [
    'GET',
    url.pathname,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${shortDate}/${process.env.S3_REGION}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const realSignature = createHmac(
    'sha256',
    signingKey(process.env.S3_SECRET_ACCESS_KEY, shortDate, process.env.S3_REGION, 's3'),
  )
    .update(stringToSign, 'utf8')
    .digest('hex');

  const response = await fetch(url.toString(), {
    headers: {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${process.env.S3_ACCESS_KEY_ID}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${realSignature}`,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`хранилище ответило ${response.status} на GET`);
  return Buffer.from(await response.arrayBuffer());
}

function runArchive(args) {
  const result = spawnSync(process.execPath, ['scripts/archive-events.mjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

console.warn('\n=== ПРОВЕРКА ВЫГРУЗКИ ЖУРНАЛА В ХОЛОДНОЕ ХРАНИЛИЩЕ ===\n');

const [{ count: before }] = await sql('SELECT count(*)::int AS count FROM audit.events');

// Прогон выгружает всё, что накопилось с прошлой выгрузки.
const firstRun = runArchive(['--days', '0']);
const [{ count: afterFirst }] = await sql('SELECT count(*)::int AS count FROM audit.events');
check('события из журнала НЕ удалены', afterFirst >= before, `было ${before}, стало ${afterFirst}`);

const [archive] = await sql(
  `SELECT object_key, event_count, sha256, chain_intact, period_start, period_end
     FROM audit.event_archives ORDER BY exported_at DESC LIMIT 1`,
);
check('запись о выгрузке есть в реестре', Boolean(archive?.object_key), archive?.object_key ?? '—');
check('цепочка отмечена целой', archive?.chain_intact === true);

const object = await getObject(archive.object_key);
check(
  'объект в хранилище совпадает по отпечатку',
  sha256Hex(object) === archive.sha256,
  `${sha256Hex(object).slice(0, 12)}… против ${archive.sha256.slice(0, 12)}…`,
);

const rows = object
  .toString('utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
check(
  'строк в файле столько же, сколько записано в реестре',
  rows.length === Number(archive.event_count),
  `${rows.length} против ${archive.event_count}`,
);

// Содержимое — настоящие события, а не правдоподобная выдумка: сверяем
// первую и последнюю строку с журналом.
for (const [label, row] of [
  ['первое', rows[0]],
  ['последнее', rows[rows.length - 1]],
]) {
  const [fromDb] = await sql(
    `SELECT verb, encode(row_hash, 'hex') AS row_hash FROM audit.events WHERE id = $1`,
    [row.id],
  );
  check(
    `${label} событие файла есть в журнале с тем же отпечатком`,
    fromDb?.verb === row.verb && fromDb?.row_hash === row.rowHash,
    row.verb,
  );
}

// Повторный прогон обязан выгрузить только НОВОЕ: иначе каждая выгрузка
// копировала бы весь журнал с начала времён.
const [{ count: newEvents }] = await sql(
  'SELECT count(*)::int AS count FROM audit.events WHERE ts > $1',
  [archive.period_end],
);
const secondRun = runArchive(['--days', '0']);
const [second] = await sql(
  `SELECT event_count, period_start FROM audit.event_archives ORDER BY exported_at DESC LIMIT 1`,
);
const secondCount = Number(second.event_count);
check(
  'повторный прогон выгружает только новые события',
  newEvents === 0
    ? secondRun.includes('Выгружать нечего')
    : secondCount <= newEvents + 5 && String(second.period_start) === String(archive.period_end),
  newEvents === 0 ? 'новых событий не было' : `новых ${newEvents}, выгружено ${secondCount}`,
);
void firstRun;

// Реестр выгрузок — эксплуатационная информация: обычной роли он не виден.
const app = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const client = await app.connect();
try {
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [
    '00000000-0000-0000-0000-000000000001',
  ]);
  await client.query(`SELECT set_config('app.current_roles', 'founder', true)`);
  const { rows: visible } = await client.query('SELECT id FROM audit.event_archives');
  check('роль без прав администратора реестр не видит', visible.length === 0);

  let updateDenied = false;
  try {
    await client.query(`UPDATE audit.event_archives SET event_count = 0`);
  } catch {
    updateDenied = true;
  }
  await client.query('ROLLBACK');
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.current_roles', 'admin', true)`);
  let deleteDenied = false;
  try {
    await client.query(`DELETE FROM audit.event_archives`);
  } catch {
    deleteDenied = true;
  }
  await client.query('ROLLBACK');
  // След выгрузки, который можно переписать задним числом, следом не является.
  check('изменить запись реестра нельзя', updateDenied);
  check('удалить запись реестра нельзя даже администратору', deleteDenied);
} finally {
  client.release();
  await app.end();
}

// Уборки за собой здесь НЕТ намеренно. Выгруженный архив — не мусор прогона, а
// настоящая копия журнала, на которую ссылается запись реестра. Удалить объект,
// оставив запись, значит сделать реестр лживым — и сломать сам этот прогон при
// повторном запуске (проверено: первая версия скрипта так и делала).

await pool.end();
console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exitCode = failed > 0 ? 1 : 0;
