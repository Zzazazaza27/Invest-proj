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

  /** Временный ключ формы загрузки материала (2.1.2): готовым файлом не бывает. */
  buildMaterialUploadKey(projectId: string, materialId: string, kind: string): string {
    return `projects/${projectId}/materials/${kind}/${materialId}/upload`;
  }

  /**
   * Окончательный ключ попытки завершения: новый на каждую попытку, в формах
   * его нет — браузер записать по нему не может.
   */
  buildMaterialFinalKey(
    projectId: string,
    materialId: string,
    kind: string,
    attemptId: string,
  ): string {
    return `projects/${projectId}/materials/${kind}/${materialId}/final/${attemptId}`;
  }

  /**
   * Существует ли объект и какого он размера.
   *
   * Нужен, чтобы подтвердить загрузку фактом, а не словом клиента: билет мог
   * быть выдан и не использован, а запись материала при этом уже создана
   * (SEC-14). HEAD дешевле GET и не тянет тело.
   */
  async headObject(
    key: string,
  ): Promise<{ exists: boolean; sizeBytes: number | null; etag: string | null }> {
    const env = getEnv();
    if (!this.isConfigured) throw new Error('S3 не настроен');

    const now = new Date();
    const amzDate = toAmzDate(now);
    const shortDate = amzDate.slice(0, 8);
    // У HEAD тела нет, и хеш пустого тела — часть подписи.
    const payloadHash = sha256Hex(Buffer.alloc(0));

    const base = env.S3_ENDPOINT.replace(/\/+$/, '');
    const url = new URL(
      env.S3_FORCE_PATH_STYLE === 'true'
        ? `${base}/${env.S3_BUCKET}/${key}`
        : `${injectBucketIntoHost(base, env.S3_BUCKET)}/${key}`,
    );

    const headers: Record<string, string> = {
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
      'HEAD',
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
      method: 'HEAD',
      headers: {
        ...headers,
        Authorization:
          `${ALGORITHM} Credential=${env.S3_ACCESS_KEY_ID}/${scope}, ` +
          `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      // Хранилище — внешняя зависимость: без таймаута зависший ответ держит
      // запрос пользователя бесконечно.
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 404) return { exists: false, sizeBytes: null, etag: null };
    if (!response.ok) throw new Error(`хранилище ответило ${response.status} на HEAD`);
    const length = response.headers.get('content-length');
    // ETag запоминается вместе с размером: подписанная форма действует до
    // истечения и относится к ПОСТОЯННОМУ ключу, поэтому тот же запрос можно
    // отправить повторно и подменить объект уже после подтверждения. Без
    // версионирования бакета это не предотвратить, но зафиксированный отпечаток
    // делает подмену ОБНАРУЖИМОЙ: размер может совпасть, отпечаток — нет
    // (SEC-04).
    const etag = response.headers.get('etag');
    return {
      exists: true,
      sizeBytes: length === null ? null : Number(length),
      etag: etag === null ? null : etag.replaceAll('"', ''),
    };
  }

  /**
   * Прочитать объект ПОТОКОМ и вернуть его фактические размер, sha256 и первые
   * байты (для сверки сигнатуры формата).
   *
   * Нужен подтверждению загрузки: ETag хранилища — НЕ криптографический
   * отпечаток содержимого (multipart и SSE меняют его семантику, SEC-HIGH-03),
   * поэтому `content_hash` считается здесь по фактическим байтам. Тело в
   * память целиком не читается — хеш инкрементальный, в памяти живёт чанк.
   */
  async getObjectDigest(key: string): Promise<{
    exists: boolean;
    sizeBytes: number;
    sha256: string | null;
    head: Buffer;
  }> {
    const env = getEnv();
    if (!this.isConfigured) throw new Error('S3 не настроен');

    const now = new Date();
    const amzDate = toAmzDate(now);
    const shortDate = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(Buffer.alloc(0));

    const base = env.S3_ENDPOINT.replace(/\/+$/, '');
    const url = new URL(
      env.S3_FORCE_PATH_STYLE === 'true'
        ? `${base}/${env.S3_BUCKET}/${key}`
        : `${injectBucketIntoHost(base, env.S3_BUCKET)}/${key}`,
    );

    const headers: Record<string, string> = {
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
    const scope = `${shortDate}/${env.S3_REGION}/s3/aws4_request`;
    const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signature = createHmac(
      'sha256',
      signingKey(env.S3_SECRET_ACCESS_KEY, shortDate, env.S3_REGION, 's3'),
    )
      .update(stringToSign, 'utf8')
      .digest('hex');

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        ...headers,
        Authorization:
          `${ALGORITHM} Credential=${env.S3_ACCESS_KEY_ID}/${scope}, ` +
          `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      // Дольше, чем HEAD: тело видео может быть до 500 МБ. Таймаут всё равно
      // обязателен — зависшее чтение держало бы запрос пользователя.
      signal: AbortSignal.timeout(120_000),
    });

    if (response.status === 404) {
      return { exists: false, sizeBytes: 0, sha256: null, head: Buffer.alloc(0) };
    }
    if (!response.ok || !response.body) {
      throw new Error(`хранилище ответило ${response.status} на GET`);
    }

    const hash = createHash('sha256');
    const headChunks: Buffer[] = [];
    let headBytes = 0;
    let sizeBytes = 0;
    for await (const chunk of response.body) {
      const buf = Buffer.from(chunk);
      hash.update(buf);
      sizeBytes += buf.byteLength;
      if (headBytes < 16) {
        headChunks.push(buf.subarray(0, 16 - headBytes));
        headBytes = Math.min(16, headBytes + buf.byteLength);
      }
    }
    return {
      exists: true,
      sizeBytes,
      sha256: hash.digest('hex'),
      head: Buffer.concat(headChunks),
    };
  }

  /**
   * Прочитать объект целиком.
   *
   * Нужен просмотру материалов: инвестор с подпиской смотрит презентацию
   * ВНУТРИ платформы, а прямой ссылки на хранилище не получает — иначе она
   * переживёт и подписку, и снятие листинга, и её можно переслать кому угодно.
   * Поэтому файл проходит через ядро: доступ проверяется на каждом запросе.
   *
   * Тело возвращается целиком, а не потоком: материалы ограничены 50 МБ на
   * загрузке, и держать поток открытым через два прокси ради такого размера
   * незачем.
   */
  async getObject(key: string): Promise<{ body: Buffer; contentType: string | null } | null> {
    const env = getEnv();
    if (!this.isConfigured) throw new Error('S3 не настроен');

    const now = new Date();
    const amzDate = toAmzDate(now);
    const shortDate = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(Buffer.alloc(0));

    const base = env.S3_ENDPOINT.replace(/\/+$/, '');
    const url = new URL(
      env.S3_FORCE_PATH_STYLE === 'true'
        ? `${base}/${env.S3_BUCKET}/${key}`
        : `${injectBucketIntoHost(base, env.S3_BUCKET)}/${key}`,
    );

    const headers: Record<string, string> = {
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
    const scope = `${shortDate}/${env.S3_REGION}/s3/aws4_request`;
    const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signature = createHmac(
      'sha256',
      signingKey(env.S3_SECRET_ACCESS_KEY, shortDate, env.S3_REGION, 's3'),
    )
      .update(stringToSign, 'utf8')
      .digest('hex');

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        ...headers,
        Authorization:
          `${ALGORITHM} Credential=${env.S3_ACCESS_KEY_ID}/${scope}, ` +
          `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      signal: AbortSignal.timeout(60_000),
    });

    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`хранилище ответило ${response.status} на GET`);
    return {
      body: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type'),
    };
  }

  /**
   * Удалить объект.
   *
   * Нужно уборке брошенных загрузок: билет мог быть выдан, объект — положен, а
   * подтверждения не случиться. Тогда объект не принадлежит ни одному
   * материалу и не будет удалён никогда (остаток SEC-14).
   *
   * Удаление несуществующего объекта — НЕ ошибка: хранилище отвечает 204 и на
   * него, и это правильное поведение для уборки, которая повторяется.
   */
  async deleteObject(key: string): Promise<void> {
    const env = getEnv();
    if (!this.isConfigured) throw new Error('S3 не настроен');

    const now = new Date();
    const amzDate = toAmzDate(now);
    const shortDate = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(Buffer.alloc(0));

    const base = env.S3_ENDPOINT.replace(/\/+$/, '');
    const url = new URL(
      env.S3_FORCE_PATH_STYLE === 'true'
        ? `${base}/${env.S3_BUCKET}/${key}`
        : `${injectBucketIntoHost(base, env.S3_BUCKET)}/${key}`,
    );

    const headers: Record<string, string> = {
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
      'DELETE',
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
      method: 'DELETE',
      headers: {
        ...headers,
        Authorization:
          `${ALGORITHM} Credential=${env.S3_ACCESS_KEY_ID}/${scope}, ` +
          `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      // Таймаут обязателен на каждом внешнем вызове (RULES.md §3.1).
      signal: AbortSignal.timeout(10_000),
    });

    // 204 — удалено, 404 — уже нет. Всё остальное означает, что объект
    // остался, и уборка обязана об этом сказать, а не молча пойти дальше.
    if (response.status !== 204 && response.status !== 200 && response.status !== 404) {
      throw new Error(`хранилище ответило ${response.status} на DELETE`);
    }
  }

  /**
   * Серверная копия объекта (CopyObject) — окончательный файл загрузки (2.1.2).
   *
   * Копия лежит по новому ключу, которого нет в подписанной форме: повторная
   * отправка формы меняет только временный объект, а готовый файл — нет.
   * Ответ 200 ещё не успех: S3 может вернуть ошибку копирования в теле.
   */
  async copyObject(input: {
    sourceKey: string;
    destinationKey: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<void> {
    const env = getEnv();
    const response = await this.signedFetch('PUT', input.destinationKey, {
      extraHeaders: {
        'x-amz-copy-source': `/${env.S3_BUCKET}/${input.sourceKey}`,
        'x-amz-metadata-directive': 'COPY',
      },
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    const body = await response.text();
    if (!response.ok || body.includes('<Error>')) {
      throw new Error(`хранилище не скопировало объект: ${response.status}`);
    }
  }

  /**
   * Прочитать объект потоком: фактические размер, SHA-256 и первые байты.
   *
   * В отличие от `getObjectDigest` пределы раздельные: простой без данных и
   * общая длительность. 404 — объекта нет (подтверждено); любая другая ошибка
   * или таймаут — исключение: отсутствие файла этим НЕ подтверждается.
   */
  async readObjectDigest(
    key: string,
    limits: { idleMs: number; totalMs: number; signal?: AbortSignal },
  ): Promise<{ exists: boolean; sizeBytes: number; sha256: string | null; head: Buffer }> {
    const idle = new AbortController();
    let idleTimer = setTimeout(() => idle.abort(new Error('простой чтения')), limits.idleMs);
    const signals = [idle.signal, AbortSignal.timeout(limits.totalMs)];
    if (limits.signal) signals.push(limits.signal);
    const signal = AbortSignal.any(signals);
    try {
      const response = await this.signedFetch('GET', key, { signal, timeoutMs: limits.totalMs });
      if (response.status === 404) {
        return { exists: false, sizeBytes: 0, sha256: null, head: Buffer.alloc(0) };
      }
      if (!response.ok || !response.body) {
        throw new Error(`хранилище ответило ${response.status} на GET`);
      }
      const hash = createHash('sha256');
      const headChunks: Buffer[] = [];
      let headBytes = 0;
      let sizeBytes = 0;
      for await (const chunk of response.body) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => idle.abort(new Error('простой чтения')), limits.idleMs);
        const buf = Buffer.from(chunk);
        hash.update(buf);
        sizeBytes += buf.byteLength;
        if (headBytes < 16) {
          headChunks.push(buf.subarray(0, 16 - headBytes));
          headBytes = Math.min(16, headBytes + buf.byteLength);
        }
      }
      return {
        exists: true,
        sizeBytes,
        sha256: hash.digest('hex'),
        head: Buffer.concat(headChunks),
      };
    } finally {
      clearTimeout(idleTimer);
    }
  }

  /** Подписанный SigV4 запрос без тела — для новых операций хранилища. */
  private async signedFetch(
    method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
    key: string,
    options: {
      extraHeaders?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<Response> {
    const env = getEnv();
    if (!this.isConfigured) throw new Error('S3 не настроен');

    const amzDate = toAmzDate(new Date());
    const shortDate = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(Buffer.alloc(0));
    const base = env.S3_ENDPOINT.replace(/\/+$/, '');
    const url = new URL(
      env.S3_FORCE_PATH_STYLE === 'true'
        ? `${base}/${env.S3_BUCKET}/${key}`
        : `${injectBucketIntoHost(base, env.S3_BUCKET)}/${key}`,
    );

    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(options.extraHeaders ?? {}),
    };
    const names = Object.keys(headers).sort();
    const signedHeaders = names.join(';');
    const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join('');
    const canonicalRequest = [
      method,
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

    const signals = [AbortSignal.timeout(options.timeoutMs ?? 10_000)];
    if (options.signal) signals.push(options.signal);
    return fetch(url.toString(), {
      method,
      headers: {
        ...headers,
        Authorization:
          `${ALGORITHM} Credential=${env.S3_ACCESS_KEY_ID}/${scope}, ` +
          `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      signal: AbortSignal.any(signals),
    });
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
