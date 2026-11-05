#!/usr/bin/env node
/**
 * Установка OpenBao без ручных шагов на искусственных ключах (блок 5, задание 3).
 *
 *   node scripts/check-openbao-auto.mjs
 *
 * Обрывает настоящий setup-vps.sh после инициализации и после отзыва root-токена: повтор
 * не теряет управление и не требует утраченного токена. Комплект открывается ключом получателя.
 * Повтор над запечатанным или упавшим OpenBao не сообщает об успехе: проверяется на заглушках.
 */
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_IMAGE } from './lib/backup.mjs';
import { KEK_DOMAINS, sameText, withOperatorToken } from './lib/openbao-keys.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'infra', 'openbao');
const IMAGE = process.env.OPENBAO_IMAGE || 'openbao/openbao:2.7.2';
const NAME = 'fifth-openbao-auto';
const VOLUME = 'fifth-openbao-auto-data';
const PORT = 18202;
const base = mkdtempSync(join(tmpdir(), 'openbao-auto-'));
const dir = join(base, 'cfg');
const keys = join(base, 'keys');
const gpgDir = join(base, 'gpg');
const PHRASE = 'lab-only-phrase';
let passed = 0;
let failed = 0;
const check = (name, ok, details = '') => {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details ? ` — ${details}` : ''}`);
};
const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

let ca;
function api(method, path, { token, body } = {}) {
  return new Promise((resolve_, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
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
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json;
          try {
            json = text ? JSON.parse(text) : {};
          } catch {
            json = {};
          }
          resolve_({ status: res.statusCode, json });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('таймаут')));
    req.end(data);
  });
}

async function start() {
  const r = docker(
    'run',
    '-d',
    '--name',
    NAME,
    '--user',
    '1990:1990',
    '-p',
    `127.0.0.1:${PORT}:8200`,
    '-v',
    `${join(SRC, 'openbao.hcl')}:/openbao/config/openbao.hcl:ro`,
    '-v',
    `${join(dir, 'seal')}:/openbao/seal:ro`,
    '-v',
    `${join(dir, 'tls')}:/openbao/tls:ro`,
    '-v',
    `${VOLUME}:/openbao/data`,
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
  throw new Error('OpenBao не поднялся');
}

/** Пара ключей получателя: настоящая форма, искусственные значения. */
function makeRecipient() {
  mkdirSync(gpgDir, { recursive: true });
  const script = [
    'set -e',
    'export GNUPGHOME=$(mktemp -d)',
    `gpg -q --batch --pinentry-mode loopback --passphrase '${PHRASE}' --quick-gen-key "lab <lab@example.test>" rsa2048 encrypt never`,
    "fpr=$(gpg --batch --list-keys --with-colons | awk -F: '/^fpr/{print $10; exit}')",
    'gpg -q --batch --armor --export "$fpr" > /out/recipient.asc',
    `gpg -q --batch --pinentry-mode loopback --passphrase '${PHRASE}' --armor --export-secret-keys "$fpr" > /out/secret.asc`,
    'echo "$fpr"',
  ].join('\n');
  const r = docker(
    'run',
    '--rm',
    '--network',
    'none',
    '-v',
    `${gpgDir}:/out`,
    '--entrypoint',
    'sh',
    TOOL_IMAGE,
    '-c',
    script,
  );
  if (r.status !== 0) throw new Error(`ключи: ${r.stderr.slice(0, 200)}`);
  writeFileSync(join(gpgDir, 'phrase'), PHRASE);
  return r.stdout.trim().split('\n').pop();
}

function bootstrap(fpr, stopAfter) {
  return spawnSync('bash', [join(SRC, 'setup-vps.sh'), 'bootstrap'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MSYS_NO_PATHCONV: '1',
      FIFTH_OPENBAO_DIR: dir,
      FIFTH_OPENBAO_CONTAINER: NAME,
      FIFTH_OPENBAO_KEYS_DIR: keys,
      FIFTH_OPENBAO_RECIPIENT: join(gpgDir, 'recipient.asc'),
      FIFTH_OPENBAO_RECIPIENT_FPR: fpr,
      FIFTH_OPENBAO_STOP_AFTER: stopAfter ?? '',
    },
  });
}

const keysCheck = (fpr, meta = join(keys, 'meta.json')) =>
  spawnSync(
    process.execPath,
    [
      join(ROOT, 'scripts', 'backup.mjs'),
      'openbao-keys-check',
      '--file',
      join(keys, 'emergency.gpg'),
      '--meta',
      meta,
      '--secret-key',
      join(gpgDir, 'secret.asc'),
      '--passphrase-file',
      join(gpgDir, 'phrase'),
      '--recipient-fpr',
      fpr,
    ],
    { encoding: 'utf8' },
  );

/** Повтор auto поверх готовой установки: заглушки вместо узла, код ответа `bao status` задаётся. */
function repeatAuto(baoRc) {
  const stubs = join(base, 'stubs');
  const cfg = join(base, 'repeat');
  const done = join(base, 'repeat-keys');
  for (const d of [stubs, join(cfg, 'seal'), join(cfg, 'tls'), done]) {
    mkdirSync(d, { recursive: true });
  }
  for (const f of ['seal/static.key', 'tls/tls.crt', 'tls/tls.key'])
    writeFileSync(join(cfg, f), 'x');
  writeFileSync(join(done, 'meta.json'), '{}');
  const stub = (name, body) => writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`);
  for (const name of ['install', 'getent', 'cp', 'systemctl', 'node']) stub(name, 'exit 0');
  stub('docker', '[ "$1" = exec ] && exit "$FAKE_BAO_RC"\nexit 0');
  const run = [
    'p=$STUBS',
    'command -v cygpath >/dev/null && p=$(cygpath -u "$p")',
    'PATH="$p:$PATH" exec bash "$0" auto',
  ].join('\n');
  const r = spawnSync('bash', ['-c', run, join(SRC, 'setup-vps.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MSYS_NO_PATHCONV: '1',
      STUBS: stubs,
      FAKE_BAO_RC: String(baoRc),
      FIFTH_OPENBAO_WAIT: '2',
      FIFTH_OPENBAO_DIR: cfg,
      FIFTH_OPENBAO_KEYS_DIR: done,
    },
  });
  return { status: r.status, text: `${r.stdout}${r.stderr}` };
}

function cleanup() {
  docker('rm', '-f', NAME);
  docker('volume', 'rm', '-f', VOLUME);
}

console.log('=== OPENBAO: УСТАНОВКА БЕЗ РУЧНЫХ ШАГОВ ===');
try {
  console.log('\n▸ Повтор над готовой установкой');
  const sealed = repeatAuto(2);
  check(
    'запечатан — отказ без «готово»',
    sealed.status !== 0 && !sealed.text.includes('готово'),
    sealed.text.slice(-200),
  );
  const down = repeatAuto(1);
  check('недоступен — отказ без «готово»', down.status !== 0 && !down.text.includes('готово'));
  const healthy = repeatAuto(0);
  check(
    'открыт — готово',
    healthy.status === 0 && healthy.text.includes('готово'),
    healthy.text.slice(-200),
  );

  cleanup();
  for (const d of ['seal', 'tls']) mkdirSync(join(dir, d), { recursive: true });
  const seal = randomBytes(32);
  writeFileSync(join(dir, 'seal', 'static.key'), seal);
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
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  if (tls.status !== 0) throw new Error(`сертификат: ${tls.stderr.slice(0, 200)}`);
  ca = readFileSync(join(dir, 'tls', 'tls.crt'));
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
    '1990:1990',
    '/d',
  );
  await start();
  const fpr = makeRecipient();
  const initDone = async () => (await api('GET', 'sys/seal-status')).json.initialized === true;

  const wrong = bootstrap('0'.repeat(40));
  check(
    'чужой отпечаток останавливает до создания ключей',
    wrong.status === 1 && !(await initDone()),
  );

  console.log('\n▸ Обрыв после инициализации');
  const first = bootstrap(fpr, 'init');
  const out = join(dir, 'auto', 'init.out');
  check(
    'обрыв сработал, значения сохранились',
    first.status === 3 && existsSync(out),
    first.stderr.slice(-200),
  );
  const text = readFileSync(out, 'utf8');
  const root = text.match(/^Initial Root Token: (.+)$/m)?.[1]?.trim();
  const recovery = text.match(/^Recovery Key 1: (.+)$/m)?.[1]?.trim();
  check('значения инициализации разбираются', Boolean(root && recovery));
  check('на экран значения не вышли', !`${first.stdout}${first.stderr}`.includes(root));

  console.log('\n▸ Обрыв после отзыва root-токена');
  const second = bootstrap(fpr, 'revoke');
  check(
    'повтор дошёл до отзыва',
    second.status === 3,
    `${second.stdout}${second.stderr}`.slice(-300),
  );
  check('комплект уже записан', existsSync(join(keys, 'emergency.gpg')));
  const lookup = await api('GET', 'auth/token/lookup-self', { token: root });
  check('root-токен отозван', lookup.status === 403, `код ${lookup.status}`);

  console.log('\n▸ Повтор без root-токена');
  const third = bootstrap(fpr);
  check('установка завершилась', third.status === 0, `${third.stdout}${third.stderr}`.slice(-300));
  check('рабочего каталога со значениями нет', !existsSync(join(dir, 'auto')));
  const all = `${second.stdout}${second.stderr}${third.stdout}${third.stderr}`;
  check('значения не напечатаны', !all.includes(root) && !all.includes(recovery));
  const meta = JSON.parse(readFileSync(join(keys, 'meta.json'), 'utf8'));
  check('описание совпадает с ключом', meta.sealSha256 === sha(seal));
  check('описание подтверждает вход и отзыв', meta.operatorLogin && meta.rootRevoked);
  const bundle = sha(readFileSync(join(keys, 'emergency.gpg')));

  console.log('\n▸ Ещё один повтор');
  const again = bootstrap(fpr);
  check('повтор ничего не делает', again.status === 0 && again.stdout.includes('уже созданы'));
  check('комплект не изменился', sha(readFileSync(join(keys, 'emergency.gpg'))) === bundle);
  check('ключ не изменился', sha(readFileSync(join(dir, 'seal', 'static.key'))) === sha(seal));

  console.log('\n▸ Комплект');
  const good = keysCheck(fpr);
  check('открывается ключом получателя', good.status === 0, good.stderr.slice(-200));
  const alien = keysCheck('1'.repeat(40));
  check('чужой получатель не принимается', alien.status !== 0);
  const forged = join(base, 'forged.json');
  writeFileSync(forged, JSON.stringify({ ...meta, sealSha256: sha(randomBytes(32)) }));
  check('подмена описания обнаруживается', keysCheck(fpr, forged).status !== 0);
  const open = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      `${gpgDir}:/in:ro`,
      '-v',
      `${keys}:/k:ro`,
      '--entrypoint',
      'sh',
      TOOL_IMAGE,
      '-c',
      `export GNUPGHOME=$(mktemp -d); gpg -q --batch --pinentry-mode loopback --passphrase '${PHRASE}' --import /in/secret.asc 2>/dev/null; gpg -q --batch --pinentry-mode loopback --passphrase '${PHRASE}' --decrypt /k/emergency.gpg 2>/dev/null`,
    ],
    { encoding: 'utf8' },
  );
  const password = open.stdout.match(/^OPENBAO_THOMAS_PASSWORD=(.+)$/m)?.[1];
  const login = await api('POST', 'auth/userpass/login/thomas', { body: { password } });
  check(
    'пароль из комплекта открывает личный вход',
    Boolean(login.json.auth?.client_token),
    `код ${login.status}, длина ${password?.length}, gpg ${open.status} ${open.stderr.slice(0, 160)} ${JSON.stringify(login.json.errors ?? [])}`,
  );
  const policies = login.json.auth?.policies ?? [];
  check('личный вход с политикой оператора', policies.includes('operator'), policies.join(','));

  console.log('\n▸ Импорт рабочих ключей');
  const operator = login.json.auth.client_token;
  const kek = Object.fromEntries(KEK_DOMAINS.map((d) => [d.env, randomBytes(32)]));
  const kitRoot = join(base, 'kit');
  mkdirSync(join(kitRoot, '.local', 'secrets'), { recursive: true });
  writeFileSync(join(kitRoot, '.env'), 'KMS_MODE=local\n');
  for (const [name, value] of Object.entries(kek)) {
    writeFileSync(join(kitRoot, '.local', 'secrets', name), `${value.toString('base64')}\n`);
  }
  const kit = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--user',
      '0',
      '-e',
      'FIFTH_TRANSITION_ROOT=/kit',
      '-e',
      'FIFTH_OPENBAO_KEYS_DIR=/keys',
      '-e',
      'FIFTH_OPENBAO_RECIPIENT=/gpg/recipient.asc',
      '-e',
      `FIFTH_OPENBAO_RECIPIENT_FPR=${fpr}`,
      '-v',
      `${kitRoot}:/kit:ro`,
      '-v',
      `${keys}:/keys`,
      '-v',
      `${gpgDir}:/gpg:ro`,
      '-v',
      `${join(ROOT, 'infra', 'host')}:/tool:ro`,
      '--entrypoint',
      'sh',
      TOOL_IMAGE,
      '/tool/fifth-transition-kit',
      'create',
    ],
    { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  check('комплект для импорта снят', kit.status === 0, kit.stderr.slice(-200));
  const importKeys = (prefix) =>
    spawnSync(
      process.execPath,
      [
        join(ROOT, 'scripts', 'openbao-keys-import.mjs'),
        '--kit',
        join(keys, 'transition.gpg'),
        '--bundle',
        join(keys, 'emergency.gpg'),
        '--secret-key',
        join(gpgDir, 'secret.asc'),
        '--passphrase-file',
        join(gpgDir, 'phrase'),
        '--addr',
        `https://127.0.0.1:${PORT}`,
        '--ca',
        join(dir, 'tls', 'tls.crt'),
        '--prefix',
        prefix,
      ],
      { encoding: 'utf8' },
    );
  const latest = async (name) =>
    (await api('GET', `transit/keys/${name}`, { token: operator })).json.data?.latest_version;
  const imported = importKeys('lab');
  const importText = `${imported.stdout}${imported.stderr}`;
  check('ключи импортированы', imported.status === 0, importText.slice(-300));
  check(
    'значения и пароль не напечатаны',
    !importText.includes(password) &&
      Object.values(kek).every((v) => !importText.includes(v.toString('base64'))),
  );
  check('версия импорта — первая', (await latest('lab-passport-sensitive')) === 1);
  const probe = await api('POST', 'transit/hmac/lab-search-index/sha2-256', {
    token: operator,
    body: { input: Buffer.from('контроль').toString('base64'), key_version: 1 },
  });
  check(
    'ключ поиска импортирован как HMAC',
    sameText(
      probe.json.data?.hmac,
      `vault:v1:${createHmac('sha256', kek.KEK_SEARCH_INDEX).update('контроль').digest('base64')}`,
    ),
  );
  const repeat = importKeys('lab');
  check(
    'повтор только сверяет',
    repeat.status === 0 && !repeat.stdout.includes('импортирован'),
    repeat.stderr.slice(-200),
  );
  check('повтор не создал версию', (await latest('lab-search-index')) === 1);
  await api('POST', 'transit/keys/alien-passport-sensitive', {
    token: operator,
    body: { type: 'aes256-gcm96' },
  });
  const foreign = importKeys('alien');
  check(
    'чужой ключ под занятым именем — отказ',
    foreign.status === 1 && foreign.stderr.includes('не совпала'),
    foreign.stderr.slice(-200),
  );
  check(
    'после отказа следующие ключи не тронуты',
    (await latest('alien-kyb-documents')) === undefined,
  );
  let issued = '';
  await withOperatorToken(api, password, async (token) => {
    issued = token;
    throw new Error('сбой внутри операции');
  }).catch(() => undefined);
  const revoked = await api('GET', 'auth/token/lookup-self', { token: issued });
  check(
    'токен отозван и при сбое',
    issued !== '' && revoked.status === 403,
    `код ${revoked.status}`,
  );

  docker('rm', '-f', NAME);
  await start();
  let opened = false;
  for (let i = 0; i < 40 && !opened; i++) {
    opened = (await api('GET', 'sys/seal-status')).json.sealed === false;
    if (!opened) await sleep(500);
  }
  check('после перезапуска открывается сам', opened);
} catch (e) {
  check('проверка дошла до конца', false, e.message);
} finally {
  cleanup();
  rmSync(base, { recursive: true, force: true });
}
console.log(`\nИТОГ: пройдено ${passed}, не пройдено ${failed}`);
process.exit(failed ? 1 : 0);
