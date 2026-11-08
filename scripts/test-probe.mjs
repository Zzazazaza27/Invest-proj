#!/usr/bin/env node
/**
 * Проба test-1 с ноутбука (блок 5, задание 5). Без участия Томаса: учётка maus и обёртка fifth-test.
 *
 *   node scripts/test-probe.mjs --build <метка> --run <запуск CI> --commit <sha>
 *   node scripts/test-probe.mjs --env test-2 --commit <sha>   test-2 в боевой режим, насовсем
 *
 * Одно подключение к серверу: SSH поднимает туннель к OpenBao и обратный туннель к этому процессу,
 * на сервере работает infra/host/test-probe.sh. Комплект среды открывается здесь ключом Томаса,
 * на сервере закрытого ключа нет.
 * Итог пишется в out/test-probe-<время>.txt, чтобы его могли прочитать без пересказа.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker, MEMORY_ONLY, TOOL_IMAGE } from './lib/backup.mjs';
import { legacyToVaultBytes } from './lib/crypto-migrate.mjs';
import { readCopy } from './lib/openbao-copy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '193.233.217.210';
const MAUS = join(homedir(), '.ssh', 'maus_5e');
const FORWARD = 18210;
const COPY_FORWARD = 18212;
const BACK = 18211;
const option = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const ENV_ID = option('--env', 'test-1');
if (!['test-1', 'test-2'].includes(ENV_ID)) {
  console.error('--env: test-1 или test-2');
  process.exit(2);
}
const PILOT = ENV_ID === 'test-2';
const build = option('--build');
const runId = option('--run');
const commit = option('--commit');
const ownerKeyPath = ['d:/misc/tmp', 'secret-key.asc'].join('/');
const keyFile = resolve(option('--secret-key', ownerKeyPath));
const passFile = resolve(option('--passphrase-file', 'd:/misc/tmp/ph.txt'));
const keysDir = join(ROOT, '.local', 'keys-openbao');
const bundle = resolve(
  option('--bundle') ??
    join(keysDir, readdirSync(keysDir).find((name) => name.endsWith('.gpg')) ?? 'нет'),
);
if (!commit || (!PILOT && (!build || !runId))) {
  console.error(PILOT ? 'нужен --commit' : 'нужны --build, --run, --commit');
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'test-probe-'));
const token = randomBytes(24).toString('hex');
const kitFile = join(work, 'transition.gpg');
mkdirSync(join(ROOT, 'out'), { recursive: true });
const logFile = join(ROOT, 'out', `test-probe-${Date.now()}.txt`);
const log = createWriteStream(logFile);
const note = (line) => {
  console.log(line);
  log.write(`${line}\n`);
};
let verdict = 'нет итога';

const run = (command, args, options = {}) => {
  const r = spawnSync(command, args, { encoding: 'buffer', maxBuffer: 1 << 30, ...options });
  if (r.status !== 0) throw new Error(`${command}: код ${r.status}`);
  return r.stdout;
};

function kitArtifact() {
  const dir = join(work, 'artifact');
  run('gh', ['run', 'download', runId, '--name', `kit-${build}`, '--dir', dir]);
  return run('tar', ['-C', dir, '-cf', '-', '.']);
}

/** Импорт через туннель; наружу отдаётся только то, что нужно Agent среды. */
function importKeys() {
  const out = join(work, 'agent');
  mkdirSync(out, { recursive: true });
  const ca = join(work, 'tls.crt');
  writeFileSync(
    ca,
    run('ssh', [
      '-i',
      MAUS,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
      `maus@${HOST}`,
      'cat /etc/fifth-openbao/tls/tls.crt',
    ]),
  );
  const r = spawnSync(
    process.execPath,
    [
      join(ROOT, 'scripts', 'openbao-keys-import.mjs'),
      '--kit',
      kitFile,
      '--bundle',
      bundle,
      '--secret-key',
      keyFile,
      '--passphrase-file',
      passFile,
      '--secrets-path',
      'secrets',
      '--addr',
      `https://127.0.0.1:${FORWARD}`,
      '--ca',
      ca,
      '--prefix',
      ENV_ID,
      '--agent-dir',
      out,
    ],
    { encoding: 'utf8' },
  );
  note(`${r.stdout}${r.stderr}`.trim());
  if (r.status !== 0) throw new Error('импорт не прошёл');
  return run('tar', ['-C', out, '-cf', '-', '.']);
}

/** Комплект открывается в памяти контейнера, наружу идёт поток для возврата. */
function restoreTar() {
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
      `${kitFile}:/in/kit.gpg:ro`,
      '-v',
      `${keyFile}:/in/secret.asc:ro`,
      '--entrypoint',
      'sh',
      TOOL_IMAGE,
      '-c',
      [
        'set -e',
        'mkdir -m 700 /secure/gpg',
        'g() { printf %s "$PASSPHRASE" | gpg -q --batch --pinentry-mode loopback --passphrase-fd 0 "$@" 2>/dev/null; }',
        'g --import /in/secret.asc',
        'g --decrypt /in/kit.gpg | base64 -w0',
      ].join('\n'),
    ],
    { env: { PASSPHRASE: readFileSync(passFile, 'utf8').trim() } },
  );
  return Buffer.from(r.stdout.trim(), 'base64');
}

/** Значения комплекта остаются в памяти этого процесса. */
function bundleValues() {
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
      `${bundle}:/in/bundle.gpg:ro`,
      '-v',
      `${keyFile}:/in/secret.asc:ro`,
      '--entrypoint',
      'sh',
      TOOL_IMAGE,
      '-c',
      [
        'set -e',
        'mkdir -m 700 /secure/gpg',
        'g() { printf %s "$PASSPHRASE" | gpg -q --batch --pinentry-mode loopback --passphrase-fd 0 "$@" 2>/dev/null; }',
        'g --import /in/secret.asc',
        'g --decrypt /in/bundle.gpg',
      ].join('\n'),
    ],
    { env: { PASSPHRASE: readFileSync(passFile, 'utf8').trim() } },
  );
  const value = (name) => new RegExp(`^${name}=(.+)$`, 'm').exec(r.stdout)?.[1];
  return { recovery: value('OPENBAO_RECOVERY_KEY'), password: value('OPENBAO_THOMAS_PASSWORD') };
}

/** Копия читается через туннель: ключ восстановления на сервер не попадает. */
async function copyCheck(body) {
  const lines = body.toString('utf8').trim().split('\n');
  const expected = lines.pop().replace('hashes ', '').split(',');
  const rows = lines.map((line) => {
    const [dek, email] = line.split(' ');
    const bytes = Buffer.from(dek, 'hex');
    const wrapped =
      bytes.subarray(0, 6).toString('latin1') === 'vault:' ? bytes : legacyToVaultBytes(bytes);
    return { wrappedDek: wrapped.toString('ascii'), emailCiphertext: Buffer.from(email, 'hex') };
  });
  const ca = readFileSync(join(work, 'tls.crt'));
  const call = (method, path, { token, body: payload } = {}) =>
    new Promise((done, fail) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port: COPY_FORWARD,
          method,
          path: `/v1/${path}`,
          ca,
          servername: 'localhost',
          headers: {
            ...(token ? { 'X-Vault-Token': token } : {}),
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(15_000),
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (text += chunk));
          res.on('error', fail);
          res.on('end', () => done({ status: res.statusCode, json: text ? JSON.parse(text) : {} }));
        },
      );
      req.on('error', fail);
      req.end(payload ? JSON.stringify(payload) : undefined);
    });
  const hashes = await readCopy(call, { ...bundleValues(), prefix: ENV_ID, rows });
  if (hashes.some((hash) => !expected.includes(hash))) throw new Error('адрес не совпал');
  return `копия прочитана: ключ восстановления принят, записей ${hashes.length}, старая и новая\n`;
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const send = (body) => {
      res.writeHead(200);
      res.end(body);
    };
    try {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(403);
        res.end();
      } else if (req.url === '/kit.tar') send(kitArtifact());
      else if (req.url === '/ghcr-token') send(run('gh', ['auth', 'token']));
      else if (req.url === '/kit') {
        writeFileSync(kitFile, Buffer.concat(chunks));
        send('ok');
      } else if (req.url === '/import') send(importKeys());
      else if (req.url === '/restore.tar') send(restoreTar());
      else if (req.url === '/stage') send(option('--stage', 'transit'));
      else if (req.url === '/copy-check') {
        copyCheck(Buffer.concat(chunks)).then(send, (error) => {
          note(`ОШИБКА копии: ${error.message}`);
          res.writeHead(500);
          res.end();
        });
      } else if (req.url === '/report') {
        verdict = Buffer.concat(chunks).toString('utf8');
        send('ok');
      } else {
        res.writeHead(404);
        res.end();
      }
    } catch (error) {
      note(`ОШИБКА на ноутбуке: ${error.message}`);
      res.writeHead(500);
      res.end();
    }
  });
});
await new Promise((done) => server.listen(BACK, '127.0.0.1', done));

for (const f of [keyFile, passFile, bundle, MAUS]) {
  if (!existsSync(f)) {
    console.error(`нет файла ${f}`);
    process.exit(2);
  }
}

const remote = [
  `sudo -n /usr/local/sbin/fifth-test sync ${commit}`,
  // Пилотная среда — шаг с откатом при сбое, а не проба: данные людей остаются на месте.
  PILOT
    ? `sudo -n /usr/local/sbin/fifth-test op prod-test2-production ${token}`
    : `sudo -n /usr/local/sbin/fifth-test probe ${build} ${token}`,
].join(' && ');

const ssh = spawn(
  'ssh',
  [
    '-i',
    MAUS,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-L',
    `127.0.0.1:${FORWARD}:127.0.0.1:8200`,
    '-L',
    `127.0.0.1:${COPY_FORWARD}:127.0.0.1:18300`,
    '-R',
    `127.0.0.1:${BACK}:127.0.0.1:${BACK}`,
    `maus@${HOST}`,
    remote,
  ],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
ssh.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  log.write(chunk);
});
const code = await new Promise((done) => ssh.on('close', done));
server.close();
rmSync(work, { recursive: true, force: true });
note(`\nИТОГ: ${verdict}, код ${code}`);
note(`Запись пробы: ${logFile}`);
log.end(() => process.exit(code === 0 ? 0 : 1));
