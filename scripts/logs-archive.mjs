#!/usr/bin/env node
/**
 * Архиватор технических журналов (блок 8, 8.4; 2.1-W08b).
 *
 *   node scripts/logs-archive.mjs init      начать архив с текущего конца журнала
 *   node scripts/logs-archive.mjs run       один проход: новые записи → порции в S3
 *   node scripts/logs-archive.mjs rebuild   состояние и каталог заново из S3
 *   node scripts/logs-archive.mjs status    сводка без секретов
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
  const fd = openSync(CATALOG, 'a');
  appendFileSync(fd, `${JSON.stringify(row)}\n`);
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

const meta = (h, name) => h.get(`x-amz-meta-${name}`);

async function headChunk(key) {
  const r = await s3Object(storage, 'HEAD', key);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`S3 HEAD ${key}: ${r.status}`);
  return {
    versionId: r.headers.get('x-amz-version-id'),
    plainSha: meta(r.headers, 'plain-sha256'),
    count: Number(meta(r.headers, 'count') ?? 0),
    firstCursor: meta(r.headers, 'first-cursor'),
    lastCursor: meta(r.headers, 'last-cursor'),
    from: meta(r.headers, 'from'),
    to: meta(r.headers, 'to'),
    reason: meta(r.headers, 'reason'),
    objSha: meta(r.headers, 'object-sha256'),
  };
}

async function putChunk(key, body, metadata) {
  // Метаданные объекта идут заголовками HTTP — только ASCII (испытание 10:
  // причина потери по-русски роняла запись). Описания — в каталоге.
  for (const [k, v] of Object.entries(metadata)) {
    if (!/^[\x20-\x7e]*$/.test(String(v))) throw new Error(`метаданные ${k}: не ASCII`);
  }
  const headers = Object.fromEntries(
    Object.entries(metadata).map(([k, v]) => [`x-amz-meta-${k}`, String(v)]),
  );
  headers['content-type'] = 'application/octet-stream';
  const r = await s3Object(storage, 'PUT', key, body, headers);
  if (!r.ok) throw new Error(`S3 PUT ${key}: ${r.status}`);
  return r.headers.get('x-amz-version-id');
}

async function listKeys(prefix) {
  const keys = [];
  let token = null;
  for (;;) {
    const query = { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) };
    const r = await s3Object(storage, 'GET', '', null, {}, query);
    if (!r.ok) throw new Error(`S3 LIST ${prefix}: ${r.status}`);
    const xml = await r.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    if (!next) break;
    token = next[1];
  }
  return keys;
}

// ------------------------------------------------------------- проход

function buildPlain(entries) {
  return Buffer.concat(entries.map((e) => e.raw));
}

/**
 * Записать порцию (или подтвердить уже записанную). Конфликт — объект с тем
 * же именем и другим исходным хешем: без перезаписи, ошибка.
 */
async function storeChunk(key, entries, keyMat) {
  const plain = buildPlain(entries);
  const plainSha = sha256Hex(plain);
  const existing = await headChunk(key);
  if (existing) {
    if (existing.plainSha !== plainSha) {
      throw new Error(`КОНФЛИКТ ${key}: в архиве другая порция с тем же отрезком — без перезаписи`);
    }
    return { versionId: existing.versionId, plainSha, objSha: existing.objSha, reused: true };
  }
  const sealed = seal(plain, keyMat.key);
  const objSha = sha256Hex(sealed);
  const first = entries[0];
  const last = entries.at(-1);
  const versionId = await putChunk(key, sealed, {
    format: FORMAT,
    'plain-sha256': plainSha,
    'object-sha256': objSha,
    count: entries.length,
    'first-cursor': first.cursor,
    'last-cursor': last.cursor,
    from: first.realtime ?? '',
    to: last.realtime ?? '',
    'key-fp': keyMat.fingerprint,
  });
  if (!versionId) throw new Error(`S3 не вернул VersionId для ${key}: версии бакета выключены?`);
  return { versionId, plainSha, objSha, reused: false };
}

async function storeLoss(seqId, first, last, reason) {
  const key = chunkKey(PREFIX, seqId, first, last, 'loss');
  const existing = await headChunk(key);
  if (existing) return existing.versionId;
  return putChunk(key, Buffer.alloc(0), { format: 'loss/v1', reason });
}

async function confirm(state, row, lastEntry) {
  appendCatalog(row);
  state.lastCursor = lastEntry.cursor;
  state.lastSeq = lastEntry.seq;
  state.seqId = lastEntry.seqId;
  state.pending = null;
  state.lastOkAt = new Date().toISOString();
  saveState(state);
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
      const entries = await readJournal({ after: state.lastCursor });
      if (!entries.length) break;
      // Разрыв или смена журнала.
      const first = entries[0];
      if (
        first.seqId === state.seqId &&
        state.lastSeq !== null &&
        first.seq !== state.lastSeq + 1n
      ) {
        if (first.seq > state.lastSeq + 1n) {
          const a = state.lastSeq + 1n;
          const b = first.seq - 1n;
          const versionId = await storeLoss(state.seqId, a, b, 'journald-vacuumed');
          appendCatalog({
            kind: 'loss',
            key: chunkKey(PREFIX, state.seqId, a, b, 'loss'),
            versionId,
            first: str(a),
            last: str(b),
            reason: 'вытеснено из journald до архивации',
            at: new Date().toISOString(),
          });
          state.losses = (state.losses ?? 0) + 1;
          console.error(`ПОТЕРЯ: записи ${a}–${b} журнала ${state.seqId} вытеснены до архивации`);
        }
      }
      // Порция — только из записей одного журнала.
      const sid = first.seqId;
      const cut = entries.findIndex((e) => e.seqId !== sid);
      let slice = cut < 0 ? entries : entries.slice(0, cut);
      // Объект за разрывом (найден при восстановлении): его отрезок читается
      // в его границах и сверяется по исходному хешу, а новая порция
      // обрывается перед ним — без перекрытий.
      const next = (state.beyond ?? []).map(parseChunkKey).filter((b) => b && b.seqId === sid)[0];
      let key;
      if (next && slice[0].seq === next.first) {
        slice = slice.filter((e) => e.seq <= next.last);
        if (slice.at(-1).seq !== next.last) {
          // Отрезок ещё не дочитан целиком (порция больше предела чтения).
          slice = await readJournal({
            from: slice[0].cursor,
            maxEntries: Number(next.last - next.first + 1n),
            maxBytes: Infinity,
          });
        }
        key = chunkKey(PREFIX, sid, next.first, next.last);
        state.beyond = state.beyond.filter((k) => k !== key);
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
    from: entries[0].realtime,
    to: entries.at(-1).realtime,
    at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------- восстановление

/**
 * Состояние и каталог из S3: продолжать с конца НЕПРЕРЫВНОЙ цепочки от
 * начала архива. Объекты за разрывом не считаются продолжением.
 */
async function rebuildState() {
  const start = readJson(join(STATE_DIR, 'start.json'));
  const keys = (await listKeys(`${PREFIX}/`)).map((k) => ({ key: k, ...parseChunkKey(k) }));
  const items = keys.filter((k) => k.seqId);
  if (!items.length) return null;
  // Журнал — тот, в котором записи последними (по номеру старта цепочки).
  const bySid = new Map();
  for (const it of items) bySid.set(it.seqId, [...(bySid.get(it.seqId) ?? []), it]);
  const sid = start?.seqId && bySid.has(start.seqId) ? start.seqId : [...bySid.keys()].at(-1);
  const { chain, end, beyond, overlaps } = contiguousChain(bySid.get(sid));
  const rows = [];
  for (const it of chain) {
    const h = await headChunk(it.key);
    rows.push({
      kind: it.kind === 'loss' ? 'loss' : 'chunk',
      key: it.key,
      versionId: h.versionId,
      first: str(it.first),
      last: str(it.last),
      count: h.count,
      plainSha: h.plainSha,
      objSha: h.objSha,
      from: h.from ? Number(h.from) : null,
      to: h.to ? Number(h.to) : null,
      at: 'rebuild',
    });
  }
  writeFileSync(CATALOG, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // Курсор — последней настоящей порции цепочки: отметка потери курсора не
  // имеет; journalctl ищет продолжение по номеру и после вытеснения.
  const lastChunk = [...chain].reverse().find((it) => it.kind === 'jx');
  const lastCursor = lastChunk ? (await headChunk(lastChunk.key)).lastCursor : start?.afterCursor;
  const state = {
    seqId: sid,
    lastSeq: end,
    lastCursor,
    pending: null,
    rebuiltAt: new Date().toISOString(),
    beyond: beyond.map((b) => b.key),
    overlaps: overlaps.map((b) => b.key),
  };
  saveState(state);
  console.log(
    `восстановлено из S3: цепочка ${chain.length} объектов до ${end}` +
      (beyond.length ? `, за разрывом ${beyond.length}` : '') +
      (overlaps.length ? `, ПЕРЕКРЫТИЙ ${overlaps.length}` : ''),
  );
  return loadState();
}

// ------------------------------------------------------------------ init

async function init() {
  mkdirSync(STATE_DIR, { recursive: true });
  if (loadState()) throw new Error('архив уже начат — состояние есть');
  const tail = await tailCursor();
  if (!tail) throw new Error('журнал пуст');
  const { seqId } = cursorParts(tail.cursor);
  writeJsonAtomic(join(STATE_DIR, 'start.json'), {
    seqId,
    afterSeq: String(tail.seq),
    afterCursor: tail.cursor,
    at: new Date().toISOString(),
    host: hostname(),
  });
  saveState({
    seqId,
    lastSeq: tail.seq,
    lastCursor: tail.cursor,
    pending: null,
    startedAt: new Date().toISOString(),
  });
  console.log(`архив начат после записи ${tail.seq} журнала ${seqId}`);
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
 * Новая версия под тем же ключом на результат не влияет.
 */
async function verify() {
  const keyMat = archiveKey(env.LOGS_ARCHIVE_KEY);
  const rows = loadCatalog().filter((r) => r.kind === 'chunk');
  const problems = [];
  for (const r of rows) {
    const res = await s3Object(storage, 'GET', r.key, null, {}, { versionId: r.versionId });
    if (!res.ok) {
      problems.push(`${r.key}@${r.versionId}: ${res.status}`);
      continue;
    }
    const sealed = Buffer.from(await res.arrayBuffer());
    if (sha256Hex(sealed) !== r.objSha) {
      problems.push(`${r.key}: хеш объекта не совпал`);
      continue;
    }
    let plain;
    try {
      plain = open(sealed, keyMat.key);
    } catch (error) {
      problems.push(`${r.key}: не расшифровано (${error.message})`);
      continue;
    }
    const reader = new ExportReader();
    const n = reader.push(plain).length;
    if (sha256Hex(plain) !== r.plainSha || n !== r.count) {
      problems.push(`${r.key}: исходный хеш или число записей не совпали`);
    }
  }
  console.log(`проверено порций: ${rows.length}, проблем: ${problems.length}`);
  for (const p of problems) console.log(`  ${p}`);
  if (problems.length) process.exitCode = 1;
}

const commands = { init, run, rebuild: rebuildState, status, verify };
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
