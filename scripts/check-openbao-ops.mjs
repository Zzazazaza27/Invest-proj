#!/usr/bin/env node
/**
 * Эксплуатация OpenBao на искусственных ключах (блок 5, задание 3).
 *
 *   node scripts/check-openbao-ops.mjs
 *
 * Берёт настоящие файлы infra/openbao. Проверяет Agent и отзыв доступа, снимок и его
 * восстановление, смену Static seal key и миграцию seal в обе стороны.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'infra', 'openbao');
const IMAGE = process.env.OPENBAO_IMAGE || 'openbao/openbao:2.7.2';
const NAME = 'fifth-openbao-ops';
const AGENT = 'fifth-openbao-ops-agent';
const NET = 'fifth-openbao-ops-net';
const VOLUMES = ['fifth-openbao-ops-a', 'fifth-openbao-ops-b'];
const PORT = 18201;
const base = mkdtempSync(join(tmpdir(), 'openbao-ops-'));
let passed = 0;
let failed = 0;
const check = (name, ok, details = '') => {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details ? ` — ${details}` : ''}`);
};
const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ca;
function api(method, path, { token, body, raw } = {}) {
  return new Promise((resolve_, reject) => {
    const data = raw ?? (body ? JSON.stringify(body) : undefined);
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        method,
        path: `/v1/${path}`,
        ca,
        servername: 'localhost',
        headers: {
          ...(token ? { 'X-Vault-Token': token } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      (res) => {
        const parts = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(parts);
          let json;
          try {
            json = buf.length ? JSON.parse(buf.toString()) : {};
          } catch {
            json = {};
          }
          resolve_({ status: res.statusCode, json, buf });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('таймаут')));
    req.end(data);
  });
}

/** Настоящий файл настроек; меняется только блок seal. */
function writeConfig(dir, seal) {
  const text = readFileSync(join(SRC, 'openbao.hcl'), 'utf8');
  const next = text.replace(/seal "static" \{[\s\S]*?\n\}\n/, seal);
  if (seal && !next.includes(seal)) throw new Error('блок seal не заменён');
  writeFileSync(join(dir, 'openbao.hcl'), next);
}
const sealBlock = (id, file, extra = '') =>
  `seal "static" {\n  current_key_id = "${id}"\n  current_key = "file:///openbao/seal/${file}"\n${extra}}\n`;

async function start(dir, volume) {
  docker('rm', '-f', NAME);
  const r = docker(
    'run',
    '-d',
    '--name',
    NAME,
    '--user',
    '1990:1990',
    '--network',
    NET,
    '-p',
    `127.0.0.1:${PORT}:8200`,
    '-v',
    `${join(dir, 'openbao.hcl')}:/openbao/config/openbao.hcl:ro`,
    '-v',
    `${join(dir, 'seal')}:/openbao/seal:ro`,
    '-v',
    `${join(dir, 'tls')}:/openbao/tls:ro`,
    '-v',
    `${volume}:/openbao/data`,
    '--tmpfs',
    '/openbao/audit:uid=1990,gid=1990',
    IMAGE,
    'server',
    '-config=/openbao/config/openbao.hcl',
  );
  if (r.status !== 0) throw new Error(`контейнер: ${r.stderr.slice(0, 200)}`);
  for (let i = 0; i < 40; i++) {
    try {
      return await api('GET', 'sys/seal-status');
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`не поднялся: ${docker('logs', '--tail', '5', NAME).stderr.slice(0, 300)}`);
}
async function waitOpen() {
  for (let i = 0; i < 40; i++) {
    if ((await api('GET', 'sys/health')).status === 200) return true;
    await sleep(500);
  }
  return false;
}
const prepareVolume = (volume) =>
  docker(
    'run',
    '--rm',
    '-v',
    `${volume}:/d`,
    '--user',
    '0',
    '--entrypoint',
    'chown',
    IMAGE,
    '-R',
    '1990:1990',
    '/d',
  );
const kvRead = (token) => api('GET', 'kv/data/prod/core/POSTGRES_PASSWORD', { token });
const kvWrite = (token, value) =>
  api('POST', 'kv/data/prod/core/POSTGRES_PASSWORD', { token, body: { data: { value } } });

function cleanup() {
  docker('rm', '-f', NAME, AGENT);
  for (const v of VOLUMES) docker('volume', 'rm', '-f', v);
  docker('network', 'rm', NET);
}

console.log('=== OPENBAO: AGENT, СНИМОК, МИГРАЦИЯ SEAL ===');
try {
  cleanup();
  docker('network', 'create', NET);
  const dir = join(base, 'cfg');
  for (const d of ['seal', 'tls', 'agent']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'seal', 'static.key'), randomBytes(32));
  writeFileSync(join(dir, 'seal', 'next.key'), randomBytes(32));
  writeFileSync(join(dir, 'seal', 'other.key'), randomBytes(32));
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
      join(dir, 'tls', 'tls.key'),
      '-out',
      join(dir, 'tls', 'tls.crt'),
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      `subjectAltName=DNS:localhost,DNS:${NAME},IP:127.0.0.1`,
    ],
    { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  if (tls.status !== 0) throw new Error(`сертификат: ${tls.stderr.slice(0, 200)}`);
  ca = readFileSync(join(dir, 'tls', 'tls.crt'));
  VOLUMES.forEach(prepareVolume);

  const staticFirst = sealBlock('fifth-1', 'static.key');
  writeConfig(dir, staticFirst);
  await start(dir, VOLUMES[0]);
  const init = await api('POST', 'sys/init', {
    body: { recovery_shares: 1, recovery_threshold: 1 },
  });
  const root = init.json.root_token;
  const recovery = init.json.recovery_keys_base64?.[0];
  check('настоящие файлы размещения запускаются', Boolean(root && recovery), `код ${init.status}`);
  if (!root) throw new Error(JSON.stringify(init.json).slice(0, 300));
  await waitOpen();
  const setup = spawnSync('bash', [join(SRC, 'setup-vps.sh'), 'configure'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MSYS_NO_PATHCONV: '1',
      FIFTH_OPENBAO_DIR: dir,
      FIFTH_OPENBAO_CONTAINER: NAME,
      FIFTH_OPENBAO_ROOT_TOKEN: root,
      FIFTH_OPENBAO_THOMAS_PASSWORD: 'lab-only-operator',
    },
  });
  check('настройка скриптом размещения', setup.status === 0, setup.stderr.slice(-200));
  const operator = await api('POST', 'auth/userpass/login/thomas', {
    body: { password: 'lab-only-operator' },
  });
  check('личный вход Томаса работает', Boolean(operator.json.auth?.client_token));
  await api('POST', 'auth/approle/role/prod-core', {
    token: root,
    body: { token_policies: ['prod-core'], token_ttl: '10s', token_max_ttl: '1h' },
  });
  await kvWrite(root, 'first-value');

  console.log('\n▸ Agent');
  const roleId = (await api('GET', 'auth/approle/role/prod-core/role-id', { token: root })).json
    .data.role_id;
  const secret = await api('POST', 'auth/approle/role/prod-core/secret-id', { token: root });
  writeFileSync(join(dir, 'agent', 'role-id'), roleId);
  writeFileSync(join(dir, 'agent', 'secret-id'), secret.json.data.secret_id);
  const agentConf = readFileSync(join(SRC, 'agent-core.hcl'), 'utf8')
    .replace('https://127.0.0.1:8200', `https://${NAME}:8200`)
    .replace('"5m"', '"2s"');
  writeFileSync(join(dir, 'agent', 'agent.hcl'), agentConf);
  copyFileSync(join(dir, 'tls', 'tls.crt'), join(dir, 'agent', 'tls.crt'));
  const run = docker(
    'run',
    '-d',
    '--name',
    AGENT,
    '--network',
    NET,
    '-v',
    `${join(dir, 'agent')}:/agent:ro`,
    '-v',
    `${join(dir, 'tls')}:/openbao/tls:ro`,
    '--tmpfs',
    '/run/fifth-secrets:uid=100,gid=1000',
    IMAGE,
    'agent',
    '-config=/agent/agent.hcl',
  );
  if (run.status !== 0) throw new Error(`Agent: ${run.stderr.slice(0, 200)}`);
  const secretFile = () =>
    docker('exec', AGENT, 'cat', '/run/fifth-secrets/POSTGRES_PASSWORD').stdout.trim();
  const waitValue = async (value, tries = 30) => {
    for (let i = 0; i < tries; i++) {
      if (secretFile() === value) return true;
      await sleep(1000);
    }
    return false;
  };
  const rendered = await waitValue('first-value');
  check(
    'Agent положил секрет файлом в память',
    rendered,
    rendered ? '' : docker('logs', '--tail', '4', AGENT).stderr.slice(0, 240),
  );
  const mode = docker(
    'exec',
    AGENT,
    'stat',
    '-c',
    '%a',
    '/run/fifth-secrets/POSTGRES_PASSWORD',
  ).stdout.trim();
  check('права файла 440', mode === '440', mode);
  const mounts = docker('exec', AGENT, 'grep', ' /run/fifth-secrets ', '/proc/mounts').stdout;
  check('каталог секретов в памяти', mounts.includes('tmpfs'));
  await sleep(14000);
  await kvWrite(root, 'second-value');
  check(
    'после срока токена Agent работает и видит новое значение',
    await waitValue('second-value'),
  );
  docker('restart', AGENT);
  check('после перезапуска Agent вошёл заново', await waitValue('second-value'));

  const extra = await api('POST', 'auth/approle/role/prod-core/secret-id', { token: root });
  const login = await api('POST', 'auth/approle/login', {
    body: { role_id: roleId, secret_id: extra.json.data.secret_id },
  });
  const token = login.json.auth.client_token;
  await api('POST', 'auth/approle/role/prod-core/secret-id/destroy', {
    token: root,
    body: { secret_id: extra.json.data.secret_id },
  });
  const again = await api('POST', 'auth/approle/login', {
    body: { role_id: roleId, secret_id: extra.json.data.secret_id },
  });
  check('отозванный SecretID не входит', again.status >= 400);
  check('выданный токен отзывается отдельно: пока работает', (await kvRead(token)).status === 200);
  await api('POST', 'auth/token/revoke', { token: root, body: { token } });
  check('отозванный токен не работает', (await kvRead(token)).status === 403);
  docker('rm', '-f', AGENT);

  console.log('\n▸ Снимок');
  process.env.FIFTH_OPENBAO_DIR = dir;
  process.env.FIFTH_OPENBAO_PORT = String(PORT);
  const { openbaoSnapshot, openbaoState } = await import('./lib/openbao.mjs');
  check('наблюдение видит открытое хранилище', (await openbaoState()) === 'open');
  const snapFile = join(base, 'openbao.snap');
  await openbaoSnapshot(snapFile);
  const snap = { buf: readFileSync(snapFile) };
  check('снимок снят входом для копий', snap.buf.length > 1000, `${snap.buf.length} байт`);
  const secretInCopy = snap.buf.includes(readFileSync(join(dir, 'seal', 'static.key')));
  check('Static seal key в снимок не попал', !secretInCopy);
  const copyRole = await api('POST', 'auth/approle/login', {
    body: {
      role_id: readFileSync(join(dir, 'approle', 'prod-backup', 'role-id'), 'utf8').trim(),
      // Значение читается из файла, в коде его нет.
      // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
      secret_id: readFileSync(join(dir, 'approle', 'prod-backup', 'secret-id'), 'utf8').trim(),
    },
  });
  check(
    'вход для копий не читает секреты',
    (await kvRead(copyRole.json.auth.client_token)).status === 403,
  );
  await kvWrite(root, 'after-snapshot');

  await start(dir, VOLUMES[1]);
  const fresh = await api('POST', 'sys/init', {
    body: { recovery_shares: 1, recovery_threshold: 1 },
  });
  await waitOpen();
  const restored = await api('POST', 'sys/storage/raft/snapshot-force', {
    token: fresh.json.root_token,
    raw: snap.buf,
  });
  check('снимок восстановлен на чистый том', restored.status < 300, `код ${restored.status}`);
  await sleep(3000);
  await waitOpen();
  const read = await kvRead(root);
  check(
    'данные на момент снимка, вход прежним токеном',
    read.json.data?.data?.value === 'second-value',
    `код ${read.status}`,
  );

  docker('rm', '-f', NAME);
  docker('volume', 'rm', '-f', VOLUMES[1]);
  docker('volume', 'create', VOLUMES[1]);
  prepareVolume(VOLUMES[1]);
  writeConfig(dir, sealBlock('other-1', 'other.key'));
  await start(dir, VOLUMES[1]);
  const foreign = await api('POST', 'sys/init', {
    body: { recovery_shares: 1, recovery_threshold: 1 },
  });
  await waitOpen();
  const refused = await api('POST', 'sys/storage/raft/snapshot-force', {
    token: foreign.json.root_token,
    raw: snap.buf,
  }).catch(() => ({ status: 599 }));
  const seen = [];
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const r = await kvRead(root).catch(() => ({ status: 599 }));
    seen.push(r.status);
  }
  const logged = docker('logs', '--tail', '6', NAME);
  check(
    'снимок без верного Static seal key не читается',
    !seen.includes(200),
    `восстановление ${refused.status}, чтение ${[...new Set(seen)].join(',')}; ${(logged.stderr + logged.stdout).match(/(error|failed)[^\n]{0,80}/i)?.[0] ?? ''}`,
  );

  console.log('\n▸ Смена Static seal key');
  writeConfig(
    dir,
    sealBlock(
      'fifth-2',
      'next.key',
      '  previous_key_id = "fifth-1"\n  previous_key = "file:///openbao/seal/static.key"\n',
    ),
  );
  await start(dir, VOLUMES[0]);
  check('новый ключ при прежнем рядом: открывается сам', await waitOpen());
  await sleep(3000);
  writeConfig(dir, sealBlock('fifth-2', 'next.key'));
  await start(dir, VOLUMES[0]);
  const rotated = await waitOpen();
  check(
    'после смены прежний ключ не нужен',
    rotated,
    rotated ? '' : docker('logs', '--tail', '3', NAME).stderr.slice(0, 200),
  );
  check('данные на месте', (await kvRead(root)).json.data?.data?.value === 'after-snapshot');

  console.log('\n▸ Миграция seal: авторазблокировка → ручная → обратно');
  writeConfig(dir, sealBlock('fifth-2', 'next.key', '  disabled = "true"\n'));
  await start(dir, VOLUMES[0]);
  const migrate = await api('POST', 'sys/unseal', { body: { key: recovery, migrate: true } });
  check(
    'миграция принята',
    migrate.status === 200,
    `код ${migrate.status} ${JSON.stringify(migrate.json.errors ?? '')}`,
  );
  check('открыта после миграции', await waitOpen());
  await sleep(3000);
  writeConfig(dir, '');
  await start(dir, VOLUMES[0]);
  const manual = await api('GET', 'sys/seal-status');
  check(
    'без блока seal стартует запечатанной',
    manual.json.sealed === true && manual.json.type === 'shamir',
    `тип ${manual.json.type}`,
  );
  await api('POST', 'sys/unseal', { body: { key: recovery } });
  check('ручная разблокировка прежним ключом восстановления', await waitOpen());
  check(
    'данные на месте после ручной разблокировки',
    (await kvRead(root)).json.data?.data?.value === 'after-snapshot',
  );

  writeConfig(dir, sealBlock('fifth-3', 'static.key'));
  await start(dir, VOLUMES[0]);
  const backTo = await api('POST', 'sys/unseal', { body: { key: recovery, migrate: true } });
  check(
    'миграция обратно принята',
    backTo.status === 200,
    `код ${backTo.status} ${JSON.stringify(backTo.json.errors ?? '')}`,
  );
  await waitOpen();
  await sleep(3000);
  await start(dir, VOLUMES[0]);
  check('снова открывается без человека', await waitOpen());
  check(
    'данные на месте в конце',
    (await kvRead(root)).json.data?.data?.value === 'after-snapshot',
  );
} catch (e) {
  check('сценарий завершён', false, e.message);
} finally {
  cleanup();
  rmSync(base, { recursive: true, force: true });
}
console.log(`\nИТОГО: ${passed} пройдено, ${failed} провалено`);
process.exit(failed ? 1 : 0);
