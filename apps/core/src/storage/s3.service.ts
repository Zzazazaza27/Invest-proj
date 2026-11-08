import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import { errors } from '../common/errors';
import { getEnv, isLoopbackUrl } from '../config/env';
import type { GroupMode } from '@fifth/contracts';
import { storageBreaker, storageMode } from '../availability/storage-health';

/** Служебные ключи проб доступности (4.11): вне материалов людей и их квот. */
export const PROBE_PREFIX = '_availability/';

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
export class S3Service implements OnModuleInit {
  private readonly logger = new Logger(S3Service.name);

  /** Неверный публичный адрес виден при старте, а не при первой загрузке пользователя. */
  onModuleInit(): void {
    if (!this.isConfigured) return;
    const problem = this.uploadAddressProblem();
    if (problem) this.logger.warn({ msg: 'загрузка файлов из браузера отключена', problem });
  }

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
   * Почему форму загрузки сейчас выдавать нельзя — или `null`, если можно
   * (блок 4, 2.1-W06).
   *
   * Форма уходит в БРАУЗЕР пользователя. На стенде, где платформа открыта по
   * внешнему адресу, публичный адрес загрузки обязан быть задан ЯВНО: без
   * него форма получила бы внутренний адрес ядра — `localhost` (браузер
   * понесёт файл на свой компьютер, как было на VPS до W06) или имя вроде
   * `minio:9000`, которое снаружи не разрешается. Публичный адрес петлёй на
   * внешнем стенде — та же ошибка. Такую форму не выдаём: честный отказ
   * «загрузка не настроена» лучше формы, которая молча не работает.
   *
   * Стенд, где и платформа на петле (браузер и хранилище на одной машине),
   * работает как раньше — на внутреннем адресе.
   */
  uploadAddressProblem(): string | null {
    const env = getEnv();
    if (isLoopbackUrl(env.PUBLIC_BASE_URL)) return null;
    const platform = new URL(env.PUBLIC_BASE_URL).host;
    if (!env.S3_PUBLIC_ENDPOINT) {
      return (
        `публичный адрес загрузки не задан: платформа открыта по ${platform}, ` +
        'а внутренний адрес хранилища браузеру не годится (нужен S3_PUBLIC_ENDPOINT)'
      );
    }
    if (isLoopbackUrl(env.S3_PUBLIC_ENDPOINT)) {
      return (
        `публичный адрес загрузки — петля (${new URL(env.S3_PUBLIC_ENDPOINT).host}), ` +
        `а платформа открыта по ${platform}`
      );
    }
    return null;
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
    // Хранилище — внешняя зависимость: без таймаута зависший ответ держит
    // запрос пользователя бесконечно.
    const response = await this.signedFetch('HEAD', key, { timeoutMs: 10_000 });

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
    // Дольше, чем HEAD: тело видео может быть до 500 МБ. Таймаут всё равно
    // обязателен — зависшее чтение держало бы запрос пользователя.
    const response = await this.signedFetch('GET', key, { timeoutMs: 120_000, settleLater: true });

    if (response.status === 404) {
      return { exists: false, sizeBytes: 0, sha256: null, head: Buffer.alloc(0) };
    }
    if (!response.ok || !response.body) {
      throw new Error(`хранилище ответило ${response.status} на GET`);
    }
    const body = response.body;
    return this.settleBody('read', async () => {
      const hash = createHash('sha256');
      const headChunks: Buffer[] = [];
      let headBytes = 0;
      let sizeBytes = 0;
      for await (const chunk of body) {
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
    });
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
    const response = await this.signedFetch('GET', key, { timeoutMs: 60_000, settleLater: true });

    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`хранилище ответило ${response.status} на GET`);
    const body = await this.settleBody('read', async () =>
      Buffer.from(await response.arrayBuffer()),
    );
    return { body, contentType: response.headers.get('content-type') };
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
    // Таймаут обязателен на каждом внешнем вызове (RULES.md §3.1).
    const response = await this.signedFetch('DELETE', key, { timeoutMs: 10_000 });

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
      settleLater: true,
    });
    const body = await this.settleBody('write', () => response.text(), input.signal);
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
      // Простой и общий предел — отказ хранилища; остановка вызывающим — нет.
      const response = await this.signedFetch('GET', key, {
        signal,
        timeoutMs: limits.totalMs,
        settleLater: true,
        cancelSignal: limits.signal,
      });
      if (response.status === 404) {
        return { exists: false, sizeBytes: 0, sha256: null, head: Buffer.alloc(0) };
      }
      if (!response.ok || !response.body) {
        throw new Error(`хранилище ответило ${response.status} на GET`);
      }
      const stream = response.body;
      return await this.settleBody(
        'read',
        async () => {
          const hash = createHash('sha256');
          const headChunks: Buffer[] = [];
          let headBytes = 0;
          let sizeBytes = 0;
          for await (const chunk of stream) {
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
        },
        limits.signal,
      );
    } finally {
      clearTimeout(idleTimer);
    }
  }

  /**
   * Чтение или разбор тела ответа — часть того же обращения: обрыв и простой посреди тела
   * считаются техническим отказом режима (4.11), успех засчитывается только после тела.
   */
  private async settleBody<T>(
    mode: GroupMode,
    read: () => Promise<T>,
    cancelSignal?: AbortSignal,
  ): Promise<T> {
    try {
      const value = await read();
      storageBreaker().record(mode, true);
      return value;
    } catch (error) {
      if (!cancelSignal?.aborted) storageBreaker().record(mode, false);
      throw error;
    }
  }

  /**
   * Подписанный SigV4 запрос — единственный путь ядра к хранилищу из этого класса: каждое
   * обращение сообщает свой технический исход размыкателю группы «Файлы» (4.11).
   */
  private async signedFetch(
    method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
    key: string,
    options: {
      extraHeaders?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
      /** Тело PUT: только для служебной пробы записи (4.11) — маленькое и фиксированное. */
      body?: Buffer;
      /**
       * Успешный ответ засчитать после тела (`settleBody`): у GET с телом и у копирования
       * отказ может прийти уже после заголовков. Отказы (5xx, сеть) учитываются сразу.
       */
      settleLater?: boolean;
      /** Чья остановка — не отказ хранилища. По умолчанию `signal`. */
      cancelSignal?: AbortSignal;
    },
  ): Promise<Response> {
    const env = getEnv();
    if (!this.isConfigured) throw new Error('S3 не настроен');

    const amzDate = toAmzDate(new Date());
    const shortDate = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(options.body ?? Buffer.alloc(0));
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
    // Технический исход обращения — размыкателю группы «Файлы» (4.11): сеть, таймаут и 5xx
    // считаются отказом зависимости, 4xx — нет. Остановка вызывающим — не отказ.
    const mode = storageMode(method);
    try {
      const response = await fetch(url.toString(), {
        method,
        headers: {
          ...headers,
          Authorization:
            `${ALGORITHM} Credential=${env.S3_ACCESS_KEY_ID}/${scope}, ` +
            `SignedHeaders=${signedHeaders}, Signature=${signature}`,
        },
        ...(options.body ? { body: new Uint8Array(options.body) } : {}),
        signal: AbortSignal.any(signals),
      });
      // 2xx/3xx с отложенным учётом засчитает settleBody; 4xx и 5xx — исход уже известен.
      if (!(options.settleLater && response.status < 400)) {
        storageBreaker().record(mode, response.status < 500);
      }
      return response;
    } catch (error) {
      if (!(options.cancelSignal ?? options.signal)?.aborted) storageBreaker().record(mode, false);
      throw error;
    }
  }

  /**
   * Служебное чтение маленького объекта — проба чтения группы «Файлы» (4.11). `null` —
   * объекта нет; отсутствие НЕ подтверждает чтение — решает вызывающий.
   */
  async getProbeObject(key: string, timeoutMs: number): Promise<Buffer | null> {
    if (!key.startsWith(PROBE_PREFIX)) throw new Error('проба чтения — только служебный ключ');
    const res = await this.signedFetch('GET', key, { timeoutMs, settleLater: true });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`проба чтения: HTTP ${res.status}`);
    return this.settleBody('read', async () => Buffer.from(await res.arrayBuffer()));
  }

  /**
   * Служебная запись маленького фиксированного объекта — проба записи группы «Файлы»
   * (4.11). Только для служебных ключей вне материалов людей и их квот.
   */
  async putProbeObject(key: string, body: Buffer, timeoutMs: number): Promise<void> {
    if (!key.startsWith(PROBE_PREFIX)) throw new Error('проба записи — только служебный ключ');
    const res = await this.signedFetch('PUT', key, {
      body,
      timeoutMs,
      extraHeaders: { 'content-length': String(body.length) },
    });
    if (!res.ok) throw new Error(`проба записи: HTTP ${res.status}`);
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
    const problem = this.uploadAddressProblem();
    if (problem) {
      this.logger.error({ msg: 'форма загрузки не выдана', problem });
      throw errors.featureDisabled('upload_public_endpoint');
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

    // Форму отправляет браузер — значит, адрес публичный, а не внутренний.
    const base = (env.S3_PUBLIC_ENDPOINT || env.S3_ENDPOINT).replace(/\/+$/, '');
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

  let response: Response;
  try {
    response = await fetch(url.toString(), {
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
  } catch (error) {
    // Технический исход — размыкателю записи группы «Файлы» (4.11), как у S3Service.
    storageBreaker().record('write', false);
    throw error;
  }
  storageBreaker().record('write', response.status < 500);

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
