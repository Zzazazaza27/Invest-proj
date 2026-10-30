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
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ENV_PATH,
  ROOT,
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
  recordJob,
  signal,
  snapshotConfig,
  standNetwork,
  withLock,
  writeState,
} from './lib/backup.mjs';

loadEnv();
const [command, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(name);
const option = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

const VPS = 'root@193.233.217.210';
const VPS_KEY = join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.ssh',
  'launchbridge_ed25519',
);
const VPS_BACKUP_DIR = '/var/backups/fifth-element';

// ------------------------------------------------------------ init-secrets

function initSecrets() {
  const env = parseEnvFile(ENV_PATH);
  const gen = () => randomBytes(32).toString('base64url');
  const wanted = {
    BACKUP_PGBACKREST_CIPHER_PASS: gen,
    BACKUP_FILES_CRYPT_PASS: gen,
    BACKUP_FILES_CRYPT_SALT: gen,
    BACKUP_S3_ACCESS_KEY_ID: () => 'unicorn_backup',
    BACKUP_S3_SECRET_ACCESS_KEY: gen,
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

/** Объекты бакета сейчас: [{key, size}]. */
function listSource(network) {
  const r = rclone(['lsjson', '-R', '--files-only', '--no-mimetype', `SRC:${cfg().bucket}`], {
    network,
  });
  return JSON.parse(r.stdout).map((o) => ({ key: o.Path, size: o.Size }));
}

function listBackup(network) {
  const r = rclone(['lsjson', '-R', '--files-only', '--no-mimetype', `DST:${cfg().bucket}`], {
    network,
    allowFail: true,
  });
  if (r.status !== 0) return new Map();
  return new Map(JSON.parse(r.stdout).map((o) => [o.Path, o.Size]));
}

async function set() {
  const c = ensureDirs();
  await withLock('set', async () => {
    const id = newId();
    const dir = join(c.sets, id);
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

      // --- файлы на T и их копия.
      const atT = listSource(network);
      const index = readIndex();
      const fresh = atT.filter((o) => !index.has(o.key));
      assertSpace(
        fresh.reduce((n, o) => n + o.size, 0),
        'копия файлов',
      );
      rclone(
        [
          'copy',
          `SRC:${c.bucket}`,
          `DST:${c.bucket}`,
          '--immutable',
          // Сравнение по размеру: время изменения в каталоге копии (общие папки
          // Docker) хранится неточно, а ключи объектов не перезаписываются по
          // 2.1.2. Содержимое новых файлов сверяется ниже через cryptcheck.
          '--size-only',
          '--transfers',
          '2',
          '--checkers',
          '4',
        ],
        {
          network,
        },
      );
      if (fresh.length) {
        const listFile = join(c.state, `new-${id}.txt`);
        writeFileSync(listFile, fresh.map((o) => o.key).join('\n') + '\n');
        const rel = `/backup/state/new-${id}.txt`;
        // Содержимое копии совпадает с источником — проверка через шифр.
        rclone(
          [
            'cryptcheck',
            `SRC:${c.bucket}`,
            `DST:${c.bucket}`,
            '--files-from-raw',
            rel,
            '--one-way',
          ],
          {
            network,
          },
        );
        const sums = rclone(
          ['hashsum', 'sha256', '--download', `SRC:${c.bucket}`, '--files-from-raw', rel],
          {
            network,
          },
        ).stdout;
        const byKey = new Map();
        for (const line of sums.split('\n')) {
          const m = line.match(/^([0-9a-f]{64})\s+(.+)$/);
          if (m) byKey.set(m[2], m[1]);
        }
        const rows = fresh.map((o) => {
          const sha256 = byKey.get(o.key);
          if (!sha256) throw new Error(`нет SHA-256 для ${o.key}`);
          return { key: o.key, size: o.size, sha256, firstSeen: at };
        });
        appendIndex(rows);
      }
      const indexAfter = readIndex();
      const inBackup = listBackup(network);

      // --- ключи и конфигурация.
      const fingerprint = ensureKeyBundle();
      const config = snapshotConfig(join(dir, 'config'));

      // --- незавершённые загрузки (2.1.2): их временные файлы — часть комплекта.
      const pending = psql(
        `SELECT coalesce(json_agg(json_build_object('id', id, 'state', upload_state, 'key', upload_key)), '[]')
           FROM lab.project_materials
          WHERE upload_state IN ('pending', 'needs_attention') AND upload_key IS NOT NULL`,
      );

      const objects = atT.map((o) => ({
        key: o.key,
        size: o.size,
        sha256: indexAfter.get(o.key)?.sha256 ?? null,
      }));
      const catalog = {
        id,
        format: 1,
        at: new Date(at).toISOString(),
        // txid зафиксированной на T транзакции: восстановленная база обязана
        // её знать — так проверяется, что восстановление дошло до T.
        target: { type: 'lsn', lsn, walfile, txid },
        db: {
          stanza: 'main',
          backup: base.label,
          backupStop: new Date(base.timestamp.stop * 1000).toISOString(),
          archiveMax: info.archive.at(-1).max,
          archiveId: info.archive.at(-1).id,
        },
        files: {
          bucket: c.bucket,
          count: objects.length,
          bytes: objects.reduce((n, o) => n + o.size, 0),
          objects,
        },
        pendingUploads: JSON.parse(pending),
        keys: { fingerprint, file: `keys/${fingerprint}.env.gpg` },
        config: { commit: config.commit, images: config.images, natsStreams: config.nats },
      };

      // --- проверка частей: только после неё комплект пригоден.
      const problems = verifyCatalog(catalog, c.dir, { inBackup });
      writeFileSync(join(dir, 'catalog.json'), JSON.stringify(catalog, null, 2));
      if (problems.length) throw new Error(`комплект неполон: ${problems.slice(0, 5).join('; ')}`);
      writeFileSync(join(dir, 'READY'), new Date().toISOString());
      recordJob('set', true, { lastSet: id, lastAt: catalog.at, files: objects.length });
      console.log(
        `комплект ${id} пригоден: T=${catalog.at}, база ${base.label}, файлов ${objects.length}`,
      );
    } catch (error) {
      recordJob('set', false, { lastError: String(error.message ?? error) });
      throw error;
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

  // Диск: предупреждение раньше, чем запрет начинать задания.
  const d = diskInfo();
  await say(
    'disk',
    d.freePercent < c.warnPercent || d.free < d.reserve,
    `свободно ${gb(d.free)} (${d.freePercent.toFixed(0)}%), запас для копий ${gb(d.reserve)}`,
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
 * Скачать последний пригодный комплект. С сервера — по ssh потоком tar;
 * для проверки на одной машине — `--from-dir`. После скачивания части
 * комплекта сверяются на месте; без этого комплект не считается скачанным.
 */
async function pull() {
  const fromDir = option('--from-dir');
  const dest = resolve(option('--to') || join(ROOT, '.local', 'backup-pull'));
  let id;
  let catalog;
  const parts = (cat) => [
    'pgbackrest',
    'files',
    'files-index.jsonl',
    `sets/${cat.id}`,
    cat.keys.file,
  ];
  if (fromDir) {
    const src = resolve(fromDir);
    id = readdirSync(join(src, 'sets'))
      .filter((s) => existsSync(join(src, 'sets', s, 'READY')))
      .sort()
      .pop();
    if (!id) throw new Error('пригодных комплектов нет');
    catalog = JSON.parse(readFileSync(join(src, 'sets', id, 'catalog.json'), 'utf8'));
    // Символические ссылки (`latest` у pgBackRest) пропускаются: созданные в
    // Linux-контейнере на общей папке Windows, они роняют копирование, а для
    // восстановления не нужны.
    const noLinks = (path) => {
      try {
        return !lstatSync(path).isSymbolicLink();
      } catch {
        return false;
      }
    };
    for (const p of parts(catalog)) {
      cpSync(join(src, p), join(dest, id, p), { recursive: true, filter: noLinks });
    }
  } else {
    const ssh = (cmd) =>
      execFileSync('ssh', ['-i', VPS_KEY, '-o', 'BatchMode=yes', VPS, cmd], { encoding: 'utf8' });
    id = ssh(
      `cd ${VPS_BACKUP_DIR}/sets && for d in *; do [ -f "$d/READY" ] && echo "$d"; done | sort | tail -1`,
    ).trim();
    if (!id) throw new Error('на сервере пригодных комплектов нет');
    catalog = JSON.parse(ssh(`cat ${VPS_BACKUP_DIR}/sets/${id}/catalog.json`));
    mkdirSync(join(dest, id), { recursive: true });
    // Поток tar по ssh прямо в распаковку: без промежуточного архива и без sh.
    const remote = spawn(
      'ssh',
      [
        '-i',
        VPS_KEY,
        '-o',
        'BatchMode=yes',
        VPS,
        `tar -C ${VPS_BACKUP_DIR} -cf - ${parts(catalog).join(' ')}`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const local = spawn('tar', ['-xf', '-', '-C', join(dest, id)], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    remote.stdout.pipe(local.stdin);
    const codes = await Promise.all(
      [remote, local].map((p) => new Promise((r) => p.on('close', r))),
    );
    if (codes.some((code) => code !== 0)) throw new Error('скачивание оборвалось');
  }
  const root = join(dest, id);
  const problems = verifyCatalog(catalog, root);
  const encrypted = countFiles(join(root, 'files'));
  if (encrypted < catalog.files.count)
    problems.push(`файлов в копии ${encrypted}, в комплекте ${catalog.files.count}`);
  writeFileSync(
    join(root, 'PULLED.json'),
    JSON.stringify(
      { at: new Date().toISOString(), from: fromDir ? 'каталог' : VPS, problems },
      null,
      2,
    ),
  );
  if (problems.length)
    throw new Error(`скачанный комплект неполон: ${problems.slice(0, 5).join('; ')}`);
  console.log(`комплект ${id} скачан и сверен: ${root}`);
  return root;
}

function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
  }
  return n;
}

// ------------------------------------------------------------------- вызов

const commands = {
  'init-secrets': initSecrets,
  'keys-init': keysInit,
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
  await run();
} catch (error) {
  console.error(`ОШИБКА: ${error.message ?? error}`);
  process.exit(1);
}
