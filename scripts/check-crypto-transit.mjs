#!/usr/bin/env node
/**
 * CryptoService на настоящем OpenBao с искусственными ключами (блок 5, задание 4).
 *
 *   node scripts/check-crypto-transit.mjs
 *
 * Поднимает контейнер, импортирует ключи контрольных примеров, выдаёт токен с рабочей политикой
 * ядра и запускает apps/core/tests/crypto-transit.live.test.ts. Рабочих ключей здесь нет.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_IMAGE } from './lib/backup.mjs';
import { MIGRATE_TARGETS, migrateTarget, verifyTarget } from './lib/crypto-migrate.mjs';
import { importTransitKey } from './lib/openbao-import.mjs';
import { repack, rewrapTarget, rotateKey } from './lib/transit-rotate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pg = createRequire(join(ROOT, 'apps', 'core', 'package.json'))('pg');
const IMAGE = process.env.OPENBAO_IMAGE || 'openbao/openbao:2.7.2';
const NAME = 'fifth-crypto-transit';
const PORT = 18203;
const ADDR = `http://127.0.0.1:${PORT}`;
const ROOT_TOKEN = 'lab-only-root';
const PG = 'fifth-crypto-migrate-pg';
const PG_PORT = 15499;
const base = mkdtempSync(join(tmpdir(), 'crypto-transit-'));
const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (d) => createHash('sha256').update(`fifth-vectors:${d}`).digest();

function call(method, path, { token = ROOT_TOKEN, body } = {}) {
  return new Promise((done, fail) => {
    const req = request(
      `${ADDR}/v1/${path}`,
      { method, headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => done({ status: res.statusCode, json: text ? JSON.parse(text) : {} }));
      },
    );
    req.on('error', fail);
    req.setTimeout(10_000, () => req.destroy(new Error('таймаут')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function must(what, promise) {
  const r = await promise;
  if (r.status >= 300) throw new Error(`${what}: код ${r.status} ${JSON.stringify(r.json.errors)}`);
  return r;
}

/** Старый формат: тот же, что у прежнего CryptoService. */
function legacyWrap(domain, plain, aad) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(domain), iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

async function checkMigration() {
  console.log('\n=== ПЕРЕНОС В ФОРМАТ VAULT ===');
  let failed = 0;
  const check = (name, ok, details = '') => {
    if (!ok) failed += 1;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details ? ` — ${details}` : ''}`);
  };
  const { json } = await must(
    'токен переноса',
    call('POST', 'auth/token/create', { body: { policies: ['prod-core'], ttl: '30m' } }),
  );
  const goodToken = json.auth.client_token;
  let token = goodToken;
  const transit = async (key, ciphertext, aad) => {
    const r = await call('POST', `transit/decrypt/${key}`, {
      token,
      body: { ciphertext, associated_data: Buffer.from(aad).toString('base64') },
    });
    if (r.status === 400) throw new Error('не открылась');
    if (r.status !== 200) throw Object.assign(new Error('отказ'), { unavailable: true });
    return Buffer.from(r.json.data.plaintext, 'base64');
  };
  docker('rm', '-f', PG);
  const pgStart = docker(
    'run',
    '-d',
    '--name',
    PG,
    '-e',
    'POSTGRES_PASSWORD=lab',
    '-p',
    `127.0.0.1:${PG_PORT}:5432`,
    '--entrypoint',
    'docker-entrypoint.sh',
    TOOL_IMAGE,
    'postgres',
  );
  if (pgStart.status !== 0) throw new Error(pgStart.stderr.slice(0, 200));
  let db;
  for (let i = 0; i < 60 && !db; i++) {
    const attempt = new pg.Client({
      host: '127.0.0.1',
      port: PG_PORT,
      user: 'postgres',
      password: 'lab',
      database: 'postgres',
    });
    attempt.on('error', () => undefined);
    await attempt.connect().then(
      () => (db = attempt),
      () => sleep(1000),
    );
  }
  if (!db) throw new Error('PostgreSQL не поднялся');
  try {
    await db.query(`CREATE SCHEMA identity; CREATE SCHEMA kyc; CREATE SCHEMA integration;
      CREATE TABLE identity.users (id uuid PRIMARY KEY, contact_wrapped_dek bytea);
      CREATE TABLE kyc.business_entities (id uuid PRIMARY KEY, entity_wrapped_dek bytea);
      CREATE TABLE integration.webhook_endpoints (id uuid PRIMARY KEY, secret_ciphertext bytea);`);
    const [users, entities, hooks] = MIGRATE_TARGETS;
    const dek = randomBytes(32);
    const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
    const put = (table, column, n, value) =>
      db.query(`INSERT INTO ${table} (id, ${column}) VALUES ($1, $2)`, [id(n), value]);
    const wrapUser = () => legacyWrap('passport_sensitive', dek, users.aad);
    for (let n = 1; n <= 5; n++) await put(users.table, users.column, n, wrapUser());
    await put(users.table, users.column, 6, null);
    const broken = wrapUser();
    broken[broken.length - 1] ^= 0xff;
    await put(users.table, users.column, 7, broken);
    await put(entities.table, entities.column, 1, legacyWrap('kyb_documents', dek, entities.aad));
    await put(hooks.table, hooks.column, 1, legacyWrap('webhook_secrets', dek, hooks.aad));
    const options = { prefix: 'prod', batch: 2 };

    let raced = false;
    const racedValue = wrapUser();
    let saved = null;
    const first = await migrateTarget(db, transit, users, {
      ...options,
      onPosition: (_, position) => (saved = position),
      afterSelect: async () => {
        if (raced) return;
        raced = true;
        await db.query(`UPDATE identity.users SET contact_wrapped_dek = $2 WHERE id = $1`, [
          id(2),
          racedValue,
        ]);
      },
    });
    check(
      'параллельно изменённая строка не перезаписана',
      first.skipped === 1 && first.converted === 4 && first.failed === 1,
      JSON.stringify(first),
    );
    const read = async (n) =>
      (await db.query(`SELECT contact_wrapped_dek v FROM identity.users WHERE id = $1`, [id(n)]))
        .rows[0].v;
    check('её новое значение на месте', (await read(2)).equals(racedValue));
    check('сохранённая позиция не прошла мимо неё', saved === id(1), String(saved));
    const partial = await verifyTarget(db, transit, users, options);
    check(
      'пройденная позиция не считается завершением',
      !partial.complete && partial.legacy === 2,
      JSON.stringify(partial),
    );
    const resumed = await migrateTarget(db, transit, users, { ...options, from: id(7) });
    check('продолжение с позиции старых значений не находит', resumed.converted === 0);
    check(
      'сверка всё равно их видит',
      (await verifyTarget(db, transit, users, options)).legacy === 2,
    );
    const again = await migrateTarget(db, transit, users, options);
    check('повтор переводит оставшееся', again.converted === 1 && again.failed === 1);
    const stuck = await verifyTarget(db, transit, users, options);
    check('неоткрываемая запись не даёт завершения', !stuck.complete && stuck.legacy === 1);
    await db.query(`UPDATE identity.users SET contact_wrapped_dek = $2 WHERE id = $1`, [
      id(7),
      wrapUser(),
    ]);
    await migrateTarget(db, transit, users, options);
    await migrateTarget(db, transit, entities, options);
    await migrateTarget(db, transit, hooks, options);
    let complete = true;
    for (const target of MIGRATE_TARGETS) {
      complete &&= (await verifyTarget(db, transit, target, options)).complete;
    }
    check('все таблицы сверены', complete);
    const value = await read(1);
    check('запись в новом формате', value.toString('ascii').startsWith('vault:v1:'));
    const plain = await transit('prod-passport-sensitive', value.toString('ascii'), users.aad);
    check('новая запись открывает прежний DEK', plain.equals(dek));

    await db.query(`UPDATE identity.users SET contact_wrapped_dek = $2 WHERE id = $1`, [
      id(1),
      wrapUser(),
    ]);
    token = 'invalid-token';
    const stopped = await migrateTarget(db, transit, users, options).then(
      () => false,
      (error) => error.unavailable === true,
    );
    check('отказ службы останавливает перенос', stopped);
    check('строка при отказе не тронута', !(await read(1)).toString('latin1').startsWith('vault:'));

    // Сама команда: библиотека получает готовую функцию и дефект чтения файлов не поймала бы.
    const stateFile = join(base, 'state.json');
    const tokenFile = join(base, 'migrate-token');
    const command = (action, extra = {}) =>
      spawnSync(
        process.execPath,
        [join(ROOT, 'scripts', 'crypto-migrate.mjs'), action, '--state', stateFile],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            DATABASE_URL_OWNER: `postgres://postgres:lab@127.0.0.1:${PG_PORT}/postgres`,
            OPENBAO_ADDR: ADDR,
            OPENBAO_KEY_PREFIX: 'prod',
            OPENBAO_TOKEN_PATH: tokenFile,
            OPENBAO_CA_PATH: '',
            ...extra,
          },
        },
      );
    const stoppedBy = (r) => r.status === 1 && r.stderr.includes('не прочитаны');
    const untouched = async () =>
      !(await read(1)).toString('latin1').startsWith('vault:') && !existsSync(stateFile);
    check('нет файла токена — команда остановлена', stoppedBy(command('run')));
    check('строка цела, позиция не сдвинута', await untouched());
    writeFileSync(tokenFile, goodToken);
    check(
      'нет файла сертификата — команда остановлена',
      stoppedBy(command('run', { OPENBAO_CA_PATH: join(base, 'нет.crt') })),
    );
    check('и тут строка цела, позиция не сдвинута', await untouched());
    const done = command('run');
    check('с доступом команда прошла', done.status === 0, done.stderr.slice(-200));
    const final = command('verify');
    check('сверка командой подтвердила', final.status === 0, final.stdout.slice(-200));

    console.log('\n=== СМЕНА ВЕРСИИ КЛЮЧА ===');
    const rotatePolicy = readFileSync(
      join(ROOT, 'infra', 'openbao', 'policy-prod-rotate.hcl'),
      'utf8',
    );
    await must(
      'политика смены',
      call('PUT', 'sys/policies/acl/prod-rotate', { body: { policy: rotatePolicy } }),
    );
    const rotateToken = (
      await must(
        'токен смены',
        call('POST', 'auth/token/create', {
          body: { policies: ['prod-rotate'], no_default_policy: true, ttl: '30m' },
        }),
      )
    ).json.auth.client_token;
    const rotateFile = join(base, 'rotate-token');
    writeFileSync(rotateFile, rotateToken);
    const rotate = (...args) =>
      spawnSync(process.execPath, [join(ROOT, 'scripts', 'rotate-kek.mjs'), '--transit', ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          DATABASE_URL_OWNER: `postgres://postgres:lab@127.0.0.1:${PG_PORT}/postgres`,
          OPENBAO_ADDR: ADDR,
          OPENBAO_KEY_PREFIX: 'prod',
          OPENBAO_TOKEN_PATH: rotateFile,
          OPENBAO_CA_PATH: '',
        },
      });
    const domain = ['--domain', 'passport_sensitive'];
    check('осмотр: отставших нет', rotate(...domain).status === 0);
    const search = rotate('--domain', 'search_index', '--rotate');
    check(
      'ключ поиска так не меняется',
      search.status === 1 && search.stderr.includes('пересчёта'),
    );
    const rotated = rotate(...domain, '--rotate');
    check(
      'новая версия с контролем',
      rotated.status === 0 && rotated.stdout.includes('новая версия: 2'),
      `${rotated.stdout}${rotated.stderr}`.slice(-200),
    );
    check('старые записи отстают, но читаются', rotate(...domain).status === 1);
    token = goodToken;
    const oldRead = await transit(
      'prod-passport-sensitive',
      (await read(3)).toString('ascii'),
      users.aad,
    );
    check('запись версии 1 открывается после смены', oldRead.equals(dek));
    const rewrapped = rotate(...domain, '--rewrap');
    check(
      'переупаковка прошла',
      rewrapped.status === 0,
      `${rewrapped.stdout}${rewrapped.stderr}`.slice(-240),
    );
    const moved = await read(3);
    check('запись на новой версии', moved.toString('ascii').startsWith('vault:v2:'));
    check(
      'DEK тот же, ядро его читает',
      (await transit('prod-passport-sensitive', moved.toString('ascii'), users.aad)).equals(dek),
    );

    const rotateCall = (method, path, { body } = {}) =>
      call(method, path, { token: rotateToken, body });
    const name = 'prod-passport-sensitive';
    const version = await rotateKey(rotateCall, name);
    let touched = false;
    const racedRewrap = await rewrapTarget(db, rotateCall, users, {
      name,
      version,
      batch: 2,
      afterSelect: async (rows) => {
        if (touched) return;
        touched = true;
        const changed = await repack(
          rotateCall,
          name,
          rows[0].value.toString('ascii'),
          Buffer.from(users.aad).toString('base64'),
        );
        await db.query(`UPDATE identity.users SET contact_wrapped_dek = $2 WHERE id = $1`, [
          rows[0].id,
          changed,
        ]);
      },
    });
    check(
      'параллельное изменение не перезаписано',
      racedRewrap.skipped === 1,
      JSON.stringify(racedRewrap),
    );
    await db.query(`UPDATE identity.users SET contact_wrapped_dek = $2 WHERE id = $1`, [
      id(4),
      wrapUser(),
    ]);
    const blocked = rotate(...domain, '--rewrap');
    check(
      'запись прежнего формата останавливает переупаковку',
      blocked.status === 1 && blocked.stderr.includes('прежнего формата'),
      blocked.stderr.slice(-200),
    );
  } finally {
    await db.end().catch(() => undefined);
    docker('rm', '-f', PG);
  }
  return failed ? 1 : 0;
}

let status;
console.log('=== CRYPTOSERVICE НА НАСТОЯЩЕМ OPENBAO ===');
try {
  docker('rm', '-f', NAME);
  const started = docker(
    'run',
    '-d',
    '--name',
    NAME,
    '-p',
    `127.0.0.1:${PORT}:8200`,
    IMAGE,
    'server',
    '-dev',
    `-dev-root-token-id=${ROOT_TOKEN}`,
    '-dev-listen-address=0.0.0.0:8200',
  );
  if (started.status !== 0) throw new Error(started.stderr.slice(0, 200));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await call('GET', 'sys/health').then(
      (r) => r.status === 200,
      () => false,
    );
    if (!up) await sleep(500);
  }
  if (!up) throw new Error('OpenBao не поднялся');

  await must('transit', call('POST', 'sys/mounts/transit', { body: { type: 'transit' } }));
  for (const [name, domain] of [
    ['prod-passport-sensitive', 'passport_sensitive'],
    ['prod-kyb-documents', 'kyb_documents'],
    ['prod-webhook-secrets', 'webhook_secrets'],
  ]) {
    await must(
      name,
      importTransitKey(call, name, 'aes256-gcm96', keyOf(domain), { allow_rotation: true }),
    );
  }
  await must(
    'ключ поиска',
    importTransitKey(call, 'prod-search-index', 'hmac', keyOf('search_index'), {
      allow_rotation: true,
    }),
  );

  const policy = readFileSync(join(ROOT, 'infra', 'openbao', 'policy-prod-core.hcl'), 'utf8');
  await must('политика', call('PUT', 'sys/policies/acl/prod-core', { body: { policy } }));
  const issued = await must(
    'токен',
    call('POST', 'auth/token/create', {
      body: { policies: ['prod-core'], no_default_policy: true, ttl: '30m' },
    }),
  );
  const tokenFile = join(base, 'token');
  writeFileSync(tokenFile, `${issued.json.auth.client_token}\n`);

  const run = spawnSync('npx', ['vitest', 'run', 'tests/crypto-transit.live.test.ts'], {
    cwd: join(ROOT, 'apps', 'core'),
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      LIVE_OPENBAO_ADDR: ADDR,
      LIVE_OPENBAO_TOKEN_PATH: tokenFile,
      LIVE_OPENBAO_ROOT: ROOT_TOKEN,
    },
  });
  status = run.status ?? 1;
  const migrated = await checkMigration();
  status ||= migrated;
} catch (error) {
  console.error(`ОШИБКА: ${error.message}`);
  status = 1;
} finally {
  docker('rm', '-f', NAME);
  rmSync(base, { recursive: true, force: true });
}
console.log(status === 0 ? '\nИТОГ: пройдено' : '\nИТОГ: не пройдено');
process.exit(status);
