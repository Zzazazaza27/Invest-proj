#!/usr/bin/env node
/**
 * Управление установкой среды 5Э из готовых образов (W09b).
 *
 *   node scripts/env.mjs create  <среда> --kit <метка> --web-port <порт> [--address <URL>]
 *                                [--files-url <URL>] [--pilot]
 *   node scripts/env.mjs status  <среда>
 *   node scripts/env.mjs stop    <среда>
 *   node scripts/env.mjs start   <среда>
 *   node scripts/env.mjs seed    <среда> --set <файл.sql>
 *   node scripts/env.mjs update  <среда> --kit <метка>
 *   node scripts/env.mjs destroy <среда> --confirm <среда>
 *   node scripts/env.mjs images  <среда>   какие образы Compose возьмёт для среды, ничего не запуская
 *
 * Среда — `test-N`. Рабочую среду эта команда не создаёт и не удаляет: её
 * установка — выпуск W09d, а удаление данных через тестовую команду запрещено.
 * Всё производное берётся из идентификатора: проект `fifth-test-N`, контейнеры,
 * сети и тома проекта, бакеты и ключи `fifth-test-N-*`. Настройки и секреты лежат
 * в `.local/envs/<среда>` (FIFTH_ENVS_DIR), значения не печатаются.
 *
 * Назначение среды записано в install.json. `--pilot` — среда с сохраняемыми данными людей: своя
 * служебная почта и пределы ресурсов, без проверочных сеансов. Её не останавливает и не удаляет
 * ничего автоматического: `stop` и `destroy` требуют `--pilot-confirm <среда>`.
 *
 * Результат — одна строка JSON на stdout (`--text` — словами). Код завершения:
 * 0 — готово, 1 — не удалось, 2 — отказ: неверный вызов или защита.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { garageApi } from './lib/garage-admin.mjs';
import { s3Object } from './lib/s3.mjs';
import { parseEnvFile } from './lib/backup.mjs';
import { envLayout, envSlotOps, extractStatic, prepareSlots } from './lib/env-slots.mjs';
import { factualState, switchSlots } from './lib/slot-switch.mjs';
import { contractRelease } from './lib/contract-release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = join(ROOT, 'infra', 'docker-compose.env.yml');
const PRODUCTION_OVERLAY = join(ROOT, 'infra', 'docker-compose.env-production.yml');
const SLOTS_OVERLAY = join(ROOT, 'infra', 'docker-compose.env-slots.yml');
// Журналы среды в journald (W32): включает флаг FIFTH_JOURNALD=1 в compose.env среды.
const JOURNALD_OVERLAY = join(ROOT, 'infra', 'docker-compose.env-journald.yml');
const KITS = process.env.FIFTH_KITS_DIR || join(ROOT, '.local', 'kits');
const ENVS = process.env.FIFTH_ENVS_DIR || join(ROOT, '.local', 'envs');
// Пределы пилотной среды: бюджет узла считается по ним, а не по текущему расходу.
const PILOT_LIMITS = [
  'FIFTH_MEM_POSTGRES=768m',
  'FIFTH_CPU_POSTGRES=1.5',
  'FIFTH_MEM_CORE=768m',
  'FIFTH_CPU_CORE=1.5',
  'FIFTH_MEM_VALKEY=128m',
  'FIFTH_CPU_VALKEY=0.25',
  'FIFTH_MEM_NATS=128m',
  'FIFTH_CPU_NATS=0.25',
  'FIFTH_MEM_WEB=64m',
  'FIFTH_CPU_WEB=0.25',
];
const KEEP = new Set(['FIFTH_KITS_DIR', 'FIFTH_ENVS_DIR']);
const STORAGE_NETWORK = process.env.FIFTH_STORAGE_NETWORK || 'fifth_default';
const STORAGE_ENDPOINT = process.env.FIFTH_STORAGE_ENDPOINT || 'http://garage-1:3900';
const STORAGE_ENDPOINT_HOST =
  process.env.FIFTH_STORAGE_ENDPOINT_HOST ||
  `http://127.0.0.1:${process.env.GARAGE_S3_PORT || 9000}`;
const INTERNAL_PORT = 4400;
const READY_TIMEOUT_MS = Number(process.env.FIFTH_READY_TIMEOUT_MS || 120_000);

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const TEXT = argv.includes('--text');

class Refused extends Error {}

function finish(result, code) {
  if (TEXT) console.log(result.message ?? JSON.stringify(result));
  else console.log(JSON.stringify(result));
  process.exit(code);
}

function needEnv(id) {
  if (id === 'prod') {
    throw new Refused('рабочая среда этой командой не управляется');
  }
  if (!/^test-[1-9][0-9]*$/.test(id ?? '')) {
    throw new Refused(`неверный идентификатор среды: ${id ?? '(нет)'}; нужен test-N`);
  }
  return id;
}

const names = (id) => ({
  project: `fifth-${id}`,
  bucket: `fifth-${id}`,
  archive: `fifth-${id}-archive`,
  dir: join(ENVS, id),
});

function loadInstall(id) {
  const file = join(names(id).dir, 'install.json');
  if (!existsSync(file)) throw new Refused(`среда ${id} не установлена`);
  const install = JSON.parse(readFileSync(file, 'utf8'));
  // Защита от подмены каталога: запись обязана говорить о той же среде.
  if (install.env !== id) throw new Refused(`запись установки не от среды ${id}`);
  return install;
}

const saveInstall = (id, install) =>
  writeFileSync(join(names(id).dir, 'install.json'), `${JSON.stringify(install, null, 2)}\n`);

const composeOf = (id) => join(names(id).dir, 'compose.yml');

/**
 * Файл запуска среды. Из комплекта — проверенный по манифесту, рабочая копия при
 * этом не участвует; из репозитория — только для меток без комплекта (разработка).
 */
function installCompose(id, label) {
  const kitFile = join(KITS, label, 'kit.json');
  if (!existsSync(kitFile)) {
    writeFileSync(composeOf(id), readFileSync(COMPOSE));
    return;
  }
  const text = readFileSync(join(KITS, label, 'compose.yml'));
  const expected = JSON.parse(readFileSync(kitFile, 'utf8')).compose.sha256;
  if (createHash('sha256').update(text).digest('hex') !== expected) {
    throw new Error(`файл запуска сборки ${label}: хеш не сошёлся`);
  }
  writeFileSync(composeOf(id), text);
}

/**
 * Окружение Compose. Переменные запускающего процесса важнее `--env-file`, а `lib/ports.mjs` при
 * импорте кладёт в процесс весь `.env`: образы рабочей среды подменили бы образы этой среды, и она
 * молча работала бы не на своём комплекте. Защищает CHK-ENV-IMAGES.
 */
function composeEnv() {
  const env = { ...process.env, MSYS_NO_PATHCONV: '1' };
  for (const name of Object.keys(env))
    if (name.startsWith('FIFTH_') && !KEEP.has(name)) delete env[name];
  return env;
}

/**
 * Боевой режим среды (test-2): TLS служб, файлы Agent, шифрованный вход к хранилищу. Дополнение
 * берётся из репозитория, как у рабочей среды в infra.mjs, и подключается, пока в compose.env
 * задан FIFTH_AGENT_DIR. Ставит его infra/host/prod-test2-production.sh.
 */
function overlays(id) {
  const file = join(names(id).dir, 'compose.env');
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  return [
    ...(/^FIFTH_AGENT_DIR=/m.test(text) ? ['-f', PRODUCTION_OVERLAY] : []),
    // Слоты ядра (блок 09, задание 3): включает `slots-enable`.
    ...(/^FIFTH_SLOTS=1$/m.test(text) ? ['-f', SLOTS_OVERLAY] : []),
    ...(/^FIFTH_JOURNALD=1$/m.test(text) ? ['-f', JOURNALD_OVERLAY] : []),
  ];
}

function compose(id, args, { allowFail = false, timeout = 300_000 } = {}) {
  const r = spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      join(names(id).dir, 'compose.env'),
      '-f',
      composeOf(id),
      ...overlays(id),
      ...args,
    ],
    { encoding: 'utf8', timeout, env: composeEnv() },
  );
  if (r.status !== 0 && !allowFail) {
    throw new Error(
      `docker compose ${args[0]}: код ${r.status ?? r.signal}: ${`${r.stdout}\n${r.stderr}`
        .trim()
        .split('\n')
        .slice(-3)
        .join(' | ')}`,
    );
  }
  return r;
}

function docker(args) {
  return spawnSync('docker', args, {
    encoding: 'utf8',
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
}

const hex = (n) => randomBytes(n).toString('hex');

/** Настройки и секреты среды. Секрет — отдельный файл, в настройках только путь. */
function writeSettings(id, { address, keys, filesUrl, pilot }) {
  const n = names(id);
  const mountDir = join(n.dir, 'secrets');
  mkdirSync(mountDir, { recursive: true });
  // Читают службы контейнеров под своими пользователями: права не зависят от umask.
  chmodSync(mountDir, 0o755);
  const secret = {};
  const put = (name, value) => {
    secret[name] = value;
    writeFileSync(join(mountDir, name), `${value}\n`);
    chmodSync(join(mountDir, name), 0o444);
  };
  const pg = (user, password) => `postgres://${user}:${password}@postgres:5432/fifth_element`;
  const roles = {
    BACKEND: 'app_backend_user',
    PUBLIC_READ: 'app_public_read_user',
    NOTIFICATIONS: 'app_notifications_user',
    INTEGRATION: 'app_integration_user',
    READONLY: 'app_readonly_user',
    AUTH: 'app_auth_user',
    MAINTENANCE: 'app_maintenance_user',
    ARCHIVE: 'app_archive_user',
    RELEASE: 'app_release_user',
  };
  const roleKey = Object.fromEntries(Object.keys(roles).map((r) => [r, hex(24)]));
  for (const [role, value] of Object.entries(roleKey)) put(`DB_ROLE_PASSWORD_APP_${role}`, value);
  const owner = hex(24);
  put('POSTGRES_PASSWORD', owner);
  put('DATABASE_URL_OWNER', pg('fifth_owner', owner));
  put('DATABASE_URL', pg(roles.BACKEND, roleKey.BACKEND));
  for (const role of [
    'INTEGRATION',
    'NOTIFICATIONS',
    'AUTH',
    'MAINTENANCE',
    'ARCHIVE',
    'RELEASE',
  ]) {
    put(`DATABASE_URL_APP_${role}`, pg(roles[role], roleKey[role]));
  }
  const redis = hex(24);
  put('REDIS_PASSWORD', redis);
  const nats = hex(24);
  put('NATS_PASSWORD', nats);
  for (const name of [
    'LOCAL_AUTH_SIGNING_KEY',
    'CSRF_SIGNING_KEY',
    'INTEGRATION_TOKEN_SIGNING_KEY',
  ]) {
    put(name, hex(48));
  }
  for (const name of [
    'KEK_KYC_DOCUMENTS',
    'KEK_KYB_DOCUMENTS',
    'KEK_PASSPORT_SENSITIVE',
    'KEK_WEBHOOK_SECRETS',
    'KEK_SEARCH_INDEX',
  ]) {
    put(name, randomBytes(32).toString('base64'));
  }
  if (pilot) put('MAIL_SMTP_PASSWORD', hex(24));
  put('S3_SECRET_ACCESS_KEY', keys.app.secretAccessKey);
  put('ARCHIVE_S3_SECRET_ACCESS_KEY', keys.archive.secretAccessKey);
  writeFileSync(
    join(mountDir, 'valkey.conf'),
    `requirepass ${redis}\nappendonly yes\nmaxmemory-policy noeviction\ndir /data\n`,
  );
  writeFileSync(
    join(mountDir, 'nats.conf'),
    `jetstream { store_dir: "/data" }\nhttp_port: 8222\nauthorization { user: "fifth", password: "${nats}" }\n`,
  );
  for (const f of ['valkey.conf', 'nats.conf']) chmodSync(join(mountDir, f), 0o444);

  const skipFile = new Set(['POSTGRES_PASSWORD']);
  const lines = [
    `FIFTH_ENV=${id}`,
    `MONITOR_ENV=${id}`,
    // Рабочий режим ядра требует KMS (блок 5, задание 4): до него среды идут как VPS.
    'NODE_ENV=development',
    'CORE_BIND_HOST=0.0.0.0',
    'CORE_PORT=4300',
    `CORE_INTERNAL_PORT=${INTERNAL_PORT}`,
    `CORE_PUBLIC_URL=${address}`,
    `PUBLIC_BASE_URL=${address}`,
    `CORS_ALLOWED_ORIGINS=${address}`,
    // Статика среды — в той же сети Docker, адрес клиента приходит от неё.
    'TRUSTED_PROXY_CIDRS=127.0.0.1/32,172.16.0.0/12',
    ...(filesUrl ? [`S3_PUBLIC_ENDPOINT=${filesUrl}`] : []),
    'AUTH_MODE=local',
    'KMS_MODE=local',
    'SESSION_COOKIE_NAME=ul_session',
    'CSRF_COOKIE_NAME=ul_csrf',
    'REDIS_URL=redis://valkey:6379',
    'NATS_URL=nats://nats:4222',
    'NATS_USER=fifth',
    'NATS_STREAM=LAUNCH',
    `S3_ENDPOINT=${STORAGE_ENDPOINT}`,
    'S3_REGION=ru-central1',
    'S3_FORCE_PATH_STYLE=true',
    `S3_BUCKET=${names(id).bucket}`,
    `S3_ACCESS_KEY_ID=${keys.app.accessKeyId}`,
    `ARCHIVE_S3_BUCKET=${names(id).archive}`,
    `ARCHIVE_S3_ACCESS_KEY_ID=${keys.archive.accessKeyId}`,
    ...(pilot
      ? [
          'MAIL_TRANSPORT=smtp',
          `MAIL_FROM=no-reply-${id}@5espace.com`,
          `MAIL_SUBJECT_PREFIX=[${id}] `,
          'MAIL_SMTP_HOST=mail.5espace.com',
          'MAIL_SMTP_PORT=587',
          'MAIL_SMTP_SECURITY=starttls',
          'MAIL_SMTP_EHLO_NAME=mail.5espace.com',
          `MAIL_SMTP_USER=no-reply-${id}@5espace.com`,
        ]
      : ['MAIL_TRANSPORT=none']),
    'WEBHOOK_DELIVERY_MODE=capture',
    `TESTING_SESSIONS_ENABLED=${pilot ? 'false' : 'true'}`,
    ...Object.keys(secret)
      .filter((k) => !skipFile.has(k))
      .map((k) => `${k}_FILE=/run/secrets/${k}`),
  ];
  writeFileSync(join(n.dir, 'settings.env'), `${lines.join('\n')}\n`);
}

function imageId(ref) {
  const r = docker(['image', 'inspect', ref, '--format', '{{.Id}}']);
  if (r.status !== 0) throw new Error(`образа ${ref} нет — комплект не загружен`);
  return r.stdout.trim();
}

/** Бакеты и ключи среды: ключ видит только свой бакет. */
async function createStorage(id) {
  const n = names(id);
  const keys = {};
  for (const [role, bucket] of [
    ['app', n.bucket],
    ['archive', n.archive],
  ]) {
    const b = await garageApi('CreateBucket', { globalAlias: bucket });
    const k = await garageApi('CreateKey', { name: `${bucket}-key` });
    await garageApi('AllowBucketKey', {
      bucketId: b.id,
      accessKeyId: k.accessKeyId,
      permissions: { read: true, write: true, owner: false },
    });
    keys[role] = { accessKeyId: k.accessKeyId, secretAccessKey: k.secretAccessKey };
  }
  return keys;
}

async function removeBucket(alias, key) {
  let bucket;
  try {
    bucket = await garageApi(
      'GetBucketInfo',
      undefined,
      `?globalAlias=${encodeURIComponent(alias)}`,
    );
  } catch (e) {
    if (e.status === 404) return;
    throw e;
  }
  const store = {
    endpoint: STORAGE_ENDPOINT_HOST,
    region: 'ru-central1',
    bucket: alias,
    accessKey: key.accessKeyId,
    secretKey: key.secretAccessKey,
  };
  for (;;) {
    const r = await s3Object(store, 'GET', '', null, {}, { 'list-type': '2' });
    if (!r.ok) throw new Error(`список бакета ${alias}: HTTP ${r.status}`);
    const found = [...(await r.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    if (!found.length) break;
    for (const k of found) await s3Object(store, 'DELETE', k);
  }
  await garageApi('DeleteBucket', {}, `?id=${bucket.id}`);
}

function schemaVersion(id) {
  const r = compose(id, [
    'exec',
    '-T',
    'postgres',
    'sh',
    '-c',
    `PGPASSWORD="$(cat /run/secrets/POSTGRES_PASSWORD)" psql -h 127.0.0.1 -U fifth_owner -d fifth_element -Atc "select count(*), max(id) from public.schema_migrations"`,
  ]);
  const [count, last] = r.stdout.trim().split('|');
  return { applied: Number(count), last };
}

/** Служебный /ready ядра изнутри контейнера. */
/** Активный слот ядра среды по её файлу маршрута; без слотов — core. */
function activeSlotService(id) {
  const routeFile = join(names(id).dir, 'release', 'core-route.json');
  return existsSync(routeFile) && JSON.parse(readFileSync(routeFile, 'utf8')).slot === 'core-b'
    ? 'core-b'
    : 'core';
}

function readiness(id) {
  // Среда на слотах — активный слот по её файлу маршрута (блок 09, задание 4).
  const service = activeSlotService(id);
  const r = compose(
    id,
    [
      ...(service === 'core-b' ? ['--profile', 'slot-b'] : []),
      'exec',
      '-T',
      service,
      'node',
      '-e',
      `Promise.all(['live','ready'].map((p)=>fetch('http://127.0.0.1:${INTERNAL_PORT}/'+p,{signal:AbortSignal.timeout(8000)}).then(async(r)=>({status:r.status,body:await r.json()})))).then((x)=>console.log(JSON.stringify(x)),(e)=>{console.log(JSON.stringify({error:e.message}));process.exit(1)})`,
    ],
    // Замёрзшее ядро не должно подвешивать команду: нет ответа — не готово.
    { allowFail: true, timeout: 15_000 },
  );
  try {
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop());
    if (!Array.isArray(parsed)) return { live: false, ready: false, detail: parsed };
    return {
      live: parsed[0].status === 200,
      ready: parsed[1].status === 200,
      detail: parsed[1].body,
    };
  } catch {
    return { live: false, ready: false, detail: null };
  }
}

async function waitReady(id) {
  const until = Date.now() + READY_TIMEOUT_MS;
  let last = null;
  while (Date.now() < until) {
    last = readiness(id);
    if (last.ready) return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return last;
}

async function loadStoreAdmin() {
  if (process.env.GARAGE_ADMIN_TOKEN) return;
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return;
  const vars = parseEnvFile(file);
  for (const k of ['GARAGE_ADMIN_TOKEN', 'GARAGE_ADMIN_PORT', 'GARAGE_ADMIN_URL']) {
    if (vars[k] && !process.env[k]) process.env[k] = vars[k];
  }
}

async function create(id) {
  const kit = flag('--kit');
  const port = flag('--web-port');
  if (!kit || !/^\d+$/.test(port ?? ''))
    throw new Refused('нужны --kit <метка> и --web-port <порт>');
  const n = names(id);
  if (existsSync(join(n.dir, 'install.json'))) throw new Refused(`среда ${id} уже установлена`);
  const images = {
    core: `fifth/core:${kit}`,
    web: `fifth/web:${kit}`,
    postgres: `fifth/postgres:${kit}`,
  };
  const digests = Object.fromEntries(Object.entries(images).map(([k, v]) => [k, imageId(v)]));
  const address = flag('--address') || `http://127.0.0.1:${port}`;
  mkdirSync(n.dir, { recursive: true });
  chmodSync(n.dir, 0o700);
  installCompose(id, kit);
  const keys = await createStorage(id);
  const pilot = process.argv.includes('--pilot');
  writeSettings(id, { address, keys, filesUrl: flag('--files-url'), pilot });
  writeFileSync(
    join(n.dir, 'storage.json'),
    `${JSON.stringify({ app: keys.app, archive: keys.archive }, null, 2)}\n`,
  );
  chmodSync(join(n.dir, 'storage.json'), 0o600);
  writeFileSync(
    join(n.dir, 'compose.env'),
    [
      `FIFTH_PROJECT=${n.project}`,
      `FIFTH_ENV_DIR=${n.dir.replace(/\\/g, '/')}`,
      `FIFTH_CORE_IMAGE=${images.core}`,
      `FIFTH_WEB_IMAGE=${images.web}`,
      `FIFTH_POSTGRES_IMAGE=${images.postgres}`,
      `FIFTH_WEB_PORT=${port}`,
      `FIFTH_ENV_LABEL=${pilot ? 'Пилотная среда' : 'Тестовый режим'}`,
      ...(pilot ? PILOT_LIMITS : []),
      // Роль IdP создаёт скрипт инициализации образа; значение своё у каждой среды.
      `FIFTH_KEYCLOAK_DB_PASSWORD=${hex(24)}`,
      `FIFTH_STORAGE_NETWORK=${STORAGE_NETWORK}`,
      '',
    ].join('\n'),
  );
  saveInstall(id, {
    env: id,
    project: n.project,
    purpose: pilot ? 'pilot' : 'technical',
    kit: { label: kit, images: digests },
    address,
    webPort: Number(port),
    schema: null,
    dataset: null,
    createdAt: new Date().toISOString(),
  });
  compose(id, ['up', '-d', 'postgres', 'valkey', 'nats', '--wait']);
  compose(id, ['run', '--rm', 'migrate']);
  compose(id, ['up', '-d', 'core', 'web']);
  const state = await waitReady(id);
  const install = loadInstall(id);
  install.schema = schemaVersion(id);
  saveInstall(id, install);
  const ok = Boolean(state?.ready);
  finish(
    {
      ok,
      env: id,
      address,
      kit: kit,
      schema: install.schema,
      ready: ok,
      message: `среда ${id}: ${ok ? 'готова' : 'не готова'}, ${address}`,
    },
    ok ? 0 : 1,
  );
}

async function status(id) {
  const install = loadInstall(id);
  // Все профили: на слотах активным может быть core-b (блок 09, задание 4).
  const ps = compose(id, ['--profile', 'slot-b', 'ps', '--format', '{{.Service}}={{.State}}'], {
    allowFail: true,
  });
  const services = Object.fromEntries(
    ps.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('=')),
  );
  // Готовность — по активному слоту: после переключения на core-b прежний core остановлен,
  // и проверка по нему называла рабочую среду неготовой (испытания задания 4).
  const active = activeSlotService(id);
  const state = services[active] === 'running' ? readiness(id) : { live: false, ready: false };
  finish(
    {
      ok: state.ready,
      env: id,
      services,
      live: state.live,
      ready: state.ready,
      checks: state.detail?.checks ?? state.detail ?? null,
      kit: install.kit,
      schema: install.schema,
      dataset: install.dataset,
      message: `среда ${id}: ${state.ready ? 'готова' : 'не готова'}`,
    },
    state.ready ? 0 : 1,
  );
}

/** Перевод среды на другие образы: миграции одним шагом, затем ядро и статика. */
async function update(id) {
  const kit = flag('--kit');
  if (!kit) throw new Refused('нужен --kit <метка>');
  const install = loadInstall(id);
  const images = {
    core: `fifth/core:${kit}`,
    web: `fifth/web:${kit}`,
    postgres: `fifth/postgres:${kit}`,
  };
  const digests = Object.fromEntries(Object.entries(images).map(([k, v]) => [k, imageId(v)]));
  // База перезапускается только при новом образе: смена метки без смены образа
  // пересоздала бы контейнер и оборвала соединения без причины.
  const imagesOnly = process.argv.includes('--images-only');
  if (imagesOnly) digests.postgres = install.kit?.images?.postgres;
  const samePostgres = install.kit?.images?.postgres === digests.postgres;
  const file = join(names(id).dir, 'compose.env');
  const lines = readFileSync(file, 'utf8')
    .replace(/^FIFTH_CORE_IMAGE=.*$/m, `FIFTH_CORE_IMAGE=${images.core}`)
    .replace(/^FIFTH_WEB_IMAGE=.*$/m, `FIFTH_WEB_IMAGE=${images.web}`)
    .replace(/^FIFTH_POSTGRES_IMAGE=.*$/m, (line) =>
      samePostgres ? line : `FIFTH_POSTGRES_IMAGE=${images.postgres}`,
    );
  writeFileSync(
    file,
    /^FIFTH_ENV_LABEL=/m.test(lines) ? lines : `${lines}FIFTH_ENV_LABEL=Тестовый режим\n`,
  );
  installCompose(id, kit);
  if (imagesOnly) compose(id, ['up', '-d', '--no-deps', 'core', 'web']);
  else {
    compose(id, ['up', '-d', 'postgres', 'valkey', 'nats', '--wait']);
    compose(id, ['run', '--rm', 'migrate']);
    compose(id, ['up', '-d', 'core', 'web']);
  }
  const state = await waitReady(id);
  install.kit = { label: kit, images: digests };
  install.schema = schemaVersion(id);
  saveInstall(id, install);
  const ok = Boolean(state?.ready);
  finish({ ok, env: id, kit, schema: install.schema, ready: ok }, ok ? 0 : 1);
}

/** Данные людей: автоматика такую среду не останавливает и не удаляет. */
function guardPilot(id, install) {
  if (install.purpose === 'pilot' && flag('--pilot-confirm') !== id) {
    throw new Refused(`среда ${id} пилотная: нужен --pilot-confirm ${id}`);
  }
}

function stop(id) {
  guardPilot(id, loadInstall(id));
  compose(id, ['stop']);
  finish({ ok: true, env: id, message: `среда ${id}: остановлена, данные сохранены` }, 0);
}

async function start(id) {
  loadInstall(id);
  compose(id, ['up', '-d', 'postgres', 'valkey', 'nats', 'core', 'web']);
  const state = await waitReady(id);
  const ok = Boolean(state?.ready);
  finish(
    { ok, env: id, ready: ok, message: `среда ${id}: ${ok ? 'готова' : 'не готова'}` },
    ok ? 0 : 1,
  );
}

function seed(id) {
  const install = loadInstall(id);
  const file = flag('--set');
  if (!file || !existsSync(file)) throw new Refused('нужен --set <файл.sql>');
  const sql = readFileSync(file);
  const r = spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      join(names(id).dir, 'compose.env'),
      '-f',
      composeOf(id),
      'exec',
      '-T',
      'postgres',
      'sh',
      '-c',
      'PGPASSWORD="$(cat /run/secrets/POSTGRES_PASSWORD)" psql -h 127.0.0.1 -v ON_ERROR_STOP=1 -U fifth_owner -d fifth_element',
    ],
    { input: sql, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  if (r.status !== 0) throw new Error(`набор не загружен: ${r.stderr.trim().split('\n').pop()}`);
  install.dataset = {
    name: file.split(/[\\/]/).pop(),
    sha256: createHash('sha256').update(sql).digest('hex'),
    at: new Date().toISOString(),
  };
  saveInstall(id, install);
  finish({ ok: true, env: id, dataset: install.dataset, message: `набор загружен в ${id}` }, 0);
}

async function destroy(id) {
  if (flag('--confirm') !== id) throw new Refused(`удаление данных: нужен --confirm ${id}`);
  guardPilot(id, loadInstall(id));
  const n = names(id);
  compose(id, ['--profile', 'tools', '--profile', 'slot-b', 'down', '-v', '--remove-orphans']);
  const keys = JSON.parse(readFileSync(join(n.dir, 'storage.json'), 'utf8'));
  await removeBucket(n.bucket, keys.app);
  await removeBucket(n.archive, keys.archive);
  for (const k of [keys.app, keys.archive]) {
    await garageApi('DeleteKey', {}, `?id=${k.accessKeyId}`);
  }
  rmSync(n.dir, { recursive: true, force: true });
  // Удалённая среда больше не держит комплекты.
  rmSync(join(KITS, 'pins', `${id}.json`), { force: true });
  finish({ ok: true, env: id, message: `среда ${id}: удалена с данными` }, 0);
}

/** Образы, которые Compose возьмёт для среды: тот же путь, что у запуска, но без запуска. */
function images(id) {
  loadInstall(id);
  const list = compose(id, ['config', '--images']).stdout.trim().split('\n');
  finish({ ok: true, env: id, images: list, message: list.join(' ') }, 0);
}

/** Применённые миграции среды (реестр в её базе). */
function appliedMigrations(id) {
  const r = compose(id, [
    'exec',
    '-T',
    'postgres',
    'sh',
    '-c',
    'PGPASSWORD="$(cat /run/secrets/POSTGRES_PASSWORD)" psql -h 127.0.0.1 -U fifth_owner -d fifth_element -Atc "select id from public.schema_migrations order by id"',
  ]);
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Contract-миграции в образе ядра сборки: по метке `-- migrate:contract` в файле. */
function contractMigrationsOf(label) {
  const r = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      `fifth/core:${label}`,
      '-c',
      "grep -l '^-- migrate:contract' /app/database/migrations/*.sql || true",
    ],
    { encoding: 'utf8', env: composeEnv(), timeout: 120_000 },
  );
  if (r.status !== 0)
    throw new Error(`образ ядра ${label}: ${(r.stderr ?? '').trim().slice(-200)}`);
  return r.stdout
    .split('\n')
    .map((l) =>
      l
        .trim()
        .split('/')
        .pop()
        ?.replace(/\.sql$/, ''),
    )
    .filter(Boolean);
}

/** Строка KEY=VALUE в compose.env среды: заменить или добавить. */
function setComposeEnv(id, key, value) {
  const file = join(names(id).dir, 'compose.env');
  const text = readFileSync(file, 'utf8');
  const re = new RegExp(`^${key}=.*$`, 'm');
  writeFileSync(
    file,
    re.test(text)
      ? text.replace(re, `${key}=${value}`)
      : `${text.replace(/\n?$/, '\n')}${key}=${value}\n`,
  );
}

const slotEnv = (id) => ({
  dir: names(id).dir,
  project: names(id).project,
  webPort: loadInstall(id).webPort,
  compose: (args, opts) => compose(id, args, opts),
  setComposeEnv: (key, value) => setComposeEnv(id, key, value),
});

/**
 * Перевод среды на слоты ядра (блок 09, задание 3) — разовый, с коротким перерывом: ядро
 * и web пересоздаются с файлами маршрута и разрешения. Пилотную среду — только с
 * --pilot-confirm.
 */
async function slotsEnable(id) {
  const install = loadInstall(id);
  guardPilot(id, install);
  if (install.slots) throw new Refused(`среда ${id} уже на слотах`);
  const label = install.kit?.label;
  if (!label) throw new Refused('у среды нет сборки');
  prepareSlots(names(id).dir, label, envLayout(names(id).project));
  setComposeEnv(id, 'FIFTH_SLOTS', '1');
  setComposeEnv(id, 'FIFTH_CORE_A_IMAGE', `fifth/core:${label}`);
  setComposeEnv(id, 'FIFTH_CORE_A_BUILD', label);
  compose(id, ['up', '-d', '--force-recreate', 'core', 'web']);
  const state = await waitReady(id);
  install.slots = { active: 'core-a', build: label, since: new Date().toISOString() };
  saveInstall(id, install);
  const ok = Boolean(state?.ready);
  finish(
    {
      ok,
      env: id,
      slots: install.slots,
      message: `среда ${id}: слоты ${ok ? 'включены' : 'включены, ядро не готово'}`,
    },
    ok ? 0 : 1,
  );
}

/**
 * Возврат тестовой среды с режима слотов к одному ядру (план выпуска W31–W33, раздел 5; то же,
 * что `release.mjs slots-disable` для рабочей среды): core-b останавливается и удаляется, флаг
 * снимается, ядро и web пересоздаются без дополнения слотов. Только когда активен core-a и web
 * той же сборки — иначе одноядерная раскладка подняла бы другую сборку.
 */
async function slotsDisable(id) {
  const install = loadInstall(id);
  guardPilot(id, install);
  if (!install.slots) throw new Refused(`среда ${id} не на слотах`);
  const label = install.slots.build;
  if (install.slots.active !== 'core-a')
    throw new Refused(`активен ${install.slots.active}: выключение слотов — только с core-a`);
  const envText = readFileSync(join(names(id).dir, 'compose.env'), 'utf8');
  if (!new RegExp(`^FIFTH_WEB_IMAGE=.*:${label.replace(/\./g, '\\.')}$`, 'm').test(envText))
    throw new Refused(`web среды не сборки ${label}: без слотов поднялась бы другая статика`);
  // core-b известен Compose только с дополнением слотов — убрать до снятия флага.
  compose(id, ['--profile', 'slot-b', 'rm', '-sf', 'core-b'], { allowFail: true });
  const file = join(names(id).dir, 'compose.env');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^FIFTH_SLOTS=1\n?/m, ''));
  setComposeEnv(id, 'FIFTH_CORE_IMAGE', `fifth/core:${label}`);
  compose(id, ['up', '-d', '--force-recreate', 'core', 'web']);
  const state = await waitReady(id);
  delete install.slots;
  saveInstall(id, install);
  const ok = Boolean(state?.ready);
  finish(
    {
      ok,
      env: id,
      build: label,
      message: `среда ${id}: слоты выключены, одно ядро ${label}${ok ? '' : ', ядро не готово'}`,
    },
    ok ? 0 : 1,
  );
}

/**
 * Выпуск через переключение слотов (блок 09, задание 3): расширение схемы, кандидат в
 * свободном слоте, пауза фона старого, маршрут, подтверждение запросом, фон кандидату,
 * наблюдение, завершение старого. Возврат в наблюдении — только с --auto-rollback.
 */
async function slotsUpdate(id) {
  const kit = flag('--kit');
  if (!kit) throw new Refused('нужен --kit <метка>');
  const install = loadInstall(id);
  guardPilot(id, install);
  if (!install.slots) throw new Refused(`среда ${id} не на слотах: сначала slots-enable`);
  const from = install.slots.active;
  const to = from === 'core-a' ? 'core-b' : 'core-a';
  const prev = install.slots.build;
  // Журнал слотов связан с операцией установщика, если она есть (release.mjs install).
  const op = flag('--op') ?? `slots-${Date.now()}`;
  // Contract-миграция кандидата (задание 4; Тэнк 09.11, п. 5) не идёт поверх обслуживающего
  // старого ядра: отдельный порядок с остановкой и только с явным согласием на перерыв.
  const applied = new Set(appliedMigrations(id));
  const contract = contractMigrationsOf(kit).filter((m) => !applied.has(m));
  if (contract.length && !process.argv.includes('--allow-contract')) {
    throw new Refused(
      `в кандидате contract-миграции ${contract.join(', ')}: бесшовный выпуск невозможен — порядок с остановкой только с --allow-contract`,
    );
  }
  // Изменения среды — только после проверки на contract: отказ ничего не трогает.
  extractStatic(names(id).dir, kit);
  setComposeEnv(id, 'FIFTH_CORE_IMAGE', `fifth/core:${kit}`);
  const ops = envSlotOps(slotEnv(id), op);
  let result;
  if (contract.length) {
    ops.migrate = async () => {
      const before = appliedMigrations(id).length;
      const r = compose(id, ['run', '--rm', 'migrate'], { allowFail: true });
      const after = appliedMigrations(id).length;
      return r.status === 0
        ? { ok: true, detail: `применено ${after - before}` }
        : { ok: false, applied: after > before, detail: `миграции: код ${r.status}` };
    };
    ops.startSlot = async (slot) => {
      compose(id, [
        '--profile',
        'slot-b',
        'up',
        '-d',
        '--no-deps',
        slot === 'core-b' ? 'core-b' : 'core',
      ]);
    };
    result = await contractRelease(ops, { from, to, build: kit, prevBuild: prev });
  } else {
    // Расширение схемы — до кандидата (9.2): прежний код совместим с ним (задание 2).
    compose(id, ['run', '--rm', 'migrate']);
    result = await switchSlots(ops, {
      from,
      to,
      build: kit,
      prevBuild: prev,
      autoRollback: process.argv.includes('--auto-rollback'),
      limits: {
        observeMs: Number(flag('--observe-ms') ?? 600_000),
        drainWaitMs: Number(flag('--drain-ms') ?? 300_000),
        confirmSamples: 5,
      },
    });
  }
  if (result.active !== 'unknown' && result.active !== 'none') {
    install.slots = {
      active: result.active,
      build: result.active === to ? kit : prev,
      since: new Date().toISOString(),
    };
    install.kit = { ...install.kit, label: install.slots.build };
    install.schema = schemaVersion(id);
    saveInstall(id, install);
  }
  finish(
    {
      ...result,
      env: id,
      op,
      message: `среда ${id}: ${result.ok ? 'переключена' : `отказ на шаге ${result.stage}`} — ${result.detail}`,
    },
    result.ok ? 0 : 1,
  );
}

/** Фактическое состояние слотов после обрыва: маршрут, разрешение, ответ через nginx, фон. */
async function slotsState(id) {
  loadInstall(id);
  const state = await factualState(envSlotOps(slotEnv(id), 'state'));
  finish({ ok: state.consistent, env: id, ...state }, state.consistent ? 0 : 1);
}

const COMMANDS = {
  create,
  status,
  stop,
  start,
  seed,
  update,
  destroy,
  images,
  'slots-enable': slotsEnable,
  'slots-update': slotsUpdate,
  'slots-disable': slotsDisable,
  'slots-state': slotsState,
};

try {
  const [command, id] = argv;
  if (!COMMANDS[command]) throw new Refused(`команды нет: ${command ?? '(нет)'}`);
  needEnv(id);
  await loadStoreAdmin();
  await COMMANDS[command](id);
} catch (e) {
  const refused = e instanceof Refused;
  finish({ ok: false, refused, error: e.message, message: e.message }, refused ? 2 : 1);
}
