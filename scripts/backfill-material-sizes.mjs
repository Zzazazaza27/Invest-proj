#!/usr/bin/env node
/**
 * Дозаполнение `lab.project_materials.size_bytes` (Ф28).
 *
 * 25 исторических строк подтверждены до M044: размер объекта тогда не
 * собирался, и ограничение `project_materials_confirmed_has_size` (M047,
 * NOT VALID) нельзя провалидировать. Размер — свойство объекта в хранилище,
 * поэтому источник — само хранилище: HEAD по каждому объекту под учёткой
 * приложения, размер из `content-length`.
 *
 * Ничего не удаляет и не выдумывает: строка без объекта в хранилище остаётся
 * нетронутой и попадает в итоговый список — это решение для владельца, а не
 * для скрипта. VALIDATE CONSTRAINT (M051) пройдёт только когда таких строк
 * не останется.
 *
 * Запуск: node scripts/backfill-material-sizes.mjs [--dry-run]
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRY_RUN = process.argv.includes('--dry-run');

// .env — тем же способом, что остальные скрипты стенда.
const envFile = resolve(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

const ENDPOINT = (process.env.S3_ENDPOINT ?? '').replace(/\/+$/, '');
const BUCKET = process.env.S3_BUCKET ?? '';
const REGION = process.env.S3_REGION ?? 'us-east-1';
const ACCESS_KEY = process.env.S3_ACCESS_KEY_ID ?? '';
const SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY ?? '';
const DB_URL = process.env.DATABASE_URL_OWNER ?? '';
if (!ENDPOINT || !BUCKET || !ACCESS_KEY || !SECRET_KEY || !DB_URL) {
  console.error(
    'нужны S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, DATABASE_URL_OWNER',
  );
  process.exit(2);
}

const ALGORITHM = 'AWS4-HMAC-SHA256';
const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');
const amzDate = (d) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
function signingKey(secret, shortDate, region, service) {
  const kDate = createHmac('sha256', `AWS4${secret}`).update(shortDate).digest();
  const kRegion = createHmac('sha256', kDate).update(region).digest();
  const kService = createHmac('sha256', kRegion).update(service).digest();
  return createHmac('sha256', kService).update('aws4_request').digest();
}

/** HEAD объекта c подписью SigV4; возвращает размер или null, если объекта нет. */
async function headObject(key) {
  const url = new URL(`${ENDPOINT}/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`);
  const now = new Date();
  const date = amzDate(now);
  const shortDate = date.slice(0, 8);
  const payloadHash = sha256Hex(Buffer.alloc(0));
  const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': date };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((n) => `${n}:${headers[n]}\n`)
    .join('');
  const canonicalRequest = [
    'HEAD',
    url.pathname,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${shortDate}/${REGION}/s3/aws4_request`;
  const stringToSign = [ALGORITHM, date, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(SECRET_KEY, shortDate, REGION, 's3'))
    .update(stringToSign, 'utf8')
    .digest('hex');
  const res = await fetch(url.toString(), {
    method: 'HEAD',
    headers: {
      ...headers,
      Authorization: `${ALGORITHM} Credential=${ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    signal: AbortSignal.timeout(15_000), // таймаут на каждый внешний вызов
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HEAD ${key}: ${res.status}`);
  const len = Number(res.headers.get('content-length'));
  if (!Number.isFinite(len) || len < 0) throw new Error(`HEAD ${key}: нечитаемый content-length`);
  return len;
}

const pool = new pg.Pool({ connectionString: DB_URL, max: 2 });
try {
  const { rows } = await pool.query(
    `SELECT id, s3_key FROM lab.project_materials
      WHERE s3_key IS NOT NULL AND uploaded_at IS NOT NULL AND size_bytes IS NULL
      ORDER BY id`,
  );
  console.warn(`строк без размера: ${rows.length}${DRY_RUN ? ' (dry-run)' : ''}`);
  let filled = 0;
  const missing = [];
  for (const row of rows) {
    const size = await headObject(row.s3_key);
    if (size === null) {
      missing.push(row);
      continue;
    }
    if (!DRY_RUN) {
      await pool.query(`UPDATE lab.project_materials SET size_bytes = $2 WHERE id = $1`, [
        row.id,
        size,
      ]);
    }
    filled += 1;
  }
  console.warn(`дозаполнено из хранилища: ${filled}`);
  if (missing.length > 0) {
    console.error(`объект НЕ найден в хранилище — строки не тронуты (${missing.length}):`);
    for (const m of missing) console.error(`  id=${m.id} s3_key=${m.s3_key}`);
    console.error('решение по таким строкам — за владельцем; VALIDATE (M051) их не пропустит.');
    process.exit(1);
  }
} finally {
  await pool.end();
}
