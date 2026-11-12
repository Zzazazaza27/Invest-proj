/**
 * Изолированная среда испытаний отказов (работа № 4 раздела 01; 2.1.6 «основа испытаний»).
 *
 * Всё своё и с именами `fifth-faults-*`: сеть, PostgreSQL, три узла Garage (как на VPS:
 * replication_factor 3, consistent, одна зона), ядро из ТЕКУЩЕГО кода (образ
 * `fifth/core:faults`, собирается из рабочего дерева) с пределом памяти. Стенд разработчика,
 * test-1, test-2 и prod не затрагиваются: адреса и токены Garage — только этой среды, имена
 * контейнеров жёсткие и не берутся из окружения. Секреты создаются на запуск, живут в памяти
 * прогона и передаются контейнерам через окружение docker (не в командной строке).
 *
 * Ресурсы ограничены (WSL на ноутбуке — 4 ГБ): база 384 МБ, узел Garage 160 МБ, ядро — по
 * сценарию (по умолчанию 512 МБ). Весь набор — меньше 1,5 ГБ.
 */
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parseEnvFile } from './backup.mjs';
import { GARAGE_IMAGE } from './garage-admin.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const NET = 'fifth-faults';
export const PG = 'fifth-faults-pg';
export const PG_PORT = 55441;
export const NODES = ['fifth-faults-garage-1', 'fifth-faults-garage-2', 'fifth-faults-garage-3'];
export const S3_PORT = 13900;
export const ADMIN_PORT = 13903;
export const CORE = 'fifth-faults-core';
/** Сосед первого узла с его томом данных: `df` и заполнение «диска» (сценарий места). */
export const DISK = 'fifth-faults-disk';
export const CORE_PORT = 14300;
export const CORE_INTERNAL_PORT = 14400;
export const CORE_IMAGE = 'fifth/core:faults';
export const BUCKET = 'fifth-faults';
export const BASE = `http://127.0.0.1:${CORE_PORT}`;
const VOLUMES = NODES.flatMap((n) => [`${n}-meta`, `${n}-data`]);

const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout ?? 180_000,
    input: opts.input,
    cwd: opts.cwd,
    env: { ...process.env, MSYS_NO_PATHCONV: '1', ...(opts.env ?? {}) },
  });
export const docker = (...args) => sh('docker', args);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const must = (r, what) => {
  if (r.status !== 0)
    throw new Error(`${what}: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  return r.stdout.trim();
};

/** Секреты прогона — в памяти. */
const hex = (n) => randomBytes(n).toString('hex');
export const secrets = {
  pg: hex(16),
  rpc: hex(32),
  admin: randomBytes(32).toString('base64url'),
  appKey: { id: `GK${hex(12)}`, secret: hex(32) },
  ownerKey: { id: `GK${hex(12)}`, secret: hex(32) },
  roles: Object.fromEntries(
    [
      'BACKEND',
      'PUBLIC',
      'NOTIFICATIONS',
      'INTEGRATION',
      'READONLY',
      'MAINTENANCE',
      'AUTH',
      'ARCHIVE',
      'RELEASE',
    ].map((r) => [r, hex(16)]),
  ),
};
const standEnv = parseEnvFile(join(ROOT, '.env'), { secrets: true });
export const ownerUrl = () =>
  `postgres://unicorn_owner:${secrets.pg}@127.0.0.1:${PG_PORT}/fifth_element`;

// ---------------------------------------------------------------- Garage admin

export async function garage(name, body, query = '') {
  const r = await fetch(`http://127.0.0.1:${ADMIN_PORT}/v2/${name}${query}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${secrets.admin}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  if (!r.ok) {
    const e = new Error(`${name}: HTTP ${r.status} ${text.slice(0, 200)}`);
    e.status = r.status;
    throw e;
  }
  return text ? JSON.parse(text) : null;
}
/** CLI узла (тот же токен; узел должен работать). */
export const garageCli = (node, ...args) => docker('exec', node, '/garage', ...args);

// ---------------------------------------------------------------- подъём и уборка

export function down() {
  docker('rm', '-f', CORE, PG, DISK, ...NODES);
  docker('volume', 'rm', '-f', ...VOLUMES, `${PG}-data`);
  docker('network', 'rm', NET);
}

/**
 * Поднять среду. `garageDataTmpfs` — размер данных узла в памяти (сценарий заполнения диска;
 * такие узлы нельзя останавливать — данные пропадут). `core` — запускать ли ядро.
 */
export async function up({
  garageDataTmpfs = null,
  core = true,
  coreMem = '512m',
  coreEnv = {},
} = {}) {
  down();
  must(docker('network', 'create', NET), 'сеть');
  {
    // ---- PostgreSQL
    must(
      sh(
        'docker',
        [
          'run',
          '-d',
          '--name',
          PG,
          '--network',
          NET,
          '--memory',
          '384m',
          '-e',
          'POSTGRES_USER=unicorn_owner',
          '-e',
          'POSTGRES_PASSWORD',
          '-e',
          'POSTGRES_DB=fifth_element',
          '-p',
          `127.0.0.1:${PG_PORT}:5432`,
          '-v',
          `${PG}-data:/var/lib/postgresql/data`,
          'fifth/postgres:16',
        ],
        { env: { POSTGRES_PASSWORD: secrets.pg } },
      ),
      'PostgreSQL',
    );
    // ---- Garage: конфигурация рабочая (infra/garage/garage.toml)
    for (const node of NODES) {
      // Маленький «диск» узла: том в памяти заданного размера. Том общий с соседом-наблюдателем
      // (`df` внутри — у образа Garage оболочки нет); пока узел работает, данные на месте.
      if (garageDataTmpfs) {
        must(
          docker(
            'volume',
            'create',
            '--driver',
            'local',
            '--opt',
            'type=tmpfs',
            '--opt',
            'device=tmpfs',
            '--opt',
            `o=size=${garageDataTmpfs}`,
            `${node}-data`,
          ),
          `том ${node}`,
        );
      }
      runNode(node);
    }
    if (garageDataTmpfs) {
      must(
        docker(
          'run',
          '-d',
          '--name',
          DISK,
          '--network',
          NET,
          // Балласт в томе-в-памяти засчитывается памяти этого контейнера: предел больше тома.
          '--memory',
          '256m',
          // Том узла принадлежит root (Garage работает от root) — балласт пишется от root.
          '--user',
          '0',
          '-v',
          `${NODES[0]}-data:/data`,
          '-v',
          `${NODES[1]}-data:/data2`,
          '-v',
          `${NODES[2]}-data:/data3`,
          '--entrypoint',
          'sleep',
          'fifth/postgres:16',
          'infinity',
        ),
        'наблюдатель диска',
      );
    }
    await waitPg();
    await initGarage();
    migrate();
    if (core) await startCore({ mem: coreMem, env: coreEnv });
  }
}

/** Контейнер узла Garage (тома — по имени узла; данные и метаданные переживают пересоздание). */
export function runNode(node) {
  const args = [
    'run',
    '-d',
    '--name',
    node,
    '--network',
    NET,
    '--memory',
    '160m',
    '-e',
    'GARAGE_RPC_SECRET',
    '-e',
    'GARAGE_ADMIN_TOKEN',
    '-v',
    `${join(ROOT, 'infra', 'garage', 'garage.toml')}:/etc/garage.toml:ro`,
    '-v',
    `${node}-meta:/var/lib/garage/meta`,
    '-v',
    `${node}-data:/var/lib/garage/data`,
  ];
  if (node === NODES[0])
    args.push('-p', `127.0.0.1:${S3_PORT}:3900`, '-p', `127.0.0.1:${ADMIN_PORT}:3903`);
  args.push(GARAGE_IMAGE, '/garage', 'server');
  must(
    sh('docker', args, {
      env: { GARAGE_RPC_SECRET: secrets.rpc, GARAGE_ADMIN_TOKEN: secrets.admin },
    }),
    node,
  );
}

/** Диск узла потерян: данные стёрты, метаданные (идентичность узла) сохранены. */
export function wipeNodeData(node) {
  docker('rm', '-f', node);
  must(docker('volume', 'rm', '-f', `${node}-data`), `том ${node}`);
  runNode(node);
}

/**
 * Новый диск узла принят оператором. Garage на пустом каталоге данных не запускается (защита от
 * неподключённого диска); его порядок: убрать `data_layout` из каталога метаданных — Garage
 * заново размечает новый каталог и пишет свою метку `garage-marker`. Затем запуск узла.
 */
export function acceptNewDisk(node) {
  must(
    docker(
      'run',
      '--rm',
      '--user',
      '0',
      '-v',
      `${node}-meta:/m`,
      'fifth/postgres:16',
      'rm',
      '-f',
      '/m/data_layout',
    ),
    `разметка ${node}`,
  );
  must(docker('start', node), `запуск ${node}`);
}

/** Работает ли контейнер (узел, отказавшийся стартовать, — нет). */
export const running = (name) =>
  docker('inspect', '-f', '{{.State.Running}}', name).stdout.trim() === 'true';

async function waitPg() {
  for (let i = 0; i < 60; i++) {
    const r = docker('exec', PG, 'pg_isready', '-U', 'unicorn_owner', '-d', 'fifth_element');
    if (r.status === 0) return;
    await sleep(1000);
  }
  throw new Error('PostgreSQL среды не поднялся');
}

async function initGarage() {
  let ids;
  for (let i = 0; i < 60; i++) {
    ids = NODES.map((n) => garageCli(n, 'node', 'id', '-q'));
    if (ids.every((r) => r.status === 0)) break;
    await sleep(1000);
  }
  ids = ids.map((r, i) => {
    if (r.status !== 0) throw new Error(`${NODES[i]}: ${r.stderr.trim()}`);
    return r.stdout.trim().split('@')[0];
  });
  for (let i = 0; i < 30; i++) {
    try {
      await garage('GetClusterHealth');
      break;
    } catch {
      await sleep(1000);
    }
  }
  await garage(
    'ConnectClusterNodes',
    ids.slice(1).map((id, i) => `${id}@${NODES[i + 1]}:3901`),
  );
  await garage('UpdateClusterLayout', {
    roles: ids.map((id, i) => ({ id, zone: 'vps', capacity: 1024 ** 3, tags: [NODES[i]] })),
  });
  const staged = await garage('GetClusterLayout');
  await garage('ApplyClusterLayout', { version: staged.version + 1 });
  for (let i = 0; i < 60; i++) {
    const h = await garage('GetClusterHealth').catch(() => null);
    if (h?.status === 'healthy') break;
    await sleep(1000);
  }
  const b = await garage('CreateBucket', { globalAlias: BUCKET });
  for (const [k, name] of [
    [secrets.appKey, 'app'],
    [secrets.ownerKey, 'owner'],
  ]) {
    await garage('ImportKey', { accessKeyId: k.id, secretAccessKey: k.secret, name });
  }
  await garage('AllowBucketKey', {
    bucketId: b.id,
    accessKeyId: secrets.appKey.id,
    permissions: { read: true, write: true, owner: false },
  });
  await garage('AllowBucketKey', {
    bucketId: b.id,
    accessKeyId: secrets.ownerKey.id,
    permissions: { read: true, write: true, owner: true },
  });
}

function migrate() {
  const env = { DATABASE_URL_OWNER: ownerUrl(), DATABASE_URL: ownerUrl() };
  for (const [r, v] of Object.entries(secrets.roles)) env[`DB_ROLE_PASSWORD_APP_${r}`] = v;
  const cwd = join(ROOT, 'database');
  const node = (script) =>
    sh(process.execPath, ['--experimental-strip-types', script], { env, cwd, timeout: 600_000 });
  must(node('src/migrate.ts'), 'миграции');
  must(node('src/bootstrap-roles.ts'), 'роли');
}

/** Окружение ядра: настройки стенда без адресов его служб + адреса и секреты этой среды. */
function coreEnvironment(extra) {
  const drop =
    /^(DATABASE_URL|S3_|REDIS|NATS|MINIO|GARAGE|ARCHIVE_|BACKUP_|LOGS_|ZABBIX|MONITOR|CORE_|PUBLIC_BASE_URL|MAIL_|SMTP_|OPENBAO|VAULT|UPLOAD_COPY|BACKGROUND_CONTROL)/;
  const env = Object.fromEntries(Object.entries(standEnv).filter(([k]) => !drop.test(k)));
  const db = (user, role) => `postgres://${user}:${secrets.roles[role]}@${PG}:5432/fifth_element`;
  Object.assign(env, {
    NODE_ENV: 'development',
    CORE_BIND_HOST: '0.0.0.0',
    CORE_PORT: '4300',
    CORE_INTERNAL_BIND_HOST: '0.0.0.0',
    CORE_INTERNAL_PORT: '4400',
    CORE_PUBLIC_URL: BASE,
    PUBLIC_BASE_URL: BASE,
    DATABASE_URL: db('app_backend_user', 'BACKEND'),
    DATABASE_URL_APP_INTEGRATION: db('app_integration_user', 'INTEGRATION'),
    DATABASE_URL_APP_NOTIFICATIONS: db('app_notifications_user', 'NOTIFICATIONS'),
    DATABASE_URL_APP_MAINTENANCE: db('app_maintenance_user', 'MAINTENANCE'),
    DATABASE_URL_APP_AUTH: db('app_auth_user', 'AUTH'),
    DATABASE_URL_APP_ARCHIVE: db('app_archive_user', 'ARCHIVE'),
    DATABASE_URL_APP_RELEASE: db('app_release_user', 'RELEASE'),
    S3_ENDPOINT: `http://${NODES[0]}:3900`,
    S3_PUBLIC_ENDPOINT: `http://127.0.0.1:${S3_PORT}`,
    S3_REGION: 'ru-central1',
    S3_BUCKET: BUCKET,
    S3_FORCE_PATH_STYLE: 'true',
    S3_ACCESS_KEY_ID: secrets.appKey.id,
    S3_SECRET_ACCESS_KEY: secrets.appKey.secret,
    MAIL_TRANSPORT: 'none',
    AVAILABILITY_PROBE_INTERVAL_MS: '2000',
    ...extra,
  });
  return env;
}

export async function startCore({ mem = '512m', env = {}, volumes = [] } = {}) {
  docker('rm', '-f', CORE);
  const values = coreEnvironment(env);
  const args = [
    'run',
    '-d',
    '--name',
    CORE,
    '--network',
    NET,
    '--memory',
    mem,
    '--memory-swap',
    mem,
    '--restart',
    'unless-stopped',
    '-p',
    `127.0.0.1:${CORE_PORT}:4300`,
    '-p',
    `127.0.0.1:${CORE_INTERNAL_PORT}:4400`,
  ];
  for (const k of Object.keys(values)) args.push('-e', k);
  for (const v of volumes) args.push('-v', v);
  args.push(CORE_IMAGE);
  must(sh('docker', args, { env: values }), 'ядро');
  await waitCore();
}

export async function waitCore(timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${CORE_INTERNAL_PORT}/ready`, {
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) return;
    } catch {
      // ещё не поднялось
    }
    await sleep(1000);
  }
  const logs = docker('logs', '--tail', '30', CORE);
  throw new Error(`ядро среды не готово: ${(logs.stdout + logs.stderr).slice(-1500)}`);
}

// ---------------------------------------------------------------- узлы и сеть

export const stopNode = (n) => must(docker('stop', '-t', '5', n), `остановка ${n}`);
export const startNode = (n) => must(docker('start', n), `запуск ${n}`);
/** Разделение связи: узел вне сети среды (ни RPC с соседями, ни ядра). */
export const isolate = (n) => must(docker('network', 'disconnect', NET, n), `отключение ${n}`);
export const heal = (n) => must(docker('network', 'connect', NET, n), `подключение ${n}`);

export async function clusterNodesUp() {
  const s = await garage('GetClusterStatus');
  return s.nodes.filter((x) => x.isUp && x.role).length;
}

// ---------------------------------------------------------------- база и клиент

let pool;
export async function sql(text, params = []) {
  pool ??= new pg.Pool({ connectionString: ownerUrl(), max: 2 });
  return (await pool.query(text, params)).rows;
}
export async function closeSql() {
  await pool?.end();
  pool = undefined;
}

export function makeClient() {
  const state = { session: null, csrf: null };
  const sessionCookie = standEnv.SESSION_COOKIE_NAME ?? 'ul_session';
  const csrfCookie = standEnv.CSRF_COOKIE_NAME ?? 'ul_csrf';
  return {
    async call(path, { method = 'GET', body, timeout = 30_000 } = {}) {
      const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (method !== 'GET' && state.csrf)
        headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
      try {
        const r = await fetch(`${BASE}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeout),
        });
        for (const cookie of r.headers.getSetCookie?.() ?? []) {
          const pair = cookie.split(';')[0];
          if (cookie.startsWith(`${sessionCookie}=`)) state.session = pair;
          if (cookie.startsWith(`${csrfCookie}=`)) state.csrf = pair;
        }
        const raw = Buffer.from(await r.arrayBuffer());
        let json = null;
        try {
          json = JSON.parse(raw.toString('utf8'));
        } catch {
          // не JSON
        }
        return { status: r.status, json, raw };
      } catch (e) {
        return {
          status: 0,
          json: null,
          raw: Buffer.alloc(0),
          error: String(e?.cause?.code ?? e?.name ?? e),
        };
      }
    },
  };
}

const blindIndex = (email) =>
  createHmac('sha256', Buffer.from(standEnv.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
export const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

/** Участник и проект — в базе этой среды. */
export async function founderWithProject(label) {
  const email = `faults-${label}-${Date.now() % 1e9}@test.local`;
  const client = makeClient();
  const reg = await client.call('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password: `Pw-${randomUUID()}`,
      displayName: `Faults ${label}`,
      role: 'founder',
      locale: 'ru-RU',
      consents: CONSENTS,
    },
  });
  if (reg.status >= 300)
    throw new Error(`регистрация: HTTP ${reg.status} ${JSON.stringify(reg.json).slice(0, 200)}`);
  const [u] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [blindIndex(email)]);
  const taxonomy = (await client.call('/v1/taxonomy')).json;
  const created = await client.call('/v1/projects', {
    method: 'POST',
    body: {
      title: `Faults ${label} ${Date.now() % 1e9}`,
      stage: 'mvp',
      taxonomyId: (taxonomy.items ?? taxonomy)[0].id,
      investmentAsk: '1000000.00',
      askCurrency: 'RUB',
    },
  });
  if (!created.json?.id) throw new Error(`проект: HTTP ${created.status}`);
  return { client, userId: u.id, projectId: created.json.id };
}

/** Билет загрузки PDF. */
export async function uploadTicket(client, projectId, bytes, label = 'f') {
  return client.call(`/v1/projects/${projectId}/materials/upload`, {
    method: 'POST',
    body: {
      type: 'deck',
      fileName: `deck-${label}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: bytes.length,
    },
  });
}

/**
 * Передача файла формой. `chunkDelayMs` — медленная передача (опыт срока формы): тело идёт
 * частями с паузами, длительность ≈ число частей × пауза.
 */
export async function postForm(
  ticket,
  bytes,
  { chunks = 1, chunkDelayMs = 0, timeout = 60_000 } = {},
) {
  const form = new FormData();
  for (const [k, v] of Object.entries(ticket.formFields)) form.append(k, v);
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'deck.pdf');
  let body = form;
  let headers;
  if (chunks > 1) {
    const req = new Request('http://x/', { method: 'POST', body: form });
    headers = { 'Content-Type': req.headers.get('content-type') };
    const all = Buffer.from(await req.arrayBuffer());
    const size = Math.ceil(all.length / chunks);
    body = new ReadableStream({
      async start(controller) {
        for (let i = 0; i < all.length; i += size) {
          controller.enqueue(all.subarray(i, i + size));
          if (i + size < all.length) await sleep(chunkDelayMs);
        }
        controller.close();
      },
    });
  }
  try {
    const r = await fetch(ticket.uploadUrl, {
      method: 'POST',
      body,
      headers,
      duplex: 'half',
      signal: AbortSignal.timeout(timeout),
    });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, text: String(e?.cause?.code ?? e?.name ?? e) };
  }
}

export const finalize = (client, projectId, materialId) =>
  client.call(`/v1/projects/${projectId}/materials/${materialId}/finalize`, { method: 'POST' });

export const pdf = (label, size = 0) =>
  Buffer.concat([Buffer.from(`%PDF-1.4 faults ${label} ${randomUUID()}\n`), randomBytes(size)]);

/** Подсчёт итогов прогона. */
export function checker() {
  const state = { passed: 0, failed: 0, notes: [] };
  const check = (name, ok, detail = '') => {
    if (ok) state.passed++;
    else state.failed++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const note = (s) => {
    state.notes.push(s);
    console.log(`  ·     ${s}`);
  };
  return { check, note, state };
}

export function writeReport(name, state) {
  const dir = join(ROOT, 'out', 'faults');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ ...state, at: new Date().toISOString() }, null, 2));
  return file;
}
