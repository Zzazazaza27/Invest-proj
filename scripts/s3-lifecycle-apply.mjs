#!/usr/bin/env node
/**
 * Политика жизненного цикла бакета материалов.
 *
 * Вторая половина уборки за брошенными загрузками (остаток SEC-14). Фоновая
 * уборка в ядре снимает объекты, у которых есть строка материала. Она НЕ видит
 * двух видов мусора:
 *
 *  1. **Незавершённые multipart-загрузки.** Части, отправленные без финального
 *     `CompleteMultipartUpload`, не являются объектом: их не видно ни в списке
 *     объектов, ни через HEAD, но место они занимают и оплачиваются.
 *  2. **Объекты, чья строка исчезла** — например, после ручного вмешательства в
 *     БД. Ссылки на них не осталось нигде.
 *
 * Что политика делает — и чего НЕ делает. Правил на удаление объектов по сроку
 * здесь НЕТ намеренно: ключи материалов лежат под `projects/…`, и срок жизни
 * такого правила означал бы автоматическое удаление НАСТОЯЩИХ материалов
 * проекта. Единственное безопасное автоматическое правило — обрыв незавершённых
 * multipart-загрузок; всё остальное решает уборка, которая знает, есть ли у
 * объекта владелец.
 *
 * Прогон идемпотентен: политика перезаписывается целиком.
 *
 * Запуск: node scripts/s3-lifecycle-apply.mjs [--show]
 */
import { createHash, createHmac } from 'node:crypto';
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

const ENDPOINT = (process.env.S3_ENDPOINT ?? '').replace(/\/+$/, '');
const BUCKET = process.env.S3_BUCKET ?? '';
const REGION = process.env.S3_REGION ?? 'ru-central1';
const ACCESS_KEY = process.env.S3_ACCESS_KEY_ID ?? '';
const SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY ?? '';
const PATH_STYLE = (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true';

if (!ENDPOINT || !BUCKET || !ACCESS_KEY || !SECRET_KEY) {
  console.error('Хранилище не настроено: нужны S3_ENDPOINT, S3_BUCKET и пара ключей.');
  process.exit(1);
}

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SIGV4_PREFIX = Buffer.from('AWS4', 'utf8');

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}
function hmac(key, data) {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}
function signingKey(keySeed, date, region, service) {
  const kDate = hmac(Buffer.concat([SIGV4_PREFIX, Buffer.from(keySeed, 'utf8')]), date);
  return hmac(hmac(hmac(kDate, region), service), 'aws4_request');
}
function amzDate(now) {
  return `${now.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

/**
 * Единственное безопасное автоматическое правило: оборвать незавершённые
 * multipart-загрузки через сутки. Сутки, а не час: крупный файл по плохому
 * каналу грузится долго, и обрывать его на середине — это уже не уборка.
 */
const LIFECYCLE_XML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
  '<Rule>' +
  '<ID>abort-incomplete-multipart</ID>' +
  '<Filter><Prefix></Prefix></Filter>' +
  '<Status>Enabled</Status>' +
  // `ExpiredObjectDeleteMarker` убирает ТОЛЬКО осиротевшие маркеры удаления в
  // версионированном бакете и никогда не трогает данные объекта. Он стоит здесь
  // не ради себя: проверенное хранилище (MinIO RELEASE.2024-12-18) отвергает
  // правило, у которого нет ни одного действия из группы Expiration, —
  // проверено тремя вариантами XML подряд. Настоящее AWS принимает правило и
  // без него, поэтому конфигурация остаётся совместимой с обоими.
  '<Expiration><ExpiredObjectDeleteMarker>true</ExpiredObjectDeleteMarker></Expiration>' +
  '<AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation>' +
  '</AbortIncompleteMultipartUpload>' +
  '</Rule>' +
  '</LifecycleConfiguration>';

function bucketUrl(query) {
  const base = PATH_STYLE
    ? `${ENDPOINT}/${BUCKET}`
    : (() => {
        const u = new URL(ENDPOINT);
        u.hostname = `${BUCKET}.${u.hostname}`;
        return u.toString().replace(/\/+$/, '');
      })();
  return new URL(`${base}?${query}`);
}

async function signedRequest(method, url, body) {
  const now = new Date();
  const date = amzDate(now);
  const shortDate = date.slice(0, 8);
  const payload = body ?? Buffer.alloc(0);
  const payloadHash = sha256Hex(payload);

  const headers = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': date,
  };
  if (body) {
    // Спецификация S3 требует Content-MD5 у PutBucketLifecycleConfiguration.
    headers['content-md5'] = createHash('md5').update(payload).digest('base64');
    headers['content-type'] = 'application/xml';
  }

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}\n`)
    .join('');
  // Канонический запрос требует форму `ключ=значение` даже у флагов без
  // значения: `?lifecycle` подписывается как `lifecycle=`. Без знака равенства
  // подпись не сходится, а хранилище отвечает SignatureDoesNotMatch, ничего не
  // подсказывая (поймано прогоном).
  const canonicalQuery = url.search
    .slice(1)
    .split('&')
    .filter(Boolean)
    .map((part) => {
      const [key, value = ''] = part.split('=');
      return `${encodeURIComponent(decodeURIComponent(key))}=${encodeURIComponent(decodeURIComponent(value))}`;
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
      Authorization:
        `${ALGORITHM} Credential=${ACCESS_KEY}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: body ? new Uint8Array(body) : undefined,
    // Таймаут обязателен на каждом внешнем вызове (RULES.md §3.1).
    signal: AbortSignal.timeout(15_000),
  });
}

const showOnly = process.argv.includes('--show');

if (!showOnly) {
  const put = await signedRequest(
    'PUT',
    bucketUrl('lifecycle'),
    Buffer.from(LIFECYCLE_XML, 'utf8'),
  );
  if (!put.ok) {
    console.error(`Хранилище отклонило политику: HTTP ${put.status}`);
    console.error((await put.text()).slice(0, 500));
    process.exit(1);
  }
  console.warn(`Политика жизненного цикла применена к бакету ${BUCKET}.`);
}

// Проверка читает то, что реально записано, а не то, что мы отправляли:
// «применено» без чтения обратно — это намерение, а не факт.
const get = await signedRequest('GET', bucketUrl('lifecycle'));
if (!get.ok) {
  console.error(`Не удалось прочитать политику обратно: HTTP ${get.status}`);
  process.exit(1);
}
const xml = await get.text();
const hasAbortRule = xml.includes('AbortIncompleteMultipartUpload');
// Опасно ровно одно: удаление объектов по возрасту или дате. Проверяется именно
// оно, а не наличие блока Expiration вообще — внутри него лежит безобидный
// ExpiredObjectDeleteMarker.
const deletesByAge = /<Days>|<Date>/.test(xml);

console.warn(
  `  ${deletesByAge ? 'FAIL' : 'OK  '} правил удаления объектов по сроку нет` +
    (deletesByAge ? ' — материалы проекта удалялись бы автоматически' : ''),
);

if (hasAbortRule) {
  console.warn('  OK   правило обрыва незавершённых загрузок сохранено хранилищем');
} else {
  // Хранилище ответило 200, но правило НЕ сохранило. Обнаружено чтением
  // политики обратно: без него прогон объявил бы применённым то, чего в бакете
  // нет. MinIO RELEASE.2024-12-18 молча отбрасывает действие
  // AbortIncompleteMultipartUpload; production-хранилища (AWS S3, Yandex Object
  // Storage) его поддерживают.
  //
  // На текущий контур это не влияет: загрузка идёт одним запросом по presigned
  // POST policy, multipart подписанной формой не разрешён, поэтому и обрывать
  // нечего. Правило остаётся эшелоном защиты для production.
  console.warn(
    '  WARN хранилище приняло запрос, но правило обрыва незавершённых загрузок ' +
      'НЕ сохранило — это ограничение хранилища, а не конфигурации',
  );
}

process.exitCode = deletesByAge ? 1 : 0;
