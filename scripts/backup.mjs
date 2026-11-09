#!/usr/bin/env node
/**
 * Резервирование стенда (блок 7, 2.1-W07).
 *
 *   node scripts/backup.mjs init-secrets   дописать в .env недостающие BACKUP_* (значения не печатаются)
 *   node scripts/backup.mjs keys-init      пара ключей gpg Томаса в .local/backup-keys (вне Git)
 *   node scripts/backup.mjs db [--full]    копия базы: полная раз в неделю, иначе добавочная; затем verify
 *   node scripts/backup.mjs set            комплект на момент T: журнал, файлы, ключи, конфигурация, READY
 *   node scripts/backup.mjs check          проверки по компонентам и сигналы (Telegram)
 *   node scripts/backup.mjs status         сводка без секретов
 *   node scripts/backup.mjs pull [--from-dir <каталог>]   скачать последний пригодный комплект
 *
 * Расписание на сервере — таймеры systemd (`infra/systemd/fifth-backup-*`),
 * не ядро: сбой ядра не выключает резервирование. Каждое задание под своей
 * блокировкой; итог пишется в `BACKUP_DIR/state`, его читает `check`.
 *
 * Чего команда НЕ делает: не удаляет копии (срок хранения не согласован, 7.5),
 * не трогает рабочие данные, не выводит секреты.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { openbaoSnapshot } from './lib/openbao.mjs';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  ENV_PATH,
  ROOT,
  MEMORY_ONLY,
  TOOL_IMAGE,
  appendIndex,
  assertSpace,
  cfg,
  diskInfo,
  docker,
  ensureDirs,
  ensureKeyBundle,
  gb,
  loadEnv,
  newId,
  parseEnvFile,
  pgbackrest,
  psql,
  rclone,
  readIndex,
  readState,
  readySets,
  verifyCatalog,
  materializeMeta,
  snapshotMeta,
  copiedVersionProblems,
  ledgerAdd,
  ledgerProblems,
  loadLedger,
  saveLedger,
  backupPathOf,
  buildManifest,
  isMutableKey,
  loadHashCache,
  objectVersion,
  planObjects,
  saveHashCache,
  walFile,
  walSegments,
  recordJob,
  signal,
  setLimitations,
  snapshotConfig,
  standNetwork,
  withLock,
  writeState,
} from './lib/backup.mjs';

// Нечитаемый файл секрета — отказ задания, и он обязан попасть в состояние. Проверка
// секретов не читает: без неё наблюдение увидело бы только молчание таймера.
const PILOT_STATE = process.env.FIFTH_MONITOR_STATE || '/var/lib/fifth-monitor';
const PILOT_BACKUP_HOURS = 30;
// Ноутбук бывает выключен: порог с запасом на выходные.
const PILOT_OFFSITE_HOURS = 72;
// Выгрузка аудита (2.1.5): порция каждый час; 2 ч — цель на сервере. Вне сервера — 72 ч:
// пока на prod нет пользователей, ноутбук забирает раз в сутки (Томас, 09.11). При выходе в
// прод — ежечасно и 3 ч (TODO сейфа, «Перед выходом в прод»).
const AUDIT_EXPORT_HOURS = 2;
const AUDIT_OFFSITE_HOURS = 72;
let secretsError = null;
try {
  loadEnv();
} catch (error) {
  secretsError = error;
  loadEnv({ secrets: false });
}
const [command, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(name);
const option = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

const VPS = 'maus@193.233.217.210';
const VPS_KEY = join(process.env.USERPROFILE || process.env.HOME || '', '.ssh', 'maus_5e');

// ------------------------------------------------------------ init-secrets

function initSecrets() {
  const env = parseEnvFile(ENV_PATH);
  const gen = () => randomBytes(32).toString('base64url');
  const wanted = {
    BACKUP_PGBACKREST_CIPHER_PASS: gen,
    BACKUP_FILES_CRYPT_PASS: gen,
    BACKUP_FILES_CRYPT_SALT: gen,
    // Ключ копий в Garage (D-001): формат GK + 24 hex и 64 hex.
    BACKUP_S3_ACCESS_KEY_ID: () => `GK${randomBytes(12).toString('hex')}`,
    BACKUP_S3_SECRET_ACCESS_KEY: () => randomBytes(32).toString('hex'),
  };
  const added = [];
  let text = readFileSync(ENV_PATH, 'utf8');
  if (!text.endsWith('\n')) text += '\n';
  const lines = [];
  for (const [k, make] of Object.entries(wanted)) {
    if (env[k]) continue;
    lines.push(`${k}=${make()}`);
    added.push(k);
  }
  if (lines.length) {
    text += `\n# Резервирование (блок 7, 2.1-W07) — дописано backup.mjs init-secrets\n${lines.join('\n')}\n`;
    writeFileSync(ENV_PATH, text);
  }
  console.log(
    added.length ? `дописаны: ${added.join(', ')}` : 'все секреты резервирования уже есть',
  );
  console.log(
    'Не секреты, задаются вручную: BACKUP_DIR, BACKUP_PGBACKREST_DIR (= BACKUP_DIR/pgbackrest), ' +
      'BACKUP_ARCHIVE_MODE=on, BACKUP_TELEGRAM_CHAT_ID; токен бота — BACKUP_TELEGRAM_BOT_TOKEN.',
  );
}

// ---------------------------------------------------------------- keys-init

/**
 * Пара ключей gpg для комплекта ключей. Закрытый ключ защищён парольной
 * фразой; обе части Томас переносит в KeePassXC. На стенд уходит только
 * открытый ключ.
 */
function keysInit() {
  const dir = join(ROOT, '.local', 'backup-keys');
  mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, 'secret-key.asc'))) {
    console.log(`пара уже есть: ${dir} — новую не создаю`);
    return;
  }
  const passphrase = randomBytes(24).toString('base64url');
  const script = [
    'set -e',
    'export GNUPGHOME=$(mktemp -d)',
    'gpg -q --batch --pinentry-mode loopback --passphrase-fd 0 --quick-gen-key "5E backup keys <backup@5espace.com>" rsa4096 encrypt never',
    "fpr=$(gpg --batch --list-keys --with-colons | awk -F: '/^fpr/{print $10; exit}')",
    'gpg -q --batch --armor --export "$fpr" > /out/recipient.asc',
    'printf %s "$PASSPHRASE" | gpg -q --batch --pinentry-mode loopback --passphrase-fd 0 --armor --export-secret-keys "$fpr" > /out/secret-key.asc',
    'echo "$fpr"',
  ].join('\n');
  const r = docker(
    [
      'run',
      '--rm',
      '-i',
      '-e',
      'PASSPHRASE',
      '-v',
      `${dir}:/out`,
      '--entrypoint',
      'sh',
      TOOL_IMAGE,
      '-c',
      script,
    ],
    { env: { PASSPHRASE: passphrase }, input: passphrase },
  );
  writeFileSync(join(dir, 'passphrase.txt'), `${passphrase}\n`);
  writeFileSync(
    join(dir, 'README.txt'),
    [
      'Ключи комплекта ключей резервирования 5Э (блок 7, 2.1-W07).',
      `Отпечаток: ${r.stdout.trim().split('\n').pop()}`,
      '',
      'secret-key.asc + passphrase.txt — ЗАКРЫТЫЙ ключ и его фраза. Перенести в KeePassXC',
      '(вложение и поле пароля), затем эти два файла отсюда удалить.',
      'recipient.asc — открытый ключ: им стенд шифрует комплект ключей. Его можно передавать.',
      '',
      'Статус: не применён — пока открытый ключ не передан на стенд.',
    ].join('\n'),
  );
  console.log(`пара создана в ${dir} (значения не печатаются); см. README.txt`);
}

/**
 * Проверка пары ключей: случайная строка шифруется открытым ключом и
 * расшифровывается закрытым с фразой. Так проверяются ключи, перенесённые в
 * KeePassXC и выгруженные оттуда во временные файлы. Значения не печатаются.
 *
 *   node scripts/backup.mjs keys-check --secret-key <файл> --passphrase-file <файл> [--recipient <файл>]
 */
function keysCheck() {
  const secret = resolve(option('--secret-key') ?? '');
  const passFile = resolve(option('--passphrase-file') ?? '');
  const recipient = resolve(
    option('--recipient') ?? join(ROOT, '.local', 'backup-keys', 'recipient.asc'),
  );
  for (const f of [secret, passFile, recipient]) {
    if (!existsSync(f)) throw new Error(`нет файла ${f}`);
  }
  const challenge = randomBytes(24).toString('hex');
  const script = [
    'set -e',
    'mkdir -m 700 /secure/pub /secure/gpg',
    'export GNUPGHOME=/secure/pub',
    'gpg -q --batch --import /in/recipient.asc 2>/dev/null',
    "fpr=$(gpg --batch --list-keys --with-colons | awk -F: '/^fpr/{print $10; exit}')",
    'printf %s "$CHALLENGE" | gpg -q --batch --trust-model always --encrypt --recipient "$fpr" --output /secure/c.gpg',
    'export GNUPGHOME=/secure/gpg',
    'printf %s "$PASSPHRASE" | gpg -q --batch --pinentry-mode loopback --passphrase-fd 0 --import /in/secret.asc 2>/dev/null',
    'printf %s "$PASSPHRASE" | gpg -q --batch --pinentry-mode loopback --passphrase-fd 0 --decrypt /secure/c.gpg',
  ].join('\n');
  const r = docker(
    [
      'run',
      '--rm',
      '--network',
      'none',
      ...MEMORY_ONLY,
      '-e',
      'CHALLENGE',
      '-e',
      'PASSPHRASE',
      '-v',
      `${recipient}:/in/recipient.asc:ro`,
      '-v',
      `${secret}:/in/secret.asc:ro`,
      '--entrypoint',
      'sh',
      TOOL_IMAGE,
      '-c',
      script,
    ],
    {
      env: { CHALLENGE: challenge, PASSPHRASE: readFileSync(passFile, 'utf8').trim() },
      allowFail: true,
    },
  );
  if (r.stdout.trim() !== challenge) {
    throw new Error('закрытый ключ с этой фразой НЕ открывает зашифрованное открытым ключом');
  }
  console.log('ключи в порядке: закрытый ключ с фразой открывает зашифрованное открытым ключом');
}

// ------------------------------------------------------------ openbao-keys

const OPENBAO_RECIPIENT = '06D54B5532998568A88185A2BEA53785936C28C0';

/** Комплект открывается ключом Томаса и совпадает с описанием. Печатаются только итоги. */
function verifyOpenbaoKeys(file, meta) {
  const secret = resolve(option('--secret-key') ?? '');
  const passFile = resolve(option('--passphrase-file') ?? '');
  for (const f of [file, secret, passFile]) {
    if (!existsSync(f)) throw new Error(`нет файла ${f}`);
  }
  if (meta.recipient !== (option('--recipient-fpr') ?? OPENBAO_RECIPIENT)) {
    throw new Error('комплект зашифрован не на ключ Томаса');
  }
  if (meta.operatorLogin !== true || meta.rootRevoked !== true) {
    throw new Error('установка не подтвердила личный вход и отзыв root-токена');
  }
  const script = [
    'set -e',
    'mkdir -m 700 /secure/gpg',
    'printf %s "$PASSPHRASE" | gpg -q --batch --pinentry-mode loopback --passphrase-fd 0 --import /in/secret.asc 2>/dev/null',
    'printf %s "$PASSPHRASE" | gpg -q --batch --pinentry-mode loopback --passphrase-fd 0 --decrypt /in/emergency.gpg > /secure/p 2>/dev/null',
    'v() { sed -n "s/^$1=//p" /secure/p; }',
    "v OPENBAO_STATIC_SEAL_B64 | base64 -d | sha256sum | cut -d' ' -f1",
    'printf %s "$(v OPENBAO_RECOVERY_KEY)" | sha256sum | cut -d\' \' -f1',
    'printf %s "$(v OPENBAO_THOMAS_PASSWORD)" | sha256sum | cut -d\' \' -f1',
  ].join('\n');
  const r = docker(
    [
      'run',
      '--rm',
      '--network',
      'none',
      ...MEMORY_ONLY,
      '-e',
      'PASSPHRASE',
      '-v',
      `${resolve(file)}:/in/emergency.gpg:ro`,
      '-v',
      `${secret}:/in/secret.asc:ro`,
      '--entrypoint',
      'sh',
      TOOL_IMAGE,
      '-c',
      script,
    ],
    { env: { PASSPHRASE: readFileSync(passFile, 'utf8').trim() }, allowFail: true },
  );
  const [seal, recovery, password] = r.stdout.trim().split('\n');
  if (
    seal !== meta.sealSha256 ||
    recovery !== meta.recoverySha256 ||
    password !== meta.passwordSha256
  ) {
    throw new Error('аварийный комплект не открылся или не совпал с описанием');
  }
  console.log('аварийный комплект открыт ключом Томаса, значения совпали с установкой');
}

/** Для проверок: комплект и описание из файлов. */
function openbaoKeysCheck() {
  const meta = JSON.parse(readFileSync(resolve(option('--meta') ?? ''), 'utf8'));
  verifyOpenbaoKeys(resolve(option('--file') ?? ''), meta);
}

/**
 * Забрать комплект с VPS и проверить его.
 *
 *   node scripts/backup.mjs openbao-keys --secret-key <файл> --passphrase-file <файл>
 */
function openbaoKeys() {
  const read = (what) =>
    execFileSync(
      'ssh',
      [
        '-i',
        VPS_KEY,
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'BatchMode=yes',
        VPS,
        `sudo -n /usr/local/sbin/fifth-backup-read ${what}`,
      ],
      { maxBuffer: 1 << 24 },
    );
  const meta = JSON.parse(read('openbao-keys-meta').toString('utf8'));
  const dir = join(ROOT, '.local', 'keys-openbao');
  mkdirSync(dir, { recursive: true });
  const name = `emergency-${meta.sealSha256.slice(0, 12)}`;
  const file = join(dir, `${name}.gpg`);
  writeFileSync(file, read('openbao-keys'));
  verifyOpenbaoKeys(file, meta);
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`копия вне VPS: ${file}`);
}

// ---------------------------------------------------------------------- db

function backupInfo() {
  const r = pgbackrest(['info', '--output=json'], { allowFail: true });
  try {
    const [stanza] = JSON.parse(r.stdout);
    return stanza ?? null;
  } catch {
    return null;
  }
}

function ensureStanza() {
  const info = backupInfo();
  if (info && info.status?.code === 0) return info;
  if (info && info.status?.code !== 1 && info.status?.code !== 2) {
    // 1 — нет хранилища, 2 — нет копий: это нормально до первой копии.
    throw new Error(`хранилище копий базы в состоянии «${info.status?.message}»`);
  }
  pgbackrest(['stanza-create']);
  return backupInfo();
}

async function db() {
  ensureDirs();
  await withLock('db', async () => {
    try {
      const archiveMode = psql('SHOW archive_mode');
      if (archiveMode !== 'on')
        throw new Error('архив журнала выключен (BACKUP_ARCHIVE_MODE не on)');
      const info = ensureStanza();
      const size = Number(psql('SELECT sum(pg_database_size(datname)) FROM pg_database'));
      assertSpace(size, 'копия базы');
      const fulls = (info?.backup ?? []).filter((b) => b.type === 'full');
      const lastFull = fulls.at(-1);
      const fullDue =
        flag('--full') || !lastFull || Date.now() / 1000 - lastFull.timestamp.stop > 7 * 86400;
      const type = fullDue ? 'full' : 'incr';
      console.log(`копия базы: ${type === 'full' ? 'полная' : 'добавочная'}…`);
      pgbackrest(['backup', `--type=${type}`]);
      // verify — разрывы журнала и повреждённые файлы хранилища (7.7).
      const verify = pgbackrest(['verify'], { allowFail: true });
      if (verify.status !== 0) {
        throw new Error(
          `проверка хранилища копий базы: ${verify.stderr.trim().split('\n').slice(-3).join(' ')}`,
        );
      }
      const after = backupInfo();
      const last = after.backup.at(-1);
      recordJob('db', true, { lastType: type, lastLabel: last.label });
      console.log(`готово: ${last.label}`);
    } catch (error) {
      recordJob('db', false, { lastError: String(error.message ?? error) });
      throw error;
    }
  });
}

// --------------------------------------------------------------------- set

const segNo = (wal) => parseInt(wal.slice(8, 16), 16) * 256 + parseInt(wal.slice(16, 24), 16);

/** Объекты бакета сейчас: [{key, size, md5, modTime}]. */
function listSource(network) {
  const r = rclone(
    [
      'lsjson',
      '-R',
      '--files-only',
      '--no-mimetype',
      '--hash',
      '--hash-type',
      'MD5',
      `SRC:${cfg().bucket}`,
    ],
    { network },
  );
  return JSON.parse(r.stdout).map((o) => ({
    key: o.Path,
    size: o.Size,
    md5: o.Hashes?.md5 ?? o.Hashes?.MD5 ?? '',
    modTime: o.ModTime ?? '',
  }));
}

/**
 * Скопировать версии объектов в копию. Неизменяемые — одной командой по
 * списку, путь в копии = ключ; изменяемые — по одному, каждая версия по
 * своему пути (прежняя версия остаётся для старых комплектов). --immutable:
 * сохранённое не перезаписывается никогда.
 */
function copyVersions(rows, network, id) {
  const c = cfg();
  const plain = rows.filter((r) => !isMutableKey(r.key));
  const versioned = rows.filter((r) => isMutableKey(r.key));
  if (plain.length) {
    writeFileSync(join(c.state, `copy-${id}.txt`), plain.map((r) => r.key).join('\n') + '\n');
    rclone(
      [
        'copy',
        `SRC:${c.bucket}`,
        `DST:${c.bucket}`,
        '--files-from-raw',
        `/backup/state/copy-${id}.txt`,
        '--immutable',
        // Время изменения в каталоге копии (общие папки Docker) хранится
        // неточно; изменение содержимого ловит сравнение версий источника.
        '--size-only',
        '--transfers',
        '2',
      ],
      { network },
    );
  }
  if (versioned.length) {
    writeFileSync(
      join(c.state, `copyto-${id}.tsv`),
      versioned.map((r) => `${r.key}\t${r.backupPath}`).join('\n') + '\n',
    );
    rclone([], {
      network,
      body:
        `TAB="$(printf '\\t')"; while IFS="$TAB" read -r key path; do ` +
        `rclone copyto "SRC:${c.bucket}/$key" "DST:$path" --immutable --size-only; ` +
        `done < /backup/state/copyto-${id}.tsv`,
    });
  }
}

/** Хеш содержимого сохранённых версий (sha256 или md5): считается по самой копии. */
function hashBackup(paths, network, id, type = 'sha256') {
  if (!paths.length) return new Map();
  const c = cfg();
  writeFileSync(join(c.state, `hash-${id}.txt`), paths.join('\n') + '\n');
  const out = rclone(
    ['hashsum', type, '--download', 'DST:', '--files-from-raw', `/backup/state/hash-${id}.txt`],
    { network },
  ).stdout;
  const map = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^([0-9a-f]{32}|[0-9a-f]{64})\s+(.+)$/);
    if (m) map.set(m[2], m[1]);
  }
  return map;
}

/** SHA-256 содержимого объектов источника (скачивая): ключ → хеш. */
function sourceSha256(keys, network, id) {
  if (!keys.length) return new Map();
  const c = cfg();
  writeFileSync(join(c.state, `srchash-${id}.txt`), keys.join('\n') + '\n');
  const out = rclone(
    [
      'hashsum',
      'sha256',
      '--download',
      `SRC:${c.bucket}`,
      '--files-from-raw',
      `/backup/state/srchash-${id}.txt`,
    ],
    { network },
  ).stdout;
  const map = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^([0-9a-f]{64})\s+(.+)$/);
    if (m) map.set(m[2], m[1]);
  }
  return map;
}

/** Все пути версий, когда-либо записанные в индекс копии. */
function indexedPaths() {
  const c = cfg();
  if (!existsSync(c.index)) return new Set();
  return new Set(
    readFileSync(c.index, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l).backupPath),
  );
}

/** Зашифрованные имена путей копии (для описи без ключей). */
function encryptedPaths(paths, network, id) {
  const map = new Map();
  if (!paths.length) return map;
  writeFileSync(join(cfg().state, `enc-${id}.txt`), paths.join('\n') + '\n');
  // cryptdecode принимает до 10 путей за вызов — серия в одном контейнере.
  const out = rclone([], {
    network,
    body: `xargs -d '\\n' -n 10 rclone cryptdecode --reverse DST: < /backup/state/enc-${id}.txt`,
  }).stdout;
  for (const line of out.split('\n')) {
    const [plain, enc] = line.split('\t').map((x) => x?.trim());
    if (plain && enc) map.set(plain, enc);
  }
  return map;
}

async function set() {
  const c = ensureDirs();
  await withLock('set', async () => {
    const id = newId();
    const dir = join(c.sets, id);
    const cache = loadHashCache();
    try {
      if (psql('SHOW archive_mode') !== 'on') throw new Error('архив журнала выключен');
      let info = ensureStanza();
      if (!(info?.backup ?? []).length) {
        console.log('копий базы ещё нет — сначала полная');
        await db();
        info = backupInfo();
      }
      mkdirSync(dir, { recursive: true });
      const network = standNetwork();

      // --- момент T: запись в журнал, LSN после неё, переключение сегмента.
      // txid_current() фиксирует транзакцию — в журнале появляется запись,
      // и сегмент с T закроется переключением, даже если база простаивала.
      // Отдельными запросами: несколько команд в одной строке psql идут одной
      // транзакцией, и LSN снимался бы до её фиксации.
      const txid = psql('SELECT txid_current()');
      const [at, lsn, walfile] = psql(
        `SELECT (to_json(now())#>>'{}') || '|' || pg_current_wal_lsn() || '|' || pg_walfile_name(pg_current_wal_lsn())`,
      ).split('|');
      psql('SELECT pg_switch_wal()');
      const deadline = Date.now() + 180_000;
      for (;;) {
        const archived = psql("SELECT coalesce(last_archived_wal, '') FROM pg_stat_archiver");
        const repoMax = backupInfo()?.archive?.at(-1)?.max ?? '';
        if (archived >= walfile && repoMax >= walfile) break;
        if (Date.now() > deadline) {
          throw new Error(`сегмент журнала ${walfile} не дошёл до хранилища за 3 минуты`);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      info = backupInfo();
      const base = [...info.backup].reverse().find((b) => lsnLe(b.lsn.stop, lsn));
      if (!base) throw new Error('нет копии базы, завершённой до T');

      // --- снимок сводок pgBackRest — под блокировкой задания копии базы,
      // чтобы не захватить их посреди обновления. Копия базы бывает долгой:
      // ждём до 50 минут, дальше — отказ с понятной причиной.
      const meta = await withLock(
        'db',
        () =>
          snapshotMeta(c.dir, id, () =>
            (backupInfo()?.backup ?? []).some((b) => b.label === base.label),
          ),
        {
          waitMs: 50 * 60_000,
        },
      );

      // --- файлы на T: что новое, что изменилось.
      const atT = listSource(network);
      // Только для опыта гонки «перезапись между списком и чтением» на стенде.
      const pause = Number(process.env.BACKUP_TEST_PAUSE_AFTER_LIST_MS || 0);
      if (pause) await new Promise((r) => setTimeout(r, pause));
      const index = readIndex();
      const plan = planObjects(index, atT);
      // Другая метка версии (ETag) ещё не значит другое содержимое: при
      // переносе хранилища объект, записанный в MinIO по частям, получает в
      // Garage ETag-MD5 (переход 03.11, control/probe-v1). Решает SHA-256
      // содержимого источника против сохранённого в копии.
      if (plan.immutableChanged.length) {
        const sums = sourceSha256(
          plan.immutableChanged.map((o) => o.key),
          network,
          id,
        );
        const sameContent = plan.immutableChanged.filter(
          (o) => sums.get(o.key) && sums.get(o.key) === index.get(o.key)?.sha256,
        );
        if (sameContent.length) {
          console.log(
            `метка версии другая, содержимое то же (SHA-256): ${sameContent.length} — копия не повторяется`,
          );
          // Новая метка — в индекс: следующие запуски не скачивают объект снова.
          appendIndex(
            sameContent.map((o) => ({
              ...index.get(o.key),
              size: o.size,
              version: objectVersion(o),
            })),
          );
        }
        plan.immutableChanged = plan.immutableChanged.filter((o) => !sameContent.includes(o));
      }
      if (plan.immutableChanged.length) {
        throw new Error(
          `готовый объект изменился под прежним ключом (2.1.2), прежняя копия сохранена: ` +
            plan.immutableChanged
              .slice(0, 3)
              .map((o) => o.key)
              .join(', '),
        );
      }
      const toSave = [...plan.fresh, ...plan.mutableChanged].map((o) => ({
        ...o,
        version: objectVersion(o),
        backupPath: backupPathOf(c.bucket, o.key, objectVersion(o)),
      }));
      assertSpace(
        toSave.reduce((n, o) => n + o.size, 0),
        'копия файлов',
      );
      copyVersions(toSave, network, id);
      if (toSave.length) {
        // Скопировано ли именно то, что было в списке: MD5 копии против MD5
        // версии, без MD5 — версия источника после копирования. Несовпадение:
        // только что записанный путь удаляется (в индексе его нет — это не
        // прежняя версия), комплект не выдаётся; следующий запуск снимет заново.
        const md5 = hashBackup(
          toSave.map((o) => o.backupPath),
          network,
          `${id}-md5`,
          'md5',
        );
        const relisted = toSave.some((o) => !o.md5)
          ? new Map(listSource(network).map((o) => [o.key, o]))
          : new Map();
        const wrong = copiedVersionProblems(toSave, md5, relisted);
        if (wrong.length) {
          const known = indexedPaths();
          const drop = wrong.filter((o) => !known.has(o.backupPath)).map((o) => o.backupPath);
          if (drop.length) {
            writeFileSync(join(c.state, `drop-${id}.txt`), drop.join('\n') + '\n');
            rclone(
              ['delete', 'DST:', '--rmdirs', '--files-from-raw', `/backup/state/drop-${id}.txt`],
              {
                network,
                allowFail: true,
              },
            );
          }
          throw new Error(
            'объект изменился во время копирования — комплект не выдан, повтор при следующем запуске: ' +
              wrong
                .slice(0, 3)
                .map((o) => o.key)
                .join(', '),
          );
        }
        const sums = hashBackup(
          toSave.map((o) => o.backupPath),
          network,
          id,
        );
        const enc = encryptedPaths(
          toSave.map((o) => o.backupPath),
          network,
          id,
        );
        appendIndex(
          toSave.map((o) => {
            const sha256 = sums.get(o.backupPath);
            const encPath = enc.get(o.backupPath);
            if (!sha256 || !encPath) throw new Error(`версия не сохранена в копии: ${o.key}`);
            return {
              key: o.key,
              size: o.size,
              version: o.version,
              sha256,
              backupPath: o.backupPath,
              encPath,
              firstSeen: at,
            };
          }),
        );
      }
      const saved = readIndex();
      const objects = atT.map((o) => {
        const row = saved.get(o.key);
        return {
          key: o.key,
          size: o.size,
          sha256: row?.sha256 ?? null,
          backupPath: row?.backupPath ?? null,
          encPath: row?.encPath ?? null,
        };
      });

      // --- ключи и конфигурация.
      const fingerprint = ensureKeyBundle();
      const config = snapshotConfig(join(dir, 'config'));
      // Снимок OpenBao без Static seal key: тот хранится отдельно, у Томаса.
      // Отказ OpenBao не лишает комплект базы и файлов: он отмечается ограничением.
      let openbao = null;
      let openbaoError = null;
      try {
        openbao = await openbaoSnapshot(join(dir, 'openbao.snap'));
      } catch (e) {
        openbaoError = e.message;
      }

      // --- незавершённые загрузки (2.1.2): их временные файлы — часть комплекта.
      const pending = psql(
        `SELECT coalesce(json_agg(json_build_object('id', id, 'state', upload_state, 'key', upload_key)), '[]')
           FROM lab.project_materials
          WHERE upload_state IN ('pending', 'needs_attention') AND upload_key IS NOT NULL`,
      );

      // --- цепочка базы: основа, её зависимости и журнал до T.
      const archiveId = info.archive.at(-1).id;
      const references = base.reference ?? [];
      const walPaths = walSegments(base.archive.start, walfile)
        .map((seg) => walFile(c.dir, archiveId, seg))
        .filter(Boolean);
      const manifest = buildManifest(
        c.dir,
        [
          ...[base.label, ...references].map((l) => `pgbackrest/backup/main/${l}`),
          meta,
          ...walPaths,
          ...objects.filter((o) => o.encPath).map((o) => `files/${o.encPath}`),
          `keys/${fingerprint}.env.gpg`,
          `sets/${id}/config`,
          ...(openbao ? [`sets/${id}/openbao.snap`] : []),
        ],
        cache,
      );

      const catalog = {
        id,
        format: 2,
        at: new Date(at).toISOString(),
        // txid зафиксированной на T транзакции: восстановленная база обязана
        // её знать — так проверяется, что восстановление дошло до T.
        target: { type: 'lsn', lsn, walfile, txid },
        db: {
          stanza: 'main',
          backup: base.label,
          references,
          backupStop: new Date(base.timestamp.stop * 1000).toISOString(),
          archiveStart: base.archive.start,
          archiveMax: info.archive.at(-1).max,
          archiveId,
          // Свой снимок сводок: скачивание и восстановление берут его, а не
          // общие файлы, которые переписывает каждая следующая копия базы.
          meta,
        },
        files: {
          bucket: c.bucket,
          count: objects.length,
          bytes: objects.reduce((n, o) => n + o.size, 0),
          objects,
        },
        pendingUploads: JSON.parse(pending),
        keys: { fingerprint, file: `keys/${fingerprint}.env.gpg` },
        openbao: openbao ? { file: `sets/${id}/openbao.snap` } : { error: openbaoError },
        config: {
          commit: config.commit,
          commitError: config.commitError,
          images: config.images,
          natsStreams: config.nats,
        },
        manifest,
      };
      catalog.limitations = setLimitations(catalog);

      // --- проверка частей: только после неё комплект пригоден. Каждый уже
      // сохранённый файл сверяется с хешем его ПЕРВОЙ проверки — порча до этой
      // сборки не становится новым эталоном.
      const ledger = loadLedger();
      const problems = [
        ...verifyCatalog(catalog, c.dir, { cache }),
        ...ledgerProblems(manifest, ledger),
      ];
      writeFileSync(join(dir, 'catalog.json'), JSON.stringify(catalog, null, 2));
      if (problems.length) throw new Error(`комплект неполон: ${problems.slice(0, 5).join('; ')}`);
      // Сначала эталон, потом публикация: авария между ними не оставит
      // готовый комплект без записанных исходных хешей.
      saveLedger(ledgerAdd(manifest, ledger));
      writeFileSync(join(dir, 'READY'), new Date().toISOString());
      recordJob('set', true, {
        lastSet: id,
        lastAt: catalog.at,
        files: objects.length,
        limitations: catalog.limitations,
      });
      console.log(
        `комплект ${id} пригоден: T=${catalog.at}, база ${base.label}, файлов ${objects.length}, ` +
          `в описи ${manifest.length}, код ${catalog.config.commit ?? '—'}`,
      );
      for (const l of catalog.limitations) console.error(`НЕПОЛНЫЙ комплект ${id}: ${l}`);
    } catch (error) {
      recordJob('set', false, { lastError: String(error.message ?? error) });
      throw error;
    } finally {
      saveHashCache(cache);
    }
  });
}

/** LSN «X/Y» — сравнение как чисел. */
function lsnLe(a, b) {
  const n = (s) => {
    const [hi, lo] = s.split('/');
    return BigInt(`0x${hi}`) * 2n ** 32n + BigInt(`0x${lo}`);
  };
  return n(a) <= n(b);
}

// ------------------------------------------------------------------- check

async function check() {
  const c = ensureDirs();
  const out = [];
  const say = async (key, problem, text) => {
    await signal(key, problem, text);
    out.push(`${problem ? 'ПРОБЛЕМА' : 'ok      '} ${key}: ${text}`);
  };

  await say(
    'secrets',
    Boolean(secretsError),
    secretsError ? secretsError.message : 'файлы секретов читаются',
  );

  // Пилотная среда: копия на сервере и её вынос. Где пилотной среды нет, сигналов нет.
  const pilotState = (name) => {
    const file = join(PILOT_STATE, name);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  };
  const hoursSince = (at) => (Date.now() - Date.parse(at)) / 3_600_000;
  const pilot = pilotState('pilot-backup.json');
  if (pilot) {
    const age = hoursSince(pilot.at);
    await say(
      'pilot-backup',
      !pilot.ok || age > PILOT_BACKUP_HOURS,
      pilot.ok
        ? `копия пилотной среды ${Math.round(age)} ч назад`
        : `копия пилотной среды: ${pilot.detail}`,
    );
    const offsite = pilotState('pilot-offsite.json');
    const offsiteAge = offsite ? hoursSince(offsite.at) : Infinity;
    await say(
      'pilot-offsite',
      offsiteAge > PILOT_OFFSITE_HOURS,
      offsite
        ? `копия вне сервера ${Math.round(offsiteAge)} ч назад`
        : 'копия пилотной среды ни разу не вынесена с сервера',
    );
  }

  // Выгрузка журнала аудита (2.1.5) по средам: на сервере каждый час, вне сервера — ноутбук
  // Томаса. Покрытие — по времени проверки последней порции, а не по наличию файла. Где
  // выгрузка среды не включена, сигналов этой среды нет.
  for (const envId of ['prod', 'test-2']) {
    const audit = pilotState(`audit-export-${envId}.json`);
    if (!audit) continue;
    const covered = audit.coveredUntil ?? null;
    const age = covered ? hoursSince(covered) : Infinity;
    await say(
      `audit-export-${envId}`,
      !audit.ok || age > AUDIT_EXPORT_HOURS,
      audit.ok
        ? `выгрузка аудита ${envId} покрывает до ${covered} (${age.toFixed(1)} ч назад)`
        : `выгрузка аудита ${envId} не удалась: ${audit.detail}`,
    );
    const offsite = pilotState(`audit-offsite-${envId}.json`);
    const offAge = offsite?.coveredUntil ? hoursSince(offsite.coveredUntil) : Infinity;
    await say(
      `audit-offsite-${envId}`,
      offAge > AUDIT_OFFSITE_HOURS,
      offsite
        ? `выгрузка аудита ${envId} вне сервера покрывает до ${offsite.coveredUntil} (${offAge.toFixed(1)} ч назад)`
        : `выгрузка аудита ${envId} ни разу не вынесена с сервера`,
    );
  }

  // Диск: предупреждение раньше, чем запрет начинать задания.
  const d = diskInfo();
  await say(
    'disk',
    d.freePercent < c.warnPercent || d.free < d.reserve,
    // Причина — в самом сигнале: какой порог нарушен (замечание Томаса по
    // первому сообщению «⚠️» без объяснения).
    d.free < d.reserve
      ? `мало места на диске копий: свободно ${gb(d.free)} — меньше запаса ${gb(d.reserve)}, новые копии не начинаются`
      : d.freePercent < c.warnPercent
        ? `место на диске копий заканчивается: свободно ${d.freePercent.toFixed(0)}% (${gb(d.free)}) — ниже порога ${c.warnPercent}%`
        : `место на диске копий в норме: свободно ${gb(d.free)} (${d.freePercent.toFixed(0)}%), запас ${gb(d.reserve)}`,
  );

  // Журнал (WAL): своё обнаружение, не через «свежесть комплекта».
  try {
    const mode = psql('SHOW archive_mode');
    if (mode !== 'on') {
      await say('wal', true, 'архив журнала выключен');
    } else {
      const [failedAt, archivedAt, archived, current] = psql(
        `SELECT coalesce(last_failed_time::text,''), coalesce(last_archived_time::text,''),
                coalesce(last_archived_wal,''), pg_walfile_name(pg_current_wal_lsn()) FROM pg_stat_archiver`,
      ).split('|');
      const repoMax = backupInfo()?.archive?.at(-1)?.max ?? '';
      const failing = failedAt && (!archivedAt || failedAt > archivedAt);
      const lag = archived && current ? segNo(current) - segNo(archived) : 0;
      // Принятый архиватором, но не дошедший до хранилища журнал —
      // сброс очереди при переполнении (archive-push-queue-max): разрыв.
      const notInRepo = archived && repoMax && segNo(archived) - segNo(repoMax) > 1;
      await say(
        'wal',
        Boolean(failing || lag > 3 || notInRepo),
        failing
          ? `архивация журнала отказывает с ${failedAt}`
          : notInRepo
            ? `журнал не дошёл до хранилища: принят ${archived}, в хранилище ${repoMax} — возможен разрыв`
            : lag > 3
              ? `отставание архива журнала: ${lag} сегментов`
              : `журнал архивируется, последний ${archived || '—'}`,
      );
    }
  } catch (error) {
    await say('wal', true, `база недоступна для проверки журнала: ${error.message}`);
  }

  // Разрыв журнала после последней основы: такая неисправность не проходит
  // сама с появлением новых сегментов — только с новой копией базы.
  try {
    const inf = backupInfo();
    const lastBase = inf?.backup?.at(-1);
    const repoMax = inf?.archive?.at(-1)?.max;
    if (lastBase && repoMax) {
      const segs = walSegments(lastBase.archive.start, repoMax);
      const missing = segs.filter((seg) => !walFile(c.dir, inf.archive.at(-1).id, seg));
      await say(
        'wal-chain',
        missing.length > 0,
        missing.length
          ? `разрыв журнала после копии ${lastBase.label}: нет ${missing.length} сегментов (${missing[0]}…) — нужна новая копия базы`
          : `журнал непрерывен от копии ${lastBase.label} до ${repoMax}`,
      );
    }
  } catch (error) {
    await say('wal-chain', true, `цепочка журнала не проверена: ${error.message}`);
  }

  // Копии базы: полная — не старше 8 суток, любая — не старше 26 часов.
  const info = backupInfo();
  const backups = info?.backup ?? [];
  const now = Date.now() / 1000;
  const lastFull = backups.filter((b) => b.type === 'full').at(-1);
  const lastAny = backups.at(-1);
  await say(
    'db-full',
    !lastFull || now - lastFull.timestamp.stop > 8 * 86400,
    lastFull ? `полная копия ${lastFull.label}` : 'полной копии базы нет',
  );
  await say(
    'db-backup',
    !lastAny || now - lastAny.timestamp.stop > 26 * 3600,
    lastAny ? `последняя копия базы ${lastAny.label}` : 'копий базы нет',
  );
  const jobDb = readState('job-db');
  await say(
    'job-db',
    jobDb ? !jobDb.lastOk : false,
    jobDb?.lastOk === false ? jobDb.lastError : 'задание копии базы без ошибок',
  );

  // Файлы и комплект: ежечасно; тревога — без пригодного комплекта 2,5 часа.
  const jobSet = readState('job-set');
  await say(
    'job-set',
    jobSet ? !jobSet.lastOk : false,
    jobSet?.lastOk === false ? jobSet.lastError : 'задание комплекта без ошибок',
  );
  const lastReady = readySets()[0];
  const readyAt = lastReady
    ? JSON.parse(readFileSync(join(c.sets, lastReady, 'catalog.json'), 'utf8')).at
    : null;
  await say(
    'set',
    !readyAt || Date.now() - Date.parse(readyAt) > 150 * 60_000,
    readyAt
      ? `последний пригодный комплект ${lastReady} (T=${readyAt})`
      : 'пригодных комплектов нет',
  );
  // Данные целы, но сведений не хватает: отдельный сигнал, не «всё в порядке».
  if (lastReady) {
    const limits = setLimitations(
      JSON.parse(readFileSync(join(c.sets, lastReady, 'catalog.json'), 'utf8')),
    );
    await say(
      'set-meta',
      limits.length > 0,
      limits.length
        ? `комплект ${lastReady} неполный: ${limits.join('; ')}`
        : `сведения комплекта ${lastReady} полные`,
    );
  }

  // Ключи: без открытого ключа получателя комплект ключей не обновится.
  await say(
    'keys',
    !existsSync(c.recipient),
    existsSync(c.recipient)
      ? 'открытый ключ получателя на месте'
      : 'нет открытого ключа получателя комплекта ключей',
  );

  const tg = Boolean(process.env.BACKUP_TELEGRAM_BOT_TOKEN && process.env.BACKUP_TELEGRAM_CHAT_ID);
  out.push(
    `${tg ? 'ok      ' : 'ВНИМАНИЕ'} telegram: ${tg ? 'настроен' : 'не настроен — сигналы только в журнале'}`,
  );
  writeState('last-check', { at: new Date().toISOString(), lines: out });
  console.log(out.join('\n'));
}

function status() {
  const c = cfg();
  const last = readState('last-check');
  console.log(`каталог копий: ${c.dir}`);
  console.log(
    `пригодных комплектов: ${readySets().length}${readySets()[0] ? `, последний ${readySets()[0]}` : ''}`,
  );
  for (const job of ['db', 'set']) {
    const s = readState(`job-${job}`);
    console.log(
      `задание ${job}: ${s ? `${s.lastOk ? 'успех' : 'ОШИБКА'} ${s.lastRunAt}${s.lastOk ? '' : ` — ${s.lastError}`}` : 'не запускалось'}`,
    );
  }
  if (last) console.log(`\nпоследняя проверка ${last.at}:\n${last.lines.join('\n')}`);
}

// -------------------------------------------------------------------- pull

/**
 * Скачать последний пригодный комплект — ровно файлы его описи и каталог.
 * С сервера — по ssh потоком tar; на одной машине — `--from-dir`.
 *
 * «Скачан и сверен» пишется только после пересчёта SHA-256 КАЖДОГО файла
 * описи на месте и проверки цепочки журнала (замечание Тэнка при приёмке
 * W07): подмена файла с тем же размером ловится уже здесь, без ключей.
 */
async function pull() {
  const fromDir = option('--from-dir');
  const dest = resolve(option('--to') || join(ROOT, '.local', 'backup-pull'));
  let id;
  let catalog;
  const parts = (cat) => [
    ...cat.manifest.map((m) => m.path),
    `sets/${cat.id}/catalog.json`,
    `sets/${cat.id}/READY`,
  ];
  if (fromDir) {
    const src = resolve(fromDir);
    id =
      option('--set') ??
      readdirSync(join(src, 'sets'))
        .filter((s) => existsSync(join(src, 'sets', s, 'READY')))
        .sort()
        .pop();
    if (!id || !existsSync(join(src, 'sets', id, 'READY'))) {
      throw new Error(`пригодного комплекта ${id ?? ''} нет`);
    }
    catalog = JSON.parse(readFileSync(join(src, 'sets', id, 'catalog.json'), 'utf8'));
    if (!catalog.manifest || !catalog.db.meta) {
      throw new Error(`у комплекта ${id} нет описи или снимка сводок (старый формат)`);
    }
    for (const p of parts(catalog)) {
      mkdirSync(dirname(join(dest, id, p)), { recursive: true });
      copyFileSync(join(src, p), join(dest, id, p));
    }
  } else {
    // На сервере maus: только обёртка, список файлов она берёт из описи сама.
    const READ = 'sudo -n /usr/local/sbin/fifth-backup-read';
    const ssh = (cmd) =>
      execFileSync('ssh', ['-i', VPS_KEY, '-o', 'BatchMode=yes', VPS, `${READ} ${cmd}`], {
        encoding: 'utf8',
      });
    const wanted = option('--set');
    if (wanted && !/^[0-9TZ]+-[0-9a-f]+$/.test(wanted)) throw new Error('неверный --set');
    id = ssh(wanted ? `has ${wanted}` : 'latest').trim();
    if (!id) throw new Error('на сервере пригодного комплекта нет');
    catalog = JSON.parse(ssh(`catalog ${id}`));
    if (!catalog.manifest || !catalog.db.meta) {
      throw new Error(`у комплекта ${id} нет описи или снимка сводок (старый формат)`);
    }
    mkdirSync(join(dest, id), { recursive: true });
    const remote = spawn('ssh', ['-i', VPS_KEY, '-o', 'BatchMode=yes', VPS, `${READ} tar ${id}`], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    // Каталог — рабочей папкой, не аргументом -C: GNU tar из Git для Windows
    // принимает «D:\…» за адрес удалённой машины.
    const local = spawn('tar', ['-xf', '-'], {
      cwd: join(dest, id),
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    // Распаковка упала — ssh не должен остаться ждать.
    local.on('close', (code) => {
      if (code !== 0) remote.kill();
    });
    remote.stdout.pipe(local.stdin);
    const codes = await Promise.all(
      [remote, local].map((p) => new Promise((r) => p.on('close', r))),
    );
    if (codes.some((code) => code !== 0)) throw new Error('скачивание оборвалось');
  }
  const root = join(dest, id);
  console.log(`сверяю ${catalog.manifest.length} файлов описи…`);
  const problems = verifyCatalog(catalog, root);
  writeFileSync(
    join(root, 'PULLED.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        from: fromDir ? 'каталог' : VPS,
        files: catalog.manifest.length,
        problems,
      },
      null,
      2,
    ),
  );
  if (problems.length) {
    throw new Error(`скачанный комплект не сошёлся с описью: ${problems.slice(0, 5).join('; ')}`);
  }
  // Сводки pgBackRest — из снимка этого комплекта, на штатные места.
  materializeMeta(root, catalog);
  console.log(`комплект ${id} скачан и сверен (SHA-256 каждого файла описи): ${root}`);
  for (const l of setLimitations(catalog)) console.log(`ОГРАНИЧЕНИЕ комплекта ${id}: ${l}`);
  return root;
}

// ------------------------------------------------------------------- вызов

const commands = {
  'init-secrets': initSecrets,
  'keys-init': keysInit,
  'keys-check': keysCheck,
  'openbao-keys': openbaoKeys,
  'openbao-keys-check': openbaoKeysCheck,
  db,
  set,
  check,
  status,
  pull,
};
const run = commands[command];
if (!run) {
  console.error(`команды: ${Object.keys(commands).join(', ')}`);
  process.exit(2);
}
try {
  if (secretsError && command !== 'check' && command !== 'status') {
    if (command === 'db' || command === 'set') {
      recordJob(command, false, { lastError: secretsError.message });
    }
    throw secretsError;
  }
  await run();
} catch (error) {
  console.error(`ОШИБКА: ${error.message ?? error}`);
  process.exit(1);
}
