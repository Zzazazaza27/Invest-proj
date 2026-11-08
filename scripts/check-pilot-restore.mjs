#!/usr/bin/env node
/**
 * Восстановление копии пилотной среды на ноутбуке, без обращения к ней самой.
 *
 *   node scripts/check-pilot-restore.mjs [--secret-key <файл>] [--passphrase-file <файл>]
 *                                        [--control <SHA-256 контрольного файла>]
 *
 * Скачивает последнюю копию через `fifth-backup-read`, сверяет хеши описи, расшифровывает ключом
 * Томаса в том площадки, поднимает базу, сверяет число записей и файлы, открывает контакты ключами
 * из копии. Всё открытое живёт в томе и удаляется в конце. Значения не печатаются.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const ownerKeyPath = ['d:/misc/tmp', 'secret-key.asc'].join('/');
const keyFile = resolve(option('--secret-key', ownerKeyPath));
const passFile = resolve(option('--passphrase-file', 'd:/misc/tmp/ph.txt'));
const control = option('--control', null);
const IMAGE = 'fifth/postgres:16';
const CORE = option('--core-image', 'fifth/core:dev');
const VOLUME = 'fifth-pilot-restore';
const PG = 'fifth-pilot-restore-pg';
const WORK = join(ROOT, '.local', 'pilot-restore');
const env = { ...process.env, MSYS_NO_PATHCONV: '1' };

let failed = 0;
const check = (name, ok, details = '') => {
  if (!ok) failed += 1;
  console.log(
    `  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details ? ` — ${String(details).slice(0, 200)}` : ''}`,
  );
};
const docker = (args, options = {}) =>
  spawnSync('docker', args, { encoding: 'utf8', env, maxBuffer: 1 << 28, ...options });
const read = (command) =>
  spawnSync(
    'ssh',
    [
      '-i',
      join(homedir(), '.ssh', 'maus_5e'),
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
      'maus@193.233.217.210',
      `sudo -n /usr/local/sbin/fifth-backup-read ${command}`,
    ],
    { maxBuffer: 1 << 30 },
  );
const clean = () => {
  docker(['rm', '-f', '-v', PG]);
  docker(['volume', 'rm', '-f', VOLUME]);
  rmSync(WORK, { recursive: true, force: true });
};

clean();
mkdirSync(WORK, { recursive: true });
try {
  const set = read('pilot-latest').stdout.toString().trim();
  if (!set) throw new Error('готовых копий нет');
  console.log(`=== ВОССТАНОВЛЕНИЕ КОПИИ ${set} ===`);
  const manifest = JSON.parse(read(`pilot-file ${set}/manifest.json`).stdout.toString());
  for (const name of ['db.dump.gpg', 'roles.sql.gpg', 'files.tar.gpg', 'env.tar.gpg']) {
    const bytes = read(`pilot-file ${set}/${name}`).stdout;
    writeFileSync(join(WORK, name), bytes);
    check(
      `${name}: хеш описи`,
      createHash('sha256').update(bytes).digest('hex') === manifest.sha256[name],
    );
  }
  const open = docker(
    [
      'run',
      '--rm',
      '--network',
      'none',
      '-u',
      '0',
      '-e',
      'PASSPHRASE',
      '-v',
      `${VOLUME}:/w`,
      '-v',
      `${WORK}:/in:ro`,
      '-v',
      `${keyFile}:/key.asc:ro`,
      '--entrypoint',
      'sh',
      IMAGE,
      '-c',
      [
        'set -e',
        'export GNUPGHOME=$(mktemp -d)',
        'd() { printf %s "$PASSPHRASE" | gpg -q --batch --pinentry-mode loopback --passphrase-fd 0 "$@"; }',
        'd --import /key.asc 2>/dev/null',
        'd --decrypt /in/db.dump.gpg > /w/db.dump 2>/dev/null',
        'd --decrypt /in/roles.sql.gpg > /w/roles.sql 2>/dev/null',
        'mkdir -p /w/files /w/env',
        'd --decrypt /in/files.tar.gpg 2>/dev/null | tar -xf - -C /w/files',
        'd --decrypt /in/env.tar.gpg 2>/dev/null | tar -xf - -C /w/env',
        'cd /w/files && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum | sha256sum | cut -d" " -f1',
        'if [ -f _control/restore-check.bin ]; then sha256sum _control/restore-check.bin | cut -d" " -f1; fi',
      ].join('\n'),
    ],
    { env: { ...env, PASSPHRASE: readFileSync(passFile, 'utf8').trim() } },
  );
  check('копия открыта ключом Томаса', open.status === 0, open.stderr.slice(-160));
  const [filesSum, controlSum] = open.stdout.trim().split('\n');
  check('файлы совпали с описью', filesSum === manifest.filesSum, `файлов ${manifest.objects}`);
  if (control) check('контрольный файл восстановлен без искажений', controlSum === control);

  docker([
    'run',
    '-d',
    '--name',
    PG,
    '--network',
    'none',
    '-e',
    'POSTGRES_PASSWORD=restore',
    '-e',
    'POSTGRES_USER=fifth_owner',
    '-e',
    'POSTGRES_DB=fifth_element',
    '-v',
    `${VOLUME}:/w:ro`,
    '--entrypoint',
    'docker-entrypoint.sh',
    IMAGE,
    'postgres',
  ]);
  // При первом запуске сервер поднимается дважды: первый раз временно, для начальной настройки.
  for (let i = 0; i < 60; i += 1) {
    const log = docker(['logs', PG]);
    const ready = `${log.stdout}${log.stderr}`.match(/ready to accept connections/g) ?? [];
    if (ready.length >= 2) break;
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
  }
  // Роль владельца уже есть, поэтому её строки дают отказ: важны остальные роли.
  docker(['exec', PG, 'psql', '-q', '-U', 'fifth_owner', '-d', 'postgres', '-f', '/w/roles.sql']);
  const restored = docker([
    'exec',
    PG,
    'pg_restore',
    '-U',
    'fifth_owner',
    '-d',
    'fifth_element',
    '--no-owner',
    '/w/db.dump',
  ]);
  const errors = restored.stderr.split(String.fromCharCode(10)).filter((l) => /error/i.test(l));
  check('база восстановлена без ошибок', errors.length === 0, errors.slice(0, 2).join(' | '));
  const psql = (sql) =>
    docker([
      'exec',
      PG,
      'psql',
      '-U',
      'fifth_owner',
      '-d',
      'fifth_element',
      '-At',
      '-F=',
      '-c',
      sql,
    ]).stdout.trim();
  const counts = psql(
    `SELECT 'users', count(*) FROM identity.users UNION ALL SELECT 'projects', count(*) FROM lab.projects UNION ALL SELECT 'materials', count(*) FROM lab.project_materials`,
  )
    .split('\n')
    .join(',');
  check('записи совпали с описью', counts === manifest.counts, counts);

  const rows = psql(
    `SELECT encode(contact_wrapped_dek, 'hex') || ' ' || encode(email_ciphertext, 'hex') FROM identity.users WHERE email_ciphertext IS NOT NULL`,
  );
  // Среда в боевом режиме пишет прежним форматом: копия открывается KEK среды без OpenBao.
  const opened = docker(
    [
      'run',
      '--rm',
      '-i',
      '--network',
      'none',
      '-u',
      '0',
      '-v',
      `${VOLUME}:/w:ro`,
      '--entrypoint',
      'sh',
      CORE,
      '-c',
      `rm -rf /run/secrets; ln -s /w/env/secrets /run/secrets; set -a; . /w/env/settings.env; set +a; export NODE_ENV=development KMS_MODE=local SESSION_COOKIE_NAME=ul_session CSRF_COOKIE_NAME=ul_csrf; unset OPENBAO_ADDR OPENBAO_TOKEN_PATH NODE_EXTRA_CA_CERTS INTEGRATION_CLIENT_CERT_HEADER; rm -rf /run/fifth-secrets; ln -s /w/env/secrets /run/fifth-secrets; for f in /run/secrets/KEK_*; do export $(basename $f)_FILE=$f; done; node -e "
require('reflect-metadata');
const {CryptoService}=require('/app/apps/core/dist/crypto/crypto.service.js');
const c=new CryptoService();
(async()=>{let n=0;for(const l of require('fs').readFileSync(0,'utf8').trim().split('\\n')){const [d,e]=l.split(' ');
await c.openField('passport_sensitive',Buffer.from(d,'hex'),Buffer.from(e,'hex'),'email');n+=1;}console.log(n);})().catch((e)=>{console.error(e.message);process.exit(1)});"`,
    ],
    { input: rows },
  );
  const total = rows ? rows.split('\n').length : 0;
  check(
    `контакты открылись ключами из копии (${total})`,
    opened.status === 0 && opened.stdout.trim() === String(total),
    opened.stderr.slice(-200),
  );
} catch (error) {
  check('проверка оборвана', false, error.message);
} finally {
  clean();
}
console.log(failed ? `=== ОТКАЗОВ: ${failed} ===` : '=== КОПИЯ ВОССТАНОВЛЕНА ===');
process.exit(failed ? 1 : 0);
