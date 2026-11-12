#!/usr/bin/env node
/**
 * Отказы OpenBao и его аудита в изолированной среде (работа № 4 раздела 01; 5.6, 4.9).
 *
 * Своя среда `fifth-faults-*` и свой OpenBao `fifth-faults-openbao` (TLS, Static seal, Raft,
 * файловый аудит на маленьком томе — как на VPS, но с искусственными ключами). Ядро из текущего
 * кода в рабочем режиме KMS_MODE=kms: ключей в окружении нет, поиск по почте (HMAC) и
 * шифрование — только через Transit. Сценарии:
 *
 *   1. исходно: регистрация (HMAC через Transit) проходит, наблюдение — open / ok;
 *   2. OpenBao остановлен — регистрация отказывает закрыто (503 dependency_unavailable), обхода
 *      ключами из окружения нет; наблюдение — down; вернулся — работает без перезапуска ядра;
 *   3. запечатан — то же; наблюдение — sealed; Static seal открывает при перезапуске сам;
 *   4. отказ аудита (том журнала заполнен) — sys/health «в порядке», но запросы получают 5xx:
 *      ядро отказывает закрыто, наблюдение — open + requests=refused (тревога Zabbix «OpenBao
 *      открыт, но отказывает в запросах»); место освобождено — работает;
 *   5. TLS: ядро с чужим сертификатом удостоверяющего центра — отказ закрыто, не «без проверки»;
 *   6. в журнале аудита нет почты, пароля и ключа в открытом виде.
 *
 *   node scripts/check-openbao-faults.mjs [--keep]
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as F from './lib/faults-env.mjs';
import { importTransitKey } from './lib/openbao-import.mjs';
import { parseEnvFile } from './lib/backup.mjs';

const IMAGE = process.env.OPENBAO_IMAGE || 'openbao/openbao:2.7.2';
const BAO = 'fifth-faults-openbao';
const BAO_VOLUME = `${BAO}-data`;
const BAO_PORT = 18210;
const PREFIX = 'faults';
const { check, note, state } = F.checker();
const work = mkdtempSync(join(tmpdir(), 'fifth-faults-bao-'));
const cfg = join(work, 'cfg'); // конфигурация и TLS OpenBao
const coreDir = join(work, 'core'); // CA и токен для ядра
const monitorDir = join(work, 'monitor'); // как /etc/fifth-openbao у наблюдения
const stateDir = join(work, 'state');
for (const d of [
  cfg,
  coreDir,
  join(monitorDir, 'tls'),
  join(monitorDir, 'approle', 'prod-backup'),
  stateDir,
]) {
  mkdirSync(d, { recursive: true });
}
const stand = parseEnvFile(join(F.ROOT, '.env'), { secrets: true });
let ca;

function api(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = request(
      {
        host: '127.0.0.1',
        port: BAO_PORT,
        method,
        path: `/v1/${path}`,
        ca,
        servername: 'localhost',
        headers: {
          ...(token ? { 'X-Vault-Token': token } : {}),
          ...(data ? { 'Content-Type': 'application/json' } : {}),
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
            json = { raw: text };
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('таймаут')));
    req.end(data);
  });
}

function cert(dir, name = 'tls') {
  const r = spawnSync(
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
      join(dir, `${name}.key`),
      '-out',
      join(dir, `${name}.crt`),
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  if (r.status !== 0) throw new Error(`сертификат: ${r.stderr.slice(0, 200)}`);
}

function startBao() {
  F.docker('rm', '-f', BAO);
  const r = F.docker(
    'run',
    '-d',
    '--name',
    BAO,
    '--network',
    F.NET,
    '--memory',
    '192m',
    '-p',
    `127.0.0.1:${BAO_PORT}:8200`,
    '-v',
    `${cfg}:/cfg:ro`,
    '-v',
    `${BAO_VOLUME}:/openbao/file`,
    // Журнал аудита — на отдельном маленьком томе: его заполнение и есть отказ аудита.
    '--tmpfs',
    '/openbao/audit:rw,size=2m,uid=100,gid=1000,mode=0750',
    IMAGE,
    'server',
    '-config=/cfg/bao.hcl',
  );
  if (r.status !== 0) throw new Error(`OpenBao: ${r.stderr.slice(0, 200)}`);
}
async function waitBao(want = 200, seconds = 40) {
  for (let i = 0; i < seconds * 2; i++) {
    const h = await api('GET', 'sys/health').catch(() => null);
    if (h && h.status === want) return true;
    await F.sleep(500);
  }
  return false;
}

/** Наблюдение — настоящий scripts/monitor-openbao.mjs против этого OpenBao. */
function monitor() {
  const r = spawnSync(process.execPath, ['scripts/monitor-openbao.mjs'], {
    cwd: F.ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      FIFTH_OPENBAO_DIR: monitorDir,
      FIFTH_OPENBAO_PORT: String(BAO_PORT),
      MONITOR_STATE_DIR: stateDir,
      KMS_MODE: 'local',
    },
  });
  if (r.status !== 0) return { error: r.stderr.slice(0, 200) };
  return JSON.parse(readFileSync(join(stateDir, 'openbao.json'), 'utf8'));
}

/** Регистрация — операция, которой нужен Transit (HMAC почты). */
async function register(label) {
  const client = F.makeClient();
  const email = `bao-${label}-${Date.now() % 1e9}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const r = await client.call('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: `Bao ${label}`,
      role: 'founder',
      locale: 'ru-RU',
      consents: F.CONSENTS,
    },
  });
  return { ...r, email, password, code: r.json?.code ?? r.json?.errors?.[0]?.code ?? '' };
}
// Наружу — безопасный код без подробностей; что отказала именно KMS — по журналу ядра.
const closed = (r) => r.status === 503 && JSON.stringify(r.json).includes('dependency_unavailable');
const kmsInLog = () => {
  const r = F.docker('logs', '--since', '2m', F.CORE);
  return `${r.stdout}${r.stderr}`.includes('"dependency":"kms"');
};

function coreEnv() {
  return {
    KMS_MODE: 'kms',
    OPENBAO_ADDR: `https://${BAO}:8200`,
    OPENBAO_CA_PATH: '/bao/ca.crt',
    OPENBAO_TOKEN_PATH: '/bao/token',
    OPENBAO_KEY_PREFIX: PREFIX,
    OPENBAO_TIMEOUT_MS: '3000',
    // Ключей в окружении нет: запасного пути в обход OpenBao не существует.
    KEK_SEARCH_INDEX: '',
    KEK_KYC_DOCUMENTS: '',
    KEK_KYB_DOCUMENTS: '',
    KEK_PASSPORT_SENSITIVE: '',
    KEK_WEBHOOK_SECRETS: '',
  };
}

const keep = process.argv.includes('--keep');
console.log('\n=== ОТКАЗЫ OPENBAO И АУДИТА (работа № 4) — изолированная среда ===\n');
let root;
try {
  await F.up({ core: false });
  F.docker('volume', 'rm', '-f', BAO_VOLUME);
  F.docker(
    'run',
    '--rm',
    '-v',
    `${BAO_VOLUME}:/d`,
    '--user',
    '0',
    '--entrypoint',
    'chown',
    IMAGE,
    '-R',
    'openbao:openbao',
    '/d',
  );
  writeFileSync(join(cfg, 'seal.key'), randomBytes(32));
  cert(cfg);
  ca = readFileSync(join(cfg, 'tls.crt'));
  writeFileSync(join(coreDir, 'ca.crt'), ca);
  writeFileSync(join(monitorDir, 'tls', 'tls.crt'), ca);
  writeFileSync(
    join(cfg, 'bao.hcl'),
    `ui = false
disable_mlock = true
api_addr = "https://127.0.0.1:8200"
cluster_addr = "https://127.0.0.1:8201"
storage "raft" {
  path = "/openbao/file"
  node_id = "faults-1"
}
listener "tcp" {
  address = "0.0.0.0:8200"
  tls_cert_file = "/cfg/tls.crt"
  tls_key_file = "/cfg/tls.key"
}
audit "file" "main" {
  options {
    file_path = "/openbao/audit/audit.log"
  }
}
seal "static" {
  current_key_id = "faults-1"
  current_key = "file:///cfg/seal.key"
}
`,
  );
  startBao();
  for (let i = 0; i < 40; i++) {
    if (await api('GET', 'sys/seal-status').catch(() => null)) break;
    await F.sleep(500);
  }
  const init = await api('POST', 'sys/init', {
    body: { recovery_shares: 1, recovery_threshold: 1 },
  });
  root = init.json.root_token;
  if (!root) throw new Error(`инициализация: ${init.status}`);
  check('OpenBao поднят (Static seal) и активен', await waitBao(200));
  await api('POST', 'sys/mounts/transit', { token: root, body: { type: 'transit' } });
  await api('POST', 'sys/auth/approle', { token: root, body: { type: 'approle' } });
  const imported = await importTransitKey(
    (m, p, o) => api(m, p, { ...o, token: root }),
    `${PREFIX}-search-index`,
    'hmac',
    Buffer.from(stand.KEK_SEARCH_INDEX, 'base64'),
  );
  if (imported.status >= 300) throw new Error(`импорт ключа поиска: ${imported.status}`);
  for (const k of ['kyc-documents', 'kyb-documents', 'passport-sensitive', 'webhook-secrets']) {
    await api('POST', `transit/keys/${PREFIX}-${k}`, {
      token: root,
      body: { type: 'aes256-gcm96' },
    });
  }
  await api('PUT', 'sys/policies/acl/faults-core', {
    token: root,
    body: {
      policy: `path "transit/encrypt/${PREFIX}-*" { capabilities = ["update"] }
path "transit/decrypt/${PREFIX}-*" { capabilities = ["update"] }
path "transit/hmac/${PREFIX}-*" { capabilities = ["update"] }`,
    },
  });
  const coreToken = await api('POST', 'auth/token/create', {
    token: root,
    body: { policies: ['faults-core'], ttl: '4h', no_default_policy: true },
  });
  writeFileSync(join(coreDir, 'token'), coreToken.json.auth.client_token);
  // Учётка наблюдения — как prod-backup: только вход (и отзыв своего токена).
  await api('POST', 'auth/approle/role/prod-backup', {
    token: root,
    body: { token_ttl: '5m', token_policies: ['default'] },
  });
  const roleId = (await api('GET', 'auth/approle/role/prod-backup/role-id', { token: root })).json
    .data.role_id;
  const secretId = (await api('POST', 'auth/approle/role/prod-backup/secret-id', { token: root }))
    .json.data.secret_id;
  writeFileSync(join(monitorDir, 'approle', 'prod-backup', 'role-id'), roleId);
  writeFileSync(join(monitorDir, 'approle', 'prod-backup', 'secret-id'), secretId);

  await F.startCore({ env: coreEnv(), volumes: [`${coreDir}:/bao:ro`] });

  // ---- 1. исходно
  console.log('\n— 1. исходно');
  const ok = await register('ok');
  check('регистрация через Transit проходит', ok.status < 300, `HTTP ${ok.status} ${ok.code}`);
  const m0 = monitor();
  check(
    'наблюдение: open, запросы обслуживаются',
    m0.state === 'open' && m0.requests === 'ok',
    JSON.stringify(m0),
  );

  // ---- 2. остановлен
  console.log('\n— 2. OpenBao остановлен');
  F.docker('stop', '-t', '5', BAO);
  const down = await register('down');
  check(
    'регистрация отказывает закрыто (503 dependency_unavailable)',
    closed(down),
    `HTTP ${down.status} ${down.code}`,
  );
  check('в журнале ядра причина — KMS (dependency: kms)', kmsInLog());
  const m1 = monitor();
  check('наблюдение: down', m1.state === 'down', JSON.stringify(m1));
  const live = await fetch(`http://127.0.0.1:${F.CORE_INTERNAL_PORT}/live`).then(
    (r) => r.status,
    () => 0,
  );
  note(`ядро живо при остановленном OpenBao: /live ${live}`);
  F.docker('start', BAO);
  check('OpenBao вернулся сам (Static seal)', await waitBao(200));
  const back = await register('back');
  check(
    'регистрация снова проходит, ядро не перезапускалось',
    back.status < 300,
    `HTTP ${back.status} ${back.code}`,
  );

  // ---- 3. запечатан
  console.log('\n— 3. OpenBao запечатан');
  await api('PUT', 'sys/seal', { token: root });
  check('OpenBao запечатан', await waitBao(503, 10));
  const sealed = await register('sealed');
  check(
    'регистрация при запечатанном отказывает закрыто',
    closed(sealed),
    `HTTP ${sealed.status} ${sealed.code}`,
  );
  const m2 = monitor();
  check('наблюдение: sealed', m2.state === 'sealed', JSON.stringify(m2));
  F.docker('restart', '-t', '5', BAO);
  check('перезапуск открыл без человека', await waitBao(200));
  check('после открытия регистрация проходит', (await register('unsealed')).status < 300);

  // ---- 4. отказ аудита
  console.log('\n— 4. отказ аудита: том журнала заполнен');
  F.docker(
    'exec',
    BAO,
    'sh',
    '-c',
    'dd if=/dev/zero of=/openbao/audit/fill bs=64k 2>/dev/null; true',
  );
  const df = F.docker('exec', BAO, 'df', '-k', '/openbao/audit').stdout.trim().split('\n').at(-1);
  note(`том аудита: ${df.replace(/\s+/g, ' ')}`);
  const health = await api('GET', 'sys/health');
  check(
    'sys/health при этом «в порядке» — по нему отказ не виден',
    health.status === 200,
    `HTTP ${health.status}`,
  );
  const audited = await register('audit');
  check(
    'регистрация отказывает закрыто, пока аудит не пишется',
    closed(audited),
    `HTTP ${audited.status} ${audited.code}`,
  );
  const m3 = monitor();
  check(
    'наблюдение: open, но requests=refused (сигнал)',
    m3.state === 'open' && m3.requests === 'refused',
    JSON.stringify(m3),
  );
  F.docker('exec', BAO, 'rm', '-f', '/openbao/audit/fill');
  const after = await register('audit-ok');
  check(
    'место освобождено — регистрация проходит',
    after.status < 300,
    `HTTP ${after.status} ${after.code}`,
  );
  const m4 = monitor();
  check('наблюдение: запросы снова обслуживаются', m4.requests === 'ok', JSON.stringify(m4));

  // ---- 5. TLS
  console.log('\n— 5. TLS: чужой удостоверяющий центр');
  cert(work, 'other');
  writeFileSync(join(coreDir, 'ca.crt'), readFileSync(join(work, 'other.crt')));
  await F.startCore({ env: coreEnv(), volumes: [`${coreDir}:/bao:ro`] });
  const tls = await register('tls');
  check(
    'с чужим CA ядро отказывает закрыто, а не идёт без проверки',
    closed(tls),
    `HTTP ${tls.status} ${tls.code}`,
  );
  writeFileSync(join(coreDir, 'ca.crt'), ca);

  // ---- 6. журнал аудита
  console.log('\n— 6. содержимое журнала аудита');
  const log = F.docker('exec', BAO, 'cat', '/openbao/audit/audit.log').stdout;
  const plainEmail = Buffer.from(`email:${ok.email}`).toString('base64');
  check('журнал аудита не пуст', log.includes('transit/hmac'), `${log.length} байт`);
  check(
    'в журнале нет почты (ни текстом, ни base64 входа HMAC)',
    !log.includes(ok.email) && !log.includes(plainEmail),
  );
  check('в журнале нет пароля', !log.includes(ok.password));
  check('в журнале нет ключа поиска', !log.includes(stand.KEK_SEARCH_INDEX));
} catch (e) {
  check('прогон без исключения', false, String(e?.stack ?? e).slice(0, 600));
} finally {
  await F.closeSql();
  if (!keep) {
    F.docker('rm', '-f', BAO);
    F.docker('volume', 'rm', '-f', BAO_VOLUME);
    F.down();
  }
  rmSync(work, { recursive: true, force: true });
}
const file = F.writeReport('openbao', state);
console.log(`\nИтог: ${state.passed} OK, ${state.failed} FAIL. Протокол: ${file}`);
process.exitCode = state.failed ? 1 : 0;
