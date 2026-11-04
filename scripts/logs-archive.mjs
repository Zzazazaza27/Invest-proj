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
 *   node scripts/logs-archive.mjs legacy-export   накопленная история в отдельный бакет
 *   node scripts/logs-archive.mjs legacy-snapshot проверенный локальный снимок без S3 (MinIO)
 *   node scripts/logs-archive.mjs legacy-gap      известный пробел истории в покрытие
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
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  renameSync,
  rmSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
} from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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
  newJournalStart,
  parseReceiptKey,
  receiptKey,
  open,
  seal,
  sha256Hex,
} from './lib/logs-archive.mjs';
import { docker, ENV_PATH, parseEnvFile, TOOL_IMAGE } from './lib/backup.mjs';
import { BASELINE_MIN_HOURS } from './lib/logs-metrics-zabbix.mjs';
import { s3Object } from './lib/s3.mjs';

const env = process.env;

// ------------------------------------------------------------ окружение
//
// Ключи и учётки архивов живут в `.env` стенда — так они входят в комплект
// ключей W07 (весь `.env`, зашифрованный ключом Томаса); отдельного хранения
// нет. Юниты systemd ставят LOGS_DOTENV=1 — недостающее берётся из `.env`
// (заданное окружением не перекрывается). На ноутбуке `--bundle <файл
// keys/*.env.gpg> --secret-key <файл> --passphrase-file <файл>` открывает
// комплект ключей в памяти: это и есть проверка «ключ архива открывается из
// комплекта W07». LOGS_PROFILE выбирает набор переменных:
//   main (по умолчанию) — запись основного архива;
//   reader — чтение основного архива (LOGS_READER_*);
//   legacy — запись накопленной истории (LOGS_LEGACY_WRITER_*, свой ключ и
//            каталог состояния);
//   legacy-reader — чтение истории (LOGS_LEGACY_READER_*).
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? (process.argv[i + 1] ?? null) : null;
};
const fill = (vars) => {
  for (const [k, v] of Object.entries(vars)) if (env[k] === undefined && v !== '') env[k] = v;
};
if (env.LOGS_DOTENV === '1') fill(parseEnvFile(ENV_PATH));
if (argOf('--bundle')) fill(openKeyBundle(argOf('--bundle')));
const PROFILES = {
  main: {},
  reader: {
    LOGS_S3_ACCESS_KEY_ID: 'LOGS_READER_ACCESS_KEY_ID',
    LOGS_S3_SECRET_ACCESS_KEY: 'LOGS_READER_SECRET_ACCESS_KEY',
  },
  legacy: {
    LOGS_S3_BUCKET: 'LOGS_LEGACY_S3_BUCKET',
    LOGS_S3_ACCESS_KEY_ID: 'LOGS_LEGACY_WRITER_ACCESS_KEY_ID',
    LOGS_S3_SECRET_ACCESS_KEY: 'LOGS_LEGACY_WRITER_SECRET_ACCESS_KEY',
    LOGS_ARCHIVE_KEY: 'LOGS_LEGACY_ARCHIVE_KEY',
    LOGS_STATE_DIR: 'LOGS_LEGACY_STATE_DIR',
  },
  'legacy-reader': {
    LOGS_S3_BUCKET: 'LOGS_LEGACY_S3_BUCKET',
    LOGS_S3_ACCESS_KEY_ID: 'LOGS_LEGACY_READER_ACCESS_KEY_ID',
    LOGS_S3_SECRET_ACCESS_KEY: 'LOGS_LEGACY_READER_SECRET_ACCESS_KEY',
    LOGS_ARCHIVE_KEY: 'LOGS_LEGACY_ARCHIVE_KEY',
  },
};
if (env.LOGS_PROFILE) {
  const map = PROFILES[env.LOGS_PROFILE];
  if (!map) throw new Error(`LOGS_PROFILE: нет профиля ${env.LOGS_PROFILE}`);
  for (const [to, from] of Object.entries(map)) if (env[from]) env[to] = env[from];
  if (env.LOGS_PROFILE === 'legacy' && !env.LOGS_LEGACY_STATE_DIR) {
    env.LOGS_STATE_DIR = '/var/lib/fifth-logs-legacy';
  }
}

/**
 * Комплект ключей W07 (`keys/<отпечаток>.env.gpg`) открывается закрытым
 * ключом Томаса во временном контейнере без сети; значения — только в
 * памяти, берутся лишь LOGS_*.
 */
function openKeyBundle(bundle) {
  const secretKey = argOf('--secret-key');
  const passFile = argOf('--passphrase-file');
  if (!secretKey || !passFile) throw new Error('--bundle требует --secret-key и --passphrase-file');
  const r = docker(
    [
      'run',
      '--rm',
      '--network',
      'none',
      '-e',
      'PASSPHRASE',
      '-v',
      `${resolve(secretKey)}:/in/key.asc:ro`,
      '-v',
      `${resolve(bundle)}:/in/bundle.gpg:ro`,
      '--entrypoint',
      'sh',
      TOOL_IMAGE,
      '-c',
      'export GNUPGHOME=$(mktemp -d) && printf %s "$PASSPHRASE" | gpg -q --batch --pinentry-mode loopback --passphrase-fd 0 --import /in/key.asc 2>/dev/null && ' +
        'printf %s "$PASSPHRASE" | gpg -q --batch --pinentry-mode loopback --passphrase-fd 0 --decrypt /in/bundle.gpg',
    ],
    { env: { PASSPHRASE: readFileSync(passFile, 'utf8').trim() }, allowFail: true },
  );
  if (r.status !== 0) throw new Error('комплект ключей не открылся этим закрытым ключом');
  const out = {};
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*(LOGS_[A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  console.log(`комплект ключей открыт: переменных LOGS_* ${Object.keys(out).length}`);
  return out;
}

const STATE_DIR = env.LOGS_STATE_DIR || '/var/lib/fifth-logs';
const PREFIX = env.LOGS_PREFIX || 'j';
const MAX_CHUNK = Number(env.LOGS_MAX_CHUNK_BYTES || 16 * 1024 * 1024);
const JOURNAL_ARGS = (env.LOGS_JOURNAL_ARGS || '').split(' ').filter(Boolean);

const storage = {
  endpoint: (env.LOGS_S3_ENDPOINT || '').replace(/\/+$/, ''),
  bucket: env.LOGS_S3_BUCKET || '',
  // Регион хранилища стенда (Garage — ru-central1, D-001).
  region: env.LOGS_S3_REGION || env.S3_REGION || 'us-east-1',
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
    .then(async (result) => {
      // Голова цепочки — в хранилище, для копии на ноутбуке.
      if (loadChain()) await publishRef();
      return result;
    })
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
function readJournal({
  after = null,
  from = null,
  maxEntries = Infinity,
  maxBytes = MAX_CHUNK,
  stop = null,
}) {
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
        if (
          entries.length >= maxEntries ||
          (entries.length && bytes + e.raw.length > maxBytes) ||
          (stop && stop(e))
        ) {
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

/*
 * Хранилище — Garage (D-001): версий объектов нет, условной записи «только
 * если объекта нет» нет, право записи включает удаление (проверено 03.11 на
 * v2.4.1 и v2.5.0). Поэтому «версия» объекта здесь — SHA-256 его байтов:
 * запись возвращает её, чтение по ней отдаёт объект, только если хеш
 * совпал, — перезаписанный объект читается как утраченный. Перезапись и
 * удаление не предотвращаются, а обнаруживаются: квитанции подписаны и
 * связаны в цепочку, её голова — эталон состава (ниже).
 */
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
  // Метка содержимого — подсказка для восстановления состояния (какая
  // квитанция действующая); доказательство — только чтение и сверка.
  headers['x-amz-meta-object-sha256'] = sha256Hex(body);
  const r = await s3('PUT', key, { body, headers });
  if (!r.ok) throw new Error(`S3 PUT ${key}: ${r.status}`);
  // Записанное — ровно эти байты: чтение обратно и сверка.
  const versionId = sha256Hex(body);
  if (!(await getVersion(key, versionId))) {
    throw new Error(`${key}: записанное не читается в прежнем виде`);
  }
  return versionId;
}

/**
 * Объект по ключу; с versionId (SHA-256 байтов) — только если содержимое
 * то же, иначе null (объект удалён или перезаписан).
 */
async function getVersion(key, versionId = null) {
  const r = await s3('GET', key);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`S3 GET ${key}: ${r.status}`);
  const body = Buffer.from(await r.arrayBuffer());
  if (versionId && sha256Hex(body) !== versionId) return null;
  return body;
}

/** Метка SHA-256 объекта из метаданных (HEAD) или null — подсказка, не доказательство. */
async function shaHint(key) {
  const r = await s3('HEAD', key);
  return r.ok ? r.headers.get('x-amz-meta-object-sha256') : null;
}

/** Объекты под префиксом: [{key, versionId: null}] — версий у хранилища нет. */
async function listVersions(prefix) {
  const out = [];
  let token = null;
  for (;;) {
    const query = {
      'list-type': '2',
      prefix,
      ...(token ? { 'continuation-token': token } : {}),
    };
    const r = await s3('GET', '', { query });
    if (!r.ok) throw new Error(`S3 LIST ${prefix}: ${r.status}`);
    const xml = await r.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = m[1].match(/<Key>([^<]+)<\/Key>/)?.[1]?.replace(/&amp;/g, '&');
      out.push({ key, versionId: null, latest: true });
    }
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
    token = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] ?? null;
    if (!token) break;
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
  if (await getVersion(key)) throw new Error(`граница архива ${anchor.seqId} уже закреплена`);
  await putChained(key, anchor);
}

// ------------------------------------------------------ цепочка квитанций

/**
 * Квитанции (граница, порции, потери, файлы почты, пакеты, известные
 * пробелы) — звенья одной цепочки: у каждой `prev` — голова цепочки до неё и
 * `mac` — HMAC-SHA256 ключом, производным от ключа архива. Подменить объект
 * вместе с квитанцией без ключа нельзя незаметно: MAC не сойдётся.
 *
 * Эталон состава — голова цепочки (контрольный хеш) и число звеньев:
 * `chain.json` в состоянии архиватора (основной) и опись копии на ноутбуке.
 * Удаление в середине — разрыв, удаление хвоста вместе с квитанциями —
 * цепочка короче эталона. Эталона нет или он восстановлен из самого
 * хранилища — «НЕПРОВЕРЯЕМО», без угадывания (замечания Тэнка 03.11).
 * Голова, подписанная, лежит и в хранилище (`ref/head.json`) — для копии на
 * ноутбуке; её откат злоумышленником ловят прежняя опись копии и эталон VPS.
 */
const CHAIN = join(STATE_DIR, 'chain.json');
const CHAINED = ['anchors/', 'r/', 'rf/', 'pr/', 'gaps/'];
const GENESIS = sha256Hex(Buffer.from('fifth-logs-chain/v1'));
const REF_KEY = 'ref/head.json';
const canonical = (o) =>
  JSON.stringify(
    Object.keys(o)
      .filter((k) => k !== 'mac')
      .sort()
      .reduce((acc, k) => ({ ...acc, [k]: o[k] }), {}),
  );
function macOf(body, keyMat) {
  const macKey = createHmac('sha256', keyMat.key).update('fifth-logs/receipt-mac/v1').digest();
  return createHmac('sha256', macKey).update(canonical(body)).digest('hex');
}
const linkOf = (prev, mac) => sha256Hex(Buffer.from(`${prev}:${mac}`));
const loadChain = () => readJson(CHAIN);
const saveChain = (c) => writeJsonAtomic(CHAIN, { ...c, at: new Date().toISOString() });

/**
 * Записать звено цепочки. Ключ уже занят нашей подписанной квитанцией —
 * повтор после сбоя: если она продолжает голову, голова сдвигается. Чужое
 * (неподписанное) содержимое под ключом — конфликт, без перезаписи.
 */
async function putChained(key, body) {
  const keyMat = archiveKey(env.LOGS_ARCHIVE_KEY);
  let chain = loadChain();
  if (!chain) {
    // Новая цепочка — только в пустом архиве; иначе эталон утрачен, и
    // продолжать от начала значило бы развилку: сначала rebuild.
    for (const p of CHAINED) {
      if ((await listVersions(p)).length) {
        throw new Error('эталона цепочки нет, а в архиве квитанции есть — сначала rebuild');
      }
    }
    chain = { head: GENESIS, count: 0, trusted: true, source: 'архиватор' };
  }
  const existing = await getVersion(key);
  if (existing) {
    let b = null;
    try {
      b = JSON.parse(existing.toString('utf8'));
    } catch {
      /* ниже — конфликт */
    }
    if (!b?.mac || b.mac !== macOf(b, keyMat)) {
      throw new Error(`КОНФЛИКТ: под ${key} квитанция без подписи ключом архива — без перезаписи`);
    }
    if (b.prev === chain.head) {
      saveChain({ ...chain, head: linkOf(chain.head, b.mac), count: chain.count + 1 });
    }
    return b;
  }
  const signed = { ...body, prev: chain.head };
  signed.mac = macOf(signed, keyMat);
  await putObject(key, Buffer.from(JSON.stringify(signed)));
  if (env.LOGS_TEST_CRASH === 'after-chained-put') process.exit(95);
  saveChain({ ...chain, head: linkOf(chain.head, signed.mac), count: chain.count + 1 });
  return signed;
}

/** Квитанция для восстановления: только подписанная, иначе остановка. */
async function receiptBody(key) {
  const b = await chainedBody(key, archiveKey(env.LOGS_ARCHIVE_KEY));
  if (!b) throw new Error(`квитанция ${key}: без подписи ключом архива — нужен разбор`);
  return b;
}

/** Подписанная квитанция по ключу или null (нет / не наша подпись). */
async function chainedBody(key, keyMat) {
  const raw = await getVersion(key);
  if (!raw) return null;
  try {
    const b = JSON.parse(raw.toString('utf8'));
    return b.mac && b.mac === macOf(b, keyMat) ? b : null;
  } catch {
    return null;
  }
}

/**
 * Цепочка в хранилище от начала: голова, число звеньев, головы по порядку,
 * неподписанные квитанции, развилки и квитанции вне цепочки (за разрывом).
 */
async function walkChain(keyMat) {
  const byPrev = new Map();
  const bad = [];
  const forks = [];
  const keys = [];
  for (const p of CHAINED) for (const v of await listVersions(p)) keys.push(v.key);
  for (const key of keys) {
    const b = await chainedBody(key, keyMat);
    if (!b) {
      bad.push(key);
      continue;
    }
    if (byPrev.has(b.prev)) forks.push(key);
    else byPrev.set(b.prev, { key, b });
  }
  const heads = [GENESIS];
  const visited = new Set();
  const links = [];
  let head = GENESIS;
  for (;;) {
    const n = byPrev.get(head);
    if (!n) break;
    visited.add(n.key);
    links.push({ key: n.key, body: n.b });
    head = linkOf(head, n.b.mac);
    heads.push(head);
  }
  const outside = keys.filter((k) => !visited.has(k) && !bad.includes(k) && !forks.includes(k));
  return { head, count: heads.length - 1, heads, links, bad, forks, outside, total: keys.length };
}

/** Сверка цепочки хранилища с эталоном: {problems, unverifiable}. */
function chainProblems(w, ref) {
  const problems = [];
  if (w.bad.length) {
    problems.push(
      `квитанций без подписи ключом архива: ${w.bad.length} (${w.bad.slice(0, 3).join(', ')})`,
    );
  }
  if (w.forks.length) problems.push(`развилка цепочки: ${w.forks.slice(0, 3).join(', ')}`);
  if (w.outside.length) {
    problems.push(`квитанций за разрывом цепочки: ${w.outside.length} — звено утрачено`);
  }
  if (!ref) return { problems, unverifiable: 'эталона состава нет' };
  if (w.count < ref.count) {
    problems.push(
      `цепочка короче эталона: ${w.count} из ${ref.count} звеньев — утрачены квитанции (в том числе хвост)`,
    );
  } else if (w.heads[ref.count] !== ref.head) {
    problems.push('цепочка не совпала с эталоном по контрольному хешу — подмена');
  }
  if (!ref.trusted) {
    return {
      problems,
      unverifiable: `эталон ${ref.source ?? 'не подтверждён'} — не подтверждён копией`,
    };
  }
  return { problems, unverifiable: null };
}

/** Голова цепочки — в хранилище, подписанной (для копии на ноутбуке). */
async function publishRef() {
  const chain = loadChain();
  if (!chain) return;
  const keyMat = archiveKey(env.LOGS_ARCHIVE_KEY);
  const cur = await chainedBody(REF_KEY, keyMat);
  if (cur && cur.head === chain.head) return;
  const ref = { head: chain.head, count: chain.count, at: new Date().toISOString() };
  ref.mac = macOf(ref, keyMat);
  await putObject(REF_KEY, Buffer.from(JSON.stringify(ref)));
}

async function readAnchors() {
  const byKey = groupByKey(await listVersions('anchors/'));
  const out = [];
  const keyMat = archiveKey(env.LOGS_ARCHIVE_KEY);
  for (const [key] of byKey) {
    const b = await chainedBody(key, keyMat);
    if (!b)
      throw new Error(`НЕОДНОЗНАЧНОСТЬ: граница ${key} без подписи ключом архива — нужен разбор`);
    out.push(b);
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
  await putChained(receiptKey(p.seqId, p.first, p.last, p.kind, row.versionId), row);
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
  // Под ключом уже есть объект (повтор после сбоя или чужая запись):
  // принимается только то же содержимое.
  if (await getVersion(key)) {
    const got = await plainOfVersion(key, null, keyMat);
    if (got && sha256Hex(got.plain) === plainSha) {
      return { versionId: got.objSha, plainSha, objSha: got.objSha, reused: true };
    }
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
  const existing = await getVersion(key);
  const versionId = existing
    ? sha256Hex(existing)
    : await putObject(key, Buffer.alloc(0), { format: 'loss/v1', reason });
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
    const row = await receiptBody(next.receipt.key);
    appendCatalog(row);
    state.lastSeq = next.last;
    if (row.lastCursor) state.lastCursor = row.lastCursor;
    state.beyond = state.beyond.filter((b) => b.key !== next.key);
    state.archiveGaps = (state.archiveGaps ?? []).filter((g) => BigInt(g.last) > next.last);
    saveState(state);
  }
}

// ------------------------------------------------- граница «до записи»

/**
 * LOGS_UNTIL_CURSOR — проход не идёт дальше этой записи (выгрузка
 * накопленной истории до границы основного архива). Внутри её нумерации —
 * по номеру записи, в других нумерациях — по времени записи: сама запись
 * границы могла быть уже вытеснена, а дальше границы читать нельзя.
 */
const UNTIL = env.LOGS_UNTIL_CURSOR || null;

function untilStop() {
  if (!UNTIL) return null;
  const u = cursorParts(UNTIL);
  const t = UNTIL.match(/(?:^|;)t=([0-9a-f]+)/)?.[1];
  const ut = t ? Number(BigInt(`0x${t}`)) : null;
  if (!u.seqId || u.seq === null || ut === null)
    throw new Error('LOGS_UNTIL_CURSOR: не курсор journald');
  return (e) => (e.seqId === u.seqId ? e.seq > u.seq : e.realtime !== null && e.realtime > ut);
}

/**
 * Граница прохода — последняя запись журнала на момент его начала. Без неё
 * проход догоняет собственный след: запись в S3 порождает строки журнала
 * узла Garage (драйвер journald), они читаются как новые и дают новую
 * порцию, и так до таймаута службы (VPS, 03.11: порции по 8 записей). Всё,
 * что появилось после начала, забирает следующий проход.
 */
function passStop(tail) {
  const until = untilStop();
  if (!tail) return until;
  return (e) =>
    Boolean(until?.(e)) ||
    (e.seqId === tail.seqId
      ? e.seq > tail.seq
      : e.realtime !== null && tail.realtime !== null && e.realtime > tail.realtime);
}

// ------------------------------------------------------ нумерации journald

/**
 * Записи одной нумерации `sid` с номерами a..b (b = null — до её конца)
 * из journald, через курсор из ID нумерации и номера — в архив: подряд
 * идущие — порциями с квитанциями, дыры — отметками потерь с причиной
 * `holeReason(x, y)`. Возвращает строки каталога.
 */
async function fillRange(sid, a, b, keyMat, holeReason) {
  const entries = (
    await readJournal({
      from: `s=${sid};i=${a.toString(16)}`,
      maxBytes: Infinity,
      stop: (e) => e.seqId !== sid || (b !== null && e.seq > b),
    })
  ).filter((e) => e.seqId === sid && e.seq >= a && (b === null || e.seq <= b));
  const rows = [];
  let expected = a;
  let run = [];
  let bytes = 0;
  const flush = async () => {
    if (!run.length) return;
    const key = chunkKey(PREFIX, sid, run[0].seq, run.at(-1).seq);
    const res = await storeChunk(key, run, keyMat);
    const row = catalogRow(key, run, res);
    await putReceipt(row);
    rows.push(row);
    run = [];
    bytes = 0;
  };
  for (const e of entries) {
    if (e.seq > expected) {
      await flush();
      // В тихом журнале (b = null) дыра в начале хвоста — вытеснение до
      // архивации; внутри известного отрезка причину даёт вызывающий.
      rows.push(await storeLoss(sid, expected, e.seq - 1n, holeReason(expected, e.seq - 1n)));
    }
    if (run.length && bytes + e.raw.length > MAX_CHUNK) await flush();
    run.push(e);
    bytes += e.raw.length;
    expected = e.seq + 1n;
  }
  await flush();
  if (b !== null && expected <= b)
    rows.push(await storeLoss(sid, expected, b, holeReason(expected, b)));
  for (const r of rows) {
    console.error(
      r.kind === 'loss'
        ? `${LOSS_LABELS[r.reason]}: записи ${r.first}–${r.last} журнала ${sid}`
        : `восполнено из journald: записи ${r.first}–${r.last} журнала ${sid}`,
    );
  }
  return rows;
}

/**
 * Новая нумерация journald (seqnum_id): journald заводит её после аварийной
 * остановки. Номера записей в ней либо начинаются с 1 (испытательный
 * journald), либо ПРОДОЛЖАЮТ счёт прежней (VPS, 03.11: после записи 3780
 * нумерации 17fa… первая запись новой — 3781). Граница — по первой
 * доступной записи новой нумерации: она идёт сразу за последней записью
 * прежней — продолжение, граница «после последней записи прежней»; иначе —
 * граница «после записи 0», и пропуск в начале станет учтённой потерей, а не
 * молчаливым началом (newJournalStart). Прежняя нумерация к этому моменту дочитана (export
 * идёт по времени); её пропуски архива дочитываются из journald по курсору
 * или отмечаются утратой. Возврат к более старой нумерации — две нумерации
 * пишутся вперемешку: остановка, нужен разбор.
 */
async function switchJournal(state, sid, keyMat, firstSeq) {
  const anchors = await readAnchors();
  const known = anchors.find((x) => x.seqId === sid);
  const current = anchors.find((x) => x.seqId === state.seqId);
  if (known && current && known.at < current.at) {
    throw new Error(
      `НЕОДНОЗНАЧНОСТЬ: нумерации журнала ${state.seqId} и ${sid} идут вперемешку — нужен разбор`,
    );
  }
  for (const g of state.archiveGaps ?? []) {
    await fillRange(state.seqId, BigInt(g.first), BigInt(g.last), keyMat, () => 'archive-missing');
  }
  if (!known) {
    await putAnchor({
      seqId: sid,
      afterSeq: str(newJournalStart(state.lastSeq, firstSeq)),
      afterCursor: null,
      at: new Date().toISOString(),
      host: hostname(),
      after: { seqId: state.seqId, lastSeq: str(state.lastSeq) },
    });
  }
  console.log(
    `новая нумерация журнала ${sid}; прежняя ${state.seqId} дочитана до ${state.lastSeq}`,
  );
  state.seqId = sid;
  state.lastSeq = BigInt(known?.afterSeq ?? str(newJournalStart(state.lastSeq, firstSeq)));
  state.archiveGaps = [];
  state.beyond = (state.beyond ?? []).filter((x) => parseChunkKey(x.key)?.seqId === sid);
  saveState(state);
}

/** Квитанции нумерации: действующие (версия порции есть) и утраченные. */
async function receiptsOf(sid) {
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
    // Квитанция действующая, если объект под ключом есть и его метка
    // содержимого — та, что в квитанции; иначе объект утрачен или заменён
    // (например, восполнен из journald заново). Доказательство — verify.
    if (!objectVersions.has(range) || (await shaHint(range)) !== r.versionId) {
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
  return { objectVersions, receipts, lostConfirmed };
}

/**
 * Закрытая (не текущая) нумерация при восстановлении: строки каталога по
 * действующим квитанциям; непокрытое от границы до последней квитанции
 * дочитывается из journald или отмечается утратой архива (была квитанция)
 * либо «не проверяемо» (квитанции не было); записи за последней квитанцией,
 * которые journald ещё хранит, архивируются.
 */
async function rebuildClosed(anchor, keyMat) {
  const sid = anchor.seqId;
  const start = BigInt(anchor.afterSeq) + 1n;
  const { receipts, lostConfirmed } = await receiptsOf(sid);
  const rows = [];
  for (const [, [rec]] of receipts) {
    rows.push(await receiptBody(rec.key));
  }
  const lost = lostConfirmed.map((k) => parseChunkKey(k));
  const maxLast = [...rows.map((r) => BigInt(r.last)), ...lost.map((l) => l.last)].reduce(
    (m, x) => (x > m ? x : m),
    start - 1n,
  );
  const covered = mergeRanges(rows.map((r) => ({ first: BigInt(r.first), last: BigInt(r.last) })));
  const holes = [];
  let at = start;
  for (const c of covered) {
    if (c.last < start) continue;
    if (c.first > at) holes.push({ first: at, last: c.first - 1n });
    if (c.last + 1n > at) at = c.last + 1n;
  }
  if (at <= maxLast) holes.push({ first: at, last: maxLast });
  const reason = (x, y) =>
    lost.some((l) => l.first <= y && x <= l.last) ? 'archive-missing' : 'archive-unverifiable';
  for (const h of holes) rows.push(...(await fillRange(sid, h.first, h.last, keyMat, reason)));
  rows.push(...(await fillRange(sid, maxLast + 1n, null, keyMat, () => 'journald-vacuumed')));
  return rows.sort((x, y) => (BigInt(x.first) < BigInt(y.first) ? -1 : 1));
}

/**
 * Откуда читать journald: после последней архивированной записи или, пока
 * её нет (начало нумерации), с записи по курсору «ID + номер» включительно.
 * `--after-cursor` с таким курсором пропускает первую найденную запись —
 * запись 1 стала бы ложной потерей (поймано испытанием L).
 */
const readPos = (state) =>
  state.lastCursor
    ? { after: state.lastCursor }
    : state.startCursor
      ? { from: state.startCursor }
      : null;

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

    // 2. Новые записи — до конца журнала на начало прохода.
    const caughtUpAt = new Date(nowMs()).toISOString();
    const stop = passStop(await tailCursor());
    let written = 0;
    for (;;) {
      await adoptConfirmed(state);
      const pos = readPos(state);
      if (!pos) throw new Error('нет позиции чтения journald — нужен разбор');
      const read = await readJournal({ ...pos, stop });
      if (!read.length) break;
      // Разрыв перед первой доступной записью — по отрезкам: подтверждённые
      // порции за разрывом принимаются по квитанции; неподтверждённая, чьё
      // начало journald уже вытеснил, сверке не поддаётся — явная отметка
      // «не проверяемо», а не доверие; остальное — отметка потери.
      const avail = read[0];
      if (avail.seqId !== state.seqId) {
        await switchJournal(state, avail.seqId, keyMat, avail.seq);
        continue;
      }
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
      if (env.LOGS_TEST_ECHO) {
        // Испытания: след записи в журнале, как у узла Garage на journald.
        if (written > 3) process.exit(94);
        spawnSync('sh', ['-c', 'echo w08b-echo | systemd-cat -t w08b-echo; sleep 0.3']);
      }
    }
    // Журнал дочитан до границы прохода — момент нужен пакетам: сутки
    // закрыты, если архиватор дочитал журнал, начатый после их конца (записи
    // суток уже в архиве). Поэтому момент — начало прохода, а не его конец.
    state.caughtUpAt = caughtUpAt;
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
  await restoreChain();
  const anchors = await readAnchors();
  if (!anchors.length) {
    if (existsSync(join(STATE_DIR, 'start.json'))) {
      throw new Error('граница архива есть только локально, в S3 её нет — начало не подтверждено');
    }
    return null;
  }
  anchors.sort((a, b) => (a.at < b.at ? -1 : 1));
  // Закрытые нумерации — по своим квитанциям и journald; текущая — ниже,
  // цепочкой от своей границы.
  const closedRows = [];
  for (const a of anchors.slice(0, -1)) {
    closedRows.push(...(await rebuildClosed(a, archiveKey(env.LOGS_ARCHIVE_KEY))));
  }
  const anchor = anchors.at(-1);
  const sid = anchor.seqId;
  const expectedStart = BigInt(anchor.afterSeq) + 1n;

  const { objectVersions, receipts, lostConfirmed } = await receiptsOf(sid);

  const objects = [...objectVersions.keys()]
    .map((k) => ({ key: k, ...parseChunkKey(k) }))
    .filter((i) => i.seqId);
  const confirmed = objects.filter((o) => receipts.has(o.key));
  const unconfirmed = objects.filter((o) => !receipts.has(o.key));
  const { chain, end, beyond, overlaps, gaps } = contiguousChain(confirmed, expectedStart);

  const rows = [];
  for (const it of chain) {
    const [rec] = receipts.get(it.key);
    rows.push(await receiptBody(rec.key));
  }
  const all = [...closedRows, ...rows];
  writeFileSync(CATALOG, all.length ? all.map((r) => JSON.stringify(r)).join('\n') + '\n' : '');
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
    // У новой нумерации нет курсора границы — курсор из её ID и номера
    // (journalctl ищет по номеру; запись 0 не существует, читается с 1).
    lastCursor: lastChunk?.lastCursor ?? anchor.afterCursor ?? null,
    startCursor: `s=${sid};i=${(end + 1n).toString(16)}`,
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

/**
 * Эталон цепочки при восстановлении. Есть `chain.json` — остаётся. Нет —
 * голова берётся из хранилища, но НЕ подтверждена: verify скажет
 * «НЕПРОВЕРЯЕМО». С `--reference <каталог копии>` (или
 * LOGS_REFERENCE_COPY) эталон — из описи копии на ноутбуке: цепочка
 * хранилища обязана содержать его голову на его месте.
 */
async function restoreChain() {
  const refDir = argOf('--reference') ?? env.LOGS_REFERENCE_COPY ?? null;
  if (loadChain() && !refDir) return;
  const keyMat = archiveKey(env.LOGS_ARCHIVE_KEY);
  const w = await walkChain(keyMat);
  if (!w.count) return;
  if (refDir) {
    let m;
    try {
      m = JSON.parse(open(readFileSync(join(refDir, MANIFEST)), keyMat.key).toString('utf8'));
    } catch {
      throw new Error(`эталон: опись копии ${refDir} не открывается`);
    }
    const ref = m.reference;
    if (!ref || w.count < ref.count || w.heads[ref.count] !== ref.head) {
      throw new Error(
        `эталон копии (${ref?.count ?? '?'} звеньев) не совпал с цепочкой хранилища (${w.count}) — утрата или подмена`,
      );
    }
    saveChain({
      head: w.head,
      count: w.count,
      trusted: true,
      source: `опись копии от ${m.at}`,
      verifiedUpTo: ref.count,
    });
    console.log(`эталон цепочки — из описи копии: ${ref.count} звеньев сошлись, всего ${w.count}`);
    return;
  }
  saveChain({ head: w.head, count: w.count, trusted: false, source: 'восстановлен из хранилища' });
  console.error(
    `ЭТАЛОН УТРАЧЕН: голова цепочки взята из хранилища (${w.count} звеньев) — не подтверждена; сверить: rebuild --reference <копия>`,
  );
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
 * Проверка архива: каждая порция каталога читается и сверяется по SHA-256
 * объекта из квитанции (перезаписанный объект — утрата), расшифровывается,
 * исходный хеш и число записей сверяются; цепочка квитанций — подписи,
 * разрывы и голова против эталона. Эталона нет или он не подтверждён —
 * «НЕПРОВЕРЯЕМО».
 */
/** Испытания: проход таймера посреди чтения; значение — JSON с учёткой записи. */
function testPassDuringRead() {
  if (!env.LOGS_TEST_VERIFY_RACE) return;
  spawnSync(process.execPath, [process.argv[1], 'run'], {
    env: { ...env, ...JSON.parse(env.LOGS_TEST_VERIFY_RACE), LOGS_TEST_VERIFY_RACE: '' },
    stdio: 'ignore',
  });
}

async function verify() {
  const keyMat = archiveKey(env.LOGS_ARCHIVE_KEY);
  const state = loadState();
  if (!state) throw new Error('нет локального состояния и каталога — сначала rebuild');
  // Проверка идёт рядом с таймерными проходами и может длиться минуты.
  // Эталон — до чтения хранилища: цепочка обязана его содержать, а звенья,
  // появившиеся за время проверки, идут за ним и разрывом не считаются.
  const reference = loadChain();
  const anchors = await readAnchors();
  const receiptKeys = new Map();
  for (const a of anchors) {
    receiptKeys.set(a.seqId, groupByKey(await listVersions(`r/${a.seqId}/`)));
  }
  // Каталог — после списка квитанций: в нём есть всё, что в списке.
  const all = loadCatalog();
  const rows = all.filter((r) => r.kind === 'chunk');
  const problems = [];
  // Независимо от состояния: каждая квитанция в S3 — отрезок, который архив
  // обязан покрывать подтверждённой порцией или учтённой отметкой потери.
  // Утрата подтверждённой порции (в том числе последней) не даёт зелёного.
  // Номера записей сравнимы только внутри одной нумерации journald — всё
  // считается по каждой границе отдельно.
  let receiptsSeen = 0;
  for (const a of anchors) {
    const sid = a.seqId;
    const own = all.filter((r) => parseChunkKey(r.key)?.seqId === sid);
    const covered = mergeRanges(own.map((r) => ({ first: BigInt(r.first), last: BigInt(r.last) })));
    const isCovered = (x, y) => covered.some((c) => c.first <= x && y <= c.last);
    for (const [key] of receiptKeys.get(sid)) {
      const r = parseReceiptKey(key);
      if (!r) continue;
      receiptsSeen++;
      if (!isCovered(r.first, r.last)) {
        problems.push(
          `отрезок ${r.first}–${r.last} журнала ${sid}: квитанция есть, в каталоге не покрыт — утрата архива`,
        );
      }
    }
    // Каталог нумерации непрерывен от её границы.
    const start = BigInt(a.afterSeq) + 1n;
    const tail = covered.filter((c) => c.last >= start);
    if (tail.length > 1 || (tail.length && tail[0].first > start)) {
      problems.push(`журнал ${sid}: каталог прерывается после границы ${a.afterSeq}`);
    }
  }
  if (anchors.length > 1) console.log(`нумераций журнала: ${anchors.length}`);
  // Цепочка квитанций против эталона (голова и число звеньев).
  const walk = await walkChain(keyMat);
  testPassDuringRead();
  const chainCheck = chainProblems(walk, reference);
  problems.push(...chainCheck.problems);
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
  }
  const filesSeen = await verifyFiles(keyMat, problems);
  const unconfirmed = state?.unconfirmed?.length ?? 0;
  const gaps = state?.archiveGaps?.length ?? 0;
  console.log(
    `проверено порций: ${rows.length}, квитанций: ${receiptsSeen}, звеньев цепочки: ${walk.count}, файлов: ${filesSeen}, проблем: ${problems.length}, без квитанции: ${unconfirmed}, пропусков архива: ${gaps}`,
  );
  for (const p of problems) console.log(`  ${p}`);
  const failedCheck = problems.length || gaps;
  // Два разных успеха (Тэнк 2026-11-03): согласованность архива с учтёнными
  // потерями не означает, что данные сохранены полностью.
  const losses = all.filter((r) => r.kind === 'loss');
  const lostRecords = losses.reduce((n, r) => n + (BigInt(r.last) - BigInt(r.first) + 1n), 0n);
  const byReason = {};
  for (const r of losses) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  console.log(
    failedCheck
      ? 'ИТОГ: проверка НЕ пройдена'
      : chainCheck.unverifiable
        ? `ИТОГ: НЕПРОВЕРЯЕМО — ${chainCheck.unverifiable}`
        : losses.length
          ? `ИТОГ: проверка пройдена, есть учтённые потери — отрезков ${losses.length}, записей ${lostRecords} (${Object.entries(
              byReason,
            )
              .map(([k, v]) => `${k}: ${v}`)
              .join(', ')}); утраченное не восстановлено`
          : 'ИТОГ: данные сохранены полностью',
  );
  if (failedCheck || chainCheck.unverifiable) process.exitCode = 1;
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

/**
 * Доступность настроенного источника: null — доступен; 'missing' — нет ни
 * каталога, ни живого файла, ни поколений; 'unavailable' — путь есть, но
 * прочитать нельзя (не каталог, нет прав). Код без текста ошибки.
 */
function sourceProblem(base) {
  const dir = dirname(base);
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    return e?.code === 'ENOENT' ? 'missing' : 'unavailable';
  }
  const re = new RegExp(`^${escapeRe(basename(base))}(\\.\\d+(\\.gz)?)?$`);
  if (!names.some((n) => re.test(n))) return 'missing';
  if (names.includes(basename(base))) {
    try {
      closeSync(openSync(base, 'r'));
    } catch (e) {
      return e?.code === 'ENOENT' ? 'missing' : 'unavailable';
    }
  }
  return null;
}

/** Закрытые поколения журнала: [{path, name, gz}]. */
function closedGenerations(base) {
  const dir = dirname(base);
  const re = new RegExp(`^${escapeRe(basename(base))}\\.\\d+(\\.gz)?$`);
  const oldest = Date.now() - FILES_MIN_AGE_SEC * 1000;
  return readdirSync(dir)
    .filter((name) => re.test(name))
    .map((name) => ({ name, path: join(dir, name), gz: name.endsWith('.gz') }))
    .filter((g) => {
      try {
        return statSync(g.path).mtimeMs <= oldest;
      } catch {
        return false; // удалено ротацией между чтением каталога и stat
      }
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Квитанции файлов из S3: хеш → тело квитанции. */
async function fileReceipts() {
  const out = new Map();
  const keyMat = archiveKey(env.LOGS_ARCHIVE_KEY);
  for (const [key] of groupByKey(await listVersions('rf/'))) {
    const body = await chainedBody(key, keyMat);
    if (!body) throw new Error(`квитанция ${key}: без подписи ключом архива — нужен разбор`);
    if (key !== fileReceiptKey(body.plainSha, body.versionId)) {
      throw new Error(`квитанция ${key}: содержимое не совпадает с именем`);
    }
    out.set(body.plainSha, body);
  }
  return out;
}

/**
 * Записать одно поколение (или файл целиком) по содержимому: уже есть —
 * 'same'; записанная версия без квитанции подтверждается по содержимому;
 * чужое содержимое под ключом — конфликт.
 */
async function storeFile(src, g, plain, keyMat, known) {
  const plainSha = sha256Hex(plain);
  if (known.has(plainSha)) return 'same';
  const key = fileKey(src, plainSha);
  // Уже записанная версия (сбой до квитанции) подтверждается по
  // содержимому; чужое содержимое под ключом — конфликт.
  let versionId = null;
  let objSha = null;
  const existing = await getVersion(key);
  if (existing) {
    const got = await plainOfVersion(key, null, keyMat);
    if (got && sha256Hex(got.plain) === plainSha) {
      versionId = got.objSha;
      objSha = got.objSha;
    }
  }
  if (!versionId && existing) {
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
    mtime: (() => {
      try {
        return new Date(statSync(g.path).mtimeMs).toISOString();
      } catch {
        return null; // переименовано ротацией после чтения
      }
    })(),
    ...(g.snapshot ? { snapshot: g.snapshot } : {}),
    at: new Date().toISOString(),
  };
  known.set(plainSha, await putChained(fileReceiptKey(plainSha, versionId), body));
  console.log(`файл ${g.path}: записан (${plain.length} байт)`);
  return 'stored';
}

// ------------------------------------------------- накопленная история

/**
 * Накопленная до W08b история — чувствительный архив (в ней могут быть
 * секреты, писавшиеся до правки источников): отдельный бакет, свой ключ,
 * свои учётки, обычный поиск её не видит. Окружение — LOGS_S3_* и
 * LOGS_ARCHIVE_KEY бакета истории и свой LOGS_STATE_DIR.
 *  - journald — с самого начала до границы основного архива включительно
 *    (LOGS_UNTIL_CURSOR — её afterCursor), по всем нумерациям;
 *  - LOGS_LEGACY_FILES — файлы целиком, как есть, в том числе ещё
 *    пишущиеся (журналы Docker json-file до смены драйвера).
 * Отчёт — покрытые интервалы и пробелы по каждой нумерации. Повтор
 * идемпотентен; локальная очистка — не здесь и только после проверки.
 *
 *   node scripts/logs-archive.mjs legacy-export
 */
async function legacyExport() {
  if (!UNTIL) throw new Error('нужен LOGS_UNTIL_CURSOR — курсор границы основного архива');
  const keyMat = archiveKey(env.LOGS_ARCHIVE_KEY);
  mkdirSync(STATE_DIR, { recursive: true });
  if (!loadState() && !(await readAnchors()).length) {
    const [first] = await readJournal({ maxEntries: 1 });
    if (!first) throw new Error('журнал пуст');
    const after = first.seq - 1n;
    await putAnchor({
      seqId: first.seqId,
      afterSeq: str(after),
      afterCursor: null,
      at: new Date().toISOString(),
      host: hostname(),
      legacy: true,
      until: UNTIL,
    });
    saveState({
      seqId: first.seqId,
      lastSeq: after,
      lastCursor: null,
      startCursor: `s=${first.seqId};i=${first.seq.toString(16)}`,
      pending: null,
      startedAt: new Date().toISOString(),
    });
    console.log(`история: начало журнала — запись ${first.seq} нумерации ${first.seqId}`);
  }
  await run();

  const exact = legacyFiles();
  let incomplete = 0;
  let total = exact.length;
  const snapshots =
    SNAP_DIR && existsSync(SNAP_DIR)
      ? readdirSync(SNAP_DIR).filter((n) => n.endsWith('.cover.json'))
      : [];
  if (exact.length || snapshots.length) {
    await withLock(async () => {
      const known = await fileReceipts();
      let stored = 0;
      let same = 0;
      for (const path of exact) {
        let snap;
        try {
          snap = snapshotFile(path);
        } catch (e) {
          if (e?.code !== 'ENOENT') throw e;
          console.error(`история: файла ${path} нет`);
          incomplete++;
          continue;
        }
        const { plain, cover } = snap;
        console.log(`история: ${path}: ${coverText(cover)}`);
        if (!cover.accepted) {
          incomplete++;
          continue;
        }
        if (!cover.complete) incomplete++;
        if (!plain.length) continue;
        const g = { name: basename(path), path, snapshot: cover };
        if ((await storeFile(fileSource(path), g, plain, keyMat, known)) === 'same') same++;
        else stored++;
      }
      // Локальные снимки (порядок для MinIO): отправляются с покрытием,
      // снятым при остановленном источнике; сверка хеша до отправки, чтение
      // записанной версии — в storeFile. Сами снимки не удаляются.
      for (const name of snapshots) {
        total++;
        const cover = JSON.parse(readFileSync(join(SNAP_DIR, name), 'utf8'));
        const plain = readFileSync(join(SNAP_DIR, name.replace(/\.cover\.json$/, '.data')));
        if (sha256Hex(plain) !== cover.sha256) {
          console.error(`снимок ${cover.path}: ХЕШ НЕ СОВПАЛ — снимок испорчен, не отправлен`);
          incomplete++;
          continue;
        }
        if (!cover.complete) incomplete++;
        const g = {
          name: basename(cover.path),
          path: cover.path,
          snapshot: { ...cover, via: 'local-snapshot' },
        };
        const r = await storeFile(fileSource(cover.path), g, plain, keyMat, known);
        if (r === 'same') same++;
        else stored++;
        console.log(
          `снимок ${cover.path}: в архиве, хеш сверен (${coverText(cover)}); локальный снимок сохранён до подтверждения архива`,
        );
      }
      console.log(`файлы истории: записано ${stored}, уже в архиве ${same}`);
    });
  }

  // Отчёт: покрытые интервалы и пробелы по каждой нумерации.
  const rows = loadCatalog();
  const anchors = (await readAnchors()).sort((a, b) => (a.at < b.at ? -1 : 1));
  for (const a of anchors) {
    const own = rows.filter((r) => parseChunkKey(r.key)?.seqId === a.seqId);
    const lossRows = own.filter((r) => r.kind === 'loss');
    const last = own.reduce(
      (m, r) => (BigInt(r.last) > m ? BigInt(r.last) : m),
      BigInt(a.afterSeq),
    );
    const lost = lossRows.reduce((n, r) => n + (BigInt(r.last) - BigInt(r.first) + 1n), 0n);
    console.log(
      `журнал ${a.seqId}: записи ${BigInt(a.afterSeq) + 1n}–${last}, порций ${own.length - lossRows.length}, пробелов ${lossRows.length} (записей ${lost})`,
    );
  }
  const gaps = await knownGaps();
  for (const g of gaps) {
    console.log(
      `известный пробел: ${g.source} до ${g.until} — ${g.reason}; восстановление не обещается`,
    );
  }
  if (total || gaps.length) {
    const extra = gaps.length ? `; известных пробелов до выгрузки: ${gaps.length}` : '';
    console.log(
      !total
        ? `ИТОГ: файлов в этом прогоне нет${extra}`
        : incomplete
          ? `ИТОГ: история файлов НЕПОЛНА (файлов ${incomplete} из ${total})${extra} — локальную историю не очищать`
          : `ИТОГ: история файлов покрыта полностью (${total})${extra}`,
    );
    if (incomplete) process.exitCode = 2;
  }
}

const SNAP_DIR = env.LOGS_LEGACY_SNAPSHOT_DIR || null;
const legacyFiles = () =>
  (env.LOGS_LEGACY_FILES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Атомарная запись байтов: временный файл + fsync + переименование. */
function writeBytesAtomic(path, bytes) {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  writeFileSync(fd, bytes);
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, path);
}

/**
 * Проверенный локальный снимок без S3 — порядок для самого MinIO (замечание
 * Тэнка 03.11): после остановки MinIO приёмник архива недоступен. Остановка
 * контейнера → этот снимок (граница, покрытие, подтверждение остановки) →
 * запуск прежнего контейнера → `legacy-export` с тем же
 * LOGS_LEGACY_SNAPSHOT_DIR отправляет и сверяет → только затем пересоздание.
 * Снимок пишется в каталог с правами 700 и не удаляется этой программой.
 *
 *   LOGS_LEGACY_FILES=<путь> LOGS_LEGACY_SNAPSHOT_DIR=<каталог> \
 *     node scripts/logs-archive.mjs legacy-snapshot
 */
async function legacySnapshot() {
  if (!SNAP_DIR) throw new Error('нужен LOGS_LEGACY_SNAPSHOT_DIR');
  const exact = legacyFiles();
  if (!exact.length) throw new Error('нужен LOGS_LEGACY_FILES');
  mkdirSync(SNAP_DIR, { recursive: true, mode: 0o700 });
  let incomplete = 0;
  for (const path of exact) {
    const { plain, cover } = snapshotFile(path);
    console.log(`снимок: ${path}: ${coverText(cover)}`);
    if (!cover.accepted) {
      incomplete++;
      continue;
    }
    if (!cover.complete) incomplete++;
    const base = join(SNAP_DIR, fileSource(path));
    writeBytesAtomic(`${base}.data`, plain);
    if (sha256Hex(readFileSync(`${base}.data`)) !== cover.sha256) {
      throw new Error(`снимок ${path}: записанное не совпало с прочитанным`);
    }
    writeJsonAtomic(`${base}.cover.json`, cover);
  }
  console.log(
    incomplete
      ? `ИТОГ: локальный снимок НЕПОЛОН (файлов ${incomplete} из ${exact.length}) — пересоздавать нельзя`
      : `ИТОГ: локальный снимок проверен, источники остановлены (${exact.length}); хранить до подтверждения архива`,
  );
  if (incomplete) process.exitCode = 2;
}

/**
 * Известный пробел истории, возникший до выгрузки (например, журнал
 * контейнера, удалённый пересозданием): фиксируется в бакете истории
 * `gaps/<источник>.json` и попадает в итоговое покрытие. Восстановление не
 * обещается. Повтор с тем же описанием — без изменений, с другим —
 * конфликт.
 *
 *   LOGS_GAP_SOURCE=docker:unicorn-postgres LOGS_GAP_UNTIL=<ISO> \
 *   LOGS_GAP_REASON='…' node scripts/logs-archive.mjs legacy-gap
 */
async function legacyGap() {
  const source = env.LOGS_GAP_SOURCE;
  const until = env.LOGS_GAP_UNTIL;
  const reason = env.LOGS_GAP_REASON;
  if (!source || !until || !reason) {
    throw new Error('нужны LOGS_GAP_SOURCE, LOGS_GAP_UNTIL, LOGS_GAP_REASON');
  }
  if (Number.isNaN(Date.parse(until))) throw new Error('LOGS_GAP_UNTIL: нужна дата ISO');
  const key = `gaps/${fileSource(source)}.json`;
  const body = { source, until, reason };
  const existing = (await listVersions(key)).filter((v) => v.key === key);
  for (const v of existing) {
    const got = JSON.parse((await getVersion(key, v.versionId)).toString('utf8'));
    if (got.source === source && got.until === until && got.reason === reason) {
      console.log(`пробел ${source}: уже записан`);
      return;
    }
  }
  if (existing.length) throw new Error(`КОНФЛИКТ: под ${key} другое описание — без перезаписи`);
  // Звено цепочки истории — пробел входит в подтверждённый состав.
  await withLock(() => putChained(key, { ...body, at: new Date().toISOString() }));
  console.log(`пробел ${source}: записан (до ${until})`);
}

/**
 * Заготовка переменных архива для `.env` стенда — в файл вне Git с пометкой
 * «не применён», права 600; значения не печатаются. Имена бакетов и учёток
 * постоянные, секреты и ключи — случайные. Существующий файл не
 * перезаписывается.
 *
 *   node scripts/logs-archive.mjs secrets-draft --to <файл>
 */
function secretsDraft() {
  const to = argOf('--to');
  if (!to) throw new Error('нужен --to <файл вне Git>');
  if (existsSync(to)) throw new Error(`${to} уже есть — не перезаписываю`);
  // Ключи Garage (D-001): GK + 24 hex и секрет 64 hex.
  const s = () => randomBytes(32).toString('hex');
  const gk = () => `GK${randomBytes(12).toString('hex')}`;
  const k = () => randomBytes(32).toString('hex');
  const vars = {
    DOCKER_LOG_DRIVER: 'journald',
    LOGS_S3_ENDPOINT: 'http://127.0.0.1:9000',
    LOGS_S3_BUCKET: 'tech-logs',
    LOGS_S3_ACCESS_KEY_ID: gk(),
    LOGS_S3_SECRET_ACCESS_KEY: s(),
    LOGS_READER_ACCESS_KEY_ID: gk(),
    LOGS_READER_SECRET_ACCESS_KEY: s(),
    LOGS_ARCHIVE_KEY: k(),
    LOGS_LEGACY_S3_BUCKET: 'tech-logs-legacy',
    LOGS_LEGACY_WRITER_ACCESS_KEY_ID: gk(),
    LOGS_LEGACY_WRITER_SECRET_ACCESS_KEY: s(),
    LOGS_LEGACY_READER_ACCESS_KEY_ID: gk(),
    LOGS_LEGACY_READER_SECRET_ACCESS_KEY: s(),
    LOGS_LEGACY_ARCHIVE_KEY: k(),
    LOGS_FILES: '/var/log/exim4/mainlog,/var/log/dovecot.log',
    LOGS_JOURNAL_MAX_BYTES: String(4 * 1024 ** 3),
  };
  const fd = openSync(to, 'wx', 0o600);
  writeFileSync(
    fd,
    `# Технические журналы W08b — НЕ ПРИМЕНЁН (${new Date().toISOString().slice(0, 10)}).\n` +
      '# Дописать в .env VPS по docs/runbooks/w08b-vps-apply.md, затем пометку снять.\n' +
      `${Object.entries(vars)
        .map(([n, v]) => `${n}=${v}`)
        .join('\n')}\n`,
  );
  closeSync(fd);
  console.log(`заготовка: ${to} (переменных ${Object.keys(vars).length}, значения не печатаются)`);
}

async function knownGaps() {
  const out = [];
  for (const [key, versions] of groupByKey(await listVersions('gaps/'))) {
    out.push(JSON.parse((await getVersion(key, versions[0].versionId)).toString('utf8')));
  }
  return out;
}

/** Прочитать ровно `n` байт с начала открытого файла. */
function readPrefix(fd, n) {
  const buf = Buffer.alloc(n);
  let off = 0;
  while (off < n) {
    const got = readSync(fd, buf, off, n - off, off);
    if (!got) break;
    off += got;
  }
  return buf.subarray(0, off);
}

/** Время первой и последней строки журнала Docker json-file (поле time). */
function lineTimes(text) {
  const lines = text.split('\n').filter(Boolean);
  const time = (l) => {
    try {
      return JSON.parse(l).time ?? null;
    } catch {
      return null;
    }
  };
  return { lines: lines.length, first: time(lines[0] ?? ''), last: time(lines.at(-1) ?? '') };
}

/**
 * Ограниченный снимок файла, который, возможно, ещё пишется (журнал Docker
 * json-file до смены драйвера; замечание Тэнка: readFileSync живого файла
 * не доказывает полноту).
 *  - Граница — размер при открытии, урезанный до конца последней целой
 *    строки: оборванная запись в снимок не входит.
 *  - После чтения через тот же дескриптор проверяется, что байты до границы
 *    не изменились (не усечён, не переписан) — иначе снимок не принят.
 *  - Покрытие: сколько дописано после границы и указывает ли путь всё ещё
 *    на тот же файл (ротация). Полным снимок считается, только если хвоста
 *    нет и ротации не было — то есть файл закрыт (контейнер остановлен).
 * Сжатое поколение (.gz) закрыто по определению: граница — весь файл.
 */
function snapshotFile(path) {
  const fd = openSync(path, 'r');
  try {
    const before = sourceState(path);
    const st = fstatSync(fd);
    const raw = readPrefix(fd, st.size);
    const gz = path.endsWith('.gz');
    const boundary = gz ? raw.length : raw.lastIndexOf(0x0a) + 1;
    const prefix = raw.subarray(0, boundary);
    const mutate = env.LOGS_TEST_LEGACY_MUTATE; // испытания: запись «во время копирования»
    if (mutate === 'append') appendFileSync(path, '{"log":"дописано при копировании\\n"}\n');
    if (mutate === 'rotate') {
      renameSync(path, `${path}.1`);
      writeFileSync(path, '{"log":"новый файл после ротации\\n"}\n');
    }
    if (mutate === 'truncate') truncateSync(path, 0);
    const after = fstatSync(fd);
    const stable =
      after.size >= boundary && sha256Hex(readPrefix(fd, boundary)) === sha256Hex(prefix);
    let samePath = false;
    try {
      const now = statSync(path);
      samePath = now.ino === st.ino && now.dev === st.dev;
    } catch {
      samePath = false;
    }
    const plain = gz ? gunzipSync(prefix) : prefix;
    const tail = Math.max(0, after.size - boundary);
    // Остановка подтверждается источником до и после чтения, а не выводится
    // из неизменности байтов: работающий контейнер мог просто молчать.
    const afterSrc = sourceState(path);
    const sourceStopped =
      before.stopped === true &&
      afterSrc.stopped === true &&
      before.finishedAt === afterSrc.finishedAt
        ? true
        : before.stopped === false || afterSrc.stopped === false
          ? false
          : null;
    const snapshotStable = stable && tail === 0 && samePath;
    const cover = {
      path,
      source: { kind: before.kind, ...(before.id ? { id: before.id } : {}) },
      dev: st.dev,
      ino: st.ino,
      sizeAtOpen: st.size,
      boundary,
      tailBytes: tail,
      rotated: !samePath,
      accepted: stable,
      snapshotStable,
      sourceStopped,
      complete: snapshotStable && sourceStopped === true,
      ...(gz ? {} : lineTimes(plain.toString('utf8'))),
      sha256: sha256Hex(plain),
      at: new Date().toISOString(),
    };
    return { plain, cover };
  } finally {
    closeSync(fd);
  }
}

/**
 * Состояние источника файла. Журнал Docker json-file
 * (`…/containers/<id>/<id>-json.log`) — по `docker inspect`: остановлен ли
 * контейнер и когда (смена времени остановки между проверками — его
 * запускали). Поколение после ротации (`.N`, `.N.gz`) закрыто по имени.
 * Прочее — остановка не подтверждена (null).
 */
const DOCKER_LOG_RE = /\/containers\/([0-9a-f]{64})\/\1-json\.log$/;
function sourceState(path) {
  const m = path.match(DOCKER_LOG_RE);
  if (!m) return { kind: 'file', stopped: /\.\d+(\.gz)?$/.test(path) ? true : null };
  const r = spawnSync(
    env.LOGS_DOCKER_BIN || 'docker',
    ['inspect', '--format', '{{.State.Running}} {{.State.FinishedAt}}', m[1]],
    { encoding: 'utf8' },
  );
  const id = m[1].slice(0, 12);
  if (r.status !== 0) return { kind: 'docker', id, stopped: null };
  const [running, finishedAt] = r.stdout.trim().split(' ');
  return {
    kind: 'docker',
    id,
    stopped: running === 'false' ? true : running === 'true' ? false : null,
    finishedAt,
  };
}

function coverText(c) {
  if (!c.accepted) return 'ИЗМЕНЁН ВНУТРИ ГРАНИЦЫ (усечён или переписан) — снимок не принят';
  const span = c.lines !== undefined ? `, строк ${c.lines}, время ${c.first}–${c.last}` : '';
  const why = [
    c.tailBytes ? `после границы ${c.tailBytes} байт (файл ещё пишется или запись оборвана)` : '',
    c.rotated ? 'путь указывает на другой файл (ротация во время копирования)' : '',
  ].filter(Boolean);
  const head = `граница ${c.boundary} байт${span}`;
  if (why.length) return `${head}; НЕПОЛНО: ${why.join('; ')}`;
  if (c.sourceStopped === true)
    return `${head}; стабильный снимок, источник остановлен — покрыт целиком`;
  return `${head}; стабильный снимок до границы, НЕПОЛНО: ${
    c.sourceStopped === false
      ? 'источник работает (контейнер запущен) — полнота не доказана'
      : 'остановка источника не подтверждена'
  }`;
}

async function files() {
  const keyMat = archiveKey(env.LOGS_ARCHIVE_KEY);
  if (!FILES.length) throw new Error('LOGS_FILES не задан');
  await withLock(async () => {
    const known = await fileReceipts();
    // Состояние — по каждому источнику: исправный dovecot не скрывает
    // недоступный exim (замечание Тэнка). Время успеха обновляется только у
    // источника, который был доступен и пройден целиком.
    const prev = readJson(FILES_STATE)?.sources ?? {};
    const sources = { ...prev }; // источники вне нынешнего LOGS_FILES не теряют истории
    let stored = 0;
    let same = 0;
    let unreadable = 0;
    const bad = [];
    for (const base of FILES) {
      const src = fileSource(base);
      const at = new Date().toISOString();
      let problem = sourceProblem(base);
      if (!problem) {
        try {
          for (const g of closedGenerations(base)) {
            let plain;
            try {
              const raw = readFileSync(g.path);
              plain = g.gz ? gunzipSync(raw) : raw;
            } catch (e) {
              if (e?.code === 'EACCES' || e?.code === 'EPERM' || e?.code === 'EISDIR') {
                problem = 'unavailable';
                break;
              }
              // Поколение сжимается или удаляется ротацией прямо сейчас —
              // следующий проход прочитает его готовым.
              unreadable++;
              continue;
            }
            if (!plain.length) continue;
            if ((await storeFile(src, g, plain, keyMat, known)) === 'same') same++;
            else stored++;
          }
        } catch (e) {
          if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(e?.code)) throw e;
          problem = e.code === 'ENOENT' ? 'missing' : 'unavailable';
        }
      }
      sources[base] = problem
        ? { state: problem, at, lastOkAt: prev[base]?.lastOkAt ?? null }
        : { state: 'ok', at, lastOkAt: at };
      if (problem) {
        bad.push(base);
        console.error(
          `источник ${base}: ${problem === 'missing' ? 'ОТСУТСТВУЕТ' : 'НЕДОСТУПЕН'} — время успеха не обновлено`,
        );
      }
    }
    writeJsonAtomic(FILES_STATE, { sources, stored, same, unreadable, known: known.size });
    console.log(
      `файлы: записано ${stored}, уже в архиве ${same}, не прочитано сейчас ${unreadable}, всего в архиве ${known.size}, источников с ошибкой ${bad.length} из ${FILES.length}`,
    );
    if (bad.length) process.exitCode = 1;
  });
}

/** Проверка файлов архива: каждая квитанция — своей версией, хеши. */
async function verifyFiles(keyMat, problems) {
  const known = await fileReceipts();
  for (const r of known.values()) {
    const got = await plainOfVersion(r.key, r.versionId, keyMat);
    if (!got) {
      problems.push(`файл ${r.source}/${r.name}: версии нет или не расшифрована — утрата архива`);
      continue;
    }
    if (got.objSha !== r.objSha || sha256Hex(got.plain) !== r.plainSha) {
      problems.push(`файл ${r.source}/${r.name}: хеш не совпал`);
    }
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
async function queueAfter(pos) {
  if (!pos) return null;
  try {
    let entries = 0;
    let bytes = 0;
    let oldest = null;
    for (const e of await readJournal({ ...pos, maxBytes: Infinity })) {
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
  const queue = state ? await queueAfter(readPos(state)) : null;
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
    // Файлы почты: null — не настроены. По каждому настроенному источнику —
    // состояние (ok / missing / unavailable / never — прохода ещё не было) и
    // время успеха; lastOkEpoch — самое старое из них (null, если у
    // какого-то источника успеха не было), bad — источников с ошибкой.
    files: FILES.length
      ? (() => {
          const st = readJson(FILES_STATE)?.sources ?? {};
          const epoch = (t) => (t ? Math.floor(Date.parse(t) / 1000) : null);
          const sources = FILES.map((base) => ({
            source: fileSource(base),
            state: st[base]?.state ?? 'never',
            lastOkEpoch: epoch(st[base]?.lastOkAt),
          }));
          const oks = sources.map((s) => s.lastOkEpoch);
          return {
            lastOkEpoch: oks.includes(null) ? null : Math.min(...oks),
            bad: sources.filter((s) => s.state === 'missing' || s.state === 'unavailable').length,
            sources,
          };
        })()
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
async function putVolumeSnapshot(day, parts) {
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
    `volume/${day}.json`,
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

// Пакет — на сутки, по всем нумерациям журнала сразу.
const packKey = (day) => `p/${day}.pack`;
const packReceiptKey = (day, versionId) => `pr/${day}/${versionId}.json`;

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
    const existing = new Set((await listVersions('pr/')).map((v) => v.key.split('/')[1]));
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
      const key = packKey(day);
      const versionId = await putObject(key, sealed, { format: `pack+${FORMAT}` });
      await putChained(packReceiptKey(day, versionId), {
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
      });
      await putVolumeSnapshot(day, parts);
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

/** Состав копии по звеньям цепочки: границы, квитанции порций, пакетов, файлов. */
function chainComposition(links) {
  const under = (p) => links.filter((l) => l.key.startsWith(p)).map((l) => l.body);
  return {
    anchors: under('anchors/'),
    receipts: under('r/'),
    packs: under('pr/'),
    files: under('rf/'),
  };
}

/** Имя квитанции сходится с её содержимым — иначе разбор, а не копия. */
function assertReceiptName({ key, body }) {
  let same = true;
  if (key.startsWith('r/')) {
    const r = parseReceiptKey(key);
    same =
      r &&
      body.key === chunkKey(PREFIX, r.seqId, r.first, r.last, r.kind) &&
      body.versionId === r.versionId &&
      BigInt(body.first) === r.first &&
      BigInt(body.last) === r.last;
  } else if (key.startsWith('rf/')) {
    same = key === fileReceiptKey(body.plainSha, body.versionId);
  }
  if (!same) throw new Error(`квитанция ${key}: содержимое не совпадает с именем`);
}

/**
 * Ручная копия на ноутбук — единый снимок. Один обход цепочки выбирает голову,
 * и всё, что в цепочке до неё, составляет копию: границы, квитанции порций и
 * потерь (включая квитанции на версии, которых в архиве уже нет — это
 * свидетельство утраты, а не мусор), пакеты, файлы. Рядом идут проходы
 * таймера: записанное после выбранной головы забирает следующий pull
 * (замечание Тэнка: квитанции до скачивания, цепочка после — и копия
 * подтверждала порции, которых в ней нет).
 *
 * Добавочно качаются пакеты и подтверждённые порции, которых нет ни в копии,
 * ни в её исправных пакетах. Вердикт выносит проверка ЛОКАЛЬНОЙ копии — та
 * же, что `verify-copy` без доступа к S3, — и только зелёный вердикт заменяет
 * подтверждённую опись.
 *
 *   node scripts/logs-archive.mjs pull --to <каталог>
 */
async function pull() {
  const keyMat = archiveKey(env.LOGS_ARCHIVE_KEY);
  const to = copyDir();
  mkdirSync(join(to, 'packs'), { recursive: true });
  mkdirSync(join(to, 'chunks'), { recursive: true });
  mkdirSync(join(to, 'files'), { recursive: true });

  // Снимок. Опубликованная голова — до обхода: прочитанная после, она
  // опередила бы цепочку без всякой утраты.
  const published = await chainedBody(REF_KEY, keyMat);
  const walk = await walkChain(keyMat);
  walk.links.forEach(assertReceiptName);
  const { anchors, receipts, packs, files: fileList } = chainComposition(walk.links);
  anchors.sort((a, b) => (a.at < b.at ? -1 : 1));
  if (!anchors.length) throw new Error('в S3 нет границы архива');

  // Сверка снимка с опубликованной головой (ref/head.json) и с эталоном
  // прежней копии: откат головы или утрата хвоста видны здесь, даже если
  // голову в хранилище подменили на старую.
  const chainNotes = chainProblems(walk, null).problems;
  if (
    published &&
    (walk.count < published.count || walk.heads[published.count] !== published.head)
  ) {
    chainNotes.push(
      `цепочка хранилища (${walk.count}) не содержит опубликованную голову (${published.count}) — утрата или подмена`,
    );
  }
  let prev = null;
  try {
    prev = JSON.parse(
      open(readFileSync(join(to, MANIFEST)), keyMat.key).toString('utf8'),
    ).reference;
  } catch {
    /* первой копии нет */
  }
  if (prev && (walk.count < prev.count || walk.heads[prev.count] !== prev.head)) {
    chainNotes.push(
      `цепочка хранилища (${walk.count}) расходится с эталоном прежней копии (${prev.count}) — утрата или подмена`,
    );
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
  testPassDuringRead();
  for (const r of receipts) {
    if (r.kind !== 'chunk' || inPacks.has(`${r.key}@${r.versionId}`)) continue;
    if (existsSync(chunkFile(to, r))) continue;
    const sealed = await getVersion(r.key, r.versionId);
    if (!sealed) continue;
    writeFileSync(chunkFile(to, r), sealed);
    downloaded++;
  }
  // Файлы почты — все квитанции; версии, которой нет, проверка копии
  // назовёт утратой.
  for (const r of fileList) {
    if (existsSync(copyFile(to, r))) continue;
    const sealed = await getVersion(r.key, r.versionId);
    if (!sealed) continue;
    writeFileSync(copyFile(to, r), sealed);
    downloaded++;
  }

  const manifest = {
    at: new Date().toISOString(),
    anchors,
    receipts,
    packs,
    files: fileList,
    reference: { head: walk.head, count: walk.count },
    chain: walk.links,
    chainNotes,
  };
  console.log(`скачано объектов: ${downloaded}`);
  console.log(`снимок: звеньев цепочки ${walk.count}; записанное позже заберёт следующий pull`);
  // Подтверждённая опись — эталон копии — заменяется только сошедшейся
  // копией, продолжающей цепочку. Иначе следующий запуск сверялся бы с
  // негодным эталоном и мог дать ложный успех (замечание Тэнка к 065cba0).
  // Попытка сохраняется отдельно — для разбора.
  const rejected = join(to, `${MANIFEST}.rejected`);
  const { failed, summary } = checkManifest(to, manifest, keyMat);
  if (failed) {
    writeFileSync(rejected, seal(Buffer.from(JSON.stringify(manifest)), keyMat.key));
    console.log(
      `подтверждённая опись и эталон прежние (${prev ? `${prev.count} звеньев` : 'первой описи нет'}); попытка — ${MANIFEST}.rejected`,
    );
    return;
  }
  const tmp = join(to, `${MANIFEST}.tmp`);
  writeFileSync(tmp, seal(Buffer.from(JSON.stringify(manifest)), keyMat.key));
  renameSync(tmp, join(to, MANIFEST));
  rmSync(rejected, { force: true });
  writeFileSync(join(to, 'PULLED.json'), JSON.stringify(summary, null, 2));
}

/**
 * Проверка ручной копии ТОЛЬКО по локальным файлам и ключу — S3 не нужен.
 * Ожидаемый состав — все квитанции цепочки до головы описи: квитанция,
 * не учтённая в составе, — красный вердикт, а не молчание.
 * Каждый отрезок покрыт точной подтверждённой порцией (отдельным файлом или
 * внутри исправного пакета) либо учтённой отметкой потери; иначе — утрата.
 *
 *   node scripts/logs-archive.mjs verify-copy --to <каталог>
 */
function verifyCopy() {
  checkCopy(copyDir(), archiveKey(env.LOGS_ARCHIVE_KEY));
}

function checkCopy(to, keyMat) {
  // Первая попытка не сошлась — подтверждённой описи нет, а вердикт есть.
  const attempt = join(to, `${MANIFEST}.rejected`);
  const file =
    !existsSync(join(to, MANIFEST)) && existsSync(attempt) ? attempt : join(to, MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(open(readFileSync(file), keyMat.key).toString('utf8'));
  } catch {
    throw new Error(`опись копии ${MANIFEST} отсутствует, испорчена или другой ключ`);
  }
  if (file === attempt) {
    manifest.chainNotes = [
      ...(manifest.chainNotes ?? []),
      'подтверждённой описи нет — проверена неудачная попытка',
    ];
  }
  const { summary } = checkManifest(to, manifest, keyMat);
  if (file !== attempt) writeFileSync(join(to, 'PULLED.json'), JSON.stringify(summary, null, 2));
}

/** Состав описи против цепочки до её головы: ни лишнего, ни неучтённого. */
function compositionProblems(manifest, links) {
  const want = chainComposition(links);
  const problems = [];
  const parts = [
    ['границ', manifest.anchors ?? [manifest.anchor], want.anchors],
    ['квитанций порций', manifest.receipts, want.receipts],
    ['квитанций пакетов', manifest.packs, want.packs],
    ['квитанций файлов', manifest.files ?? [], want.files],
  ];
  for (const [name, listed, chained] of parts) {
    const macs = (list) => new Set(list.map((x) => x.mac));
    const [have, expected] = [macs(listed), macs(chained)];
    const missing = chained.filter((x) => !have.has(x.mac)).length;
    const extra = listed.filter((x) => !expected.has(x.mac)).length;
    if (missing) problems.push(`опись: ${name} из цепочки не учтено в составе копии: ${missing}`);
    if (extra) problems.push(`опись: ${name} в составе копии вне цепочки: ${extra}`);
  }
  return problems;
}

/** Вердикт по описи и локальным файлам: {failed, summary}. */
function checkManifest(to, manifest, keyMat) {
  const { receipts, packs } = manifest;
  const anchors = manifest.anchors ?? [manifest.anchor];
  const problems = [...(manifest.chainNotes ?? [])];
  // Цепочка по описи: подписи, голова против эталона копии, и состав копии
  // против цепочки — каждая квитанция до головы учтена.
  if (manifest.reference) {
    const byPrev = new Map();
    for (const link of manifest.chain ?? []) {
      const { body } = link;
      if (body.mac !== macOf(body, keyMat)) problems.push('опись: звено без подписи ключом архива');
      else byPrev.set(body.prev, link);
    }
    let head = GENESIS;
    const links = [];
    for (let l = byPrev.get(head); l; l = byPrev.get(head)) {
      head = linkOf(head, l.body.mac);
      links.push(l);
    }
    if (links.length !== manifest.reference.count || head !== manifest.reference.head) {
      problems.push(
        `опись: цепочка (${links.length}) не сошлась с эталоном копии (${manifest.reference.count})`,
      );
    }
    problems.push(...compositionProblems(manifest, links));
  } else {
    problems.push('опись без эталона цепочки — копия старого формата, НЕПРОВЕРЯЕМО');
  }
  const known = new Set(anchors.map((a) => a.seqId));
  for (const sid of new Set(receipts.map((r) => parseChunkKey(r.key)?.seqId))) {
    if (!known.has(sid)) problems.push(`опись: нумерация ${sid} — квитанции есть, границы нет`);
  }
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
    const range = {
      sid: parseChunkKey(r.key)?.seqId,
      first: BigInt(r.first),
      last: BigInt(r.last),
    };
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

  // Покрытие — по каждой нумерации journald отдельно: от её границы до
  // последней ожидаемой записи (по всем квитанциям этой нумерации).
  const gaps = [];
  const journals = [];
  for (const a of anchors) {
    const sid = a.seqId;
    const own = (list) => list.filter((x) => x.sid === sid);
    const covered = mergeRanges([...own(ok), ...own(lost)]);
    const isCovered = (x, y) => covered.some((c) => c.first <= x && y <= c.last);
    for (const r of absent) {
      if (parseChunkKey(r.key)?.seqId !== sid) continue;
      if (!isCovered(BigInt(r.first), BigInt(r.last))) {
        problems.push(
          `отрезок ${r.first}–${r.last}: квитанция есть, порции нет ни отдельно, ни в пакете — утрата архива`,
        );
      }
    }
    const start = BigInt(a.afterSeq) + 1n;
    const expectedEnd = receipts
      .filter((r) => parseChunkKey(r.key)?.seqId === sid)
      .reduce((m, r) => (BigInt(r.last) > m ? BigInt(r.last) : m), start - 1n);
    let at = start;
    for (const c of covered) {
      if (c.last < start) continue;
      if (c.first > at) gaps.push(`${at}–${c.first - 1n}${anchors.length > 1 ? ` (${sid})` : ''}`);
      if (c.last + 1n > at) at = c.last + 1n;
    }
    if (at <= expectedEnd) {
      gaps.push(`${at}–${expectedEnd}${anchors.length > 1 ? ` (${sid})` : ''}`);
    }
    journals.push({ seqId: sid, from: str(start), to: str(expectedEnd) });
  }

  const lostRecords = lost.reduce((n, r) => n + (r.last - r.first + 1n), 0n);
  const byReason = {};
  for (const r of lost) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  const summary = {
    at: new Date().toISOString(),
    journals,
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
  console.log(
    `копия: записи ${journals.map((j) => `${j.from}–${j.to}`).join(', ')}, пакетов: ${packs.length}, порций из пакетов: ${viaPack}, отдельно: ${viaChunk}, нет в копии: ${absent.length}, файлов: ${fileList.length}, пропусков: ${gaps.length}, проблем: ${problems.length}`,
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
  return { failed: Boolean(failedCheck), summary };
}

// ----------------------------------------------------------------- поиск

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
  // задевают интервал. Номера сравнимы только внутри нумерации journald —
  // по каждой отдельно; нумерация целиком до интервала (следующая уже шла
  // до его начала) или целиком после него не рассматривается.
  const bySid = new Map();
  for (const r of rows) {
    const sid = parseChunkKey(r.key)?.seqId;
    bySid.set(sid, [...(bySid.get(sid) ?? []), r]);
  }
  const firstTime = (sid) =>
    Math.min(
      ...bySid
        .get(sid)
        .filter((r) => r.kind === 'chunk')
        .map((r) => r.from),
      Infinity,
    );
  const sids = [...bySid.keys()].sort((a, b) => firstTime(a) - firstTime(b));
  const has = (list, test) =>
    list.some((s) => bySid.get(s).some((r) => r.kind === 'chunk' && test(r)));
  const losses = [];
  sids.forEach((sid, i) => {
    if (has(sids.slice(i + 1), (r) => r.to < fromUs)) return;
    if (has(sids.slice(0, i), (r) => r.from > toUs)) return;
    const own = bySid.get(sid);
    const ch = chunks.filter((r) => own.includes(r));
    const before = ch.filter((r) => r.to < fromUs).at(-1);
    const after = ch.find((r) => r.from > toUs);
    const lo = before ? BigInt(before.last) : -1n;
    const hi = after ? BigInt(after.first) : null;
    losses.push(
      ...own.filter(
        (r) => r.kind === 'loss' && BigInt(r.last) > lo && (hi === null || BigInt(r.first) < hi),
      ),
    );
  });

  const found = [];
  const problems = [];
  // Одна запись может оказаться и в двух порциях (повтор после разбора):
  // выдаётся один раз — по номеру.
  const seen = new Set();
  const take = (e) => {
    if (e.realtime === null || e.realtime < fromUs || e.realtime > toUs) return;
    const id = `${e.seqId}:${e.seq}`;
    if (seen.has(id)) return;
    seen.add(id);
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
  if (!copy && readPos(state)) {
    for (const e of await readJournal({ ...readPos(state), maxBytes: Infinity })) {
      fresh++;
      take(e);
    }
  }

  found.sort((a, b) => a.t - b.t);
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
  // По таймеру: занятая блокировка (идёт files или pack) — пропуск минуты,
  // а не отказ; застревание видит тревога отставания архива.
  run: () =>
    run().catch((error) => {
      if (!String(error?.message).startsWith('проход уже идёт')) throw error;
      console.log(`проход пропущен: ${error.message}`);
    }),
  rebuild: rebuildState,
  status,
  verify,
  pack,
  pull,
  'verify-copy': verifyCopy,
  files,
  'legacy-export': legacyExport,
  'legacy-snapshot': legacySnapshot,
  'legacy-gap': legacyGap,
  'secrets-draft': secretsDraft,
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
