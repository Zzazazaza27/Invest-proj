#!/usr/bin/env node
/**
 * Архиватор технических журналов (блок 8, 8.4; 2.1-W08b).
 *
 *   node scripts/logs-archive.mjs init      начать архив с текущего конца журнала
 *   node scripts/logs-archive.mjs run       один проход: новые записи → порции в S3
 *   node scripts/logs-archive.mjs rebuild   состояние и каталог заново из S3
 *   node scripts/logs-archive.mjs status    сводка без секретов
 *   node scripts/logs-archive.mjs verify    каждая порция — своей версией; вердикт
 *   node scripts/logs-archive.mjs pack      суточные пакеты закрытых суток
 *   node scripts/logs-archive.mjs pull --to <каталог>   ручная копия (добавочно)
 *   node scripts/logs-archive.mjs verify-copy --to <каталог>   проверка копии без S3
 *
 * Источник — journald (`journalctl -o export`), курсоры даёт он; подтверждение
 * архива, повторы, каталог и обнаружение потерь — ответственность этого кода.
 *
 * Порядок прохода: отрезок порции записывается в состояние ДО отправки →
 * объект с тем же именем уже есть? исходный хеш совпал — порция в архиве;
 * не совпал — конфликт, остановка без перезаписи → иначе запись → VersionId и
 * хеши в каталог → курсор продвигается. Повтор после сбоя читает тот же
 * отрезок в тех же границах.
 *
 * Окружение: LOGS_S3_ENDPOINT, LOGS_S3_BUCKET, LOGS_S3_ACCESS_KEY_ID,
 * LOGS_S3_SECRET_ACCESS_KEY, LOGS_S3_REGION, LOGS_ARCHIVE_KEY (64 hex),
 * LOGS_STATE_DIR, LOGS_PREFIX (j), LOGS_JOURNAL_ARGS (доп. аргументы
 * journalctl, через пробел), LOGS_MAX_CHUNK_BYTES.
 */
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  ExportReader,
  FORMAT,
  archiveKey,
  chunkKey,
  contiguousChain,
  cursorParts,
  parseChunkKey,
  parseReceiptKey,
  receiptKey,
  open,
  seal,
  sha256Hex,
} from './lib/logs-archive.mjs';
import { s3Object } from './lib/s3.mjs';

const env = process.env;
const STATE_DIR = env.LOGS_STATE_DIR || '/var/lib/fifth-logs';
const PREFIX = env.LOGS_PREFIX || 'j';
const MAX_CHUNK = Number(env.LOGS_MAX_CHUNK_BYTES || 16 * 1024 * 1024);
const JOURNAL_ARGS = (env.LOGS_JOURNAL_ARGS || '').split(' ').filter(Boolean);

const storage = {
  endpoint: (env.LOGS_S3_ENDPOINT || '').replace(/\/+$/, ''),
  bucket: env.LOGS_S3_BUCKET || '',
  region: env.LOGS_S3_REGION || 'us-east-1',
  accessKey: env.LOGS_S3_ACCESS_KEY_ID || '',
  secretKey: env.LOGS_S3_SECRET_ACCESS_KEY || '',
};

const STATE = join(STATE_DIR, 'state.json');
const CATALOG = join(STATE_DIR, 'catalog.jsonl');
const LOCK = join(STATE_DIR, 'lock');

// ------------------------------------------------------------ состояние

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** Атомарная запись: временный файл + fsync + переименование. */
function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  writeFileSync(fd, JSON.stringify(value, null, 2));
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, path);
}

const big = (v) => (v === null || v === undefined ? null : BigInt(v));
const str = (v) => (v === null || v === undefined ? null : String(v));

function loadState() {
  const s = readJson(STATE);
  if (!s) return null;
  return { ...s, lastSeq: big(s.lastSeq), pending: s.pending ?? null };
}

function saveState(s) {
  writeJsonAtomic(STATE, { ...s, lastSeq: str(s.lastSeq) });
}

/** Каталог: строка на подтверждённую порцию; оборванная последняя строка пропускается. */
function loadCatalog() {
  if (!existsSync(CATALOG)) return [];
  const out = [];
  for (const line of readFileSync(CATALOG, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Незавершённая запись строки: восстанавливается из метаданных S3 (rebuild).
    }
  }
  return out;
}

function appendCatalog(row) {
  // Оборванная последняя строка (сбой посреди записи) не должна склеиться
  // со следующей: иначе пропадает и новая, уже подтверждённая порция
  // (поймано сверкой каталога с квитанциями, испытание 6).
  let lead = '';
  if (existsSync(CATALOG)) {
    const text = readFileSync(CATALOG);
    if (text.length && text[text.length - 1] !== 0x0a) lead = '\n';
  }
  const fd = openSync(CATALOG, 'a');
  appendFileSync(fd, `${lead}${JSON.stringify(row)}\n`);
  fsyncSync(fd);
  closeSync(fd);
}

function withLock(fn) {
  mkdirSync(STATE_DIR, { recursive: true });
  let fd;
  try {
    fd = openSync(LOCK, 'wx');
  } catch {
    const holder = Number(readFileSync(LOCK, 'utf8').trim());
    let alive = false;
    try {
      process.kill(holder, 0);
      alive = true;
    } catch {
      /* процесса нет — блокировка осталась от упавшего прохода */
    }
    if (alive) throw new Error(`проход уже идёт (pid ${holder})`);
    unlinkSync(LOCK);
    fd = openSync(LOCK, 'wx');
  }
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      try {
        unlinkSync(LOCK);
      } catch {
        /* уже снята */
      }
    });
}

// --------------------------------------------------------------- journald

/**
 * Прочитать записи: после курсора (`after`) или начиная с него (`from`),
 * не больше `maxEntries` и (кроме первой) не больше `maxBytes` байт.
 */
function readJournal({ after = null, from = null, maxEntries = Infinity, maxBytes = MAX_CHUNK }) {
  const args = ['-o', 'export', '--no-pager', ...JOURNAL_ARGS];
  if (after) args.push('--after-cursor', after);
  else if (from) args.push('--cursor', from);
  return new Promise((resolve, reject) => {
    const child = spawn('journalctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const reader = new ExportReader();
    const entries = [];
    let bytes = 0;
    let stopped = false;
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.on('data', (chunk) => {
      if (stopped) return;
      for (const e of reader.push(chunk)) {
        if (entries.length >= maxEntries || (entries.length && bytes + e.raw.length > maxBytes)) {
          stopped = true;
          child.kill();
          break;
        }
        entries.push(e);
        bytes += e.raw.length;
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (!stopped && code !== 0) {
        reject(new Error(`journalctl: код ${code}: ${stderr.trim().split('\n')[0] ?? ''}`));
      } else if (!stopped && reader.pending) {
        reject(new Error('journalctl: поток оборван посреди записи'));
      } else resolve(entries);
    });
  });
}

/** Текущий последний курсор журнала. */
async function tailCursor() {
  const args = ['-o', 'export', '--no-pager', '-n', '1', ...JOURNAL_ARGS];
  return new Promise((resolve, reject) => {
    const child = spawn('journalctl', args, { stdio: ['ignore', 'pipe', 'inherit'] });
    const reader = new ExportReader();
    let last = null;
    child.stdout.on('data', (d) => {
      for (const e of reader.push(d)) last = e;
    });
    child.on('error', reject);
    child.on('close', () => resolve(last));
  });
}

// --------------------------------------------------------------------- S3

async function s3(method, key, { body = null, headers = {}, query = {} } = {}) {
  return s3Object(storage, method, key, body, headers, query);
}

async function putObject(key, body, metadata = {}) {
  // Метаданные объекта идут заголовками HTTP — только ASCII (испытание 10:
  // причина потери по-русски роняла запись). Описания — в каталоге.
  for (const [k, v] of Object.entries(metadata)) {
    if (!/^[\x20-\x7e]*$/.test(String(v))) throw new Error(`метаданные ${k}: не ASCII`);
  }
  const headers = Object.fromEntries(
    Object.entries(metadata).map(([k, v]) => [`x-amz-meta-${k}`, String(v)]),
  );
  headers['content-type'] = 'application/octet-stream';
  const r = await s3('PUT', key, { body, headers });
  if (!r.ok) throw new Error(`S3 PUT ${key}: ${r.status}`);
  const versionId = r.headers.get('x-amz-version-id');
  if (!versionId) throw new Error(`S3 не вернул VersionId для ${key}: версии бакета выключены?`);
  return versionId;
}

async function getVersion(key, versionId) {
  const r = await s3('GET', key, { query: { versionId } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`S3 GET ${key}@${versionId}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Все версии под префиксом: [{key, versionId, latest}] (удаления не входят). */
async function listVersions(prefix) {
  const out = [];
  let marker = null;
  let vmarker = null;
  for (;;) {
    const query = {
      versions: '',
      prefix,
      ...(marker ? { 'key-marker': marker } : {}),
      ...(vmarker ? { 'version-id-marker': vmarker } : {}),
    };
    const r = await s3('GET', '', { query });
    if (!r.ok) throw new Error(`S3 LIST VERSIONS ${prefix}: ${r.status}`);
    const xml = await r.text();
    for (const m of xml.matchAll(/<Version>([\s\S]*?)<\/Version>/g)) {
      out.push({
        key: m[1].match(/<Key>([^<]+)<\/Key>/)?.[1],
        versionId: m[1].match(/<VersionId>([^<]+)<\/VersionId>/)?.[1],
        latest: /<IsLatest>true<\/IsLatest>/.test(m[1]),
      });
    }
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
    marker = xml.match(/<NextKeyMarker>([^<]+)<\/NextKeyMarker>/)?.[1] ?? null;
    vmarker = xml.match(/<NextVersionIdMarker>([^<]+)<\/NextVersionIdMarker>/)?.[1] ?? null;
    if (!marker) break;
  }
  return out;
}

const groupByKey = (versions) => {
  const map = new Map();
  for (const v of versions) map.set(v.key, [...(map.get(v.key) ?? []), v]);
  return map;
};

// -------------------------------------------------------- граница архива

/**
 * Граница архива журнала — в S3, вне теряемого локального состояния:
 * `anchors/<seqnum_id>.json` = после какой записи начат архив. Две версии
 * одной границы — неоднозначность, работа останавливается.
 */
async function putAnchor(anchor) {
  const key = `anchors/${anchor.seqId}.json`;
  const versions = (await listVersions(key)).filter((v) => v.key === key);
  if (versions.length) throw new Error(`граница архива ${anchor.seqId} уже закреплена`);
  await putObject(key, Buffer.from(JSON.stringify(anchor)));
}

async function readAnchors() {
  const byKey = groupByKey(await listVersions('anchors/'));
  const out = [];
  for (const [key, versions] of byKey) {
    if (versions.length !== 1) {
      throw new Error(`НЕОДНОЗНАЧНОСТЬ: у границы ${key} версий ${versions.length} — нужен разбор`);
    }
    out.push(JSON.parse((await getVersion(key, versions[0].versionId)).toString('utf8')));
  }
  return out;
}

// ------------------------------------------------------------- квитанции

/**
 * Квитанция — подтверждённая привязка «отрезок → VersionId → хеши». Пишется
 * после записи порции и проверки её содержимого; восстановление каталога
 * берёт привязки только из квитанций и никогда не признаёт эталоном
 * последнюю версию объекта.
 */
async function putReceipt(row) {
  const p = parseChunkKey(row.key);
  const key = receiptKey(p.seqId, p.first, p.last, p.kind, row.versionId);
  const existing = (await listVersions(key)).filter((v) => v.key === key);
  if (existing.length) return;
  await putObject(key, Buffer.from(JSON.stringify(row)));
}

// ------------------------------------------------------------- проход

function buildPlain(entries) {
  return Buffer.concat(entries.map((e) => e.raw));
}

/** Содержимое версии порции: исходные байты или null, если не открывается. */
async function plainOfVersion(key, versionId, keyMat) {
  const sealed = await getVersion(key, versionId);
  if (!sealed) return null;
  try {
    return { plain: open(sealed, keyMat.key), objSha: sha256Hex(sealed) };
  } catch {
    return null;
  }
}

/**
 * Записать порцию или подтвердить уже записанную. Уже лежащая версия
 * подтверждается только по СОДЕРЖИМОМУ: расшифровка и исходный хеш, а не
 * метаданные объекта (их может записать кто угодно с правом записи).
 * Под ключом есть версии, но ни одна не совпала, — конфликт, без перезаписи.
 */
async function storeChunk(key, entries, keyMat) {
  const plain = buildPlain(entries);
  const plainSha = sha256Hex(plain);
  const versions = (await listVersions(key)).filter((v) => v.key === key);
  for (const v of versions) {
    const got = await plainOfVersion(key, v.versionId, keyMat);
    if (got && sha256Hex(got.plain) === plainSha) {
      return { versionId: v.versionId, plainSha, objSha: got.objSha, reused: true };
    }
  }
  if (versions.length) {
    throw new Error(`КОНФЛИКТ ${key}: в архиве другая порция с тем же отрезком — без перезаписи`);
  }
  const sealed = seal(plain, keyMat.key);
  const objSha = sha256Hex(sealed);
  const versionId = await putObject(key, sealed, {
    format: FORMAT,
    'plain-sha256': plainSha,
    'object-sha256': objSha,
    count: entries.length,
    'key-fp': keyMat.fingerprint,
  });
  return { versionId, plainSha, objSha, reused: false };
}

const LOSS_REASONS = {
  'journald-vacuumed': 'вытеснено из journald до архивации',
  'archive-missing': 'утрачено в архиве; в journald записей уже нет',
  'archive-unverifiable':
    'порция в архиве без квитанции; в journald записей уже нет — сверить нельзя',
};
const LOSS_LABELS = {
  'journald-vacuumed': 'ПОТЕРЯ (вытеснено journald)',
  'archive-missing': 'ПРОПУСК АРХИВА (в journald уже нет)',
  'archive-unverifiable': 'НЕ ПРОВЕРЯЕМО (нет квитанции, в journald уже нет)',
};

async function storeLoss(seqId, first, last, reason) {
  const key = chunkKey(PREFIX, seqId, first, last, 'loss');
  const versions = (await listVersions(key)).filter((v) => v.key === key);
  const versionId =
    versions[0]?.versionId ??
    (await putObject(key, Buffer.alloc(0), { format: 'loss/v1', reason }));
  const row = {
    kind: 'loss',
    key,
    versionId,
    first: str(first),
    last: str(last),
    reason,
    reasonText: LOSS_REASONS[reason],
    at: new Date().toISOString(),
  };
  await putReceipt(row);
  appendCatalog(row);
  return row;
}

async function confirm(state, row, lastEntry) {
  await putReceipt(row);
  if (env.LOGS_TEST_CRASH === 'after-receipt') process.exit(99);
  appendCatalog(row);
  state.lastCursor = lastEntry.cursor;
  state.lastSeq = lastEntry.seq;
  state.seqId = lastEntry.seqId;
  state.pending = null;
  state.lastOkAt = new Date().toISOString();
  // Пропуск архива закрыт, если цепочка прошла через него.
  state.archiveGaps = (state.archiveGaps ?? []).filter((g) => BigInt(g.last) > lastEntry.seq);
  saveState(state);
}

const gapsOf = (state) =>
  (state.archiveGaps ?? []).map((g) => ({ first: BigInt(g.first), last: BigInt(g.last) }));

/** Пропуск архива, содержащий запись n. */
function archiveGapAt(state, n) {
  return gapsOf(state).find((g) => g.first <= n && n <= g.last) ?? null;
}

/** Ближайший пропуск архива, начинающийся после записи n. */
function archiveGapAfter(state, n) {
  return (
    gapsOf(state)
      .filter((g) => g.first > n)
      .sort((x, y) => (x.first < y.first ? -1 : 1))[0] ?? null
  );
}

/** Объединить пересекающиеся и смежные отрезки. */
function mergeRanges(ranges) {
  const sorted = [...ranges].sort((x, y) => (x.first < y.first ? -1 : 1));
  const out = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r.first <= last.last + 1n) {
      if (r.last > last.last) last.last = r.last;
    } else out.push({ ...r });
  }
  return out;
}

/** Следующий объект за разрывом в этом журнале: {key, receipt, ...отрезок}. */
function nextBeyond(state, sid) {
  for (const b of state.beyond ?? []) {
    const p = parseChunkKey(b.key);
    if (p && p.seqId === sid) return { ...b, ...p };
  }
  return null;
}

/**
 * Подтверждённые квитанцией объекты, которые продолжают цепочку, принимаются
 * по квитанции — без чтения journald (их записи там может уже не быть).
 */
async function adoptConfirmed(state) {
  for (;;) {
    const next = nextBeyond(state, state.seqId);
    if (!next?.receipt || state.lastSeq === null || next.first !== state.lastSeq + 1n) return;
    const row = JSON.parse(
      (await getVersion(next.receipt.key, next.receipt.versionId)).toString('utf8'),
    );
    appendCatalog(row);
    state.lastSeq = next.last;
    if (row.lastCursor) state.lastCursor = row.lastCursor;
    state.beyond = state.beyond.filter((b) => b.key !== next.key);
    state.archiveGaps = (state.archiveGaps ?? []).filter((g) => BigInt(g.last) > next.last);
    saveState(state);
  }
}

async function run() {
  const keyMat = archiveKey(env.LOGS_ARCHIVE_KEY);
  await withLock(async () => {
    let state = loadState();
    if (!state) state = await rebuildState();
    if (!state) throw new Error('архив не начат: выполните init');

    // 1. Незавершённая порция прошлого прохода — в тех же границах.
    if (state.pending) {
      const p = state.pending;
      const entries = await readJournal({
        from: p.firstCursor,
        maxEntries: p.count,
        maxBytes: Infinity,
      });
      const plainSha = sha256Hex(buildPlain(entries));
      if (entries.length !== p.count || plainSha !== p.plainSha) {
        throw new Error(`незавершённая порция ${p.key} не читается в прежнем виде — нужен разбор`);
      }
      const res = await storeChunk(p.key, entries, keyMat);
      await confirm(state, catalogRow(p.key, entries, res), entries.at(-1));
      console.log(`повтор ${p.key}: ${res.reused ? 'уже в архиве' : 'записан'}`);
    }

    // 2. Новые записи.
    let written = 0;
    for (;;) {
      await adoptConfirmed(state);
      const read = await readJournal({ after: state.lastCursor });
      if (!read.length) break;
      // Разрыв перед первой доступной записью — по отрезкам: подтверждённые
      // порции за разрывом принимаются по квитанции; неподтверждённая, чьё
      // начало journald уже вытеснил, сверке не поддаётся — явная отметка
      // «не проверяемо», а не доверие; остальное — отметка потери.
      const avail = read[0];
      while (
        avail.seqId === state.seqId &&
        state.lastSeq !== null &&
        state.lastSeq + 1n < avail.seq
      ) {
        await adoptConfirmed(state);
        if (state.lastSeq + 1n >= avail.seq) break;
        const a = state.lastSeq + 1n;
        const nb = nextBeyond(state, state.seqId);
        let b;
        let reason;
        if (nb && nb.first === a && !nb.receipt) {
          b = nb.last;
          reason = 'archive-unverifiable';
          state.beyond = state.beyond.filter((x) => x.key !== nb.key);
        } else {
          b = nb && nb.first <= avail.seq - 1n ? nb.first - 1n : avail.seq - 1n;
          // Пропуск, известный по восстановлению, — утрата архива, а не
          // вытеснение journald: в journald записей просто уже нет. Отметка
          // режется по границам пропуска: внутри — «утрачено в архиве»,
          // снаружи — вытеснение journald до архивации.
          const g = archiveGapAt(state, a);
          if (g) {
            if (g.last < b) b = g.last;
            reason = 'archive-missing';
          } else {
            const nextGap = archiveGapAfter(state, a);
            if (nextGap && nextGap.first <= b) b = nextGap.first - 1n;
            reason = 'journald-vacuumed';
          }
        }
        await storeLoss(state.seqId, a, b, reason);
        state.losses = (state.losses ?? 0) + 1;
        state.lastSeq = b;
        state.archiveGaps = (state.archiveGaps ?? []).filter((g) => BigInt(g.last) > b);
        saveState(state);
        console.error(`${LOSS_LABELS[reason]}: записи ${a}–${b} журнала ${state.seqId}`);
      }
      // Записи, уже покрытые цепочкой (принятой порцией или отметкой), не
      // пишутся второй раз.
      const entries = read.filter(
        (e) => !(e.seqId === state.seqId && state.lastSeq !== null && e.seq <= state.lastSeq),
      );
      if (!entries.length) {
        state.lastCursor = read.at(-1).cursor;
        saveState(state);
        continue;
      }
      const first = entries[0];
      // Порция — только из записей одного журнала.
      const sid = first.seqId;
      const cut = entries.findIndex((e) => e.seqId !== sid);
      let slice = cut < 0 ? entries : entries.slice(0, cut);
      // Неподтверждённый объект (найден при восстановлении): его отрезок
      // читается в его границах и сверяется по содержимому; новая порция
      // обрывается перед любым объектом за разрывом — без перекрытий.
      const next = nextBeyond(state, sid);
      let key;
      if (next && !next.receipt && slice[0].seq === next.first) {
        slice = slice.filter((e) => e.seq <= next.last);
        if (slice.at(-1).seq !== next.last) {
          slice = await readJournal({
            from: slice[0].cursor,
            maxEntries: Number(next.last - next.first + 1n),
            maxBytes: Infinity,
          });
        }
        key = next.key;
        state.beyond = state.beyond.filter((b) => b.key !== key);
      } else {
        if (next) slice = slice.filter((e) => e.seq < next.first);
        key = chunkKey(PREFIX, sid, slice[0].seq, slice.at(-1).seq);
      }
      state.pending = {
        key,
        firstCursor: slice[0].cursor,
        count: slice.length,
        plainSha: sha256Hex(buildPlain(slice)),
      };
      saveState(state);
      if (env.LOGS_TEST_CRASH === 'after-pending') process.exit(97);
      const res = await storeChunk(key, slice, keyMat);
      if (env.LOGS_TEST_CRASH === 'after-put') process.exit(98);
      await confirm(state, catalogRow(key, slice, res), slice.at(-1));
      written++;
    }
    // Журнал дочитан до конца — момент нужен пакетам: сутки закрыты, если
    // после их конца архиватор дочитал журнал (записи суток уже в архиве).
    state.caughtUpAt = new Date(nowMs()).toISOString();
    saveState(state);
    console.log(`проход: порций ${written}, последняя запись ${state.lastSeq ?? '—'}`);
  });
}

function catalogRow(key, entries, res) {
  return {
    kind: 'chunk',
    key,
    versionId: res.versionId,
    first: str(entries[0].seq),
    last: str(entries.at(-1).seq),
    count: entries.length,
    plainSha: res.plainSha,
    objSha: res.objSha,
    firstCursor: entries[0].cursor,
    lastCursor: entries.at(-1).cursor,
    from: entries[0].realtime,
    to: entries.at(-1).realtime,
    at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------- восстановление

/**
 * Состояние и каталог из S3.
 *  - Граница архива — из `anchors/` (не из локального файла).
 *  - Привязки «порция → VersionId → хеши» — только из квитанций, чья версия
 *    порции существует. Порция без такой квитанции — неподтверждённая: её
 *    отрезок прочитается из journald заново и сверится по содержимому;
 *    последняя версия объекта эталоном не становится. Квитанция на
 *    удалённую версию — свидетельство утраты в архиве. Две действующие
 *    квитанции на отрезок — неоднозначность, остановка.
 *  - Цепочка — от границы; пропуск в начале или середине — пропуск АРХИВА
 *    (archiveGaps), а не потеря journald.
 */
async function rebuildState() {
  const anchors = await readAnchors();
  if (!anchors.length) {
    if (existsSync(join(STATE_DIR, 'start.json'))) {
      throw new Error('граница архива есть только локально, в S3 её нет — начало не подтверждено');
    }
    return null;
  }
  const anchor = anchors.sort((a, b) => (a.at < b.at ? -1 : 1)).at(-1);
  const sid = anchor.seqId;
  const expectedStart = BigInt(anchor.afterSeq) + 1n;

  const objectVersions = groupByKey(await listVersions(`${PREFIX}/${sid}/`));
  const receipts = new Map();
  const lostConfirmed = [];
  for (const [key, versions] of groupByKey(await listVersions(`r/${sid}/`))) {
    const r = parseReceiptKey(key);
    if (!r) continue;
    if (versions.length !== 1) {
      throw new Error(
        `НЕОДНОЗНАЧНОСТЬ: у квитанции ${key} версий ${versions.length} — нужен разбор`,
      );
    }
    const range = chunkKey(PREFIX, sid, r.first, r.last, r.kind);
    if (!(objectVersions.get(range) ?? []).some((v) => v.versionId === r.versionId)) {
      lostConfirmed.push(range);
      continue;
    }
    receipts.set(range, [
      ...(receipts.get(range) ?? []),
      { key, versionId: versions[0].versionId },
    ]);
  }
  for (const [range, list] of receipts) {
    if (list.length > 1) {
      throw new Error(`НЕОДНОЗНАЧНОСТЬ: на отрезок ${range} действующих квитанций ${list.length}`);
    }
  }

  const objects = [...objectVersions.keys()]
    .map((k) => ({ key: k, ...parseChunkKey(k) }))
    .filter((i) => i.seqId);
  const confirmed = objects.filter((o) => receipts.has(o.key));
  const unconfirmed = objects.filter((o) => !receipts.has(o.key));
  const { chain, end, beyond, overlaps, gaps } = contiguousChain(confirmed, expectedStart);

  const rows = [];
  for (const it of chain) {
    const [rec] = receipts.get(it.key);
    rows.push(JSON.parse((await getVersion(rec.key, rec.versionId)).toString('utf8')));
  }
  writeFileSync(CATALOG, rows.length ? rows.map((r) => JSON.stringify(r)).join('\n') + '\n' : '');
  const lastChunk = [...rows].reverse().find((r) => r.kind === 'chunk');
  const later = [
    ...beyond.map((b) => ({ key: b.key, first: b.first, receipt: receipts.get(b.key)[0] })),
    ...unconfirmed
      .filter((u) => u.first > end)
      .map((u) => ({ key: u.key, first: u.first, receipt: null })),
  ].sort((a, b) => (a.first < b.first ? -1 : 1));
  // Пропуски архива: в начале и середине — по сохранившимся объектам; за
  // концом цепочки — по квитанциям утраченных порций (иначе утрата
  // последних порций не видна: за ними нет объекта, на котором видно разрыв).
  const ranges = gaps.map((g) => ({ first: g.first, last: g.last }));
  if (!gaps.length && later.length && later[0].first > end + 1n) {
    ranges.push({ first: end + 1n, last: later[0].first - 1n });
  }
  for (const key of lostConfirmed) {
    const p = parseChunkKey(key);
    if (p.last > end) ranges.push({ first: p.first > end ? p.first : end + 1n, last: p.last });
  }
  const archiveGaps = mergeRanges(ranges).map((g) => ({ first: str(g.first), last: str(g.last) }));
  const state = {
    seqId: sid,
    lastSeq: end,
    lastCursor: lastChunk?.lastCursor ?? anchor.afterCursor,
    pending: null,
    rebuiltAt: new Date().toISOString(),
    beyond: later.map(({ key, receipt }) => ({ key, receipt })),
    overlaps: overlaps.map((b) => b.key),
    archiveGaps,
    unconfirmed: unconfirmed.map((u) => u.key),
    lostConfirmed,
  };
  saveState(state);
  console.log(
    `восстановлено из S3: граница после ${anchor.afterSeq}, цепочка ${chain.length} объектов до ${end}` +
      (later.length ? `, за разрывом ${later.length}` : '') +
      (unconfirmed.length ? `, без квитанции ${unconfirmed.length}` : '') +
      (lostConfirmed.length ? `, УТРАЧЕНО ПОДТВЕРЖДЁННЫХ ${lostConfirmed.length}` : '') +
      (overlaps.length ? `, ПЕРЕКРЫТИЙ ${overlaps.length}` : ''),
  );
  for (const g of archiveGaps) console.error(`ПРОПУСК В АРХИВЕ: записи ${g.first}–${g.last}`);
  return loadState();
}

// ------------------------------------------------------------------ init

async function init() {
  mkdirSync(STATE_DIR, { recursive: true });
  if (loadState()) throw new Error('архив уже начат — состояние есть');
  const tail = await tailCursor();
  if (!tail) throw new Error('журнал пуст');
  const { seqId } = cursorParts(tail.cursor);
  const anchor = {
    seqId,
    afterSeq: String(tail.seq),
    afterCursor: tail.cursor,
    at: new Date().toISOString(),
    host: hostname(),
  };
  await putAnchor(anchor);
  writeJsonAtomic(join(STATE_DIR, 'start.json'), anchor);
  saveState({
    seqId,
    lastSeq: tail.seq,
    lastCursor: tail.cursor,
    pending: null,
    startedAt: anchor.at,
  });
  console.log(`архив начат после записи ${tail.seq} журнала ${seqId}, граница закреплена в S3`);
}

function status() {
  const s = loadState();
  const rows = loadCatalog();
  console.log(
    JSON.stringify(
      {
        state: s
          ? { ...s, lastSeq: str(s.lastSeq), lastCursor: s.lastCursor ? '(есть)' : null }
          : null,
        catalog: { rows: rows.length, losses: rows.filter((r) => r.kind === 'loss').length },
      },
      null,
      2,
    ),
  );
}

/**
 * Проверка архива: каждая порция каталога читается ИМЕННО своей версией
 * (VersionId), расшифровывается, исходный хеш и число записей сверяются.
 * Отдельно — посторонние версии под ключами порций (запись мимо архиватора)
 * и неподтверждённые порции: это тоже не «всё в порядке».
 */
async function verify() {
  const keyMat = archiveKey(env.LOGS_ARCHIVE_KEY);
  const state = loadState();
  if (!state) throw new Error('нет локального состояния и каталога — сначала rebuild');
  const all = loadCatalog();
  const rows = all.filter((r) => r.kind === 'chunk');
  const problems = [];
  // Независимо от состояния: каждая квитанция в S3 — отрезок, который архив
  // обязан покрывать подтверждённой порцией или учтённой отметкой потери.
  // Утрата подтверждённой порции (в том числе последней) не даёт зелёного.
  const covered = mergeRanges(all.map((r) => ({ first: BigInt(r.first), last: BigInt(r.last) })));
  const isCovered = (a, b) => covered.some((c) => c.first <= a && b <= c.last);
  let receiptsSeen = 0;
  for (const [key] of groupByKey(await listVersions(`r/${state.seqId}/`))) {
    const r = parseReceiptKey(key);
    if (!r) continue;
    receiptsSeen++;
    if (!isCovered(r.first, r.last)) {
      problems.push(
        `отрезок ${r.first}–${r.last}: квитанция есть, в каталоге не покрыт — утрата архива`,
      );
    }
  }
  const foreign = [];
  const byKey = groupByKey(await listVersions(`${PREFIX}/`));
  for (const r of rows) {
    const got = await plainOfVersion(r.key, r.versionId, keyMat);
    if (!got) {
      problems.push(`${r.key}@${r.versionId}: нет или не расшифровано`);
      continue;
    }
    if (got.objSha !== r.objSha) problems.push(`${r.key}: хеш объекта не совпал`);
    const n = new ExportReader().push(got.plain).length;
    if (sha256Hex(got.plain) !== r.plainSha || n !== r.count) {
      problems.push(`${r.key}: исходный хеш или число записей не совпали`);
    }
    const others = (byKey.get(r.key) ?? []).filter((v) => v.versionId !== r.versionId);
    if (others.length) foreign.push(`${r.key}: посторонних версий ${others.length}`);
  }
  const unconfirmed = state?.unconfirmed?.length ?? 0;
  const gaps = state?.archiveGaps?.length ?? 0;
  console.log(
    `проверено порций: ${rows.length}, квитанций: ${receiptsSeen}, проблем: ${problems.length}, посторонних версий: ${foreign.length}, без квитанции: ${unconfirmed}, пропусков архива: ${gaps}`,
  );
  for (const p of [...problems, ...foreign]) console.log(`  ${p}`);
  const failedCheck = problems.length || foreign.length || gaps;
  // Два разных успеха (Тэнк 2026-11-03): согласованность архива с учтёнными
  // потерями не означает, что данные сохранены полностью.
  const losses = all.filter((r) => r.kind === 'loss');
  const lostRecords = losses.reduce((n, r) => n + (BigInt(r.last) - BigInt(r.first) + 1n), 0n);
  const byReason = {};
  for (const r of losses) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  console.log(
    failedCheck
      ? 'ИТОГ: проверка НЕ пройдена'
      : losses.length
        ? `ИТОГ: проверка пройдена, есть учтённые потери — отрезков ${losses.length}, записей ${lostRecords} (${Object.entries(
            byReason,
          )
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ')}); утраченное не восстановлено`
        : 'ИТОГ: данные сохранены полностью',
  );
  if (failedCheck) process.exitCode = 1;
}

// ------------------------------------------------------------- пакеты

const DAY_MS = 86_400_000;
const dayOf = (micros) => new Date(Math.floor(Number(micros) / 1000)).toISOString().slice(0, 10);
const nowMs = () => (env.LOGS_TEST_NOW ? Date.parse(env.LOGS_TEST_NOW) : Date.now());

/**
 * Пакет суток: заголовок-опись (длина + JSON) и исходные байты порций подряд.
 * Минутные порции остаются — пакет уменьшает число СКАЧИВАЕМЫХ объектов, а не
 * хранимых.
 */
function buildPack(parts) {
  const manifest = [];
  let offset = 0;
  for (const p of parts) {
    manifest.push({ ...p.row, offset, length: p.plain.length });
    offset += p.plain.length;
  }
  const head = Buffer.from(JSON.stringify(manifest));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length);
  return Buffer.concat([len, head, ...parts.map((p) => p.plain)]);
}

function parsePack(plain) {
  const n = plain.readUInt32BE(0);
  const manifest = JSON.parse(plain.subarray(4, 4 + n).toString('utf8'));
  const body = plain.subarray(4 + n);
  return manifest.map((m) => ({ ...m, plain: body.subarray(m.offset, m.offset + m.length) }));
}

const packKey = (sid, day) => `p/${sid}/${day}.pack`;
const packReceiptKey = (sid, day, versionId) => `pr/${sid}/${day}/${versionId}.json`;

/**
 * Собрать пакеты закрытых суток (UTC). Сутки закрыты, когда архиватор дочитал
 * журнал до конца позже их окончания (с запасом 5 минут), — иначе опоздавшая
 * порция выпала бы из пакета. Каждая порция читается ИМЕННО своей версией и
 * сверяется по исходному хешу.
 */
async function pack() {
  const keyMat = archiveKey(env.LOGS_ARCHIVE_KEY);
  await withLock(async () => {
    const state = loadState();
    if (!state) throw new Error('нет состояния — сначала rebuild');
    const rows = loadCatalog().filter((r) => r.kind === 'chunk' && r.from);
    const today = new Date(nowMs()).toISOString().slice(0, 10);
    const caughtUp = state.caughtUpAt ? Date.parse(state.caughtUpAt) : 0;
    const byDay = new Map();
    for (const r of rows) {
      const d = dayOf(r.from);
      if (d < today && caughtUp >= Date.parse(`${d}T00:00:00Z`) + DAY_MS + 5 * 60_000) {
        byDay.set(d, [...(byDay.get(d) ?? []), r]);
      }
    }
    const existing = new Set(
      (await listVersions(`pr/${state.seqId}/`)).map((v) => v.key.split('/')[2]),
    );
    let made = 0;
    for (const [day, list] of [...byDay].sort()) {
      if (existing.has(day)) continue;
      const parts = [];
      for (const row of list.sort((a, b) => (BigInt(a.first) < BigInt(b.first) ? -1 : 1))) {
        const got = await plainOfVersion(row.key, row.versionId, keyMat);
        if (!got || sha256Hex(got.plain) !== row.plainSha) {
          throw new Error(`пакет ${day}: порция ${row.key} не сошлась — пакет не собран`);
        }
        parts.push({ row, plain: got.plain });
      }
      const plain = buildPack(parts);
      const sealed = seal(plain, keyMat.key);
      const key = packKey(state.seqId, day);
      const versionId = await putObject(key, sealed, { format: `pack+${FORMAT}` });
      await putObject(
        packReceiptKey(state.seqId, day, versionId),
        Buffer.from(
          JSON.stringify({
            day,
            key,
            versionId,
            objSha: sha256Hex(sealed),
            plainSha: sha256Hex(plain),
            chunks: parts.map((p) => ({
              key: p.row.key,
              versionId: p.row.versionId,
              first: p.row.first,
              last: p.row.last,
              count: p.row.count,
              plainSha: p.row.plainSha,
            })),
          }),
        ),
      );
      made++;
      console.log(`пакет ${day}: порций ${parts.length}`);
    }
    console.log(`пакетов собрано: ${made}`);
  });
}

// ------------------------------------------------------------- скачивание

const MANIFEST = 'MANIFEST.sealed';

function copyDir() {
  const i = process.argv.indexOf('--to');
  const to = i > 0 ? process.argv[i + 1] : env.LOGS_PULL_TO || null;
  if (!to) throw new Error('нужен --to <каталог>');
  return to;
}

const packFile = (to, p) => join(to, 'packs', `${p.day}.${p.versionId}.pack`);
const chunkFile = (to, r) => join(to, 'chunks', `${r.key.split('/').pop()}.${r.versionId}`);

/** Пакет из локального файла: проверенные порции `key@versionId` или проблема. */
function packParts(to, p, keyMat) {
  const local = packFile(to, p);
  if (!existsSync(local)) return { missing: true, parts: new Map() };
  const sealed = readFileSync(local);
  if (sha256Hex(sealed) !== p.objSha) {
    return { problem: `пакет ${p.day}: хеш файла не совпал (порча копии)`, parts: new Map() };
  }
  let list;
  try {
    const plain = open(sealed, keyMat.key);
    if (sha256Hex(plain) !== p.plainSha) throw new Error('исходный хеш');
    list = parsePack(plain);
  } catch {
    return { problem: `пакет ${p.day}: не расшифрован или не сошёлся`, parts: new Map() };
  }
  const parts = new Map();
  const problems = [];
  for (const c of p.chunks) {
    const part = list.find((x) => x.key === c.key && x.versionId === c.versionId);
    if (
      !part ||
      sha256Hex(part.plain) !== c.plainSha ||
      new ExportReader().push(part.plain).length !== c.count
    ) {
      problems.push(`пакет ${p.day}: порция ${c.key} не сошлась`);
      continue;
    }
    parts.set(`${c.key}@${c.versionId}`, c);
  }
  return { problem: problems.join('; ') || null, parts };
}

/**
 * Ручная копия на ноутбук. Состав берётся из S3 — граница и ВСЕ квитанции
 * порций и потерь, включая квитанции на версии, которых в архиве уже нет
 * (это свидетельство утраты, а не мусор). Добавочно качаются пакеты и
 * подтверждённые порции, которых нет ни в копии, ни в её исправных пакетах.
 * Опись копии (граница, квитанции, пакеты) сохраняется рядом, зашифрованной
 * ключом архива, и вердикт выносит проверка ЛОКАЛЬНОЙ копии — та же, что
 * `verify-copy` без доступа к S3.
 *
 *   node scripts/logs-archive.mjs pull --to <каталог>
 */
async function pull() {
  const keyMat = archiveKey(env.LOGS_ARCHIVE_KEY);
  const to = copyDir();
  mkdirSync(join(to, 'packs'), { recursive: true });
  mkdirSync(join(to, 'chunks'), { recursive: true });

  const anchors = await readAnchors();
  if (!anchors.length) throw new Error('в S3 нет границы архива');
  const anchor = anchors.sort((a, b) => (a.at < b.at ? -1 : 1)).at(-1);
  const sid = anchor.seqId;

  const receipts = [];
  for (const [key, versions] of groupByKey(await listVersions(`r/${sid}/`))) {
    const r = parseReceiptKey(key);
    if (!r) continue;
    if (versions.length !== 1)
      throw new Error(`НЕОДНОЗНАЧНОСТЬ: у квитанции ${key} версий ${versions.length}`);
    const body = JSON.parse((await getVersion(key, versions[0].versionId)).toString('utf8'));
    const range = chunkKey(PREFIX, sid, r.first, r.last, r.kind);
    if (
      body.key !== range ||
      body.versionId !== r.versionId ||
      BigInt(body.first) !== r.first ||
      BigInt(body.last) !== r.last
    ) {
      throw new Error(`квитанция ${key}: содержимое не совпадает с именем`);
    }
    receipts.push(body);
  }
  const packs = [];
  for (const [key, versions] of groupByKey(await listVersions(`pr/${sid}/`))) {
    if (versions.length !== 1) throw new Error(`НЕОДНОЗНАЧНОСТЬ: квитанция пакета ${key}`);
    packs.push(JSON.parse((await getVersion(key, versions[0].versionId)).toString('utf8')));
  }

  let downloaded = 0;
  const inPacks = new Set();
  for (const p of packs) {
    if (!existsSync(packFile(to, p))) {
      const sealed = await getVersion(p.key, p.versionId);
      if (!sealed) continue; // проверка копии назовёт отсутствие
      writeFileSync(packFile(to, p), sealed);
      downloaded++;
    }
    for (const k of packParts(to, p, keyMat).parts.keys()) inPacks.add(k);
  }
  const versions = groupByKey(await listVersions(`${PREFIX}/${sid}/`));
  for (const r of receipts) {
    if (r.kind !== 'chunk' || inPacks.has(`${r.key}@${r.versionId}`)) continue;
    if (existsSync(chunkFile(to, r))) continue;
    if (!(versions.get(r.key) ?? []).some((v) => v.versionId === r.versionId)) continue;
    const sealed = await getVersion(r.key, r.versionId);
    if (!sealed) continue;
    writeFileSync(chunkFile(to, r), sealed);
    downloaded++;
  }

  const manifest = { at: new Date().toISOString(), anchor, receipts, packs };
  const tmp = join(to, `${MANIFEST}.tmp`);
  writeFileSync(tmp, seal(Buffer.from(JSON.stringify(manifest)), keyMat.key));
  renameSync(tmp, join(to, MANIFEST));
  console.log(`скачано объектов: ${downloaded}`);
  checkCopy(to, keyMat);
}

/**
 * Проверка ручной копии ТОЛЬКО по локальным файлам и ключу — S3 не нужен.
 * Ожидаемый состав — все квитанции описи до последней ожидаемой записи.
 * Каждый отрезок покрыт точной подтверждённой порцией (отдельным файлом или
 * внутри исправного пакета) либо учтённой отметкой потери; иначе — утрата.
 *
 *   node scripts/logs-archive.mjs verify-copy --to <каталог>
 */
function verifyCopy() {
  checkCopy(copyDir(), archiveKey(env.LOGS_ARCHIVE_KEY));
}

function checkCopy(to, keyMat) {
  let manifest;
  try {
    manifest = JSON.parse(open(readFileSync(join(to, MANIFEST)), keyMat.key).toString('utf8'));
  } catch {
    throw new Error(`опись копии ${MANIFEST} отсутствует, испорчена или другой ключ`);
  }
  const { anchor, receipts, packs } = manifest;
  const problems = [];
  const fromPacks = new Map();
  for (const p of packs) {
    const res = packParts(to, p, keyMat);
    if (res.missing) problems.push(`пакет ${p.day}: файла нет в копии`);
    if (res.problem) problems.push(res.problem);
    for (const [k, c] of res.parts) fromPacks.set(k, c);
  }

  const ok = [];
  const lost = [];
  const absent = [];
  let viaPack = 0;
  let viaChunk = 0;
  for (const r of receipts) {
    const range = { first: BigInt(r.first), last: BigInt(r.last) };
    if (r.kind === 'loss') {
      lost.push({ ...range, reason: r.reason });
      continue;
    }
    if (fromPacks.has(`${r.key}@${r.versionId}`)) {
      ok.push(range);
      viaPack++;
      continue;
    }
    const local = chunkFile(to, r);
    if (!existsSync(local)) {
      absent.push(r);
      continue;
    }
    const sealed = readFileSync(local);
    let plain = null;
    try {
      plain = open(sealed, keyMat.key);
    } catch {
      /* ниже — проблема */
    }
    if (
      !plain ||
      sha256Hex(sealed) !== r.objSha ||
      sha256Hex(plain) !== r.plainSha ||
      new ExportReader().push(plain).length !== r.count
    ) {
      problems.push(`порция ${r.key}: копия не сошлась с квитанцией`);
      continue;
    }
    ok.push(range);
    viaChunk++;
  }

  // Покрытие от границы до последней ожидаемой записи (по всем квитанциям).
  const covered = mergeRanges([...ok, ...lost]);
  const isCovered = (a, b) => covered.some((c) => c.first <= a && b <= c.last);
  for (const r of absent) {
    if (!isCovered(BigInt(r.first), BigInt(r.last))) {
      problems.push(
        `отрезок ${r.first}–${r.last}: квитанция есть, порции нет ни отдельно, ни в пакете — утрата архива`,
      );
    }
  }
  const start = BigInt(anchor.afterSeq) + 1n;
  const expectedEnd = receipts.reduce(
    (m, r) => (BigInt(r.last) > m ? BigInt(r.last) : m),
    start - 1n,
  );
  const gaps = [];
  let at = start;
  for (const c of covered) {
    if (c.first > at) gaps.push(`${at}–${c.first - 1n}`);
    if (c.last + 1n > at) at = c.last + 1n;
  }
  if (at <= expectedEnd) gaps.push(`${at}–${expectedEnd}`);

  const lostRecords = lost.reduce((n, r) => n + (r.last - r.first + 1n), 0n);
  const byReason = {};
  for (const r of lost) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  const summary = {
    at: new Date().toISOString(),
    seqId: anchor.seqId,
    from: str(start),
    to: str(expectedEnd),
    packs: packs.length,
    chunksViaPack: viaPack,
    chunksSeparate: viaChunk,
    chunksAbsent: absent.length,
    losses: lost.length,
    lossRecords: str(lostRecords),
    gaps,
    problems,
  };
  writeFileSync(join(to, 'PULLED.json'), JSON.stringify(summary, null, 2));
  console.log(
    `копия: записи ${summary.from}–${summary.to}, пакетов: ${packs.length}, порций из пакетов: ${viaPack}, отдельно: ${viaChunk}, нет в копии: ${absent.length}, пропусков: ${gaps.length}, проблем: ${problems.length}`,
  );
  for (const p of [...gaps.map((g) => `пропуск ${g}`), ...problems]) console.log(`  ${p}`);
  const failedCheck = gaps.length || problems.length;
  console.log(
    failedCheck
      ? 'ИТОГ: копия НЕ сошлась'
      : lost.length
        ? `ИТОГ: копия сошлась, есть учтённые потери — отрезков ${lost.length}, записей ${lostRecords} (${Object.entries(
            byReason,
          )
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ')}); утраченное не восстановлено`
        : 'ИТОГ: данные сохранены полностью',
  );
  if (failedCheck) process.exitCode = 1;
}

const commands = {
  init,
  run,
  rebuild: rebuildState,
  status,
  verify,
  pack,
  pull,
  'verify-copy': verifyCopy,
};
const command = process.argv[2];
if (!commands[command]) {
  console.error(`команды: ${Object.keys(commands).join(', ')}`);
  process.exit(2);
}
try {
  await commands[command]();
} catch (error) {
  console.error(`ОШИБКА: ${error.message}`);
  process.exit(1);
}
