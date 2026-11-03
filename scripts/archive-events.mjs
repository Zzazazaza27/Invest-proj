#!/usr/bin/env node
/**
 * Выгрузка журнала событий в холодное хранилище.
 *
 * Закрывает эксплуатационный пункт: «архив событий старше 90 дней уезжает в
 * холодное хранилище отдельной процедурой». Процедура — эта.
 *
 * Решения, каждое со своей причиной.
 *
 * 1. **Только копирование, без удаления.** Срок хранения журнала оператора
 *    инвестиционной платформы определяется законом и Правилами платформы, а не
 *    удобством эксплуатации. Скрипт, умеющий удалять события, рано или поздно
 *    удалит их «для чистоты» — поэтому он этого не умеет вовсе.
 *
 * 2. **Своя роль БД, не владелец (M052, остаток SEC-10).** Выгрузке нужен весь
 *    журнал НА ЧТЕНИЕ и append-only реестр. Владелец схем — суперпользователь,
 *    который может переписать сам журнал; скомпрометированный скрипт выгрузки
 *    не должен этого уметь. `app_archive_user` не умеет.
 *
 * 3. **Свой бакет и свой ключ хранилища.** Ключ архива пишет и читает только
 *    бакет архива и файлов платформы не видит. На Garage (D-001) право
 *    записи включает удаление, поэтому копия сама по себе не неудаляема —
 *    источником остаётся журнал в базе, из которого не удаляется ничего.
 *
 * 4. **Сверка цепочки до выгрузки.** Копия, снятая с повреждённой hash-chain,
 *    доказательством целостности не является — и в реестре помечается
 *    `chain_intact = false`, а не выглядит полноценным архивом.
 *
 * 5. **Потоковая сборка и сверка содержимого (остаток SEC-10).** События
 *    пишутся во временный файл партиями — в памяти живёт одна партия, а не
 *    весь диапазон. Запись подтверждается не размером, а ЧТЕНИЕМ ОБЪЕКТА
 *    ОБРАТНО со сверкой sha256 байт в байт.
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
import { existsSync, readFileSync, createWriteStream, createReadStream, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';

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
// Порог — конечное неотрицательное число, и отказ ДО первого SQL: NaN или
// отрицательное значение молча сдвинули бы границу выгрузки.
if (!Number.isFinite(RETENTION_DAYS) || RETENTION_DAYS < 0) {
  console.error(`--days обязан быть конечным неотрицательным числом, получено: ${RETENTION_DAYS}`);
  process.exit(1);
}
const DRY_RUN = process.argv.includes('--dry-run');
/** Сколько событий читается за раз: в памяти живёт партия, а не весь диапазон. */
const BATCH = 5_000;

// --- Хранилище: свой бакет и свой ключ архива, подпись SigV4 -------------------
// Garage (D-001): политик по префиксу нет, а право записи включает удаление —
// поэтому архив событий в отдельном бакете (ARCHIVE_S3_BUCKET), и его ключ
// не имеет доступа к файлам платформы. Неудаляемость копии хранилище больше
// не обеспечивает: источник — журнал в базе (из него не удаляется ничего) и
// копии базы W07.
const S3 = {
  endpoint: (process.env.S3_ENDPOINT ?? '').replace(/\/+$/, ''),
  bucket: process.env.ARCHIVE_S3_BUCKET ?? '',
  region: process.env.S3_REGION ?? 'us-east-1',
  accessKey: process.env.ARCHIVE_S3_ACCESS_KEY_ID ?? '',
  secretKey: process.env.ARCHIVE_S3_SECRET_ACCESS_KEY ?? '',
};
if (!S3.endpoint || !S3.bucket || !S3.accessKey || !S3.secretKey) {
  console.error(
    'Хранилище архива не настроено: нужны S3_ENDPOINT, ARCHIVE_S3_BUCKET, ' +
      'ARCHIVE_S3_ACCESS_KEY_ID, ARCHIVE_S3_SECRET_ACCESS_KEY (свой ключ архива).',
  );
  process.exit(1);
}
const DB_URL = process.env.DATABASE_URL_APP_ARCHIVE ?? '';
if (!DB_URL) {
  console.error(
    'Нужен DATABASE_URL_APP_ARCHIVE (роль app_archive_user, M052) — выгрузка не работает ' +
      'подключением владельца: у владельца слишком много прав для этой задачи.',
  );
  process.exit(1);
}

const sha256HexOf = (buf) => createHash('sha256').update(buf).digest('hex');
const amzDate = (d) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
function signingKey(secret, shortDate, region, service) {
  let k = createHmac('sha256', `AWS4${secret}`).update(shortDate).digest();
  for (const part of [region, service, 'aws4_request'])
    k = createHmac('sha256', k).update(part).digest();
  return k;
}

/**
 * Подписанный запрос к объекту архива. Для PUT тело подаётся ПОТОКОМ из файла:
 * хеш содержимого посчитан заранее при сборке, файл в память не читается.
 */
async function s3Request(method, key, { bodyPath = null, payloadHashHex = null } = {}) {
  const url = new URL(
    `${S3.endpoint}/${S3.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`,
  );
  const date = amzDate(new Date());
  const shortDate = date.slice(0, 8);
  const payloadHash = payloadHashHex ?? sha256HexOf(Buffer.alloc(0));
  const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': date };
  if (bodyPath) {
    headers['content-length'] = String(statSync(bodyPath).size);
    headers['content-type'] = 'application/x-ndjson';
  }
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((n) => `${n}:${headers[n]}\n`)
    .join('');
  const canonicalRequest = [
    method,
    url.pathname,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${shortDate}/${S3.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256HexOf(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(S3.secretKey, shortDate, S3.region, 's3'))
    .update(stringToSign, 'utf8')
    .digest('hex');
  return fetch(url.toString(), {
    method,
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${S3.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: bodyPath ? ReadableStream.from(createReadStream(bodyPath)) : undefined,
    duplex: bodyPath ? 'half' : undefined,
    // Таймаут обязателен на каждом внешнем вызове (RULES.md §3.1).
    signal: AbortSignal.timeout(120_000),
  });
}

/** Прочитать объект обратно и посчитать sha256 потоком — сверка содержимого. */
async function readBackDigest(key) {
  const res = await s3Request('GET', key);
  if (!res.ok) return { exists: res.status !== 404, ok: false, status: res.status };
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of res.body) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { exists: true, ok: true, sha256: hash.digest('hex'), size };
}

const pool = new pg.Pool({ connectionString: DB_URL, max: 2 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

console.warn('\n=== ВЫГРУЗКА ЖУРНАЛА СОБЫТИЙ В ХОЛОДНОЕ ХРАНИЛИЩЕ ===\n');
console.warn(
  `порог: события старше ${RETENTION_DAYS} дней${DRY_RUN ? ' · сухой прогон' : ''} · роль app_archive_user · учётка unicorn_archive`,
);

const [{ boundary }] = await sql(`SELECT (now() - ($1 || ' days')::interval) AS boundary`, [
  String(RETENTION_DAYS),
]);

const [{ last_end: lastEnd }] = await sql(
  `SELECT coalesce(max(period_end), to_timestamp(0)) AS last_end FROM audit.event_archives`,
);

// Временный каталог СИСТЕМЫ (не репозитория); снос при любом исходе.
const tmpRoot = await mkdtemp(join(tmpdir(), 'unicorn-archive-'));
const cleanup = () => rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
process.on('exit', () => {
  /* rm асинхронный — на exit только сигнал ниже */
});
process.on('SIGINT', async () => {
  await cleanup();
  process.exit(130);
});

/**
 * Собрать события диапазона `(from, to]` в JSONL-файл ПОТОКОМ.
 * В памяти живёт одна партия BATCH; sha256 считается инкрементально.
 * Тот же сбор используется восстановлением утраченной копии — и обязан давать
 * байт в байт тот же файл, иначе сверка отпечатка ничего не доказывает.
 */
async function collectRangeToFile(from, to, filePath) {
  const out = createWriteStream(filePath, { encoding: 'utf8' });
  const hash = createHash('sha256');
  let count = 0;
  let firstEventId = null;
  let lastEventId = null;
  let offsetTs = from;
  let offsetId = '00000000-0000-0000-0000-000000000000';

  for (;;) {
    // Keyset по (ts, id): OFFSET на сотнях тысяч строк квадратичен.
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

    let chunk = '';
    for (const row of batch) {
      firstEventId ??= row.id;
      lastEventId = row.id;
      chunk += `${JSON.stringify({
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
      })}\n`;
      count += 1;
    }
    hash.update(chunk, 'utf8');
    if (!out.write(chunk)) await once(out, 'drain');

    const tail = batch[batch.length - 1];
    offsetTs = tail.ts;
    offsetId = tail.id;
    if (batch.length < BATCH) break;
  }

  out.end();
  await once(out, 'finish');
  return { count, firstEventId, lastEventId, sha256: hash.digest('hex') };
}

/** Записать файл в хранилище и доказать сверкой содержимого, что он там. */
async function uploadAndVerify(key, filePath, expectedSha256) {
  const put = await s3Request('PUT', key, { bodyPath: filePath, payloadHashHex: expectedSha256 });
  if (!put.ok) {
    console.error(`PUT ${key}: HTTP ${put.status}`);
    return false;
  }
  // «Записано» подтверждается чтением обратно и сверкой sha256, а не кодом
  // ответа и не размером: хранилище может принять запрос и сохранить не то.
  const back = await readBackDigest(key);
  if (!back.ok || back.sha256 !== expectedSha256) {
    console.error(
      `объект в хранилище НЕ совпал по содержимому: sha256 ${back.sha256?.slice(0, 16)}… ` +
        `против ${expectedSha256.slice(0, 16)}…`,
    );
    return false;
  }
  return { size: back.size };
}

const EXIT = Symbol('exit');
try {
  // Реестр утверждает, что копия существует. Проверяем это, а не верим записи;
  // сверка — по СОДЕРЖИМОМУ, восстановление — из журнала.
  const [previous] = await sql(
    `SELECT object_key, period_start, period_end, sha256, last_event_id
       FROM audit.event_archives ORDER BY exported_at DESC LIMIT 1`,
  );
  if (previous) {
    const back = await readBackDigest(previous.object_key);
    if (!back.exists) {
      console.warn(`  ВНИМАНИЕ  объект прошлой выгрузки отсутствует: ${previous.object_key}`);
      const restorePath = join(tmpRoot, 'restore.jsonl');
      const restored = await collectRangeToFile(
        previous.period_start,
        previous.period_end,
        restorePath,
      );
      if (restored.sha256 !== previous.sha256) {
        // Тот же диапазон журнала обязан дать тот же файл. Расхождение означает,
        // что append-only журнал изменился, — это находка, а не повод перезаписать.
        console.error(
          'Восстановленная копия НЕ совпала с отпечатком из реестра: ' +
            `${restored.sha256} против ${previous.sha256}. Журнал изменился — разбирайтесь вручную.`,
        );
        process.exitCode = 1;
        throw EXIT;
      }
      if (DRY_RUN) {
        console.warn('  сухой прогон: восстановление объекта пропущено');
      } else if (await uploadAndVerify(previous.object_key, restorePath, restored.sha256)) {
        console.warn('  OK    объект восстановлен из журнала, отпечаток совпал');
      } else {
        process.exitCode = 1;
        throw EXIT;
      }
    } else if (back.sha256 !== previous.sha256) {
      console.error(
        `Объект прошлой выгрузки ИЗМЕНЁН в хранилище: sha256 ${back.sha256.slice(0, 16)}… ` +
          `против реестра ${previous.sha256.slice(0, 16)}…. Разбирайтесь вручную.`,
      );
      process.exitCode = 1;
      throw EXIT;
    }
  }

  const [counts] = await sql(
    `SELECT count(*)::bigint AS total FROM audit.events WHERE ts > $1 AND ts <= $2`,
    [lastEnd, boundary],
  );
  const total = Number(counts.total);
  console.warn(
    `к выгрузке: ${total} событий в диапазоне ` +
      `(${new Date(lastEnd).toISOString()} … ${new Date(boundary).toISOString()}]`,
  );

  if (total === 0) {
    console.warn('\nВыгружать нечего: в диапазоне нет событий.\n');
    process.exitCode = 0;
    throw EXIT;
  }

  // Сверка цепочки ДО выгрузки: копия с повреждённой цепочки архивом не
  // является. Диапазонный verifier (M053): верхняя граница — текущий boundary
  // (события новее не влияют на эту выгрузку), seed — row_hash последнего
  // события прошлого архива, поэтому СВЯЗЬ нового диапазона с уже
  // заархивированным проверяется строго, а не пропускается (SEC-HIGH-04).
  const broken = await sql(
    'SELECT broken_event_id, reason FROM audit.verify_event_chain_range($1, $2)',
    [previous?.last_event_id ?? null, boundary],
  );
  const chainIntact = broken.length === 0;
  console.warn(
    chainIntact
      ? '  OK    hash-chain цела на момент выгрузки'
      : `  ВНИМАНИЕ  цепочка повреждена (${broken.length} разрывов) — архив будет помечен`,
  );

  const objectKey =
    `archive/audit-events/${new Date(boundary).toISOString().slice(0, 10)}/` +
    `events-${new Date(lastEnd).getTime()}-${new Date(boundary).getTime()}.jsonl`;

  const exportPath = join(tmpRoot, 'export.jsonl');
  const collected = await collectRangeToFile(lastEnd, boundary, exportPath);
  console.warn(
    `  собрано строк: ${collected.count}, размер ${statSync(exportPath).size} байт, ` +
      `sha256 ${collected.sha256.slice(0, 16)}…`,
  );

  if (DRY_RUN) {
    console.warn('\nСухой прогон: в хранилище и в реестр ничего не записано.\n');
    process.exitCode = 0;
    throw EXIT;
  }

  const uploaded = await uploadAndVerify(objectKey, exportPath, collected.sha256);
  if (!uploaded) {
    process.exitCode = 1;
    throw EXIT;
  }
  console.warn(
    `  OK    объект в хранилище: ${objectKey} (${uploaded.size} байт, sha256 сверен чтением обратно)`,
  );

  // Запись — только через append-функцию (M053): непрерывность диапазонов,
  // запрет будущей границы и сверку count/first/last с журналом держит БД,
  // а не дисциплина этого скрипта. Прямой INSERT у роли отозван.
  await sql(`SELECT audit.append_event_archive($1, $2, $3, $4, $5, $6, $7, $8)`, [
    lastEnd,
    boundary,
    objectKey,
    collected.count,
    collected.sha256,
    collected.firstEventId,
    collected.lastEventId,
    chainIntact,
  ]);
  console.warn('  OK    запись в реестре выгрузок создана (append-функция M053)');

  console.warn(
    `\nВыгружено ${collected.count} событий. События в журнале НЕ удалены: ` +
      'выгрузка только копирует.\n',
  );
} catch (e) {
  if (e !== EXIT) throw e;
} finally {
  await cleanup();
  await pool.end();
}
