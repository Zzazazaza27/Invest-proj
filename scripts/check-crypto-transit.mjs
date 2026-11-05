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
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTransitKey } from './lib/openbao-import.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = process.env.OPENBAO_IMAGE || 'openbao/openbao:2.7.2';
const NAME = 'fifth-crypto-transit';
const PORT = 18203;
const ADDR = `http://127.0.0.1:${PORT}`;
const ROOT_TOKEN = 'lab-only-root';
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

let status = 1;
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
} catch (error) {
  console.error(`ОШИБКА: ${error.message}`);
} finally {
  docker('rm', '-f', NAME);
  rmSync(base, { recursive: true, force: true });
}
console.log(status === 0 ? '\nИТОГ: пройдено' : '\nИТОГ: не пройдено');
process.exit(status);
