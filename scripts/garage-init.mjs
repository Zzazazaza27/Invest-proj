#!/usr/bin/env node
/**
 * Настройка кластера Garage стенда (D-001; переход с MinIO) — замена шага
 * `minio-init`. Идемпотентно: повтор ничего не меняет.
 *
 *   1. узлы соединены, у каждого роль в раскладке (одна зона — один VPS;
 *      три копии на одном диске НЕ защищают от потери VPS);
 *   2. бакеты: файлы платформы (S3_BUCKET), архив событий
 *      (ARCHIVE_S3_BUCKET), журналы (LOGS_S3_BUCKET, LOGS_LEGACY_S3_BUCKET —
 *      если заданы);
 *   3. ключи из .env (формат Garage: GK + 24 hex, секрет 64 hex) и права:
 *      ядро — чтение и запись в бакет файлов; архив событий — чтение и
 *      запись только в свой бакет; копии W07 — только чтение файлов и архива
 *      событий; журналы — запись в свой бакет, чтение — отдельным ключом.
 *      У Garage права — на ключ и бакет, без запрета удаления при праве
 *      записи и без политик по префиксу (D-001).
 *
 * Админ-API — на петле первого узла (GARAGE_ADMIN_PORT), токен —
 * GARAGE_ADMIN_TOKEN. ID узлов берутся у контейнеров (`garage node id`).
 * Секреты не печатаются.
 *
 *   node scripts/garage-init.mjs [--status]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadEnv, parseEnvFile } from './lib/backup.mjs';
import { applyKeysFile, garageApi } from './lib/garage-admin.mjs';
import { PORTS } from './lib/ports.mjs';
import { s3Object } from './lib/s3.mjs';

loadEnv();
// До окна переноса ключи и бакеты Garage — из отдельного файла, не из .env.
const keysFile = applyKeysFile(process.argv, parseEnvFile);
if (keysFile) console.log(`ключи Garage — из ${keysFile}; рабочий .env для них не используется`);
const env = process.env;
const TOKEN = env.GARAGE_ADMIN_TOKEN;
const NODES = (env.GARAGE_NODES || 'unicorn-garage-1,unicorn-garage-2,unicorn-garage-3')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Ёмкость роли — для раскладки (доля данных узла), не квота: узлы равны.
const CAPACITY = Number(env.GARAGE_NODE_CAPACITY_BYTES || 20 * 1024 ** 3);
const ZONE = env.GARAGE_ZONE || 'vps';

// Заготовка переменных для VPS — два файла вне Git с пометкой «не
// применён», права 600; значения не печатаются, существующие не
// перезаписываются. Ключи — формат Garage.
//   <префикс>-pre.env    — дописывается в .env ДО окна: потребители
//                          хранилища (ядро, W07, архив событий, Caddy) этих
//                          переменных не читают;
//   <префикс>-window.env — ключи Garage: до окна — только --keys-file для
//                          garage-init и переноса; в .env — в окне
//                          (storage-switch apply).
//   node scripts/garage-init.mjs --secrets-draft <префикс>
const draftIdx = process.argv.indexOf('--secrets-draft');
if (draftIdx > 0) {
  const { randomBytes } = await import('node:crypto');
  const { closeSync, existsSync, openSync, writeFileSync } = await import('node:fs');
  const prefix = process.argv[draftIdx + 1];
  const files = { pre: `${prefix}-pre.env`, window: `${prefix}-window.env` };
  if (!prefix || Object.values(files).some((p) => existsSync(p))) {
    console.error(`--secrets-draft: нужен новый префикс (${prefix ?? 'не задан'})`);
    process.exit(2);
  }
  const gk = () => `GK${randomBytes(12).toString('hex')}`;
  const sec = () => randomBytes(32).toString('hex');
  const sets = {
    pre: {
      GARAGE_RPC_SECRET: sec(),
      GARAGE_ADMIN_TOKEN: randomBytes(32).toString('base64url'),
      GARAGE_S3_PORT: '3900',
      S3_CORS_ALLOW_ORIGIN: 'https://5espace.com',
    },
    window: {
      GARAGE_S3_PORT: '9000',
      S3_ACCESS_KEY_ID: gk(),
      S3_SECRET_ACCESS_KEY: sec(),
      ARCHIVE_S3_BUCKET: 'unicorn-launch-archive',
      ARCHIVE_S3_ACCESS_KEY_ID: gk(),
      ARCHIVE_S3_SECRET_ACCESS_KEY: sec(),
      BACKUP_S3_ACCESS_KEY_ID: gk(),
      BACKUP_S3_SECRET_ACCESS_KEY: sec(),
      BACKUP_S3_SOURCE_ENDPOINT: 'http://garage-1:3900',
    },
  };
  const day = new Date().toISOString().slice(0, 10);
  for (const [name, vars] of Object.entries(sets)) {
    const fd = openSync(files[name], 'wx', 0o600);
    writeFileSync(
      fd,
      `# Garage (D-001), ${name === 'pre' ? 'до окна' : 'в окне'} — НЕ ПРИМЕНЁН (${day}).\n` +
        '# Порядок — docs/architecture/garage-migration-plan.md.\n' +
        `${Object.entries(vars)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n')}\n`,
    );
    closeSync(fd);
  }
  console.log(`заготовка: ${files.pre}, ${files.window} (значения не печатаются)`);
  process.exit(0);
}

if (!TOKEN) {
  console.error('GARAGE_ADMIN_TOKEN не задан');
  process.exit(2);
}

const api = garageApi;

function nodeId(container) {
  const r = spawnSync('docker', ['exec', container, '/garage', 'node', 'id', '-q'], {
    encoding: 'utf8',
    env: { ...env, MSYS_NO_PATHCONV: '1' },
  });
  if (r.status !== 0) throw new Error(`${container}: garage node id — ${r.stderr.trim()}`);
  // «<id>@<адрес>:3901» — адрес контейнер видит сам; соединяем по имени.
  return r.stdout.trim().split('@')[0];
}

const say = (s) => console.log(s);

// ------------------------------------------------------------ 1. кластер
const ids = NODES.map((c) => ({ container: c, id: nodeId(c) }));
await api(
  'ConnectClusterNodes',
  ids.slice(1).map((n) => `${n.id}@${n.container}:3901`),
);
const layout = await api('GetClusterLayout');
const have = new Set((layout.roles ?? []).map((r) => r.id));
const missing = ids.filter((n) => !have.has(n.id));
if (missing.length) {
  await api('UpdateClusterLayout', {
    roles: missing.map((n) => ({ id: n.id, zone: ZONE, capacity: CAPACITY, tags: [n.container] })),
  });
  const staged = await api('GetClusterLayout');
  await api('ApplyClusterLayout', { version: staged.version + 1 });
  say(`раскладка: узлов добавлено ${missing.length}, версия ${staged.version + 1}`);
} else {
  say(`раскладка: все ${ids.length} узла в ней, версия ${layout.version}`);
}
const status = await api('GetClusterStatus');
const up = status.nodes.filter((n) => n.isUp && n.role).length;
say(`кластер: узлов в строю с ролью ${up} из ${ids.length}`);
if (process.argv.includes('--status')) process.exit(up === ids.length ? 0 : 1);

// ------------------------------------------------------------ 2. бакеты
async function bucket(alias) {
  try {
    return await api('GetBucketInfo', undefined, `?globalAlias=${encodeURIComponent(alias)}`);
  } catch (e) {
    if (e.status !== 404) throw e;
    const b = await api('CreateBucket', { globalAlias: alias });
    say(`бакет ${alias}: создан`);
    return b;
  }
}

// ------------------------------------------------------------ 3. ключи
async function key(idVar, secretVar, name) {
  const id = env[idVar];
  const secret = env[secretVar];
  if (!id || !secret) return null;
  if (!/^GK[0-9a-f]{24}$/.test(id) || !/^[0-9a-f]{64}$/.test(secret)) {
    throw new Error(`${idVar}/${secretVar}: формат Garage — GK + 24 hex и 64 hex`);
  }
  try {
    await api('GetKeyInfo', undefined, `?id=${id}`);
  } catch (e) {
    if (e.status !== 404) throw e;
    await api('ImportKey', { accessKeyId: id, secretAccessKey: secret, name });
    say(`ключ ${name}: заведён`);
  }
  return id;
}

async function allow(b, keyId, permissions, label) {
  if (!keyId) return;
  // Права выставляются ровно такими: лишнее снимается.
  const all = { read: true, write: true, owner: true };
  const extra = Object.fromEntries(Object.keys(all).map((p) => [p, !permissions[p]]));
  if (Object.values(extra).some(Boolean)) {
    await api('DenyBucketKey', { bucketId: b.id, accessKeyId: keyId, permissions: extra });
  }
  await api('AllowBucketKey', { bucketId: b.id, accessKeyId: keyId, permissions });
  const p = Object.entries(permissions)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join('+');
  say(`права ${label} на ${b.globalAliases?.[0] ?? b.id}: ${p}`);
}

const RW = { read: true, write: true, owner: false };
const R = { read: true, write: false, owner: false };
const W = { read: false, write: true, owner: false };

const files = await bucket(env.S3_BUCKET || 'unicorn-launch');
const archive = await bucket(env.ARCHIVE_S3_BUCKET || 'unicorn-launch-archive');
const app = await key('S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'app');
const arch = await key(
  'ARCHIVE_S3_ACCESS_KEY_ID',
  'ARCHIVE_S3_SECRET_ACCESS_KEY',
  'archive-events',
);
const backup = await key('BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY', 'backup-read');
await allow(files, app, RW, 'ядра');
await allow(archive, arch, RW, 'архива событий');
await allow(files, backup, R, 'копий W07');
await allow(archive, backup, R, 'копий W07');

// CORS бакета файлов — вторая линия, как MINIO_API_CORS_ALLOW_ORIGIN у MinIO:
// на VPS правило по сайтам держит Caddy (files.<домен>), локально браузер
// отправляет форму прямо в Garage. PutBucketCors требует права владельца —
// его получает временный ключ, который сразу удаляется.
const origins = (
  env.S3_CORS_ALLOW_ORIGIN ||
  env.MINIO_CORS_ALLOW_ORIGIN ||
  'http://127.0.0.1,http://localhost'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
{
  const tmp = await api('CreateKey', { name: 'garage-init-cors' });
  try {
    await api('AllowBucketKey', {
      bucketId: files.id,
      accessKeyId: tmp.accessKeyId,
      permissions: { read: false, write: false, owner: true },
    });
    const xml = Buffer.from(
      `<CORSConfiguration><CORSRule>${origins.map((o) => `<AllowedOrigin>${o}</AllowedOrigin>`).join('')}<AllowedMethod>POST</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>600</MaxAgeSeconds></CORSRule></CORSConfiguration>`,
    );
    const r = await s3Object(
      {
        // Прямо в Garage (его порт), а не по S3_ENDPOINT: до окна там MinIO.
        endpoint: `http://127.0.0.1:${PORTS.garageS3}`,
        bucket: files.globalAliases?.[0],
        region: env.S3_REGION || 'us-east-1',
        accessKey: tmp.accessKeyId,
        secretKey: tmp.secretAccessKey,
      },
      'PUT',
      '',
      xml,
      { 'content-md5': createHash('md5').update(xml).digest('base64') },
      { cors: '' },
    );
    if (r.status !== 200)
      throw new Error(`PutBucketCors: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    say(`CORS ${files.globalAliases?.[0]}: POST с ${origins.join(', ')}`);
  } finally {
    await api('DeleteKey', {}, `?id=${tmp.accessKeyId}`);
  }
}

for (const [bucketVar, writer, reader] of [
  [
    'LOGS_S3_BUCKET',
    ['LOGS_S3_ACCESS_KEY_ID', 'LOGS_S3_SECRET_ACCESS_KEY'],
    ['LOGS_READER_ACCESS_KEY_ID', 'LOGS_READER_SECRET_ACCESS_KEY'],
  ],
  [
    'LOGS_LEGACY_S3_BUCKET',
    ['LOGS_LEGACY_WRITER_ACCESS_KEY_ID', 'LOGS_LEGACY_WRITER_SECRET_ACCESS_KEY'],
    ['LOGS_LEGACY_READER_ACCESS_KEY_ID', 'LOGS_LEGACY_READER_SECRET_ACCESS_KEY'],
  ],
]) {
  if (!env[bucketVar]) continue;
  const b = await bucket(env[bucketVar]);
  await allow(
    b,
    await key(...writer, `${bucketVar}-writer`),
    { ...W, read: true },
    'записи журналов',
  );
  await allow(b, await key(...reader, `${bucketVar}-reader`), R, 'чтения журналов');
}
say('garage-init: готово');
