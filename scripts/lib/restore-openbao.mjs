/**
 * OpenBao из снимка на площадке восстановления (блок 5, задание 5).
 *
 * Берёт только снимок из комплекта и аварийный комплект Томаса. Настройки — настоящий
 * `infra/openbao/openbao.hcl`, сертификат свой, на сутки. Static seal key и ключ
 * восстановления идут через память и том площадки, на диск машины не попадают.
 * Значения не печатаются.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { join, resolve } from 'node:path';
import { MEMORY_ONLY, ROOT, TOOL_IMAGE, docker } from './backup.mjs';
import { rootByRecoveryKey } from './openbao-copy.mjs';

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

function openbaoImage() {
  const compose = readFileSync(join(ROOT, 'infra', 'openbao', 'docker-compose.yml'), 'utf8');
  return compose.match(/image: (openbao\S+)/)[1];
}

/** Ключи из аварийного комплекта: остаются в памяти этого процесса. */
function openKit(kit, secretKey, passphraseFile) {
  const script = [
    'set -e',
    'mkdir -m 700 /secure/gpg',
    'printf %s "$PASSPHRASE" | gpg -q --batch --pinentry-mode loopback --passphrase-fd 0 --import /in/secret.asc 2>/dev/null',
    'printf %s "$PASSPHRASE" | gpg -q --batch --pinentry-mode loopback --passphrase-fd 0 --decrypt /in/emergency.gpg 2>/dev/null',
  ].join('\n');
  const r = docker(
    [
      'run',
      '--rm',
      '--network',
      'none',
      ...MEMORY_ONLY,
      '-e',
      'PASSPHRASE',
      '-v',
      `${resolve(kit)}:/in/emergency.gpg:ro`,
      '-v',
      `${secretKey}:/in/secret.asc:ro`,
      '--entrypoint',
      'sh',
      TOOL_IMAGE,
      '-c',
      script,
    ],
    { env: { PASSPHRASE: readFileSync(passphraseFile, 'utf8').trim() }, allowFail: true },
  );
  const value = (name) => r.stdout.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();
  return { seal: value('OPENBAO_STATIC_SEAL_B64'), recovery: value('OPENBAO_RECOVERY_KEY') };
}

function caller(port, ca) {
  return (method, path, { token, body, raw } = {}) =>
    new Promise((done, fail) => {
      const data = raw ?? (body ? JSON.stringify(body) : undefined);
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method,
          path: `/v1/${path}`,
          ca,
          headers: {
            ...(token ? { 'X-Vault-Token': token } : {}),
            ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => {
            let json = {};
            try {
              json = text ? JSON.parse(text) : {};
            } catch {
              /* не JSON: важен код ответа */
            }
            done({ status: res.statusCode, json });
          });
        },
      );
      req.on('error', fail);
      req.setTimeout(60000, () => req.destroy(new Error('OpenBao не ответил вовремя')));
      req.end(data);
    });
}

async function waitStatus(call, want, seconds = 60) {
  for (let i = 0; i < seconds; i += 1) {
    const status = await call('GET', 'sys/health').then(
      (r) => r.status,
      () => 0,
    );
    if (want(status)) return status;
    await wait(1000);
  }
  return 0;
}

/**
 * Поднимает OpenBao из снимка. Возвращает адрес, файлы для ядра и `stop()`.
 * `check(имя, условие, подробности)` — учёт проверки вызывающего.
 */
export async function restoreOpenbao({
  tag,
  from,
  snapshot,
  kit,
  secretKey,
  passphraseFile,
  port,
  prefix,
  postgresPassword,
  check,
}) {
  const name = `fifth-restore-bao-${tag}`;
  const dir = join(from, '.restore-openbao');
  const stop = () => {
    docker(['rm', '-f', '-v', name], { allowFail: true });
    for (const v of [`${name}-cfg`, `${name}-data`]) {
      docker(['volume', 'rm', '-f', v], { allowFail: true });
    }
    rmSync(dir, { recursive: true, force: true });
  };

  const { seal, recovery } = openKit(kit, secretKey, passphraseFile);
  check('аварийный комплект открыт закрытым ключом', Boolean(seal && recovery));
  if (!seal || !recovery) throw new Error('без аварийного комплекта vault не прочитать');

  const hcl = readFileSync(join(ROOT, 'infra', 'openbao', 'openbao.hcl'), 'utf8')
    .replaceAll('/openbao/tls/', '/openbao/cfg/tls/')
    .replaceAll('/openbao/seal/', '/openbao/cfg/seal/')
    .replace(
      /^listener "tcp" \{$/m,
      'listener "tcp" {\n  disable_unauthed_generate_root_endpoints = false',
    );
  const prepare = [
    'set -e',
    'mkdir -p /cfg/tls /cfg/seal',
    'base64 -d > /cfg/seal/static.key',
    'printf %s "$HCL" | base64 -d > /cfg/openbao.hcl',
    'openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost ' +
      '-addext subjectAltName=DNS:localhost,IP:127.0.0.1 ' +
      '-keyout /cfg/tls/tls.key -out /cfg/tls/tls.crt 2>/dev/null',
    'chown -R 1990:1990 /cfg /data',
    'chmod 400 /cfg/seal/static.key /cfg/tls/tls.key',
    'cat /cfg/tls/tls.crt',
  ].join('\n');
  const prepared = docker(
    [
      'run',
      '--rm',
      '-i',
      '--network',
      'none',
      '-u',
      'root',
      '-e',
      'HCL',
      '-v',
      `${name}-cfg:/cfg`,
      '-v',
      `${name}-data:/data`,
      '--entrypoint',
      'sh',
      TOOL_IMAGE,
      '-c',
      prepare,
    ],
    { env: { HCL: Buffer.from(hcl).toString('base64') }, input: seal },
  );
  const ca = prepared.stdout;
  mkdirSync(dir, { recursive: true });
  const caPath = join(dir, 'ca.crt');
  const tokenPath = join(dir, 'token');
  writeFileSync(caPath, ca);

  docker([
    'run',
    '-d',
    '--name',
    name,
    '--user',
    '1990:1990',
    '-p',
    `127.0.0.1:${port}:8200`,
    '-v',
    `${name}-cfg:/openbao/cfg:ro`,
    '-v',
    `${name}-data:/openbao/data`,
    '--tmpfs',
    '/openbao/audit:uid=1990,gid=1990',
    openbaoImage(),
    'server',
    '-config=/openbao/cfg/openbao.hcl',
  ]);
  const call = caller(port, ca);
  await waitStatus(call, (s) => s !== 0);
  const init = await call('PUT', 'sys/init', {
    body: { recovery_shares: 1, recovery_threshold: 1 },
  });
  await waitStatus(call, (s) => s === 200);
  const restored = await call('POST', 'sys/storage/raft/snapshot-force', {
    token: init.json.root_token,
    raw: readFileSync(snapshot),
  });
  check('снимок OpenBao принят', restored.status === 204, `код ${restored.status}`);
  const open = await waitStatus(call, (s) => s === 200);
  check('OpenBao открылся сам ключом из комплекта', open === 200, `код ${open}`);

  const root = await rootByRecoveryKey(call, recovery);
  check('ключ восстановления выпустил root-токен', Boolean(root));
  const kv = await call('GET', `kv/data/${prefix}/core/POSTGRES_PASSWORD`, { token: root });
  check(
    'секреты приложения в снимке совпали с комплектом ключей',
    kv.json.data?.data?.value === postgresPassword,
    `код ${kv.status}`,
  );
  const core = await call('POST', 'auth/token/create', {
    token: root,
    body: { policies: [`${prefix}-core`], no_parent: true, ttl: '2h' },
  });
  if (!core.json.auth?.client_token) throw new Error(`нет токена ядра, код ${core.status}`);
  writeFileSync(tokenPath, core.json.auth.client_token, { mode: 0o600 });
  await call('POST', 'auth/token/revoke-self', { token: root });
  return { addr: `https://127.0.0.1:${port}`, caPath, tokenPath, stop };
}
