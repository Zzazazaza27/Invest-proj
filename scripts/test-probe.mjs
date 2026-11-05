#!/usr/bin/env node
/**
 * Проба test-1 одной командой с ноутбука (блок 5, задание 5). Запускает Томас.
 *
 *   node scripts/test-probe.mjs --build <метка> --run <запуск CI> --commit <sha>
 *
 * Одно подключение к серверу: SSH поднимает туннель к OpenBao и обратный туннель к этому процессу,
 * на сервере работает infra/host/test-probe.sh. Спрашивает фразу SSH-ключа и пароль sudo, больше
 * ничего. Комплект среды открывается здесь ключом Томаса, на сервере закрытого ключа нет.
 * Итог пишется в out/test-probe-<время>.txt, чтобы его могли прочитать без пересказа.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker, MEMORY_ONLY, TOOL_IMAGE } from './lib/backup.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '193.233.217.210';
const KEY = join(homedir(), '.ssh', 'thomas_5e');
const MAUS = join(homedir(), '.ssh', 'maus_5e');
const FORWARD = 18210;
const BACK = 18211;
const ENV_ID = 'test-1';
const option = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const build = option('--build');
const runId = option('--run');
const commit = option('--commit');
const secretKey = resolve(option('--secret-key', 'd:/misc/tmp/secret-key.asc'));
const passFile = resolve(option('--passphrase-file', 'd:/misc/tmp/ph.txt'));
const bundle = resolve(
  option('--bundle', join(ROOT, '.local', 'keys-openbao', 'emergency-2d0fff231bcc.gpg')),
);
if (!build || !runId || !commit) {
  console.error('нужны --build, --run, --commit');
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
      secretKey,
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
      `${secretKey}:/in/secret.asc:ro`,
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
      else if (req.url === '/report') {
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

for (const f of [secretKey, passFile, bundle, KEY]) {
  if (!existsSync(f)) {
    console.error(`нет файла ${f}`);
    process.exit(2);
  }
}

const remote = [
  'sudo -H git -C /opt/fifth-element fetch -q origin',
  `sudo -H git -C /opt/fifth-element reset -q --hard ${commit}`,
  `sudo -H env PROBE_TOKEN=${token} PROBE_URL=http://127.0.0.1:${BACK} bash /opt/fifth-element/infra/host/test-probe.sh ${build}`,
].join(' && ');

const ssh = spawn(
  'ssh',
  [
    '-t',
    '-i',
    KEY,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-L',
    `127.0.0.1:${FORWARD}:127.0.0.1:8200`,
    '-R',
    `127.0.0.1:${BACK}:127.0.0.1:${BACK}`,
    `thomas@${HOST}`,
    remote,
  ],
  { stdio: ['inherit', 'pipe', 'inherit'] },
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
