/**
 * Резервирование стенда (блок 7, 2.1-W07) — общая часть команд.
 *
 * Что здесь и почему так:
 *
 * - База — pgBackRest внутри контейнера PostgreSQL: полные и добавочные
 *   копии, непрерывный архив журнала (WAL). Хранилище копий — каталог узла
 *   `BACKUP_DIR/pgbackrest`, смонтированный в контейнер.
 * - Файлы — rclone из рабочего бакета под учёткой «только чтение» в
 *   шифрованный каталог `BACKUP_DIR/files`. Только `copy --immutable`:
 *   удалённое в источнике остаётся в копии, изменившийся под прежним ключом
 *   объект — ошибка, а не тихая перезапись прежней копии (7.3).
 * - Ключи — весь `.env` стенда (в нём и ключи шифрования полей, и пароли
 *   копий), зашифрованный открытым ключом Томаса (gpg). Закрытый ключ на
 *   сервере не хранится: комплект ключей не открывается одним сервером.
 * - Комплект на момент T — каталог `sets/<id>`: метка копии базы и LSN на T
 *   (восстановление на T, а не «на дату копии»), объекты бакета на T с
 *   размером и SHA-256, отпечаток комплекта ключей, несекретная конфигурация.
 *   Пригодным комплект становится только после проверки всех частей — файл
 *   READY; команда скачивания берёт только такие.
 *
 * Инструменты (pgBackRest, rclone, gpg) — из образа базы `fifth/postgres:16`:
 * одна версия и на сервере, и на площадке проверки.
 *
 * Секреты не печатаются: в контейнеры уходят переменными окружения процесса
 * docker (`-e ИМЯ` без значения), а не аргументами.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  lstatSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySecretFiles } from './secret-files.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TOOL_IMAGE = 'fifth/postgres:16';
/**
 * Контейнер, который видит расшифрованные ключи: корень только для чтения, писать можно лишь в
 * /secure, а это память. Закрытый ключ и значения на диск Docker не попадают.
 */
export const MEMORY_ONLY = [
  '--read-only',
  '--tmpfs',
  '/secure:rw,nosuid,nodev,noexec,size=32m,mode=0700',
  '--user',
  '0',
  '-e',
  'GNUPGHOME=/secure/gpg',
];
export const PG_CONTAINER = 'fifth-postgres';

// ----------------------------------------------------------------- окружение

export const ENV_PATH = join(ROOT, '.env');

/** Разбор `.env` в объект; файл не печатается. */
export function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[trimmed.slice(0, eq).trim()] = value;
  }
  // `<ИМЯ>_FILE`: значение в файле (блок 5, задание 2), правила те же, что у ядра.
  applySecretFiles(out);
  return out;
}

/**
 * Текст `.env` со значениями вместо `<ИМЯ>_FILE`. Комплект ключей хранит значения: файлы
 * секретов в него сами не попадут, а восстановлению нужен прежний формат.
 */
export function resolvedEnvText(path = ENV_PATH) {
  const full = parseEnvFile(path);
  return readFileSync(path, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^([A-Z0-9_]+)_FILE=.*$/gm, (line, name) =>
      full[name] === undefined ? line : `${name}=${full[name]}`,
    );
}

export function loadEnv() {
  const env = parseEnvFile(ENV_PATH);
  for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;
  return env;
}

export function cfg() {
  const dir = resolve(process.env.BACKUP_DIR || join(ROOT, '.local', 'backup-stand'));
  return {
    dir,
    repo: join(dir, 'pgbackrest'),
    files: join(dir, 'files'),
    index: join(dir, 'files-index.jsonl'),
    keys: join(dir, 'keys'),
    sets: join(dir, 'sets'),
    state: join(dir, 'state'),
    bucket: process.env.S3_BUCKET || 'unicorn-launch',
    recipient: process.env.BACKUP_KEYS_RECIPIENT
      ? resolve(process.env.BACKUP_KEYS_RECIPIENT)
      : join(dir, 'recipient.asc'),
    // Пороги места (7.3, замечание Тэнка): предупреждение и запрет начинать.
    warnPercent: Number(process.env.BACKUP_DISK_WARN_PERCENT || 25),
    reservePercent: Number(process.env.BACKUP_DISK_RESERVE_PERCENT || 15),
    reserveMinBytes: Number(process.env.BACKUP_DISK_RESERVE_MIN_GB || 10) * 1024 ** 3,
  };
}

/** Секрет ли переменная `.env` — по имени или по значению с паролем в URL. */
export function isSecretVar(name, value) {
  if (/(PASS|SECRET|KEY|TOKEN|KEK|PRIVATE|SALT|CREDENTIAL|SIGNING|DSN)/i.test(name)) return true;
  return /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/i.test(String(value ?? ''));
}

// --------------------------------------------------------------- исполнение

/** docker с выводом в строку; ошибка — исключение с хвостом stderr. */
export function docker(args, { env, input, allowFail = false, timeoutMs = 3_600_000 } = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    input,
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFail) {
    const tail = `${result.stderr || ''}${result.error ? String(result.error) : ''}`
      .trim()
      .split('\n')
      .slice(-6)
      .join('\n');
    throw new Error(`docker ${args.slice(0, 3).join(' ')}… → ${result.status}: ${tail}`);
  }
  return result;
}

/** Сеть compose стенда (по контейнеру базы — он есть при любом хранилище). */
export function standNetwork() {
  const out = docker([
    'inspect',
    PG_CONTAINER,
    '-f',
    '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}',
  ]).stdout.trim();
  return out.split(/\s+/)[0];
}

/** Команда pgBackRest в контейнере базы — окружение у него своё (compose). */
export function pgbackrest(args, opts = {}) {
  return docker(['exec', '-u', 'postgres', PG_CONTAINER, 'pgbackrest', ...args], opts);
}

export function psql(sql, { allowFail = false } = {}) {
  const r = docker(
    [
      'exec',
      '-i',
      PG_CONTAINER,
      'psql',
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
      '-U',
      'unicorn_owner',
      '-d',
      process.env.POSTGRES_DB || 'fifth_element',
    ],
    { input: sql, allowFail },
  );
  return r.stdout.trim();
}

/**
 * rclone в образе инструментов. Источник SRC — рабочий бакет Garage (ключ
 * только для чтения), DST — шифрованный каталог копий. Пароли шифрования
 * обфусцируются внутри контейнера из переменных окружения, в аргументы не
 * попадают.
 */
export function rclone(
  rcloneArgs,
  { network, mounts = [], extraEnv = {}, allowFail = false, body = 'exec rclone "$@"' } = {},
) {
  const c = cfg();
  // body — команда после настройки шифра; по умолчанию сам rclone с
  // аргументами, для серии copyto — короткий цикл sh.
  const script = [
    'set -e',
    'export RCLONE_CONFIG_DST_PASSWORD="$(printf %s "$BACKUP_FILES_CRYPT_PASS" | rclone obscure -)"',
    'export RCLONE_CONFIG_DST_PASSWORD2="$(printf %s "$BACKUP_FILES_CRYPT_SALT" | rclone obscure -)"',
    body,
  ].join('\n');
  const env = {
    RCLONE_CONFIG_SRC_TYPE: 's3',
    // Источник — ТОЛЬКО из настройки: адрес в сети стенда меняется в окне
    // переключения хранилища вместе с ключом (BACKUP_S3_SOURCE_ENDPOINT:
    // MinIO — http://minio:9000, Garage — http://garage-1:3900), а не
    // выкладкой кода. Провайдер Other — для обоих.
    RCLONE_CONFIG_SRC_PROVIDER: 'Other',
    RCLONE_CONFIG_SRC_ENDPOINT: process.env.BACKUP_S3_SOURCE_ENDPOINT || 'http://minio:9000',
    RCLONE_CONFIG_SRC_ACCESS_KEY_ID: process.env.BACKUP_S3_ACCESS_KEY_ID,
    RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY: process.env.BACKUP_S3_SECRET_ACCESS_KEY,
    RCLONE_CONFIG_SRC_REGION: process.env.S3_REGION || 'us-east-1',
    RCLONE_CONFIG_DST_TYPE: 'crypt',
    RCLONE_CONFIG_DST_REMOTE: '/backup/files',
    RCLONE_CONFIG_DST_FILENAME_ENCRYPTION: 'standard',
    RCLONE_CONFIG_DST_DIRECTORY_NAME_ENCRYPTION: 'true',
    BACKUP_FILES_CRYPT_PASS: process.env.BACKUP_FILES_CRYPT_PASS,
    BACKUP_FILES_CRYPT_SALT: process.env.BACKUP_FILES_CRYPT_SALT,
    ...extraEnv,
  };
  // От root: образ инструмента по умолчанию — пользователь postgres (999), а
  // каталог копий на VPS — root с правами 700. Без этого rclone не мог прочесть
  // список файлов и писать в /backup/files; скрыто, пока новых файлов не было
  // (первые появились при выпуске W08a 2026-11-02 — комплект 16:17 упал).
  const args = ['run', '--rm', '--user', '0:0', '--entrypoint', 'sh'];
  if (network) args.push('--network', network);
  args.push('-v', `${c.dir}:/backup`);
  for (const m of mounts) args.push('-v', m);
  for (const k of Object.keys(env)) args.push('-e', k);
  args.push(TOOL_IMAGE, '-c', script, 'rclone', ...rcloneArgs);
  return docker(args, { env, allowFail });
}

// ------------------------------------------------------------------ состояние

export function ensureDirs() {
  const c = cfg();
  for (const d of [c.dir, c.repo, c.files, c.keys, c.sets, c.state])
    mkdirSync(d, { recursive: true });
  return c;
}

export function readState(name) {
  const p = join(cfg().state, `${name}.json`);
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function writeState(name, value) {
  const p = join(cfg().state, `${name}.json`);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(`${p}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${p}.tmp`, p);
}

/** Итог задания: успех или ошибка — читает проверка. */
export function recordJob(name, ok, details = {}) {
  const prev = readState(`job-${name}`) ?? {};
  writeState(`job-${name}`, {
    ...prev,
    lastRunAt: new Date().toISOString(),
    lastOk: ok,
    ...(ok ? { lastSuccessAt: new Date().toISOString(), lastError: null } : {}),
    ...details,
  });
}

/**
 * Блокировка задания: два запуска одного задания не идут одновременно.
 * waitMs > 0 — ждать освобождения (комплект ждёт окончания копии базы).
 */
export async function withLock(name, fn, { waitMs = 0 } = {}) {
  const c = ensureDirs();
  const lock = join(c.state, `${name}.lock`);
  const deadline = Date.now() + waitMs;
  let fd;
  for (;;) {
    try {
      fd = takeLock(lock, name);
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

function takeLock(lock, name) {
  let fd;
  try {
    fd = openSync(lock, 'wx');
  } catch {
    const pid = Number(readFileSync(lock, 'utf8').trim());
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      /* процесса нет — блокировка осталась от упавшего запуска */
    }
    if (alive) throw new Error(`задание «${name}» уже идёт (pid ${pid})`);
    rmSync(lock, { force: true });
    fd = openSync(lock, 'wx');
  }
  return fd;
}

// --------------------------------------------------------------------- диск

/** Свободное место на диске копий. */
export function diskInfo() {
  const c = ensureDirs();
  const s = statfsSync(c.dir);
  const total = s.blocks * s.bsize;
  const free = s.bavail * s.bsize;
  const reserve = Math.max(c.reserveMinBytes, (total * c.reservePercent) / 100);
  return { total, free, freePercent: (free / total) * 100, reserve };
}

/**
 * Можно ли начать задание, которому нужно `needBytes`. Не удаляет ничего ради
 * места: старые пригодные комплекты без согласованного правила не трогаются.
 */
export function assertSpace(needBytes, what) {
  const d = diskInfo();
  if (d.free - needBytes < d.reserve) {
    throw new Error(
      `мало места для «${what}»: свободно ${gb(d.free)}, нужно ~${gb(needBytes)}, ` +
        `запас ${gb(d.reserve)} — задание не начато, прежние копии не тронуты`,
    );
  }
  return d;
}

export const gb = (n) => `${(n / 1024 ** 3).toFixed(2)} ГБ`;

// ------------------------------------------------------------------- ключи

/** Отпечаток комплекта ключей: SHA-256 содержимого `.env`. */
export function keysFingerprint() {
  return createHash('sha256').update(resolvedEnvText()).digest('hex').slice(0, 32);
}

/**
 * Зашифровать `.env` открытым ключом Томаса, если такого комплекта ещё нет.
 * Возвращает отпечаток. Без открытого ключа — ошибка: комплект без ключей
 * восстановить нельзя, и молчать об этом нельзя.
 */
export function ensureKeyBundle() {
  const c = ensureDirs();
  const fp = keysFingerprint();
  const target = join(c.keys, `${fp}.env.gpg`);
  if (existsSync(target)) return fp;
  if (!existsSync(c.recipient)) {
    throw new Error(
      `нет открытого ключа получателя комплекта ключей (${c.recipient}) — ` +
        'выполните `node scripts/backup.mjs keys-init` и передайте открытый ключ на стенд',
    );
  }
  const tmp = `${target}.tmp`;
  const r = docker(
    [
      'run',
      '--rm',
      '-i',
      '--entrypoint',
      'sh',
      '-v',
      `${c.recipient}:/in/recipient.asc:ro`,
      TOOL_IMAGE,
      '-c',
      'export GNUPGHOME=$(mktemp -d) && gpg -q --batch --import /in/recipient.asc 2>/dev/null && ' +
        'gpg -q --batch --trust-model always --encrypt --armor ' +
        '--recipient "$(gpg --batch --list-keys --with-colons | awk -F: \'/^fpr/{print $10; exit}\')" --output -',
    ],
    { input: Buffer.from(resolvedEnvText()) },
  );
  if (!r.stdout.includes('BEGIN PGP MESSAGE')) throw new Error('gpg не зашифровал комплект ключей');
  writeFileSync(tmp, r.stdout);
  renameSync(tmp, target);
  return fp;
}

// ------------------------------------------------------------- конфигурация

/** Несекретная конфигурация на момент комплекта; секреты — в комплекте ключей. */
export function snapshotConfig(targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const env = parseEnvFile(ENV_PATH);
  const lines = Object.entries(env).map(([k, v]) =>
    isSecretVar(k, v) ? `${k}=<секрет: в комплекте ключей>` : `${k}=${v}`,
  );
  writeFileSync(join(targetDir, 'env.public'), `${lines.join('\n')}\n`);

  const copy = (from, name) => {
    if (existsSync(from)) writeFileSync(join(targetDir, name), readFileSync(from));
  };
  copy(join(ROOT, 'infra', 'docker-compose.yml'), 'docker-compose.yml');
  copy(join(ROOT, 'infra', 'caddy', 'files.caddy'), 'files.caddy');
  copy('/etc/caddy/Caddyfile', 'Caddyfile');
  for (const unit of ['unicorn-core.service', 'unicorn-workers.service']) {
    copy(`/etc/systemd/system/${unit}`, unit);
  }
  const timers = '/etc/systemd/system';
  if (existsSync(timers)) {
    for (const f of readdirSync(timers)) {
      if (/^fifth-backup-.*\.(service|timer)$/.test(f)) copy(join(timers, f), f);
    }
  }

  // Версия кода — полный SHA или явная причина, почему её нет: пустая строка
  // выдавала неполный комплект за полный (комплекты 02.11 на VPS).
  let commit = null;
  let commitError = null;
  const git = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const sha = (git.stdout ?? '').trim();
  if (git.status === 0 && /^[0-9a-f]{40}$/.test(sha)) commit = sha;
  else {
    commitError =
      (git.error?.message ?? git.stderr ?? '').trim().split('\n')[0] ||
      `git rev-parse: код ${git.status}, ответ «${sha}»`;
  }
  const images = {};
  const ps = docker(['ps', '--format', '{{.Names}}'], { allowFail: true }).stdout.trim();
  for (const name of ps.split('\n').filter((n) => n.startsWith('unicorn-'))) {
    const r = docker(['inspect', name, '-f', '{{.Config.Image}} {{.Image}}'], { allowFail: true });
    const [image, id] = r.stdout.trim().split(' ');
    images[name] = { image, id };
  }
  // Конфигурация потоков NATS: при восстановлении поток создаётся пустым (7.1).
  let nats = null;
  const port = process.env.NATS_MONITOR_PORT || 8222;
  const r = spawnSync(
    'curl',
    ['-s', '-m', '5', `http://127.0.0.1:${port}/jsz?streams=true&config=true`],
    {
      encoding: 'utf8',
    },
  );
  if (r.status === 0 && r.stdout.trim().startsWith('{')) {
    try {
      const j = JSON.parse(r.stdout);
      nats = (j.account_details ?? []).flatMap((a) =>
        (a.stream_detail ?? []).map((s) => ({ name: s.name, config: s.config })),
      );
    } catch {
      /* монитор недоступен — отметим пустым */
    }
  }
  const meta = { commit, commitError, images, nats };
  writeFileSync(join(targetDir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

// ---------------------------------------------------------------- сигналы

/** Как часто повторять недоставленное сообщение. */
export const SIGNAL_RETRY_MS = 15 * 60_000;

/**
 * Состояние проверки и сообщение при смене: первое нарушение — сообщение,
 * повторы того же состояния — без шума, возврат к норме — «восстановилось».
 *
 * Недоставленное сообщение не теряется (замечание Тэнка при приёмке W07):
 * оно остаётся в очереди и повторяется не чаще раза в SIGNAL_RETRY_MS, пока
 * не дойдёт. Если состояние сменилось раньше, в очереди — новое сообщение.
 */
export async function signal(key, problem, text, { send = telegram, now = Date.now() } = {}) {
  const all = readState('signals') ?? {};
  const prev = all[key] ?? { status: 'ok' };
  const at = new Date(now).toISOString();
  const status = problem ? 'problem' : 'ok';
  let entry;
  if (status !== prev.status) {
    entry = {
      status,
      since: at,
      text,
      pending: problem
        ? `⚠️ Резервирование 5Э: ${text}`
        : `✅ Резервирование 5Э восстановилось: ${text}`,
      attempts: 0,
      lastAttemptAt: null,
      notified: false,
    };
  } else {
    entry = { ...prev, text, checkedAt: at };
  }
  const due =
    entry.pending &&
    (!entry.lastAttemptAt || now - Date.parse(entry.lastAttemptAt) >= SIGNAL_RETRY_MS);
  if (due) {
    entry.attempts = (entry.attempts ?? 0) + 1;
    entry.lastAttemptAt = at;
    const delivered = await send(entry.pending);
    if (delivered) {
      entry.notified = true;
      entry.notifiedAt = at;
      entry.pending = null;
    } else {
      console.warn(`[сигнал не доставлен, попытка ${entry.attempts}] ${entry.pending}`);
    }
  }
  all[key] = entry;
  writeState('signals', all);
  return entry;
}

/** Отправка в Telegram; без настроек — false (и это видно в статусе). */
export async function telegram(text) {
  const token = process.env.BACKUP_TELEGRAM_BOT_TOKEN;
  const chat = process.env.BACKUP_TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const host = process.env.HOSTNAME_LABEL || process.env.PUBLIC_BASE_URL || '';
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: host ? `${text}\n${host}` : text }),
      signal: AbortSignal.timeout(15_000),
    });
    return Boolean(r.ok);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ разное

export const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
export const newId = () =>
  `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z')}-${randomBytes(3).toString('hex')}`;

/**
 * Индекс файлов копии: ключ → последняя сохранённая версия
 * {key, size, version, sha256, backupPath, encPath, firstSeen}.
 */
export function readIndex() {
  const c = cfg();
  const map = new Map();
  if (!existsSync(c.index)) return map;
  for (const line of readFileSync(c.index, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    map.set(row.key, row);
  }
  return map;
}

export function appendIndex(rows) {
  if (!rows.length) return;
  const c = cfg();
  writeFileSync(c.index, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { flag: 'a' });
}

/** Готовые комплекты, новые первыми. */
export function readySets() {
  const c = cfg();
  if (!existsSync(c.sets)) return [];
  return readdirSync(c.sets)
    .filter((id) => existsSync(join(c.sets, id, 'READY')))
    .sort()
    .reverse();
}

// ------------------------------------------------------- объекты и версии

/**
 * Временный ключ формы загрузки — изменяемый: повторная отправка формы
 * перезаписывает его. Остальные (окончательные файлы, медиа) по 2.1.2 не
 * перезаписываются никогда.
 */
export const isMutableKey = (key) => key.endsWith('/upload');

/** Версия объекта источника: MD5 из ETag, иначе время изменения. */
export const objectVersion = (o) => o.md5 || o.modTime || '';

/** Путь версии в копии: неизменяемый — по ключу, изменяемый — по ключу и версии. */
export function backupPathOf(bucket, key, version) {
  if (!isMutableKey(key)) return `${bucket}/${key}`;
  const v =
    String(version)
      .replace(/[^0-9A-Za-z]/g, '')
      .slice(0, 40) || 'v';
  return `mutable/${v}/${bucket}/${key}`;
}

/**
 * Что делать с объектами источника по сравнению с индексом копии:
 * fresh — их нет в копии; mutableChanged — изменилась временная загрузка
 * (сохраняется новой версией рядом с прежней); immutableChanged — изменился
 * готовый объект под прежним ключом: нарушение 2.1.2, комплект не выдаётся,
 * прежняя копия не затирается.
 */
export function planObjects(index, current) {
  const fresh = [];
  const mutableChanged = [];
  const immutableChanged = [];
  for (const o of current) {
    const last = index.get(o.key);
    if (!last) {
      fresh.push(o);
      continue;
    }
    const v = objectVersion(o);
    const changed = last.size !== o.size || Boolean(v && last.version && v !== last.version);
    if (!changed) continue;
    if (isMutableKey(o.key)) mutableChanged.push(o);
    else immutableChanged.push(o);
  }
  return { fresh, mutableChanged, immutableChanged };
}

// ------------------------------------------------------- журнал базы (WAL)

/** Сегменты журнала от a до b включительно (одна линия времени, 16 МБ). */
export function walSegments(a, b) {
  if (a.slice(0, 8) !== b.slice(0, 8)) {
    throw new Error(`сегменты на разных линиях времени: ${a} … ${b}`);
  }
  const tl = a.slice(0, 8);
  const n = (w) => parseInt(w.slice(8, 16), 16) * 256 + parseInt(w.slice(16, 24), 16);
  const hex = (x) => x.toString(16).toUpperCase().padStart(8, '0');
  const out = [];
  for (let i = n(a); i <= n(b); i += 1) out.push(`${tl}${hex(Math.floor(i / 256))}${hex(i % 256)}`);
  return out;
}

/** Файл сегмента в хранилище pgBackRest (относительно корня копий) или null. */
export function walFile(dir, archiveId, seg) {
  const sub = `pgbackrest/archive/main/${archiveId}/${seg.slice(0, 16)}`;
  const abs = join(dir, sub);
  if (!existsSync(abs)) return null;
  const f = readdirSync(abs).find((x) => x.startsWith(`${seg}-`));
  return f ? `${sub}/${f}` : null;
}

/**
 * Цепочка восстановления на T: основа и все копии, от которых она зависит
 * (добавочная → полная), их описи и КАЖДЫЙ сегмент журнала от начала основы
 * до сегмента T. Разрыв в середине — неисправность, даже если конечный
 * сегмент на месте: восстановление через него не пройдёт, пока не появится
 * новая основа (замечание Тэнка при приёмке W07).
 */
export function chainProblems(catalog, dir) {
  const problems = [];
  const backups = [catalog.db.backup, ...(catalog.db.references ?? [])];
  for (const label of new Set(backups)) {
    const b = join(dir, 'pgbackrest', 'backup', 'main', label);
    if (!existsSync(b)) problems.push(`нет копии базы ${label}`);
    else if (!existsSync(join(b, 'backup.manifest'))) {
      problems.push(`нет описи копии базы ${label}`);
    }
  }
  if (!catalog.db.archiveStart) {
    problems.push('в каталоге нет начала журнала основы');
    return problems;
  }
  let segs = [];
  try {
    segs = walSegments(catalog.db.archiveStart, catalog.target.walfile);
  } catch (error) {
    problems.push(error.message);
  }
  const missing = segs.filter((seg) => !walFile(dir, catalog.db.archiveId, seg));
  if (missing.length) {
    const head = missing.slice(0, 3).join(', ');
    problems.push(
      `разрыв журнала: нет ${missing.length} из ${segs.length} сегментов (${head}${missing.length > 3 ? ', …' : ''})`,
    );
  }
  return problems;
}

// ----------------------------------------------------- опись файлов комплекта

/** SHA-256 файла с запоминанием по пути, размеру и времени изменения. */
export function hashCached(abs, cache) {
  const st = statSync(abs);
  const id = `${abs}|${st.size}|${Math.floor(st.mtimeMs)}`;
  if (cache && cache[id]) return { size: st.size, sha256: cache[id] };
  const sha256 = sha256File(abs);
  if (cache) cache[id] = sha256;
  return { size: st.size, sha256 };
}

function listFilesRel(dir, rel) {
  const abs = join(dir, rel);
  if (!existsSync(abs)) return [rel];
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) return [];
  if (!st.isDirectory()) return [rel];
  return readdirSync(abs).flatMap((name) => listFilesRel(dir, `${rel}/${name}`));
}

/**
 * Опись комплекта: каждый файл, нужный для восстановления, с размером и
 * SHA-256. По ней сверяется и сам комплект перед READY, и скачанная копия —
 * без ключей расшифровки: хеш считается от того, что лежит на диске.
 */
export function buildManifest(dir, relPaths, cache) {
  const files = [...new Set(relPaths.flatMap((p) => listFilesRel(dir, p)))].sort();
  return files.map((path) => {
    const abs = join(dir, path);
    if (!existsSync(abs)) return { path, size: null, sha256: null };
    return { path, ...hashCached(abs, cache) };
  });
}

/** Расхождения с описью: нет файла, другой размер, другой SHA-256. */
export function manifestProblems(dir, manifest, { cache } = {}) {
  const problems = [];
  for (const m of manifest) {
    const abs = join(dir, m.path);
    if (!m.sha256 || !existsSync(abs)) {
      problems.push(`нет файла ${m.path}`);
      continue;
    }
    const got = hashCached(abs, cache);
    if (got.size !== m.size) problems.push(`другой размер ${m.path}`);
    else if (got.sha256 !== m.sha256) problems.push(`другое содержимое ${m.path}`);
  }
  return problems;
}

export const loadHashCache = () => readState('hash-cache') ?? {};
export const saveHashCache = (cache) => writeState('hash-cache', cache);

/**
 * Ограничения пригодного комплекта: чего в нём нет, хотя данные целы.
 * Такой комплект восстанавливает данные, но не выдаётся за полный. Старые
 * комплекты (до 2026-11-02 включительно) писали пустую строку вместо SHA.
 */
export function setLimitations(catalog) {
  const out = [];
  const commit = catalog.config?.commit;
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
    out.push(
      `версия кода не записана${catalog.config?.commitError ? `: ${catalog.config.commitError}` : ''}`,
    );
  }
  if (catalog.openbao?.error) out.push(`снимка OpenBao нет: ${catalog.openbao.error}`);
  return out;
}

/**
 * Пригодность комплекта: цепочка базы до T, опись (каждый файл на месте и с
 * тем же SHA-256), SHA-256 содержимого каждого объекта, комплект ключей.
 */
export function verifyCatalog(catalog, dir, { cache } = {}) {
  const problems = [...chainProblems(catalog, dir)];
  const inManifest = new Set((catalog.manifest ?? []).map((m) => m.path));
  if (!inManifest.size) problems.push('у комплекта нет описи файлов');
  else problems.push(...manifestProblems(dir, catalog.manifest, { cache }));
  if (!inManifest.has(catalog.keys.file)) problems.push('комплект ключей не в описи');
  for (const o of catalog.files.objects) {
    if (!o.sha256) problems.push(`нет SHA-256 содержимого: ${o.key}`);
    if (!o.encPath || !inManifest.has(`files/${o.encPath}`)) {
      problems.push(`файла нет в описи: ${o.key}`);
    }
  }
  return problems;
}

// ------------------------------------------------- реестр исходных хешей

/**
 * Файлы копий, которые штатно ПЕРЕПИСЫВАЮТСЯ: сводки pgBackRest. Остальное
 * (копии базы, сегменты журнала, зашифрованные файлы, комплекты ключей,
 * конфигурация комплекта) после записи не меняется никогда.
 */
export const isRewrittenBackupFile = (path) =>
  /^pgbackrest\/(backup|archive)\/main\/(backup|archive)\.info(\.copy)?$/.test(path);

/**
 * Реестр исходных хешей: путь → SHA-256 и размер на момент ПЕРВОЙ проверки,
 * вошедшей в пригодный комплект. Пересчёт описи сравнивается с ним, а не с
 * самим собой: испорченный после сохранения файл не становится новым эталоном
 * (замечание Тэнка при приёмке W07). Запись в реестр — только после READY.
 */
export const loadLedger = () => readState('ledger') ?? {};
export const saveLedger = (ledger) => writeState('ledger', ledger);

export function ledgerProblems(manifest, ledger) {
  const problems = [];
  for (const m of manifest) {
    if (isRewrittenBackupFile(m.path)) continue;
    const first = ledger[m.path];
    if (!first) continue;
    if (first.size !== m.size || first.sha256 !== m.sha256) {
      problems.push(`сохранённый файл изменился после первой проверки: ${m.path}`);
    }
  }
  return problems;
}

export function ledgerAdd(manifest, ledger, at = new Date().toISOString()) {
  for (const m of manifest) {
    if (isRewrittenBackupFile(m.path) || ledger[m.path] || !m.sha256) continue;
    ledger[m.path] = { size: m.size, sha256: m.sha256, at };
  }
  return ledger;
}

// ------------------------------------- соответствие копии версии источника

/**
 * Скопировано ли именно то, что было в списке. Копирование берёт объект по
 * ключу в момент чтения; если временную загрузку перезаписали между списком
 * и чтением, в путь версии A легла бы версия B (замечание Тэнка). MD5
 * содержимого копии сравнивается с MD5 версии из списка; без MD5 в источнике
 * (составная загрузка) — версия источника до и после копирования.
 */
export function copiedVersionProblems(saved, copiedMd5, relisted = new Map()) {
  const wrong = [];
  for (const o of saved) {
    if (o.md5) {
      const got = copiedMd5.get(o.backupPath);
      if (!got || got.toLowerCase() !== o.md5.toLowerCase()) wrong.push(o);
    } else {
      const after = relisted.get(o.key);
      if (!after || objectVersion(after) !== objectVersion(o) || after.size !== o.size) {
        wrong.push(o);
      }
    }
  }
  return wrong;
}

// ------------------------------------------- снимок сводок pgBackRest

/**
 * Сводки хранилища pgBackRest. Их переписывает каждая новая копия базы,
 * поэтому комплект ссылается не на общие файлы, а на свой снимок (замечание
 * Тэнка при приёмке W07): иначе после очередной копии прежний пригодный
 * комплект переставал бы сходиться с описью.
 */
export const META_FILES = [
  'backup/main/backup.info',
  'backup/main/backup.info.copy',
  'archive/main/archive.info',
  'archive/main/archive.info.copy',
];

/**
 * Снять сводки в каталог комплекта (`sets/<id>/meta/…`). Вызывать под
 * блокировкой задания копии базы — тогда сводки не меняются между проверкой
 * и снятием. Сводки зашифрованы, поэтому «знают ли они основу комплекта»
 * проверяет вызывающий (pgBackRest info) — функция knowsBase.
 */
export function snapshotMeta(dir, setId, knowsBase) {
  if (!knowsBase()) throw new Error('сводки pgBackRest не знают основу комплекта');
  const rel = `sets/${setId}/meta`;
  for (const f of META_FILES) {
    const from = join(dir, 'pgbackrest', f);
    if (!existsSync(from)) throw new Error(`нет сводки pgBackRest ${f}`);
    const to = join(dir, rel, f);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(from));
  }
  return rel;
}

/** Разложить снимок сводок комплекта на штатные места скачанной копии. */
export function materializeMeta(root, catalog) {
  if (!catalog.db.meta) throw new Error('у комплекта нет снимка сводок (старый формат)');
  for (const f of META_FILES) {
    const to = join(root, 'pgbackrest', f);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(join(root, catalog.db.meta, f)));
  }
}
