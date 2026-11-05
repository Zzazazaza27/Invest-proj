#!/usr/bin/env node
/**
 * Проверка восстановления из скачанного комплекта (блок 7, 7.7; 2.1-W07).
 *
 * Локальное испытание МЕХАНИЗМА, а не приёмка по 2.1.4: та — после
 * подключения независимого хранилища, без исходного VPS.
 *
 * Берёт только скачанный каталог комплекта (`backup.mjs pull`) и закрытый
 * ключ из KeePassXC (файлы `--secret-key`, `--passphrase-file`). К стенду, с
 * которого комплект снят, не обращается: ни ssh, ни адресов исходной
 * площадки — окружение ядра переписывается на свои контейнеры, а любой
 * оставшийся внешний адрес останавливает проверку.
 *
 * Что проверяется:
 *  1. комплект ключей открывается закрытым ключом;
 *  2. база восстанавливается на момент T (LSN), транзакция T в ней есть;
 *  3. файлы расшифровываются в чистое хранилище, SHA-256 каждого — как в каталоге;
 *  4. ядро стартует на восстановленных базе, файлах и ключах;
 *  5. шифрованные поля всех учётных записей открываются, слепой индекс email сходится;
 *  6. вход по API и чтение своего профиля (email расшифрован ядром);
 *  7. готовые материалы ссылаются на существующие файлы; незавершённые
 *     загрузки не стали «готовыми» без файла.
 *
 * Площадка временная: свои контейнеры, тома и сеть, удаляются в конце.
 * Внешние действия выключены: почта none, вебхуки capture, без NATS и Valkey.
 *
 *   node scripts/check-backup-restore.mjs [--from <каталог комплекта>]
 *        [--secret-key <файл>] [--passphrase-file <файл>] [--keep]
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { ROOT, TOOL_IMAGE, docker } from './lib/backup.mjs';
import { GARAGE_IMAGE, garageKeyPair } from './lib/garage-admin.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const PULL = join(ROOT, '.local', 'backup-pull');
const from = resolve(
  opt(
    '--from',
    existsSync(PULL)
      ? join(
          PULL,
          readdirSync(PULL)
            .filter((d) => existsSync(join(PULL, d, 'PULLED.json')))
            .sort()
            .pop() ?? '',
        )
      : '',
  ),
);
const secretKey = resolve(
  opt('--secret-key', join(ROOT, '.local', 'backup-keys-local-stand', 'secret-key.asc')),
);
const passphraseFile = resolve(
  opt('--passphrase-file', join(ROOT, '.local', 'backup-keys-local-stand', 'passphrase.txt')),
);
const keep = args.includes('--keep');

const tag = randomBytes(3).toString('hex');
const NET = `fifth-restore-${tag}`;
const PG = `fifth-restore-pg-${tag}`;
const S3 = `fifth-restore-s3-${tag}`;
const PG_PORT = 55432;
const S3_PORT = 59000;
// Ожидание без async внутри синхронного шага площадки.
const spawnSyncSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const CORE_PORT = 4390;

let passed = 0;
let failed = 0;
const results = [];
const check = (name, ok, details = '') => {
  results.push({ name, ok: Boolean(ok), details: String(details).slice(0, 300) });
  if (ok) passed += 1;
  else failed += 1;
  console.log(
    `  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details ? ` — ${String(details).slice(0, 200)}` : ''}`,
  );
};
const stage = {};
const timed = async (name, fn) => {
  const t = Date.now();
  console.log(`\n▸ ${name}`);
  try {
    return await fn();
  } finally {
    stage[name] = Math.round((Date.now() - t) / 1000);
  }
};

let core;
// Вывод ядра площадки — в подробности отказа (без него причина 500 не видна).
let coreLog = [];
async function cleanup() {
  if (core) core.kill();
  if (keep) {
    console.log(`\n(--keep: площадка оставлена — ${PG}, ${S3}, сеть ${NET})`);
    return;
  }
  for (const c of [PG, S3]) docker(['rm', '-f', '-v', c], { allowFail: true });
  for (const v of [`${PG}-data`, `${S3}-data`])
    docker(['volume', 'rm', '-f', v], { allowFail: true });
  docker(['network', 'rm', NET], { allowFail: true });
}

const catalog = JSON.parse(
  readFileSync(join(from, 'sets', readdirSync(join(from, 'sets'))[0], 'catalog.json'), 'utf8'),
);
const report = { set: catalog.id, T: catalog.at, from, startedAt: new Date().toISOString() };
console.log(`=== ВОССТАНОВЛЕНИЕ ИЗ КОМПЛЕКТА ${catalog.id} (T=${catalog.at}) ===`);
console.log(`каталог: ${from}`);

try {
  // ----------------------------------------------------------- 1. ключи
  const env = await timed('Комплект ключей', () => {
    const bundle = join(from, catalog.keys.file);
    const r = docker(
      [
        'run',
        '--rm',
        '-i',
        '--network',
        'none',
        '-e',
        'PASSPHRASE',
        '-v',
        `${secretKey}:/in/key.asc:ro`,
        '-v',
        `${bundle}:/in/bundle.gpg:ro`,
        '--entrypoint',
        'sh',
        TOOL_IMAGE,
        '-c',
        'export GNUPGHOME=$(mktemp -d) && printf %s "$PASSPHRASE" | gpg -q --batch --pinentry-mode loopback --passphrase-fd 0 --import /in/key.asc 2>/dev/null && ' +
          'printf %s "$PASSPHRASE" | gpg -q --batch --pinentry-mode loopback --passphrase-fd 0 --decrypt /in/bundle.gpg',
      ],
      { env: { PASSPHRASE: readFileSync(passphraseFile, 'utf8').trim() }, allowFail: true },
    );
    const parsed = {};
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) parsed[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
    check(
      'комплект ключей открыт закрытым ключом',
      r.status === 0 && parsed.DATABASE_URL,
      r.status,
    );
    for (const k of [
      'BACKUP_PGBACKREST_CIPHER_PASS',
      'BACKUP_FILES_CRYPT_PASS',
      'KEK_PASSPORT_SENSITIVE',
      'KEK_SEARCH_INDEX',
    ]) {
      check(`в комплекте есть ${k}`, Boolean(parsed[k]));
    }
    if (!parsed.DATABASE_URL) throw new Error('без комплекта ключей дальше нельзя');
    return parsed;
  });

  docker(['network', 'create', NET]);

  // ------------------------------------------------------------- 2. база
  await timed('База на момент T', async () => {
    const repo = join(from, 'pgbackrest');
    const pgbr = {
      PGBACKREST_STANZA: 'main',
      PGBACKREST_PG1_PATH: '/var/lib/postgresql/data',
      PGBACKREST_REPO1_PATH: '/var/lib/pgbackrest',
      PGBACKREST_REPO1_CIPHER_TYPE: 'aes-256-cbc',
      PGBACKREST_REPO1_CIPHER_PASS: env.BACKUP_PGBACKREST_CIPHER_PASS,
      PGBACKREST_LOG_LEVEL_CONSOLE: 'warn',
    };
    const e = Object.keys(pgbr).flatMap((k) => ['-e', k]);
    docker(['volume', 'create', `${PG}-data`]);
    const restore = docker(
      [
        'run',
        '--rm',
        '-u',
        'root',
        ...e,
        '-v',
        `${PG}-data:/var/lib/postgresql/data`,
        '-v',
        `${repo}:/var/lib/pgbackrest:ro`,
        '--entrypoint',
        'sh',
        TOOL_IMAGE,
        '-c',
        'chown postgres:postgres /var/lib/postgresql/data && chmod 700 /var/lib/postgresql/data && ' +
          `gosu postgres pgbackrest restore --set=${catalog.db.backup} --type=lsn --target=${catalog.target.lsn} --target-action=promote`,
      ],
      { env: pgbr, allowFail: true },
    );
    check(
      'pgBackRest восстановил копию на LSN T',
      restore.status === 0,
      restore.stderr.trim().split('\n').pop(),
    );
    docker(
      [
        'run',
        '-d',
        '--name',
        PG,
        '--network',
        NET,
        ...e,
        '-p',
        `127.0.0.1:${PG_PORT}:5432`,
        '-v',
        `${PG}-data:/var/lib/postgresql/data`,
        '-v',
        `${repo}:/var/lib/pgbackrest:ro`,
        TOOL_IMAGE,
        'postgres',
        '-c',
        'archive_mode=off',
        '-c',
        'shared_preload_libraries=pg_stat_statements',
        // Не меньше, чем на исходной базе (там 120): иначе восстановление
        // журнала прерывается «insufficient parameter settings».
        '-c',
        'max_connections=200',
      ],
      { env: pgbr },
    );
    const url = new URL(env.DATABASE_URL_OWNER || env.DATABASE_URL);
    const pool = new pg.Pool({
      host: '127.0.0.1',
      port: PG_PORT,
      user: 'unicorn_owner',
      password: env.POSTGRES_PASSWORD,
      database: url.pathname.slice(1),
      max: 2,
    });
    let promoted = false;
    for (let i = 0; i < 90 && !promoted; i += 1) {
      try {
        const r = await pool.query('SELECT pg_is_in_recovery() AS rec');
        promoted = r.rows[0].rec === false;
      } catch {
        /* ещё стартует */
      }
      if (!promoted) await new Promise((r) => setTimeout(r, 2000));
    }
    check('база поднялась и вышла из восстановления', promoted);
    const tx = await pool.query('SELECT txid_status($1::bigint) AS s', [catalog.target.txid]);
    check('транзакция момента T в базе есть', tx.rows[0].s === 'committed', tx.rows[0].s);
    const counts = await pool
      .query(
        `SELECT (SELECT count(*) FROM identity.users)::int AS users,
              (SELECT count(*) FROM lab.projects)::int AS projects,
              (SELECT count(*) FROM lab.project_materials)::int AS materials,
              (SELECT count(*) FROM schema_migrations)::int AS migrations`,
      )
      .catch(async () =>
        pool.query(
          `SELECT (SELECT count(*) FROM identity.users)::int AS users,
                (SELECT count(*) FROM lab.projects)::int AS projects,
                (SELECT count(*) FROM lab.project_materials)::int AS materials`,
        ),
      );
    report.db = counts.rows[0];
    console.log(`  данные: ${JSON.stringify(counts.rows[0])}`);
    await pool.end();
  });

  // ----------------------------------------------------------- 3. файлы
  const restored = await timed('Файлы', () => {
    // Чистое хранилище — Garage (D-001), как рабочее: один узел, одна копия
    // (площадка временная), ключ — новый, только на этой площадке.
    docker(['volume', 'create', `${S3}-data`]);
    writeFileSync(
      join(from, '.restore-garage.toml'),
      [
        'metadata_dir = "/var/lib/garage/meta"',
        'data_dir = "/var/lib/garage/data"',
        'db_engine = "lmdb"',
        'replication_factor = 1',
        'rpc_bind_addr = "[::]:3901"',
        '[s3_api]',
        `s3_region = "${env.S3_REGION || 'us-east-1'}"`,
        'api_bind_addr = "[::]:3900"',
        'root_domain = ".s3.garage.invalid"',
        '',
      ].join('\n'),
    );
    const garageEnv = { GARAGE_RPC_SECRET: randomBytes(32).toString('hex') };
    docker(
      [
        'run',
        '-d',
        '--name',
        S3,
        '--network',
        NET,
        '-e',
        'GARAGE_RPC_SECRET',
        '-p',
        `127.0.0.1:${S3_PORT}:3900`,
        '-v',
        `${join(from, '.restore-garage.toml')}:/etc/garage.toml:ro`,
        '-v',
        `${S3}-data:/var/lib/garage`,
        GARAGE_IMAGE,
        '/garage',
        'server',
      ],
      { env: garageEnv },
    );
    const garage = (...cmd) => docker(['exec', S3, '/garage', ...cmd]).stdout.trim();
    let nodeId = '';
    for (let i = 0; i < 30 && !nodeId; i++) {
      nodeId = docker(['exec', S3, '/garage', 'node', 'id', '-q'], { allowFail: true })
        .stdout.trim()
        .split('@')[0];
      if (!nodeId) spawnSyncSleep(1000);
    }
    garage('layout', 'assign', '-z', 'restore', '-c', '10G', nodeId);
    garage('layout', 'apply', '--version', '1');
    const restoreKey = garageKeyPair(randomBytes);
    garage('bucket', 'create', catalog.files.bucket);
    garage('key', 'import', '--yes', '-n', 'restore', restoreKey.id, restoreKey.secret);
    garage(
      'bucket',
      'allow',
      '--read',
      '--write',
      '--owner',
      catalog.files.bucket,
      '--key',
      restoreKey.id,
    );
    const rc = {
      BACKUP_FILES_CRYPT_PASS: env.BACKUP_FILES_CRYPT_PASS,
      BACKUP_FILES_CRYPT_SALT: env.BACKUP_FILES_CRYPT_SALT,
      RCLONE_CONFIG_SRC_TYPE: 'crypt',
      RCLONE_CONFIG_SRC_REMOTE: '/backup/files',
      RCLONE_CONFIG_SRC_FILENAME_ENCRYPTION: 'standard',
      RCLONE_CONFIG_SRC_DIRECTORY_NAME_ENCRYPTION: 'true',
      RCLONE_CONFIG_DST_TYPE: 's3',
      RCLONE_CONFIG_DST_PROVIDER: 'Other',
      RCLONE_CONFIG_DST_ENDPOINT: `http://${S3}:3900`,
      RCLONE_CONFIG_DST_ACCESS_KEY_ID: restoreKey.id,
      RCLONE_CONFIG_DST_SECRET_ACCESS_KEY: restoreKey.secret,
      RCLONE_CONFIG_DST_REGION: env.S3_REGION || 'us-east-1',
    };
    const lists = join(from, '.restore-lists');
    mkdirSync(lists, { recursive: true });
    writeFileSync(
      join(lists, 'restore.tsv'),
      catalog.files.objects.map((o) => `${o.backupPath}\t${o.key}`).join('\n') + '\n',
    );
    const script = [
      'set -e',
      'export RCLONE_CONFIG_SRC_PASSWORD="$(printf %s "$BACKUP_FILES_CRYPT_PASS" | rclone obscure -)"',
      'export RCLONE_CONFIG_SRC_PASSWORD2="$(printf %s "$BACKUP_FILES_CRYPT_SALT" | rclone obscure -)"',
      'for i in $(seq 1 30); do rclone lsd DST: >/dev/null 2>&1 && break; sleep 1; done',
      // Каждый объект — из своей версии в копии (путь из каталога) под свой ключ.
      `TAB="$(printf '\\t')"; while IFS="$TAB" read -r path key; do ` +
        `rclone copyto "SRC:$path" "DST:${catalog.files.bucket}/$key" --size-only; ` +
        `done < /lists/restore.tsv`,
      `rclone hashsum sha256 --download "DST:${catalog.files.bucket}"`,
    ].join('\n');
    const r = docker(
      [
        'run',
        '--rm',
        '--network',
        NET,
        '-v',
        `${join(from, 'files')}:/backup/files:ro`,
        '-v',
        `${lists}:/lists:ro`,
        ...Object.keys(rc).flatMap((k) => ['-e', k]),
        '--entrypoint',
        'sh',
        TOOL_IMAGE,
        '-c',
        script,
      ],
      { env: rc, allowFail: true },
    );
    check(
      'файлы расшифрованы в чистое хранилище',
      r.status === 0,
      r.stderr.trim().split('\n').pop(),
    );
    const got = new Map();
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^([0-9a-f]{64})\s+(.+)$/);
      if (m) got.set(m[2], m[1]);
    }
    const missing = catalog.files.objects.filter((o) => !got.has(o.key));
    const mismatch = catalog.files.objects.filter(
      (o) => got.has(o.key) && got.get(o.key) !== o.sha256,
    );
    check(
      `все ${catalog.files.count} файлов комплекта на месте`,
      missing.length === 0,
      missing
        .slice(0, 3)
        .map((o) => o.key)
        .join(', '),
    );
    check(
      'SHA-256 каждого файла совпал с каталогом',
      mismatch.length === 0,
      mismatch
        .slice(0, 3)
        .map((o) => o.key)
        .join(', '),
    );
    report.files = {
      count: catalog.files.count,
      restored: got.size,
      missing: missing.length,
      mismatch: mismatch.length,
    };
    return { keys: new Set(got.keys()), restoreKey };
  });

  // ------------------------------------------------------------ 4. ядро
  const coreEnv = await timed('Ядро на восстановленных данных', async () => {
    const e = { ...env };
    const rewriteDb = (v) => {
      const u = new URL(v);
      u.hostname = '127.0.0.1';
      u.port = String(PG_PORT);
      return u.toString();
    };
    for (const k of Object.keys(e)) if (/^DATABASE_URL/.test(k) && e[k]) e[k] = rewriteDb(e[k]);
    Object.assign(e, {
      CORE_PORT: String(CORE_PORT),
      CORE_INTERNAL_PORT: String(CORE_PORT + 100),
      PUBLIC_BASE_URL: `http://127.0.0.1:${CORE_PORT}`,
      S3_ENDPOINT: `http://127.0.0.1:${S3_PORT}`,
      S3_PUBLIC_ENDPOINT: '',
      // Ключ приложения рабочего хранилища здесь не заведён — на площадке
      // проверки ядро ходит в чистый Garage её собственным ключом.
      S3_ACCESS_KEY_ID: restored.restoreKey.id,
      S3_SECRET_ACCESS_KEY: restored.restoreKey.secret,
      REDIS_URL: '',
      NATS_URL: '',
      MAIL_TRANSPORT: 'none',
      WEBHOOK_DELIVERY_MODE: 'capture',
      DATABASE_SSL: 'false',
    });
    // Переменные других компонентов ядру не передаются: CORS хранилища
    // (MinIO, Garage), адрес прикладной пробы, узлы Garage. Ядро их не читает,
    // а внешние адреса в них остановили бы проверку изоляции (комплект VPS
    // 03.11: MINIO_CORS_ALLOW_ORIGIN, MONITOR_PUBLIC_URL).
    for (const k of Object.keys(e)) {
      if (/^(MINIO_|MONITOR_|GARAGE_)|^S3_CORS_ALLOW_ORIGIN$/.test(k)) delete e[k];
    }
    // Изоляция: ни одного адреса вне этой машины.
    const outside = Object.entries(e)
      .filter(([k, v]) => !/^(MAIL_|BACKUP_|SMTP_)/.test(k) && /^[a-z]+:\/\//i.test(v ?? ''))
      .filter(([, v]) => {
        try {
          return !['127.0.0.1', 'localhost'].includes(new URL(v).hostname);
        } catch {
          return false;
        }
      })
      .map(([k]) => k);
    check('у ядра нет адресов вне площадки проверки', outside.length === 0, outside.join(', '));
    if (outside.length) throw new Error('изоляция не обеспечена');
    const base = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    core = spawn(process.execPath, [join(ROOT, 'apps', 'core', 'dist', 'main.js')], {
      env: { ...base, ...e },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = [];
    coreLog = log;
    core.stdout.on('data', (d) => log.push(String(d)));
    core.stderr.on('data', (d) => log.push(String(d)));
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) {
      try {
        // Ядро площадки проверки на петле этой машины: TLS процессу на 127.0.0.1
        // ничего не защищает, а правило смотрит на схему.
        // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
        const r = await fetch(`http://127.0.0.1:${CORE_PORT}/v1/health`, {
          signal: AbortSignal.timeout(3000),
        });
        up = r.ok;
      } catch {
        /* стартует */
      }
      if (!up) await new Promise((r) => setTimeout(r, 1000));
    }
    check('ядро стартовало, health 200', up, up ? '' : log.join('').slice(-400));
    if (!up) throw new Error('ядро не стартовало');
    return e;
  });

  // ------------------------------------------- 5. шифрованные поля и вход
  await timed('Шифрованные поля и вход', async () => {
    for (const [k, v] of Object.entries(coreEnv)) process.env[k] = v;
    const require = createRequire(join(ROOT, 'apps', 'core', 'package.json'));
    const { CryptoService } = require(
      join(ROOT, 'apps', 'core', 'dist', 'crypto', 'crypto.service.js'),
    );
    const argon2 = require('argon2');
    const crypto = new CryptoService();
    const pool = new pg.Pool({
      host: '127.0.0.1',
      port: PG_PORT,
      user: 'unicorn_owner',
      password: env.POSTGRES_PASSWORD,
      database: new URL(env.DATABASE_URL_OWNER || env.DATABASE_URL).pathname.slice(1),
      max: 2,
    });
    const users = (
      await pool.query(
        `SELECT id, email_ciphertext, phone_ciphertext, contact_wrapped_dek, email_hmac, status, deleted_at
           FROM identity.users WHERE contact_wrapped_dek IS NOT NULL`,
      )
    ).rows;
    let opened = 0;
    let indexOk = 0;
    const broken = [];
    let candidate = null;
    const emails = new Map(); // id → email: вход для контрольного чтения
    for (const u of users) {
      try {
        const email = u.email_ciphertext
          ? (
              await crypto.openField(
                'passport_sensitive',
                u.contact_wrapped_dek,
                u.email_ciphertext,
                'email',
              )
            ).toString('utf8')
          : null;
        if (u.phone_ciphertext)
          await crypto.openField(
            'passport_sensitive',
            u.contact_wrapped_dek,
            u.phone_ciphertext,
            'phone',
          );
        opened += 1;
        if (email && u.email_hmac && (await crypto.blindIndex(email, 'email')).equals(u.email_hmac))
          indexOk += 1;
        if (email && u.status === 'active' && !u.deleted_at) emails.set(u.id, email);
        if (email && !candidate && u.status === 'active' && !u.deleted_at)
          candidate = { id: u.id, email };
      } catch (error) {
        broken.push(`${u.id}: ${error.message}`);
      }
    }
    check(
      `шифрованные контакты открылись у всех (${users.length})`,
      broken.length === 0 && opened === users.length,
      broken.slice(0, 2).join('; '),
    );
    check(
      'слепой индекс email сходится (ключ поиска верный)',
      indexOk === users.filter((u) => u.email_hmac).length,
      `${indexOk}`,
    );

    if (!candidate) {
      check('есть активная учётная запись для проверки входа', false);
    } else {
      // Площадка одноразовая: пароль проверочной учётки задаётся здесь же.
      const password = randomBytes(18).toString('base64url');
      const hash = await argon2.hash(password, { type: argon2.argon2id });
      await pool.query('UPDATE identity.users SET password_hash = $1 WHERE id = $2', [
        hash,
        candidate.id,
      ]);
      // Ядро площадки проверки на петле этой машины: TLS процессу на 127.0.0.1
      // ничего не защищает, а правило смотрит на схему.
      // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
      const login = await fetch(`http://127.0.0.1:${CORE_PORT}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: candidate.email, password }),
        signal: AbortSignal.timeout(15_000),
      });
      const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
      check(
        'вход по API на восстановленной базе',
        login.status === 200 || login.status === 201,
        login.status,
      );
      // Ядро площадки проверки на петле этой машины: TLS процессу на 127.0.0.1
      // ничего не защищает, а правило смотрит на схему.
      // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
      const me = await fetch(`http://127.0.0.1:${CORE_PORT}/v1/auth/me`, {
        headers: { cookie },
        signal: AbortSignal.timeout(15_000),
      });
      const body = await me.json().catch(() => ({}));
      // Ядро отдаёт email маской (maskEmail): первые 2 символа и домен — их
      // можно получить только расшифровав поле.
      const [name, domain] = candidate.email.split('@');
      const expected = `${name.slice(0, 2)}${'*'.repeat(Math.max(1, name.length - Math.min(2, name.length)))}@${domain}`;
      check(
        'свой профиль читается, email расшифрован ядром',
        me.status === 200 && body.emailMasked === expected,
        me.status === 200
          ? ''
          : `${me.status}; ядро: ${coreLog
              .join('')
              .split('\n')
              .filter((l) => /error|ERROR|Error/.test(l))
              .slice(-3)
              .join(' | ')
              .slice(0, 600)}`,
      );
      // Ядро площадки проверки на петле этой машины: TLS процессу на 127.0.0.1
      // ничего не защищает, а правило смотрит на схему.
      // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
      const anon = await fetch(`http://127.0.0.1:${CORE_PORT}/v1/auth/me`, {
        signal: AbortSignal.timeout(15_000),
      });
      check('без входа профиль закрыт', anon.status === 401 || anon.status === 403, anon.status);
    }

    // ------------------------------------------------ 7. материалы и загрузки
    const ready = (
      await pool.query(
        `SELECT id, s3_key FROM lab.project_materials WHERE upload_state = 'ready' AND s3_key IS NOT NULL`,
      )
    ).rows;
    const noFile = ready.filter((m) => !restored.keys.has(m.s3_key));
    check(
      `готовые материалы ссылаются на восстановленные файлы (${ready.length})`,
      noFile.length === 0,
      noFile
        .slice(0, 3)
        .map((m) => m.id)
        .join(', '),
    );
    // Контрольное чтение через ядро: загрузивший входит и получает байты
    // готового материала — размер и SHA-256 как в базе (замечание Тэнка при
    // переходе на Garage: ссылки на файлы мало, нужно чтение).
    const control = (
      await pool.query(
        `SELECT m.id, m.project_id, m.uploaded_by, m.size_bytes, m.content_hash, m.s3_key
           FROM lab.project_materials m JOIN lab.projects p ON p.id = m.project_id
          WHERE m.upload_state = 'ready' AND m.s3_key IS NOT NULL AND p.deleted_at IS NULL
          ORDER BY m.uploaded_at DESC NULLS LAST`,
      )
    ).rows.find((m) => emails.has(m.uploaded_by));
    if (!control) {
      check('контрольное чтение материала через ядро — есть кому читать', ready.length === 0);
    } else {
      const password = randomBytes(18).toString('base64url');
      await pool.query('UPDATE identity.users SET password_hash = $1 WHERE id = $2', [
        await argon2.hash(password, { type: argon2.argon2id }),
        control.uploaded_by,
      ]);
      // Ядро площадки проверки на петле этой машины.
      // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
      const login = await fetch(`http://127.0.0.1:${CORE_PORT}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: emails.get(control.uploaded_by), password }),
        signal: AbortSignal.timeout(15_000),
      });
      const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
      // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
      const file = await fetch(
        `http://127.0.0.1:${CORE_PORT}/v1/projects/${control.project_id}/materials/${control.id}/content`,
        { headers: { cookie }, signal: AbortSignal.timeout(60_000) },
      );
      const bytes = file.status === 200 ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0);
      const sha = createHash('sha256').update(bytes).digest('hex');
      // Эталон — хеш в базе; у служебного контрольного материала его нет
      // (заведён напрямую, не загрузкой) — тогда хеш объекта в каталоге
      // комплекта на момент T.
      const want = control.content_hash
        ? control.content_hash.replace(/^sha256:/, '')
        : catalog.files.objects.find((o) => o.key === control.s3_key)?.sha256;
      check(
        'контрольное чтение материала через ядро: размер и SHA-256 как в базе (или в каталоге комплекта)',
        file.status === 200 &&
          bytes.length === Number(control.size_bytes) &&
          Boolean(want) &&
          sha === want,
        `HTTP ${file.status}, ${bytes.length} байт`,
      );
    }
    const pendingIds = catalog.pendingUploads.map((p) => p.id);
    if (pendingIds.length) {
      const now = (
        await pool.query(
          `SELECT id, upload_state, s3_key FROM lab.project_materials WHERE id = ANY($1::uuid[])`,
          [pendingIds],
        )
      ).rows;
      const falseReady = now.filter(
        (m) => m.upload_state === 'ready' && !restored.keys.has(m.s3_key),
      );
      check(
        `незавершённые загрузки (${pendingIds.length}) не стали готовыми без файла`,
        falseReady.length === 0,
        falseReady.map((m) => m.id).join(', '),
      );
    } else {
      check('незавершённых загрузок на T нет — проверять нечего', true);
    }
    await pool.end();
  });
} catch (error) {
  failed += 1;
  console.error(`\nПРОВЕРКА ОБОРВАНА: ${error.message ?? error}`);
  results.push({ name: 'оборвано', ok: false, details: String(error.message ?? error) });
} finally {
  await cleanup();
}

report.finishedAt = new Date().toISOString();
report.stagesSeconds = stage;
report.passed = passed;
report.failed = failed;
report.results = results;
const outDir = join(ROOT, 'out', 'backup-restore');
mkdirSync(outDir, { recursive: true });
const reportPath = join(outDir, `${report.startedAt.replace(/[:.]/g, '-')}.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`\nэтапы, с: ${JSON.stringify(stage)}`);
console.log(`отчёт: ${reportPath}`);
console.log(`=== ИТОГ: ${passed} OK, ${failed} FAIL ===`);
process.exit(failed ? 1 : 0);
