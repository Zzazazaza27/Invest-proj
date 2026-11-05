#!/usr/bin/env node
/**
 * Импорт рабочих ключей в Transit с ноутбука (блок 5, задание 5). Запускает Томас.
 *
 *   node scripts/openbao-keys-import.mjs --kit <transition.gpg> --bundle <emergency.gpg> \
 *     --secret-key <файл> --passphrase-file <файл> [--prefix prod]
 *
 * Открывает комплекты ключом Томаса в памяти, поднимает SSH-туннель к OpenBao и работает по TLS с
 * закреплённым сертификатом. Пароль оператора не попадает на VPS и в журнал, выданный токен
 * отзывается при любом исходе. Повтор безопасен: занятое имя только сверяется.
 *
 * Заодно загружает секреты среды в KV и пишет шаблоны Agent в --agent-out: в них только имена.
 *
 * Для проверок вместо туннеля: --addr <https://…> --ca <файл>.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker, MEMORY_ONLY, TOOL_IMAGE } from './lib/backup.mjs';
import {
  agentTemplates,
  ensureKeys,
  ensureSecrets,
  KEK_DOMAINS,
  withOperatorToken,
} from './lib/openbao-keys.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const HOST = '193.233.217.210';
const TUNNEL_PORT = 18210;
const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** Значения остаются в памяти контейнера и этого процесса: диск Docker и ноутбука их не видит. */
function openKits(kit, bundle, secretKey, passFile, secretsPath) {
  for (const f of [kit, bundle, secretKey, passFile]) {
    if (!existsSync(f)) throw new Error(`нет файла ${f}`);
  }
  const script = [
    'set -e',
    'mkdir -m 700 /secure/gpg /secure/k',
    'g() { printf %s "$PASSPHRASE" | gpg -q --batch --pinentry-mode loopback --passphrase-fd 0 "$@" 2>/dev/null; }',
    'g --import /in/secret.asc',
    'g --decrypt /in/bundle.gpg | sed -n "s/^OPENBAO_THOMAS_PASSWORD=//p"',
    `g --decrypt /in/kit.gpg | tar -x -C /secure/k ${secretsPath}`,
    'for f in /secure/k/$SECRETS_PATH/*; do [ -f "$f" ] && printf "%s=%s\\n" "$(basename "$f")" "$(base64 -w0 "$f")"; done',
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
      '-e',
      `SECRETS_PATH=${secretsPath}`,
      '-v',
      `${kit}:/in/kit.gpg:ro`,
      '-v',
      `${bundle}:/in/bundle.gpg:ro`,
      '-v',
      `${secretKey}:/in/secret.asc:ro`,
      '--entrypoint',
      'sh',
      TOOL_IMAGE,
      '-c',
      script,
    ],
    { env: { PASSPHRASE: readFileSync(passFile, 'utf8').trim() }, allowFail: true },
  );
  const [password, ...lines] = r.stdout.trim().split('\n');
  const all = Object.fromEntries(
    lines.map((line) => {
      const value = Buffer.from(line.slice(line.indexOf('=') + 1), 'base64').toString('utf8');
      return [line.slice(0, line.indexOf('=')), value.replace(/\r?\n$/, '')];
    }),
  );
  const keys = Object.fromEntries(KEK_DOMAINS.map((d) => [d.env, all[d.env]]));
  const secrets = Object.fromEntries(Object.entries(all).filter(([name]) => !/^KEK_/.test(name)));
  if (!password || KEK_DOMAINS.some((d) => !all[d.env])) {
    throw new Error(`комплекты не открылись ключом Томаса: ${r.status} ${r.stderr.slice(-200)}`);
  }
  return { password, keys, secrets };
}

/** Политика и AppRole среды: те же права, что у ядра, но на её имена. */
async function environmentAccess(call, token, prefix) {
  const policy = readFileSync(join(ROOT, 'infra', 'openbao', 'policy-prod-core.hcl'), 'utf8')
    .replaceAll('prod/core', `${prefix}/core`)
    .replaceAll('/prod-', `/${prefix}-`);
  const name = `${prefix}-core`;
  const rotatePolicy = readFileSync(
    join(ROOT, 'infra', 'openbao', 'policy-prod-rotate.hcl'),
    'utf8',
  ).replaceAll('/prod-', `/${prefix}-`);
  const steps = [
    ['PUT', `sys/policies/acl/${name}`, { policy }],
    ['PUT', `sys/policies/acl/${prefix}-rotate`, { policy: rotatePolicy }],
    [
      'POST',
      `auth/approle/role/${name}`,
      { token_policies: name, token_ttl: '1h', token_max_ttl: '4h' },
    ],
  ];
  for (const [method, path, body] of steps) {
    const r = await call(method, path, { token, body });
    if (r.status >= 300) throw new Error(`${path}: код ${r.status}`);
  }
  const role = await call('GET', `auth/approle/role/${name}/role-id`, { token });
  const secret = await call('POST', `auth/approle/role/${name}/secret-id`, { token });
  const rotate = await call('POST', 'auth/token/create', {
    token,
    body: { policies: [`${prefix}-rotate`], no_default_policy: true, ttl: '1h' },
  });
  return {
    roleId: role.json.data.role_id,
    secretId: secret.json.data.secret_id,
    rotateToken: rotate.json.auth.client_token,
  };
}

/** Настройка Agent среды: вход и токен как у ядра, шаблоны — на её секреты. */
function agentConfig(prefix, names) {
  const base = readFileSync(join(ROOT, 'infra', 'openbao', 'agent-core.hcl'), 'utf8');
  const head = base.slice(0, base.indexOf('template {'));
  return `${head.replace('address = "https://127.0.0.1:8200"', 'address = "https://fifth-openbao:8200"\n  tls_server_name = "localhost"')}${agentTemplates(prefix, names)}`;
}

function parsed(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function client(addr, ca) {
  const url = new URL(addr);
  return (method, path, { token, body } = {}) =>
    new Promise((done, fail) => {
      const req = request(
        {
          host: url.hostname,
          port: url.port,
          method,
          path: `/v1/${path}`,
          ca,
          servername: 'localhost',
          headers: {
            ...(token ? { 'X-Vault-Token': token } : {}),
            'Content-Type': 'application/json',
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => {
            done({ status: res.statusCode, json: parsed(text) });
          });
          res.on('error', fail);
        },
      );
      req.on('error', fail);
      req.setTimeout(15_000, () => req.destroy(new Error('таймаут OpenBao')));
      req.end(body ? JSON.stringify(body) : undefined);
    });
}

/** Сертификат берётся учёткой maus: он не секрет, а закрепление защищает пароль внутри туннеля. */
function serverCertificate() {
  const r = spawnSync(
    'ssh',
    [
      '-i',
      join(HOME, '.ssh', 'maus_5e'),
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
      `maus@${HOST}`,
      'cat /etc/fifth-openbao/tls/tls.crt',
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0 || !r.stdout.includes('BEGIN CERTIFICATE')) {
    throw new Error('сертификат OpenBao не получен');
  }
  return r.stdout;
}

/** Туннель под ключом Томаса: фразу спрашивает сам ssh, через этот процесс она не проходит. */
async function openTunnel() {
  const ssh = spawn(
    'ssh',
    [
      '-N',
      '-i',
      join(HOME, '.ssh', 'thomas_5e'),
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      `127.0.0.1:${TUNNEL_PORT}:127.0.0.1:8200`,
      `thomas@${HOST}`,
    ],
    { stdio: 'inherit' },
  );
  return ssh;
}

async function waitFor(call) {
  for (let i = 0; i < 120; i++) {
    const up = await call('GET', 'sys/seal-status').then(
      (r) => r.json.sealed === false,
      () => false,
    );
    if (up) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('OpenBao через туннель не ответил');
}

let tunnel = null;
try {
  const { password, keys, secrets } = openKits(
    resolve(option('--kit') ?? ''),
    resolve(option('--bundle') ?? ''),
    resolve(option('--secret-key') ?? ''),
    resolve(option('--passphrase-file') ?? ''),
    option('--secrets-path') ?? '.local/secrets',
  );
  let call;
  if (option('--addr')) {
    call = client(option('--addr'), readFileSync(resolve(option('--ca') ?? '')));
  } else {
    const ca = serverCertificate();
    tunnel = await openTunnel();
    call = client(`https://127.0.0.1:${TUNNEL_PORT}`, ca);
  }
  await waitFor(call);
  const prefix = option('--prefix') ?? 'prod';
  const { report, stored, access } = await withOperatorToken(call, password, async (token) => ({
    report: await ensureKeys(call, token, prefix, keys),
    stored: await ensureSecrets(call, token, prefix, secrets),
    // Установка могла пройти раньше этой политики: root-токена уже нет, поэтому ставит оператор.
    policy: await call('PUT', 'sys/policies/acl/prod-rotate', {
      token,
      body: {
        policy: readFileSync(join(ROOT, 'infra', 'openbao', 'policy-prod-rotate.hcl'), 'utf8'),
      },
    }),
    access: option('--agent-dir') ? await environmentAccess(call, token, prefix) : null,
  }));
  for (const { name, action } of report) console.log(`${name}: ${action}`);
  console.log(`KV: записано ${stored.written}, уже на месте ${stored.same}`);
  if (option('--agent-out')) {
    writeFileSync(resolve(option('--agent-out')), agentTemplates(prefix, Object.keys(secrets)));
  }
  if (access) {
    const dir = resolve(option('--agent-dir'));
    writeFileSync(join(dir, 'role-id'), access.roleId);
    writeFileSync(join(dir, 'secret-id'), access.secretId);
    writeFileSync(join(dir, 'rotate-token'), access.rotateToken);
    writeFileSync(join(dir, 'agent.hcl'), agentConfig(prefix, Object.keys(secrets)));
  }
  console.log('ключи и секреты совпали с комплектом, токен отозван');
} catch (error) {
  console.error(`ОШИБКА: ${error.message}`);
  process.exitCode = 1;
} finally {
  tunnel?.kill();
}
