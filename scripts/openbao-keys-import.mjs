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
 * Для проверок вместо туннеля: --addr <https://…> --ca <файл>.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:https';
import { join, resolve } from 'node:path';
import { docker, MEMORY_ONLY, TOOL_IMAGE } from './lib/backup.mjs';
import { ensureKeys, KEK_DOMAINS, withOperatorToken } from './lib/openbao-keys.mjs';

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const HOST = '193.233.217.210';
const TUNNEL_PORT = 18210;
const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** Значения остаются в памяти контейнера и этого процесса: диск Docker и ноутбука их не видит. */
function openKits(kit, bundle, secretKey, passFile) {
  for (const f of [kit, bundle, secretKey, passFile]) {
    if (!existsSync(f)) throw new Error(`нет файла ${f}`);
  }
  const names = KEK_DOMAINS.map((d) => d.env).join(' ');
  const script = [
    'set -e',
    'mkdir -m 700 /secure/gpg /secure/k',
    'g() { printf %s "$PASSPHRASE" | gpg -q --batch --pinentry-mode loopback --passphrase-fd 0 "$@" 2>/dev/null; }',
    'g --import /in/secret.asc',
    'g --decrypt /in/bundle.gpg | sed -n "s/^OPENBAO_THOMAS_PASSWORD=//p"',
    'g --decrypt /in/kit.gpg | tar -x -C /secure/k .local/secrets',
    `for n in ${names}; do printf '%s=%s\\n' "$n" "$(cat "/secure/k/.local/secrets/$n")"; done`,
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
  const keys = Object.fromEntries(
    lines.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  if (!password || lines.length !== KEK_DOMAINS.length) {
    throw new Error(`комплекты не открылись ключом Томаса: ${r.status} ${r.stderr.slice(-200)}`);
  }
  return { password, keys };
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
  const { password, keys } = openKits(
    resolve(option('--kit') ?? ''),
    resolve(option('--bundle') ?? ''),
    resolve(option('--secret-key') ?? ''),
    resolve(option('--passphrase-file') ?? ''),
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
  const report = await withOperatorToken(call, password, (token) =>
    ensureKeys(call, token, option('--prefix') ?? 'prod', keys),
  );
  for (const { name, action } of report) console.log(`${name}: ${action}`);
  console.log('ключи совпали с комплектом, токен отозван');
} catch (error) {
  console.error(`ОШИБКА: ${error.message}`);
  process.exitCode = 1;
} finally {
  tunnel?.kill();
}
