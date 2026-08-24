import { createHash, createHmac } from 'node:crypto';

/**
 * Подписанные запросы к объектному хранилищу (SigV4) без внешних зависимостей.
 *
 * Зачем свой код вместо SDK: у ядра его тоже нет — `apps/core/src/storage`
 * подписывает запросы сам. Держать в скриптах другой клиент означало бы, что
 * стенд и прогоны ходят в хранилище иначе, чем приложение, и расхождение
 * настроек (path-style, регион, кодирование ключа) вылезет не там, где его
 * ищут.
 *
 * Здесь только то, что нужно скриптам: PUT, HEAD, GET, DELETE по ключу.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');

const amzDate = (date) =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

function signingKey(secret, shortDate, region, service) {
  const kDate = createHmac('sha256', `AWS4${secret}`).update(shortDate).digest();
  const kRegion = createHmac('sha256', kDate).update(region).digest();
  const kService = createHmac('sha256', kRegion).update(service).digest();
  return createHmac('sha256', kService).update('aws4_request').digest();
}

/**
 * Настройки хранилища из окружения.
 *
 * Возвращает `null`, если хранилище не настроено: это законное состояние
 * (например, чистая машина без инфраструктуры), и вызывающий обязан сказать
 * об этом словами, а не упасть в середине работы.
 */
export function storageFromEnv(env = process.env) {
  const endpoint = (env.S3_ENDPOINT ?? '').replace(/\/+$/, '');
  const bucket = env.S3_BUCKET ?? '';
  const accessKey = env.S3_ACCESS_KEY_ID ?? '';
  const secretKey = env.S3_SECRET_ACCESS_KEY ?? '';
  if (!endpoint || !bucket || !accessKey || !secretKey) return null;
  return {
    endpoint,
    bucket,
    region: env.S3_REGION ?? 'us-east-1',
    accessKey,
    secretKey,
  };
}

/**
 * Запрос к объекту по ключу.
 *
 * Путь собирается в path-style (`/bucket/key`) — так же, как ядро работает с
 * MinIO. Каждый сегмент ключа кодируется отдельно: `encodeURIComponent` целиком
 * съел бы разделители и превратил `projects/a/b` в один сегмент.
 */
export async function s3Object(storage, method, key, body = null, headers = {}) {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`${storage.endpoint}/${storage.bucket}/${encodedKey}`);
  const payload = body ?? Buffer.alloc(0);
  const date = amzDate(new Date());
  const shortDate = date.slice(0, 8);
  const payloadHash = sha256Hex(payload);

  const signed = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': date,
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  };
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed[n]}\n`).join('');
  const canonicalRequest = [
    method,
    url.pathname,
    '',
    canonicalHeaders,
    names.join(';'),
    payloadHash,
  ].join('\n');

  const scope = `${shortDate}/${storage.region}/s3/aws4_request`;
  const stringToSign = [ALGORITHM, date, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(storage.secretKey, shortDate, storage.region, 's3'))
    .update(stringToSign, 'utf8')
    .digest('hex');

  return fetch(url.toString(), {
    method,
    headers: {
      ...signed,
      Authorization: `${ALGORITHM} Credential=${storage.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
    },
    body: body ? new Uint8Array(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
}
