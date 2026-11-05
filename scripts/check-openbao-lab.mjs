#!/usr/bin/env node
/**
 * OpenBao на искусственных ключах (блок 5, задания 3–4). Один контейнер, рабочих ключей нет.
 *
 *   node scripts/check-openbao-lab.mjs
 *
 * Проверяет Static seal, TLS, разделение прав и главное для переноса: прежний ключ поиска,
 * импортированный как HMAC, даёт те же значения, а импортированный AES-ключ читает старый
 * формат `iv || tag || ciphertext` с AAD.
 */
import { spawnSync } from 'node:child_process';
import { createCipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { importTransitKey } from './lib/openbao-import.mjs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IMAGE = process.env.OPENBAO_IMAGE || 'openbao/openbao:2.7.2';
const NAME = 'fifth-openbao-lab';
const VOLUME = 'fifth-openbao-lab-data';
const PORT = 18200;
const base = mkdtempSync(join(tmpdir(), 'openbao-lab-'));
let passed = 0;
let failed = 0;
const check = (name, ok, details = '') => {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details ? ` — ${details}` : ''}`);
};
const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (x) => Buffer.from(x).toString('base64');
const sameHmac = (response, local) => {
  const a = Buffer.from(String(response.json.data?.hmac));
  const b = Buffer.from(`vault:v1:${local}`);
  return a.length === b.length && timingSafeEqual(a, b);
};

let ca;
function api(method, path, { token, body, verify = true } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        method,
        path: `/v1/${path}`,
        ca: verify ? ca : undefined,
        servername: 'localhost',
        rejectUnauthorized: true,
        headers: {
          ...(token ? { 'X-Vault-Token': token } : {}),
          ...(data ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json;
          try {
            json = text ? JSON.parse(text) : {};
          } catch {
            json = { raw: text };
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('таймаут')));
    req.end(data);
  });
}

function config(dir, keyFile) {
  writeFileSync(
    join(dir, 'bao.hcl'),
    `ui = false
disable_mlock = true
api_addr = "https://127.0.0.1:8200"
cluster_addr = "https://127.0.0.1:8201"
storage "raft" {
  path = "/openbao/file"
  node_id = "lab-1"
}
listener "tcp" {
  address = "0.0.0.0:8200"
  tls_cert_file = "/cfg/tls.crt"
  tls_key_file = "/cfg/tls.key"
}
audit "file" "main" {
  options {
    file_path = "/openbao/file/audit.log"
  }
}
seal "static" {
  current_key_id = "lab-1"
  current_key = "file:///cfg/${keyFile}"
}
`,
  );
}

async function start(dir) {
  docker('rm', '-f', NAME);
  const r = docker(
    'run',
    '-d',
    '--name',
    NAME,
    '-p',
    `127.0.0.1:${PORT}:8200`,
    '-v',
    `${dir}:/cfg:ro`,
    '-v',
    `${VOLUME}:/openbao/file`,
    IMAGE,
    'server',
    '-config=/cfg/bao.hcl',
  );
  if (r.status !== 0) throw new Error(`контейнер не запущен: ${r.stderr.slice(0, 200)}`);
  for (let i = 0; i < 40; i++) {
    try {
      return await api('GET', 'sys/seal-status');
    } catch {
      await sleep(500);
    }
  }
  return { status: 0, json: {} };
}

const importKey = (token, name, type, key) =>
  importTransitKey(
    (method, path, options) => api(method, path, { ...options, token }),
    name,
    type,
    key,
  );

/** Старый формат CryptoService: iv || tag || ciphertext. */
function oldSeal(key, plain, aad) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return { iv, tag: c.getAuthTag(), body };
}

console.log('=== OPENBAO, ИСКУССТВЕННЫЕ КЛЮЧИ ===');
try {
  docker('rm', '-f', NAME);
  docker('volume', 'rm', '-f', VOLUME);
  const dir = join(base, 'cfg');
  mkdirSync(dir);
  writeFileSync(join(dir, 'seal.key'), randomBytes(32));
  writeFileSync(join(dir, 'wrong.key'), randomBytes(32));
  const tls = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      join(dir, 'tls.key'),
      '-out',
      join(dir, 'tls.crt'),
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  if (tls.status !== 0) throw new Error(`сертификат: ${tls.stderr.slice(0, 200)}`);
  ca = readFileSync(join(dir, 'tls.crt'));
  docker(
    'run',
    '--rm',
    '-v',
    `${VOLUME}:/d`,
    '--user',
    '0',
    '--entrypoint',
    'chown',
    IMAGE,
    '-R',
    'openbao:openbao',
    '/d',
  );

  config(dir, 'seal.key');
  await start(dir);
  const init = await api('POST', 'sys/init', {
    body: { recovery_shares: 1, recovery_threshold: 1 },
  });
  const root = init.json.root_token;
  check(
    'инициализация с Static seal',
    Boolean(root && init.json.recovery_keys_base64?.length),
    `код ${init.status}`,
  );
  if (!root) throw new Error(JSON.stringify(init.json).slice(0, 300));
  for (let i = 0; i < 30; i++) {
    const s = await api('GET', 'sys/seal-status');
    if (s.json.sealed === false) break;
    await sleep(500);
  }
  const rejected = await api('GET', 'sys/seal-status', { verify: false }).then(
    () => false,
    () => true,
  );
  check('TLS: без доверенного сертификата отказ', rejected);

  await api('POST', 'sys/mounts/transit', { token: root, body: { type: 'transit' } });
  await api('POST', 'sys/mounts/kv', {
    token: root,
    body: { type: 'kv', options: { version: '2' } },
  });
  await api('POST', 'sys/auth/approle', { token: root, body: { type: 'approle' } });

  const searchKey = randomBytes(32);
  const hmacImport = await importKey(root, 'prod-search-index', 'hmac', searchKey);
  check(
    'импорт прежнего ключа поиска как HMAC',
    hmacImport.status < 300,
    `код ${hmacImport.status} ${JSON.stringify(hmacImport.json.errors ?? '')}`,
  );
  const value = 'email:person@example.com';
  const local = createHmac('sha256', searchKey).update(value, 'utf8').digest('base64');
  const remote = await api('POST', 'transit/hmac/prod-search-index/sha2-256', {
    token: root,
    body: { input: b64(value) },
  });
  check('HMAC в точности совпал с локальным', sameHmac(remote, local));

  const kek = randomBytes(32);
  const aesImport = await importKey(root, 'prod-passport-sensitive', 'aes256-gcm96', kek);
  check(
    'импорт прежнего KEK как AES',
    aesImport.status < 300,
    `код ${aesImport.status} ${JSON.stringify(aesImport.json.errors ?? '')}`,
  );
  const dek = randomBytes(32);
  const aad = 'wrap:passport_sensitive';
  const old = oldSeal(kek, dek, aad);
  const toTransit = (o) => `vault:v1:${Buffer.concat([o.iv, o.body, o.tag]).toString('base64')}`;
  const opened = await api('POST', 'transit/decrypt/prod-passport-sensitive', {
    token: root,
    body: { ciphertext: toTransit(old), associated_data: b64(aad) },
  });
  check(
    'старая упаковка DEK читается с AAD',
    opened.json.data?.plaintext === dek.toString('base64'),
    JSON.stringify(opened.json.errors ?? ''),
  );
  const wrongAad = await api('POST', 'transit/decrypt/prod-passport-sensitive', {
    token: root,
    body: { ciphertext: toTransit(old), associated_data: b64('wrap:kyc_documents') },
  });
  check('чужой AAD — отказ', wrongAad.status >= 400);
  const exported = await api('GET', 'transit/export/encryption-key/prod-passport-sensitive', {
    token: root,
  });
  check('ключ не экспортируется', exported.status >= 400);
  const test = await importKey(root, 'test-1-passport-sensitive', 'aes256-gcm96', randomBytes(32));
  check('ключ второй среды заведён', test.status < 300);

  await api('PUT', 'sys/policies/acl/prod-core', {
    token: root,
    body: {
      policy: `path "transit/decrypt/prod-*" { capabilities = ["update"] }
path "transit/encrypt/prod-*" { capabilities = ["update"] }
path "transit/hmac/prod-*" { capabilities = ["update"] }
path "kv/data/prod/core/*" { capabilities = ["read"] }`,
    },
  });
  await api('POST', 'auth/approle/role/prod-core', {
    token: root,
    body: { token_policies: ['prod-core'], token_ttl: '1h', token_max_ttl: '4h' },
  });
  const roleId = (await api('GET', 'auth/approle/role/prod-core/role-id', { token: root })).json
    .data.role_id;
  const secret = await api('POST', 'auth/approle/role/prod-core/secret-id', { token: root });
  const secretId = secret.json.data.secret_id;
  const login = await api('POST', 'auth/approle/login', {
    body: { role_id: roleId, secret_id: secretId },
  });
  const core = login.json.auth?.client_token;
  check('вход ядра по AppRole', Boolean(core));
  const own = await api('POST', 'transit/decrypt/prod-passport-sensitive', {
    token: core,
    body: { ciphertext: toTransit(old), associated_data: b64(aad) },
  });
  check('ядро расшифровывает в своей среде', own.status === 200);
  const foreign = await api('POST', 'transit/decrypt/test-1-passport-sensitive', {
    token: core,
    body: { ciphertext: toTransit(old), associated_data: b64(aad) },
  });
  check('чужая среда закрыта', foreign.status === 403);
  const rotate = await api('POST', 'transit/keys/prod-passport-sensitive/rotate', { token: core });
  check('ядро не меняет ключи', rotate.status === 403);
  const policy = await api('PUT', 'sys/policies/acl/x', { token: core, body: { policy: '' } });
  check('ядро не меняет политики', policy.status === 403);
  const audit = await api('PUT', 'sys/audit/x', { token: core, body: { type: 'file' } });
  check('ядро не меняет аудит', audit.status === 403);

  await api('POST', 'transit/decrypt/prod-passport-sensitive', {
    token: core,
    body: { ciphertext: toTransit(old), associated_data: b64(aad) },
  });
  const log = docker('exec', NAME, 'cat', '/openbao/file/audit.log').stdout;
  check(
    'в аудите есть запись, открытого значения нет',
    log.includes('transit/decrypt') && !log.includes(dek.toString('base64')),
  );
  const noApi = await api('PUT', 'sys/audit/x', { token: root, body: { type: 'file' } });
  check('аудит не отключить и не добавить через API', noApi.status >= 400);

  const again = await start(dir);
  let unsealed = again.json.sealed === false;
  for (let i = 0; i < 30 && !unsealed; i++) {
    await sleep(500);
    unsealed = (await api('GET', 'sys/seal-status')).json.sealed === false;
  }
  check('перезапуск: разблокировка без человека', unsealed);

  config(dir, 'wrong.key');
  const wrong = await start(dir);
  await sleep(3000);
  const logs = docker('logs', NAME);
  const stillSealed = wrong.status === 0 || wrong.json.sealed !== false;
  check(
    'чужой Static seal key — не открывается',
    stillSealed,
    (logs.stderr + logs.stdout).match(/error[^\n]{0,90}/i)?.[0] ?? '',
  );

  config(dir, 'seal.key');
  await start(dir);
  let back = false;
  for (let i = 0; i < 30 && !back; i++) {
    await sleep(500);
    back = (await api('GET', 'sys/seal-status')).json.sealed === false;
  }
  check('верный файл возвращает работу', back);
  const after = await api('POST', 'transit/hmac/prod-search-index/sha2-256', {
    token: root,
    body: { input: b64(value) },
  });
  check('после перезапуска HMAC тот же', sameHmac(after, local));

  await api('POST', 'auth/token/revoke-self', { token: root });
  const dead = await api('GET', 'sys/mounts', { token: root });
  check('начальный root-токен отозван', dead.status === 403);
} catch (e) {
  check('сценарий завершён', false, e.message);
} finally {
  docker('rm', '-f', NAME);
  docker('volume', 'rm', '-f', VOLUME);
  rmSync(base, { recursive: true, force: true });
}
console.log(`\nИТОГО: ${passed} пройдено, ${failed} провалено`);
process.exit(failed ? 1 : 0);
