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
 *   node scripts/logs-archive.mjs find --from <ISO> [...]   поиск (архив + свежее)
 *   node scripts/logs-archive.mjs files     закрытые поколения файловых журналов (почта)
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
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  ExportReader,
  exportFields,
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
import { BASELINE_MIN_HOURS } from './lib/logs-metrics-zabbix.mjs';
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

async function runPass() {
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
      tally(state, entries);
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
      tally(state, slice);
      await confirm(state, catalogRow(key, slice, res), slice.at(-1));
      written++;
    }
    // Журнал дочитан до конца — момент нужен пакетам: сутки закрыты, если
    // после их конца архиватор дочитал журнал (записи суток уже в архиве).
    state.caughtUpAt = new Date(nowMs()).toISOString();
    saveState(state);
    await writeMetrics(state, null);
    console.log(`проход: порций ${written}, последняя запись ${state.lastSeq ?? '—'}`);
  });
}

/** Проход + файл состояния для Zabbix и при сбое (кроме «проход уже идёт»). */
async function run() {
  try {
    await runPass();
  } catch (error) {
    if (!String(error?.message).startsWith('проход уже идёт')) {
      try {
        await writeMetrics(loadState(), failureCode(error));
      } catch {
        /* состояние для наблюдения не записалось — Zabbix увидит устаревание */
      }
    }
    throw error;
  }
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
    startedAt: anchor.at,
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
  const filesSeen = await verifyFiles(keyMat, problems, foreign);
  const unconfirmed = state?.unconfirmed?.length ?? 0;
  const gaps = state?.archiveGaps?.length ?? 0;
  console.log(
    `проверено порций: ${rows.length}, квитанций: ${receiptsSeen}, файлов: ${filesSeen}, проблем: ${problems.length}, посторонних версий: ${foreign.length}, без квитанции: ${unconfirmed}, пропусков архива: ${gaps}`,
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

// ---------------------------------------------------------- файлы почты

/**
 * Файловые журналы (exim, dovecot) — закрытыми поколениями после ротации:
 * `<журнал>.N` и `<журнал>.N.gz`, не моложе LOGS_FILES_MIN_AGE_SEC (10 мин);
 * изменяющийся файл не копируется. LOGS_FILES — пути журналов через запятую,
 * например `/var/log/exim4/mainlog,/var/log/dovecot.log`.
 *
 * Поколение узнаётся по СОДЕРЖИМОМУ (SHA-256 после распаковки): ротация
 * переименовывает `.1` в `.2.gz`, и это то же поколение — второй раз не
 * пишется. Объект `f/<журнал>/<хеш>.fx` шифруется как порции; квитанция
 * `rf/<хеш>/<VersionId>.json` пишется после чтения записанной версии и сверки
 * хеша. Под ключом объекта чужое содержимое — конфликт, без перезаписи.
 */
const FILES = (env.LOGS_FILES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const FILES_MIN_AGE_SEC = Number(env.LOGS_FILES_MIN_AGE_SEC ?? 600);
const FILES_STATE = join(STATE_DIR, 'files.json');
const fileSource = (base) => base.replace(/^\/+/, '').replace(/[^\w.-]/g, '_');
const fileKey = (src, sha) => `f/${src}/${sha}.fx`;
const fileReceiptKey = (sha, versionId) => `rf/${sha}/${versionId}.json`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Закрытые поколения журнала: [{path, name, gz}]. */
function closedGenerations(base) {
  const dir = dirname(base);
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^${escapeRe(basename(base))}\\.\\d+(\\.gz)?$`);
  const oldest = Date.now() - FILES_MIN_AGE_SEC * 1000;
  return readdirSync(dir)
    .filter((name) => re.test(name))
    .map((name) => ({ name, path: join(dir, name), gz: name.endsWith('.gz') }))
    .filter((g) => statSync(g.path).mtimeMs <= oldest)
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Квитанции файлов из S3: хеш → тело квитанции. */
async function fileReceipts() {
  const out = new Map();
  for (const [key, versions] of groupByKey(await listVersions('rf/'))) {
    if (versions.length !== 1) {
      throw new Error(`НЕОДНОЗНАЧНОСТЬ: у квитанции ${key} версий ${versions.length}`);
    }
    const body = JSON.parse((await getVersion(key, versions[0].versionId)).toString('utf8'));
    if (key !== fileReceiptKey(body.plainSha, body.versionId)) {
      throw new Error(`квитанция ${key}: содержимое не совпадает с именем`);
    }
    out.set(body.plainSha, body);
  }
  return out;
}

async function files() {
  const keyMat = archiveKey(env.LOGS_ARCHIVE_KEY);
  if (!FILES.length) throw new Error('LOGS_FILES не задан');
  await withLock(async () => {
    const known = await fileReceipts();
    let stored = 0;
    let same = 0;
    let unreadable = 0;
    for (const base of FILES) {
      const src = fileSource(base);
      for (const g of closedGenerations(base)) {
        let plain;
        try {
          const raw = readFileSync(g.path);
          plain = g.gz ? gunzipSync(raw) : raw;
        } catch {
          // Поколение сжимается или удаляется ротацией прямо сейчас —
          // следующий проход прочитает его готовым.
          unreadable++;
          continue;
        }
        if (!plain.length) continue;
        const plainSha = sha256Hex(plain);
        if (known.has(plainSha)) {
          same++;
          continue;
        }
        const key = fileKey(src, plainSha);
        // Уже записанная версия (сбой до квитанции) подтверждается по
        // содержимому; чужое содержимое под ключом — конфликт.
        let versionId = null;
        let objSha = null;
        const existing = (await listVersions(key)).filter((v) => v.key === key);
        for (const v of existing) {
          const got = await plainOfVersion(key, v.versionId, keyMat);
          if (got && sha256Hex(got.plain) === plainSha) {
            versionId = v.versionId;
            objSha = got.objSha;
            break;
          }
        }
        if (!versionId && existing.length) {
          throw new Error(`КОНФЛИКТ: под ${key} другое содержимое — без перезаписи, нужен разбор`);
        }
        if (!versionId) {
          versionId = await putObject(key, seal(plain, keyMat.key), {
            format: `file+${FORMAT}`,
            source: src,
          });
          const got = await plainOfVersion(key, versionId, keyMat);
          if (!got || sha256Hex(got.plain) !== plainSha) {
            throw new Error(`${key}@${versionId}: записанное не читается в прежнем виде`);
          }
          objSha = got.objSha;
          if (env.LOGS_TEST_CRASH === 'file-after-put') process.exit(96);
        }
        const body = {
          kind: 'file',
          key,
          versionId,
          source: src,
          name: g.name,
          size: plain.length,
          plainSha,
          objSha,
          mtime: new Date(statSync(g.path).mtimeMs).toISOString(),
          at: new Date().toISOString(),
        };
        await putObject(fileReceiptKey(plainSha, versionId), Buffer.from(JSON.stringify(body)));
        known.set(plainSha, body);
        stored++;
        console.log(`файл ${g.path}: записан (${plain.length} байт)`);
      }
    }
    writeJsonAtomic(FILES_STATE, {
      lastOkAt: new Date().toISOString(),
      stored,
      same,
      unreadable,
      known: known.size,
    });
    console.log(
      `файлы: записано ${stored}, уже в архиве ${same}, не прочитано сейчас ${unreadable}, всего в архиве ${known.size}`,
    );
  });
}

/** Проверка файлов архива: каждая квитанция — своей версией, хеши. */
async function verifyFiles(keyMat, problems, foreign) {
  const known = await fileReceipts();
  const byKey = groupByKey(await listVersions('f/'));
  for (const r of known.values()) {
    const got = await plainOfVersion(r.key, r.versionId, keyMat);
    if (!got) {
      problems.push(`файл ${r.source}/${r.name}: версии нет или не расшифрована — утрата архива`);
      continue;
    }
    if (got.objSha !== r.objSha || sha256Hex(got.plain) !== r.plainSha) {
      problems.push(`файл ${r.source}/${r.name}: хеш не совпал`);
    }
    const others = (byKey.get(r.key) ?? []).filter((v) => v.versionId !== r.versionId);
    if (others.length) foreign.push(`${r.key}: посторонних версий ${others.length}`);
  }
  return known.size;
}

// --------------------------------------------------------- наблюдение

/**
 * Файл состояния для Zabbix (как сигналы W07): только числа, метки
 * источников и коды — без текстов ошибок и сообщений журнала. Пишется после
 * каждого прохода, в том числе неудачного. Zabbix считает файл старше 5 минут
 * «неизвестно», а не нулями.
 */
const METRICS = join(STATE_DIR, 'metrics.json');
/** Суточные снимки объёма — отдельно от состояния прохода (его можно потерять). */
const SNAPSHOTS = join(STATE_DIR, 'snapshots.json');
const MIN_US = 60_000_000;
const HOUR_US = 3_600_000_000;

/** Метка для счётчика: имя источника или код, но не текст. */
const label = (s) =>
  String(s)
    .replace(/[^\w.@:-]/g, '_')
    .slice(0, 64);

const emptyBucket = () => ({
  bytes: 0,
  requests: 0,
  s5xx: 0,
  fail2xx: 0,
  oom: 0,
  crashes: 0,
  suppressed: 0,
  errors: {},
  codes: {},
});

/**
 * Счётчики по минутам времени записи (последний час) и объём по часам
 * (31 сутки). Считаются при подтверждении порции и сохраняются вместе с её
 * курсором — повтор после сбоя не считает дважды.
 */
function tally(state, entries) {
  // С какого момента идёт счёт: до часа счёта значения часа неполные, до
  // 72 часов база среднего притока не готова (счёт сбрасывается вместе с
  // потерей состояния).
  state.countingSince ??= new Date().toISOString();
  const minutes = (state.minutes ??= {});
  const hours = (state.hours ??= {});
  for (const e of entries) {
    if (e.realtime === null) continue;
    const f = exportFields(e.raw);
    const b = (minutes[Math.floor(e.realtime / MIN_US)] ??= emptyBucket());
    const hk = Math.floor(e.realtime / HOUR_US);
    hours[hk] = (hours[hk] ?? 0) + e.raw.length;
    b.bytes += e.raw.length;
    const msg = f.MESSAGE ?? '';
    let m = null;
    try {
      m = msg.startsWith('{') ? JSON.parse(msg) : null;
    } catch {
      /* не JSON */
    }
    if (m && m.ctx === 'http' && typeof m.status === 'number') {
      b.requests++;
      if (m.status >= 500) b.s5xx++;
      else if (m.status < 300 && m.code) b.fail2xx++;
    }
    const isError = m ? ['error', 'fatal'].includes(m.level) : Number(f.PRIORITY ?? 6) <= 3;
    if (isError) {
      const k = label(m?.component ?? sourceOf(f));
      b.errors[k] = (b.errors[k] ?? 0) + 1;
      if (m?.code) b.codes[label(m.code)] = (b.codes[label(m.code)] ?? 0) + 1;
    }
    if (/Out of memory|invoked oom-killer|oom-kill/i.test(msg)) b.oom++;
    if (/Main process exited, code=(dumped|killed)|core dumped/.test(msg)) b.crashes++;
    const sup = msg.match(/^Suppressed (\d+) messages/);
    if (sup) b.suppressed += Number(sup[1]);
  }
  const nowUs = Date.now() * 1000;
  for (const k of Object.keys(minutes)) {
    if (Number(k) < Math.floor((nowUs - HOUR_US) / MIN_US)) delete minutes[k];
  }
  for (const k of Object.keys(hours)) {
    if (Number(k) < Math.floor((nowUs - 31 * 24 * HOUR_US) / HOUR_US)) delete hours[k];
  }
}

/** Код сбоя прохода — для сигнала; текст ошибки в файл не попадает. */
function failureCode(error) {
  const m = String(error?.message ?? '');
  if (m.includes('КОНФЛИКТ')) return 'conflict';
  if (m.includes('НЕОДНОЗНАЧНОСТЬ')) return 'ambiguity';
  if (/S3|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND/.test(m) || error?.cause?.code) return 's3';
  if (m.includes('journalctl')) return 'journal';
  if (m.includes('не начат')) return 'not-started';
  return 'other';
}

/** Занятость journald, байт (`journalctl --disk-usage`). */
function journalUsage() {
  const r = spawnSync('journalctl', ['--disk-usage', ...JOURNAL_ARGS], { encoding: 'utf8' });
  const m = (r.stdout ?? '').match(/take up ([\d.]+)([BKMGT])/);
  if (!m) return null;
  return Math.round(Number(m[1]) * 1024 ** 'BKMGT'.indexOf(m[2]));
}

/** Записи journald за подтверждённым курсором: очередь и её возраст. */
async function queueAfter(cursor) {
  if (!cursor) return null;
  try {
    let entries = 0;
    let bytes = 0;
    let oldest = null;
    for (const e of await readJournal({ after: cursor, maxBytes: Infinity })) {
      entries++;
      bytes += e.raw.length;
      if (oldest === null && e.realtime !== null) oldest = e.realtime;
    }
    return { entries, bytes, oldestEpoch: oldest === null ? null : Math.floor(oldest / 1e6) };
  } catch {
    return null;
  }
}

async function writeMetrics(state, failure) {
  const now = Date.now();
  const nowUs = now * 1000;
  const sum = emptyBucket();
  for (const [k, b] of Object.entries(state?.minutes ?? {})) {
    if (Number(k) * MIN_US < nowUs - HOUR_US) continue;
    for (const n of ['bytes', 'requests', 's5xx', 'fail2xx', 'oom', 'crashes', 'suppressed']) {
      sum[n] += b[n];
    }
    for (const n of ['errors', 'codes']) {
      for (const [x, v] of Object.entries(b[n])) sum[n][x] = (sum[n][x] ?? 0) + v;
    }
  }
  // Счёт идёт с countingSince: раньше этого момента записи не считались, и
  // ноль там — «не измерено», а не «притока не было».
  const since = state?.countingSince ? Date.parse(state.countingSince) * 1000 : null;
  const coveredSec = since === null ? 0 : Math.min(3600, Math.floor((nowUs - since) / 1e6));
  const hourComplete = coveredSec >= 3600;
  // Среднее за час — по ВСЕМ завершённым часам окна (час без записей — ноль
  // притока), окно не раньше начала счёта; база готова от 72 часов.
  const nowHour = Math.floor(nowUs / HOUR_US);
  const firstHour = since === null ? nowHour : Math.max(Math.ceil(since / HOUR_US), nowHour - 168);
  const baselineHours = Math.max(0, nowHour - firstHour);
  const baselineReady = baselineHours >= BASELINE_MIN_HOURS;
  let pastSum = 0;
  for (const [k, v] of Object.entries(state?.hours ?? {})) {
    if (Number(k) >= firstHour && Number(k) < nowHour) pastSum += v;
  }
  const avgHour = baselineReady ? Math.round(pastSum / baselineHours) : null;
  const usage = journalUsage();
  const limit = env.LOGS_JOURNAL_MAX_BYTES ? Number(env.LOGS_JOURNAL_MAX_BYTES) : null;
  // Запас: причина, если не вычислен. Скорость — измеренная (полный час или
  // готовая база); нулевая измеренная скорость — «притока нет», запас не
  // ограничен, но это не число.
  const rates = [hourComplete ? sum.bytes : null, avgHour].filter((x) => x !== null);
  const rate = rates.length ? Math.max(...rates) : null;
  const fillState =
    usage === null
      ? 'no-usage'
      : !limit
        ? 'no-limit'
        : rate === null
          ? 'no-rate'
          : rate === 0
            ? 'no-inflow'
            : 'ok';
  const rows = loadCatalog();
  const losses = rows.filter((r) => r.kind === 'loss');
  const byReason = {};
  for (const r of losses) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  const snaps = readJson(SNAPSHOTS);
  const daily = Object.entries(snaps?.daily ?? {}).sort();
  const avgDays = (n) => {
    const xs = daily.slice(-n - 1, -1).map(([, v]) => v);
    return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  };
  const queue = await queueAfter(state?.lastCursor);
  writeJsonAtomic(METRICS, {
    format: 'logs-metrics/v1',
    atEpoch: Math.floor(now / 1000),
    run: { ok: !failure, failure: failure ?? null },
    lastOkEpoch: state?.lastOkAt ? Math.floor(Date.parse(state.lastOkAt) / 1000) : null,
    caughtUpEpoch: state?.caughtUpAt ? Math.floor(Date.parse(state.caughtUpAt) / 1000) : null,
    queue: queue && {
      ...queue,
      lagSec:
        queue.oldestEpoch === null ? 0 : Math.max(0, Math.floor(now / 1000) - queue.oldestEpoch),
    },
    losses: {
      segments: losses.length,
      records: str(losses.reduce((n, r) => n + (BigInt(r.last) - BigInt(r.first) + 1n), 0n)),
      byReason,
    },
    archiveGaps: state?.archiveGaps?.length ?? 0,
    unconfirmed: state?.unconfirmed?.length ?? 0,
    archiveStartEpoch: state?.startedAt ? Math.floor(Date.parse(state.startedAt) / 1000) : null,
    // Файлы почты: null — не настроены; lastOkEpoch null — успешного прохода
    // ещё не было.
    files: FILES.length
      ? {
          lastOkEpoch: (() => {
            const t = readJson(FILES_STATE)?.lastOkAt;
            return t ? Math.floor(Date.parse(t) / 1000) : null;
          })(),
        }
      : null,
    lastHour: { ...sum, coveredSec },
    inflow: {
      lastHourBytes: hourComplete ? sum.bytes : null,
      avg7dHourBytes: avgHour,
      baselineHours,
      baselineReady,
    },
    journald: {
      usageBytes: usage,
      limitBytes: limit,
      // Запас до вытеснения неархивированного: при остановке архива это
      // время, за которое journald заполнится текущим притоком.
      fillState,
      fillHours: fillState === 'ok' ? Math.round(((limit - usage) / rate) * 10) / 10 : null,
    },
    snapshot: snaps?.lastAt
      ? {
          lastEpoch: Math.floor(Date.parse(snaps.lastAt) / 1000),
          lastDay: daily.at(-1)?.[0] ?? null,
          lastDayBytes: daily.at(-1)?.[1] ?? null,
          avg7dDayBytes: avgDays(7),
          avg30dDayBytes: avgDays(30),
        }
      : null,
  });
}

/** Снимок объёма суток по источникам — объектом в архиве и в файле снимков. */
async function putVolumeSnapshot(sid, day, parts) {
  const bySource = {};
  let total = 0;
  let entries = 0;
  for (const p of parts) {
    for (const e of new ExportReader().push(p.plain)) {
      const k = label(sourceOf(exportFields(e.raw)));
      bySource[k] = (bySource[k] ?? 0) + e.raw.length;
      total += e.raw.length;
      entries++;
    }
  }
  await putObject(
    `volume/${sid}/${day}.json`,
    Buffer.from(JSON.stringify({ day, total, entries, bySource })),
  );
  const snaps = readJson(SNAPSHOTS) ?? { daily: {} };
  snaps.daily[day] = total;
  for (const d of Object.keys(snaps.daily).sort().slice(0, -40)) delete snaps.daily[d];
  snaps.lastAt = new Date().toISOString();
  writeJsonAtomic(SNAPSHOTS, snaps);
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
      await putVolumeSnapshot(state.seqId, day, parts);
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
const copyFile = (to, r) => join(to, 'files', `${r.plainSha}.${r.versionId}`);

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
    parts.set(`${c.key}@${c.versionId}`, { ...c, plain: part.plain });
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
  // Файлы почты — все квитанции; версии, которой нет, проверка копии
  // назовёт утратой.
  mkdirSync(join(to, 'files'), { recursive: true });
  const fileList = [...(await fileReceipts()).values()];
  for (const r of fileList) {
    if (existsSync(copyFile(to, r))) continue;
    const sealed = await getVersion(r.key, r.versionId);
    if (!sealed) continue;
    writeFileSync(copyFile(to, r), sealed);
    downloaded++;
  }

  const manifest = { at: new Date().toISOString(), anchor, receipts, packs, files: fileList };
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

  // Файлы почты: каждый по квитанции — есть в копии и сходится.
  const fileList = manifest.files ?? [];
  for (const r of fileList) {
    const local = copyFile(to, r);
    if (!existsSync(local)) {
      problems.push(`файл ${r.source}/${r.name}: нет в копии — утрата архива`);
      continue;
    }
    const sealed = readFileSync(local);
    let plain = null;
    try {
      plain = open(sealed, keyMat.key);
    } catch {
      /* ниже — проблема */
    }
    if (!plain || sha256Hex(sealed) !== r.objSha || sha256Hex(plain) !== r.plainSha) {
      problems.push(`файл ${r.source}/${r.name}: копия не сошлась с квитанцией`);
    }
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
    files: fileList.length,
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
    `копия: записи ${summary.from}–${summary.to}, пакетов: ${packs.length}, порций из пакетов: ${viaPack}, отдельно: ${viaChunk}, нет в копии: ${absent.length}, файлов: ${fileList.length}, пропусков: ${gaps.length}, проблем: ${problems.length}`,
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

// ----------------------------------------------------------------- поиск

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? (process.argv[i + 1] ?? null) : null;
};

/** Время ISO → микросекунды journald; неверное значение — ошибка, не «всё». */
function micros(name, fallback) {
  const v = argOf(name);
  if (v === null) return fallback;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new Error(`${name}: нужно время ISO, например 2026-11-03T10:00:00Z`);
  return ms * 1000;
}

const sourceOf = (f) => f.CONTAINER_NAME || f._SYSTEMD_UNIT || f.SYSLOG_IDENTIFIER || '?';

/** Фильтр записи: источник; ID запроса и код — по полям JSON-сообщения. */
function matcher({ source, requestId, code }) {
  return (f) => {
    if (source && ![f.CONTAINER_NAME, f._SYSTEMD_UNIT, f.SYSLOG_IDENTIFIER].includes(source)) {
      return false;
    }
    if (!requestId && !code) return true;
    let m = null;
    try {
      m = (f.MESSAGE ?? '').startsWith('{') ? JSON.parse(f.MESSAGE) : null;
    } catch {
      /* не JSON — ID запроса и кода нет */
    }
    if (!m) return false;
    if (requestId && m.requestId !== requestId) return false;
    if (code && m.code !== code && String(m.status ?? '') !== code) return false;
    return true;
  };
}

/**
 * Поиск по журналам за интервал.
 *
 *   node scripts/logs-archive.mjs find --from <ISO> [--to <ISO>] [--source <имя>]
 *        [--request-id <id>] [--code <код или HTTP-статус>] [--limit N] [--copy <каталог>]
 *
 * Архивное — по каталогу: каждая порция, пересекающая интервал, читается
 * ИМЕННО своей версией и сверяется по исходному хешу (учётка только на
 * чтение); свежее, ещё не ушедшее в архив, — из journald после курсора
 * архиватора. С `--copy` — только по ручной копии на ноутбуке, без S3 и
 * journald. Учтённые потери, задевающие интервал, называются; порция,
 * которая не прочиталась или не сошлась, делает поиск неполным (код 1).
 * Накопленная до W08b история сюда не входит (чувствительный архив).
 */
async function find() {
  const keyMat = archiveKey(env.LOGS_ARCHIVE_KEY);
  const fromUs = micros('--from', null);
  if (fromUs === null) throw new Error('нужен --from <ISO>');
  const toUs = micros('--to', Date.now() * 1000);
  if (toUs < fromUs) throw new Error('--to раньше --from');
  const limit = Number(argOf('--limit') ?? 1000);
  const match = matcher({
    source: argOf('--source'),
    requestId: argOf('--request-id'),
    code: argOf('--code'),
  });
  const copy = argOf('--copy');

  // Порции и отметки потерь: из каталога сервера или из описи копии.
  let rows;
  let plainOf;
  let state = null;
  if (copy) {
    let manifest;
    try {
      manifest = JSON.parse(open(readFileSync(join(copy, MANIFEST)), keyMat.key).toString('utf8'));
    } catch {
      throw new Error(`опись копии ${MANIFEST} отсутствует, испорчена или другой ключ`);
    }
    const fromPacks = new Map();
    for (const p of manifest.packs) {
      for (const [k, c] of packParts(copy, p, keyMat).parts) fromPacks.set(k, c.plain);
    }
    // Квитанция на версию, которой нет в копии, но отрезок покрыт другой
    // порцией или отметкой потери, — не пропуск поиска (как в verify-copy).
    const has = (r) => fromPacks.has(`${r.key}@${r.versionId}`) || existsSync(chunkFile(copy, r));
    const covered = mergeRanges(
      manifest.receipts
        .filter((r) => r.kind === 'loss' || has(r))
        .map((r) => ({ first: BigInt(r.first), last: BigInt(r.last) })),
    );
    rows = manifest.receipts.filter(
      (r) =>
        r.kind !== 'chunk' ||
        has(r) ||
        !covered.some((c) => c.first <= BigInt(r.first) && BigInt(r.last) <= c.last),
    );
    plainOf = async (r) => {
      const packed = fromPacks.get(`${r.key}@${r.versionId}`);
      if (packed) return packed;
      const local = chunkFile(copy, r);
      if (!existsSync(local)) return null;
      try {
        const plain = open(readFileSync(local), keyMat.key);
        return sha256Hex(plain) === r.plainSha ? plain : null;
      } catch {
        return null;
      }
    };
  } else {
    state = loadState();
    if (!state) throw new Error('нет каталога архиватора — поиск по архиву невозможен');
    rows = loadCatalog();
    plainOf = async (r) => {
      const got = await plainOfVersion(r.key, r.versionId, keyMat);
      return got && sha256Hex(got.plain) === r.plainSha ? got.plain : null;
    };
  }
  const chunks = rows
    .filter((r) => r.kind === 'chunk')
    .sort((a, b) => (BigInt(a.first) < BigInt(b.first) ? -1 : 1));
  const hit = chunks.filter((r) => r.from <= toUs && r.to >= fromUs);
  // Записи интервала лежат по номерам между последней порцией, целиком
  // раньше интервала, и первой, целиком позже; потери в этом отрезке
  // задевают интервал.
  const before = chunks.filter((r) => r.to < fromUs).at(-1);
  const after = chunks.find((r) => r.from > toUs);
  const lo = before ? BigInt(before.last) : -1n;
  const hi = after ? BigInt(after.first) : null;
  const losses = rows.filter(
    (r) => r.kind === 'loss' && BigInt(r.last) > lo && (hi === null || BigInt(r.first) < hi),
  );

  const found = [];
  const problems = [];
  // Одна запись может оказаться и в двух порциях (повтор после разбора):
  // выдаётся один раз — по номеру.
  const seen = new Set();
  const take = (e) => {
    if (e.realtime === null || e.realtime < fromUs || e.realtime > toUs) return;
    if (seen.has(e.seq)) return;
    seen.add(e.seq);
    const f = exportFields(e.raw);
    if (match(f))
      found.push({ t: e.realtime, seq: e.seq, source: sourceOf(f), msg: f.MESSAGE ?? '' });
  };
  for (const r of hit) {
    const plain = await plainOf(r);
    if (!plain) {
      problems.push(`порция ${r.first}–${r.last}: не прочитана или не сошлась с хешем`);
      continue;
    }
    for (const e of new ExportReader().push(plain)) take(e);
  }
  // Свежее — из journald после последней архивированной записи.
  let fresh = 0;
  if (!copy && state.lastCursor) {
    for (const e of await readJournal({ after: state.lastCursor, maxBytes: Infinity })) {
      fresh++;
      take(e);
    }
  }

  found.sort((a, b) => (a.seq < b.seq ? -1 : 1));
  for (const x of found.slice(0, limit)) {
    // Управляющие символы (переводы строк, ESC) — пробелом: одна запись — одна строка.
    const msg = [...x.msg].map((c) => (c.charCodeAt(0) < 32 || c === '\x7f' ? ' ' : c)).join('');
    console.log(`${new Date(Math.floor(x.t / 1000)).toISOString()}  ${x.source}  ${msg}`);
  }
  console.log(
    `найдено: ${found.length}${found.length > limit ? ` (показаны первые ${limit})` : ''}; порций архива: ${hit.length}${copy ? ' (копия)' : `, свежих записей journald: ${fresh}`}; учтённых потерь в интервале: ${losses.length}; проблем: ${problems.length}`,
  );
  for (const l of losses)
    console.log(
      `  потеря ${l.first}–${l.last} (${l.reason}): записи интервала могли быть утрачены`,
    );
  for (const p of problems) console.log(`  ${p}`);
  if (problems.length) {
    console.log('ИТОГ: поиск НЕПОЛОН');
    process.exitCode = 1;
  }
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
  files,
  find,
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
