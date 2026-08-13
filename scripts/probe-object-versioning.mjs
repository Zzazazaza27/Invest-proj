#!/usr/bin/env node
/**
 * Зонд версионирования хранилища (Ф29, остаток SEC-04).
 *
 * Угроза: подписанная форма загрузки действует до истечения срока и указывает
 * на постоянный ключ — повторная отправка перезаписывает объект ПОСЛЕ
 * подтверждения. Отпечаток (M044) делает подмену обнаружимой; версионирование
 * бакета делает её ОБРАТИМОЙ: прежнее содержимое остаётся отдельной версией.
 *
 * Что проверяется фактом, под учёткой приложения:
 *   1. объект записан, затем перезаписан тем же ключом другим содержимым;
 *   2. у ключа ≥2 версий (ListObjectVersions);
 *   3. прежняя версия читается по versionId и байт в байт равна исходному
 *      содержимому — то есть перезапись ничего не уничтожила.
 *
 * На бакете без версионирования шаг 2 даёт одну версию — зонд падает
 * (проверено приостановкой версионирования: см. отчёт Ф29).
 *
 * Object Lock зонд НЕ проверяет и не подменяет: он требует бакета, созданного
 * с --with-lock, и остаётся требованием к production-хранилищу.
 *
 * Запуск: node scripts/probe-object-versioning.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
if (!ENDPOINT || !BUCKET || !ACCESS_KEY || !SECRET_KEY) {
  console.error('нужны S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY');
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

/** Подписанный запрос SigV4. query — строка вида 'versions=&prefix=x' (уже канонична). */
async function s3(method, path, query = '', body = null) {
  const url = new URL(`${ENDPOINT}${path}${query ? `?${query}` : ''}`);
  const payload = body ?? Buffer.alloc(0);
  const date = amzDate(new Date());
  const shortDate = date.slice(0, 8);
  const payloadHash = sha256Hex(payload);
  const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': date };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((n) => `${n}:${headers[n]}\n`)
    .join('');
  const canonicalQuery = query
    .split('&')
    .filter(Boolean)
    .map((part) => {
      const [k, v = ''] = part.split('=');
      return `${encodeURIComponent(decodeURIComponent(k))}=${encodeURIComponent(decodeURIComponent(v))}`;
    })
    .sort()
    .join('&');
  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${shortDate}/${REGION}/s3/aws4_request`;
  const stringToSign = [ALGORITHM, date, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(SECRET_KEY, shortDate, REGION, 's3'))
    .update(stringToSign, 'utf8')
    .digest('hex');
  return fetch(url.toString(), {
    method,
    headers: {
      ...headers,
      Authorization: `${ALGORITHM} Credential=${ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: body ? new Uint8Array(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
}

let ok = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    ok += 1;
    console.warn(`  OK    ${name}`);
  } else {
    fail += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const key = `probe-versioning/${randomBytes(8).toString('hex')}.bin`;
const objectPath = `/${BUCKET}/${key}`;
const bodyA = Buffer.from(`оригинал-${randomBytes(16).toString('hex')}`);
const bodyB = Buffer.from(`подмена-${randomBytes(16).toString('hex')}`);

console.warn('=== ЗОНД ВЕРСИОНИРОВАНИЯ ХРАНИЛИЩА ===\n');

// 1. Запись и перезапись тем же ключом.
const put1 = await s3('PUT', objectPath, '', bodyA);
check('исходный объект записан', put1.ok, `status=${put1.status}`);
const put2 = await s3('PUT', objectPath, '', bodyB);
check('объект перезаписан тем же ключом', put2.ok, `status=${put2.status}`);

// 2. Список версий ключа.
const list = await s3('GET', `/${BUCKET}`, `versions=&prefix=${encodeURIComponent(key)}`);
check('список версий отвечает 200', list.ok, `status=${list.status}`);
const xml = await list.text();
const versionIds = [
  ...xml.matchAll(/<Version>[\s\S]*?<VersionId>([^<]+)<\/VersionId>[\s\S]*?<\/Version>/g),
].map((m) => m[1]);
check(
  'перезапись создала новую версию, прежняя сохранилась (версий ≥ 2)',
  versionIds.length >= 2,
  `версий: ${versionIds.length}${versionIds.length < 2 ? ' — версионирование бакета выключено?' : ''}`,
);

// 3. Прежняя версия читается и равна исходному содержимому байт в байт.
//    В ответе ListObjectVersions версии идут от новой к старой.
if (versionIds.length >= 2) {
  const oldest = versionIds[versionIds.length - 1];
  const got = await s3('GET', objectPath, `versionId=${encodeURIComponent(oldest)}`);
  check('прежняя версия читается по versionId', got.ok, `status=${got.status}`);
  const gotBytes = Buffer.from(await got.arrayBuffer());
  check(
    'содержимое прежней версии равно исходному байт в байт',
    gotBytes.equals(bodyA),
    `sha256 ожидался ${sha256Hex(bodyA).slice(0, 12)}, получен ${sha256Hex(gotBytes).slice(0, 12)}`,
  );
  const current = await s3('GET', objectPath);
  const curBytes = Buffer.from(await current.arrayBuffer());
  check('текущая версия — перезаписанное содержимое', curBytes.equals(bodyB));
}

// Уборка: удалить все версии тестового ключа, чтобы зонд не копил мусор.
for (const vid of versionIds) {
  await s3('DELETE', objectPath, `versionId=${encodeURIComponent(vid)}`);
}
if (versionIds.length === 0) await s3('DELETE', objectPath);
const after = await s3('GET', `/${BUCKET}`, `versions=&prefix=${encodeURIComponent(key)}`);
const leftover = ((await after.text()).match(/<VersionId>/g) ?? []).length;
check('тестовые версии убраны за собой', leftover === 0, `осталось: ${leftover}`);

console.warn(`\n=== ИТОГ: ${ok} OK, ${fail} FAIL ===`);
// НЕ process.exit: резкий выход при живых keep-alive сокетах fetch роняет
// libuv на Windows ассерцией (uv_handle_closing) и превращает 0 в 127.
process.exitCode = fail === 0 ? 0 : 1;
