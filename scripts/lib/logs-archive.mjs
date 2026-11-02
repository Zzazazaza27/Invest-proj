import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * Архив технических журналов (блок 8, 8.4; 2.1-W08b) — чистая логика без
 * ввода-вывода: разбор потока `journalctl -o export`, имена порций, шифрование,
 * восстановление непрерывной цепочки порций. Ввод-вывод — scripts/logs-archive.mjs.
 *
 * Порция — непрерывный отрезок записей одного журнала (seqnum_id) по номерам
 * записей (seqnum). Имя порции детерминировано отрезком; повтор сравнивается
 * по SHA-256 ИСХОДНЫХ байтов порции (до сжатия и шифрования): повторное
 * шифрование даёт другие байты.
 */

export const FORMAT = 'journal-export+gzip+aes-256-gcm/v1';
const MAGIC = Buffer.from('5ELOG1\n');

export const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

// ------------------------------------------------------------------ export

/**
 * Разбор потока формата export по мере поступления. Поле — «KEY=value\n»
 * или двоичное «KEY\n» + 64-битная длина LE + данные + «\n»; запись
 * заканчивается пустой строкой. Хранятся исходные байты записи — порция
 * собирается из них без изменений.
 */
export class ExportReader {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  /** Добавить байты; вернуть полностью прочитанные записи. */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      const entry = this.#next();
      if (!entry) break;
      out.push(entry);
    }
    return out;
  }

  /** Остаток недочитанной записи: после конца потока он означает обрыв. */
  get pending() {
    return this.buf.length;
  }

  #next() {
    const b = this.buf;
    let pos = 0;
    const fields = {};
    for (;;) {
      if (pos >= b.length) return null;
      if (b[pos] === 0x0a) {
        // Пустая строка — конец записи.
        const raw = b.subarray(0, pos + 1);
        this.buf = b.subarray(pos + 1);
        return toEntry(raw, fields);
      }
      const nl = b.indexOf(0x0a, pos);
      if (nl < 0) return null;
      const line = b.subarray(pos, nl);
      const eq = line.indexOf(0x3d);
      if (eq >= 0) {
        fields[line.subarray(0, eq).toString('latin1')] = line.subarray(eq + 1).toString('utf8');
        pos = nl + 1;
      } else {
        // Двоичное поле.
        if (nl + 9 > b.length) return null;
        const size = Number(b.readBigUInt64LE(nl + 1));
        const end = nl + 9 + size;
        if (end + 1 > b.length) return null;
        fields[line.toString('latin1')] = null; // содержимое не нужно логике
        pos = end + 1;
      }
    }
  }
}

function toEntry(raw, fields) {
  const cursor = fields.__CURSOR ?? '';
  const parts = cursorParts(cursor);
  const seq = fields.__SEQNUM ? BigInt(fields.__SEQNUM) : parts.seq;
  const seqId = fields.__SEQNUM_ID ?? parts.seqId;
  if (!cursor || seq === null || !seqId) {
    throw new Error('запись без курсора или номера — формат export не распознан');
  }
  return {
    raw,
    cursor,
    seq,
    seqId,
    realtime: fields.__REALTIME_TIMESTAMP ? Number(fields.__REALTIME_TIMESTAMP) : null,
  };
}

/** Курсор journald: s=<seqnum_id>;i=<seqnum hex>;… */
export function cursorParts(cursor) {
  const map = Object.fromEntries(
    cursor
      .split(';')
      .map((p) => p.split('='))
      .filter((p) => p.length === 2),
  );
  return { seqId: map.s ?? null, seq: map.i ? BigInt(`0x${map.i}`) : null };
}

// ------------------------------------------------------------------- имена

const hex16 = (n) => n.toString(16).padStart(16, '0');

/** Ключ порции: <префикс>/<seqnum_id>/<первый>-<последний>.<вид> */
export function chunkKey(prefix, seqId, first, last, kind = 'jx') {
  return `${prefix}/${seqId}/${hex16(first)}-${hex16(last)}.${kind}`;
}

export function parseChunkKey(key) {
  const m = key.match(/\/([0-9a-f]{32})\/([0-9a-f]{16})-([0-9a-f]{16})\.(jx|loss)$/);
  if (!m) return null;
  return { seqId: m[1], first: BigInt(`0x${m[2]}`), last: BigInt(`0x${m[3]}`), kind: m[4] };
}

// -------------------------------------------------------------- шифрование

/** Ключ архива: 32 байта из hex; отпечаток — для метаданных и проверки. */
export function archiveKey(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex ?? '')) throw new Error('ключ архива: нужно 64 hex-символа');
  const key = Buffer.from(hex, 'hex');
  return { key, fingerprint: sha256Hex(key).slice(0, 16) };
}

export function seal(plain, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  const body = Buffer.concat([cipher.update(gzipSync(plain)), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, body, cipher.getAuthTag()]);
}

export function open(sealed, key) {
  if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('не порция архива журналов');
  const nonce = sealed.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = sealed.subarray(sealed.length - 16);
  const body = sealed.subarray(MAGIC.length + 12, sealed.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return gunzipSync(Buffer.concat([decipher.update(body), decipher.final()]));
}

// ----------------------------------------------------------------- цепочка

/** Ключ квитанции: подтверждённая привязка «отрезок → VersionId → хеши». */
export function receiptKey(seqId, first, last, kind, versionId) {
  return `r/${seqId}/${hex16(first)}-${hex16(last)}.${kind}/${versionId}.json`;
}

export function parseReceiptKey(key) {
  const m = key.match(
    /^r\/([0-9a-f]{32})\/([0-9a-f]{16})-([0-9a-f]{16})\.(jx|loss)\/([^/]+)\.json$/,
  );
  if (!m) return null;
  return {
    seqId: m[1],
    first: BigInt(`0x${m[2]}`),
    last: BigInt(`0x${m[3]}`),
    kind: m[4],
    versionId: m[5],
  };
}

/**
 * Непрерывная цепочка от начала архива по одному журналу: порции и отметки
 * потерь, каждая следующая начинается ровно за предыдущей. Продолжать запись
 * — с конца цепочки, а не с самого позднего объекта. Объекты за разрывом
 * (`beyond`) — уже записанное после пропуска: при повторном чтении их отрезки
 * сверяются по исходному хешу, а не пишутся заново.
 */
export function contiguousChain(items, expectedStart = null) {
  const sorted = [...items].sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
  const chain = [];
  const beyond = [];
  const overlaps = [];
  const gaps = [];
  // Начало закреплено границей архива (expectedStart = первая запись после
  // неё). Без границы первый найденный объект НЕ считается началом: утрата
  // начальных порций иначе выглядела бы как штатное начало.
  let end = expectedStart === null ? null : expectedStart - 1n;
  for (const it of sorted) {
    if (end === null) {
      chain.push(it);
      end = it.last;
    } else if (it.first === end + 1n && beyond.length === 0) {
      chain.push(it);
      end = it.last;
    } else if (it.first <= end) {
      overlaps.push(it);
    } else {
      if (beyond.length === 0) gaps.push({ first: end + 1n, last: it.first - 1n });
      beyond.push(it);
    }
  }
  return { chain, end, beyond, overlaps, gaps, start: expectedStart ?? chain[0]?.first ?? null };
}
