#!/usr/bin/env node
/**
 * Переход рабочей среды на OpenBao, шаги 1–2 (блок 5, задание 5). Запускает Томас.
 *
 *   node scripts/prod-transition.mjs --build 2.1-b120.1 --expect 2.1-b104.1 --commit <sha>
 *
 * Выпуск, читающий оба формата; переходный комплект и его копия на ноутбук; импорт ключей и секретов
 * через туннель; Agent; ядро в kms/legacy. Запись остаётся прежним форматом, при сбое ядра .env
 * возвращается сам. KEK на сервере этим не удаляются. Значения не печатаются.
 * Запись хода: out/prod-transition-<время>.txt.
 *
 * Боевой режим: --stage production --mail-to <адрес>. Учётка почты и сертификаты, новый комплект и
 * импорт, ядро на файлах Agent, затем TLS, mTLS и NODE_ENV=production. При сбое режим возвращается сам.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'maus@193.233.217.210';
const KEY = join(homedir(), '.ssh', 'maus_5e');
const SSH = ['-i', KEY, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes'];
const FORWARD = 18210;
const option = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const production = option('--stage') === 'production';
const build = option('--build');
const expect = option('--expect');
const commit = option('--commit');
const secretKey = resolve(option('--secret-key', 'd:/misc/tmp/secret-key.asc'));
const passFile = resolve(option('--passphrase-file', 'd:/misc/tmp/ph.txt'));
if (!build || !expect || !commit) {
  console.error('нужны --build, --expect, --commit');
  process.exit(2);
}

const keysDir = join(ROOT, '.local', 'keys-openbao');
const bundle = join(
  keysDir,
  readdirSync(keysDir).find((n) => n.startsWith('emergency') && n.endsWith('.gpg')),
);
mkdirSync(join(ROOT, 'out'), { recursive: true });
const logFile = join(ROOT, 'out', `prod-transition-${Date.now()}.txt`);
const log = createWriteStream(logFile);
const note = (text) => {
  console.log(text);
  log.write(`${text}\n`);
};

function remote(command, input) {
  const r = spawnSync('ssh', [...SSH, HOST, command], { input, maxBuffer: 1 << 28 });
  if (r.status !== 0) {
    note(`${r.stdout}${r.stderr}`.trim());
    throw new Error(`шаг не прошёл: ${command.slice(0, 80)}`);
  }
  return r.stdout;
}
const op = (name, ...args) => {
  note(`\n▸ ${name}`);
  note(
    remote(`sudo -n /usr/local/sbin/fifth-test op ${[name, ...args].join(' ')}`)
      .toString()
      .trim(),
  );
};

const work = mkdtempSync(join(tmpdir(), 'prod-transition-'));
let tunnel = null;
let failed = false;
try {
  remote(`sudo -n /usr/local/sbin/fifth-test sync ${commit}`);
  if (option('--stage') === 'tighten') {
    op('prod-tighten');
    note('\nИТОГ: ЗАМЕЧАНИЯ ПРИМЕНЕНЫ');
    process.exitCode = 0;
    throw Object.assign(new Error('готово'), { done: true });
  }
  if (production) op('prod-prepare');
  else op('prod-release', build, expect);
  op('prod-kit');

  note('\n▸ комплект на ноутбук');
  const meta = JSON.parse(
    remote('sudo -n /usr/local/sbin/fifth-backup-read transition-kit-meta').toString(),
  );
  const kit = remote('sudo -n /usr/local/sbin/fifth-backup-read transition-kit');
  if (createHash('sha256').update(kit).digest('hex') !== meta.kitSha256) {
    throw new Error('комплект не совпал с описанием');
  }
  const name = `transition-${meta.kitSha256.slice(0, 12)}`;
  const kitFile = join(keysDir, `${name}.gpg`);
  writeFileSync(kitFile, kit);
  writeFileSync(join(keysDir, `${name}.json`), `${JSON.stringify(meta, null, 2)}\n`);
  note(`сохранён: ${kitFile}, файлов ${meta.files}`);

  note('\n▸ импорт через туннель');
  const ca = join(work, 'tls.crt');
  writeFileSync(ca, remote('cat /etc/fifth-openbao/tls/tls.crt'));
  tunnel = spawn(
    'ssh',
    [
      ...SSH,
      '-N',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      `127.0.0.1:${FORWARD}:127.0.0.1:8200`,
      HOST,
    ],
    {
      stdio: 'ignore',
    },
  );
  const imported = spawnSync(
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
      '--addr',
      `https://127.0.0.1:${FORWARD}`,
      '--ca',
      ca,
      '--prefix',
      'prod',
      '--agent-dir',
      work,
    ],
    { encoding: 'utf8' },
  );
  note(`${imported.stdout}${imported.stderr}`.trim());
  if (imported.status !== 0) throw new Error('импорт не прошёл');

  note('\n▸ prod-agent');
  note(
    remote(
      'sudo -n /usr/local/sbin/fifth-test op prod-agent',
      readFileSync(join(work, 'agent.hcl')),
    )
      .toString()
      .trim(),
  );
  if (production) {
    op('prod-agent-core');
    op('prod-production', option('--mail-to'));
    note('\nИТОГ: БОЕВОЙ РЕЖИМ ВКЛЮЧЁН');
  } else {
    op('prod-kms');
    note('\nИТОГ: ПЕРЕХОД НА KMS/LEGACY ПРОЙДЕН');
  }
} catch (error) {
  if (!error.done) {
    failed = true;
    note(`\nИТОГ: ОСТАНОВЛЕНО — ${error.message}`);
  }
} finally {
  tunnel?.kill();
  rmSync(work, { recursive: true, force: true });
}
note(`Запись: ${logFile}`);
log.end(() => process.exit(failed ? 1 : 0));
