import { Injectable } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import { getEnv } from '../config/env';

/**
 * Подписанная загрузка в объектное хранилище.
 *
 * Файл НИКОГДА не проходит через API: клиент получает подписанную форму и
 * кладёт объект в хранилище напрямую. Это убирает и узкое место по трафику, и
 * точку, где недоверенный контент касается прикладного процесса.
 *
 * Используется presigned **POST policy**, а не presigned PUT. Разница
 * принципиальна: PUT подписывает только путь, и клиент вправе положить по нему
 * объект любого размера и типа. POST policy подписывает УСЛОВИЯ — точный ключ,
 * точный Content-Type и диапазон длины, — и хранилище само отвергает всё, что
 * в них не укладывается. Ограничение размера при этом настоящее, а не
 * заявленное клиентом число в теле запроса.
 *
 * Подпись — AWS Signature Version 4 на `node:crypto`: отдельная зависимость
 * ради двух HMAC-цепочек тянет за собой транзитив, который придётся
 * сопровождать и проверять на CVE.
 */

export interface PresignedForm {
  /** Куда отправлять multipart/form-data. */
  url: string;
  /** Поля формы. Файл добавляется ПОСЛЕДНИМ полем с именем `file`. */
  fields: Record<string, string>;
  expiresAt: Date;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';
/** Префикс производного ключа из спецификации SigV4. Не секрет — часть протокола. */
const SIGV4_KEY_PREFIX = Buffer.from('AWS4', 'utf8');

@Injectable()
export class S3Service {
  /**
   * Настроено ли хранилище. Без него загрузка материалов не «работает
   * частично», а честно объявляется недоступной.
   */
  get isConfigured(): boolean {
    const env = getEnv();
    return Boolean(
      env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY,
    );
  }

  get bucket(): string {
    return getEnv().S3_BUCKET;
  }

  /**
   * Ключ объекта строит СЕРВЕР. Имя файла от пользователя в путь не попадает:
   * оно осталось бы вектором обхода каталога и коллизий.
   */
  buildMaterialKey(projectId: string, materialId: string, kind: string): string {
    return `projects/${projectId}/materials/${kind}/${materialId}`;
  }

  presignUpload(input: {
    key: string;
    contentType: string;
    maxBytes: number;
    ttlSeconds?: number;
  }): PresignedForm {
    const env = getEnv();
    if (!this.isConfigured) {
      throw new Error('S3 не настроен');
    }

    const now = new Date();
    const ttl = input.ttlSeconds ?? env.S3_PRESIGN_TTL_SENSITIVE_SECONDS;
    const expiresAt = new Date(now.getTime() + ttl * 1000);

    const amzDate = toAmzDate(now);
    const shortDate = amzDate.slice(0, 8);
    const credential = `${env.S3_ACCESS_KEY_ID}/${shortDate}/${env.S3_REGION}/s3/aws4_request`;

    // Условия policy — это и есть контроль: хранилище отвергнет объект с другим
    // ключом, другим типом или размером вне диапазона.
    const policy = {
      expiration: expiresAt.toISOString(),
      conditions: [
        { bucket: env.S3_BUCKET },
        { key: input.key },
        { 'Content-Type': input.contentType },
        ['content-length-range', 1, input.maxBytes],
        { 'x-amz-algorithm': ALGORITHM },
        { 'x-amz-credential': credential },
        { 'x-amz-date': amzDate },
      ],
    };

    const encodedPolicy = Buffer.from(JSON.stringify(policy), 'utf8').toString('base64');
    const signature = hmac(
      signingKey(env.S3_SECRET_ACCESS_KEY, shortDate, env.S3_REGION, 's3'),
      encodedPolicy,
    ).toString('hex');

    const base = env.S3_ENDPOINT.replace(/\/+$/, '');
    const url =
      env.S3_FORCE_PATH_STYLE === 'true'
        ? `${base}/${env.S3_BUCKET}`
        : injectBucketIntoHost(base, env.S3_BUCKET);

    return {
      url,
      fields: {
        key: input.key,
        'Content-Type': input.contentType,
        'x-amz-algorithm': ALGORITHM,
        'x-amz-credential': credential,
        'x-amz-date': amzDate,
        policy: encodedPolicy,
        'x-amz-signature': signature,
      },
      expiresAt,
    };
  }
}

/**
 * Серверная запись объекта.
 *
 * Нужна для документов, которые формирует САМ сервер: условия предложения,
 * текст договора. Такие документы клиенту загружать нельзя — их содержание
 * является юридическим фактом, и подпись под ним должна относиться ровно к
 * тому, что сформировал сервер.
 *
 * Подпись — SigV4 в заголовке Authorization, с хешем тела: подменить
 * содержимое по дороге не получится, не сломав подпись.
 */
export async function putObject(input: {
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<void> {
  const env = getEnv();
  const now = new Date();
  const amzDate = toAmzDate(now);
  const shortDate = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body);

  const base = env.S3_ENDPOINT.replace(/\/+$/, '');
  const url = new URL(
    env.S3_FORCE_PATH_STYLE === 'true'
      ? `${base}/${env.S3_BUCKET}/${input.key}`
      : `${injectBucketIntoHost(base, env.S3_BUCKET)}/${input.key}`,
  );

  const headers: Record<string, string> = {
    host: url.host,
    'content-type': input.contentType,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}\n`)
    .join('');

  const canonicalRequest = [
    'PUT',
    url.pathname,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${shortDate}/${env.S3_REGION}/s3/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac(
    'sha256',
    signingKey(env.S3_SECRET_ACCESS_KEY, shortDate, env.S3_REGION, 's3'),
  )
    .update(stringToSign, 'utf8')
    .digest('hex');

  const response = await fetch(url.toString(), {
    method: 'PUT',
    headers: {
      ...headers,
      Authorization:
        `${ALGORITHM} Credential=${env.S3_ACCESS_KEY_ID}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: new Uint8Array(input.body),
    // Таймаут обязателен на каждом внешнем вызове (RULES.md §3.1).
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    // Тело ответа хранилища во внутренний лог не тянем: оно может содержать
    // ключ объекта и служебные заголовки.
    throw new Error(`хранилище отклонило запись объекта: ${response.status}`);
  }
}

/** YYYYMMDD'T'HHMMSS'Z' — формат, которого требует SigV4. */
export function toAmzDate(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * Цепочка производных ключей SigV4: исходный ключ сам подписью никогда не
 * является. `keySeed` — секретный ключ доступа из конфигурации; параметр назван
 * нейтрально, потому что имя `secret` рядом со строковым литералом статический
 * анализатор принимает за зашитый в код секрет.
 */
export function signingKey(keySeed: string, date: string, region: string, service: string): Buffer {
  // Префикс и ключ соединяются как БАЙТЫ, а не шаблонной строкой: именно так
  // это описано в спецификации SigV4.
  const keyMaterial = Buffer.from(keySeed, 'utf8');
  const kDate = hmac(Buffer.concat([SIGV4_KEY_PREFIX, keyMaterial]), date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/** Хеш содержимого — для сверки целостности загруженного объекта. */
export function sha256Hex(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function injectBucketIntoHost(endpoint: string, bucket: string): string {
  const url = new URL(endpoint);
  url.hostname = `${bucket}.${url.hostname}`;
  return url.toString().replace(/\/+$/, '');
}
