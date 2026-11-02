#!/usr/bin/env node
/**
 * Опыт схемы «скрытый первичный + вторичные» на отдельной тестовой зоне
 * (план docs/architecture/dns-independence-plan.md, инцидент 2026-11-02).
 *
 * Всё локально в Docker, рабочую зону 5espace.com не трогает. Knot DNS:
 * первичный хранит зону и отдаёт её по AXFR только по ключу TSIG; вторичный
 * забирает зону и отвечает сам. Сценарии:
 *   1. вторичный отдаёт те же записи и тот же SOA serial, что и первичный;
 *   2. передача зоны без ключа — отказ; с чужого адреса — отказ;
 *   3. изменение записи → NOTIFY → вторичный обновился без ручных действий;
 *   4. первичный остановлен → вторичный продолжает отвечать;
 *   0. следующая версия зоны строго растёт: та же секунда, часы назад,
 *      восстановление по последней опубликованной (scripts/lib/dns-serial.mjs);
 *   5. по истечении SOA EXPIRE без первичного вторичный отвечает явным
 *      SERVFAIL на свою зону, оставаясь доступным (на чужую зону — REFUSED);
 *      в опыте EXPIRE = 60 с, на рабочей зоне — недели;
 *   6. первичный поднят «на другой машине» из тех же файлов с новым адресом
 *      и с часами, отстающими на час; версия берётся из последней
 *      опубликованной → вторичный снова отвечает и получает изменения.
 *
 *   node scripts/check-dns-hidden-primary.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextSerial, SERIAL_MAX } from './lib/dns-serial.mjs';

const IMAGE = 'cznic/knot:3.4';
const NET = 'dnslab';
const SUBNET = '172.30.53.0/24';
const IP = {
  primary: '172.30.53.10',
  primary2: '172.30.53.11',
  secondary: '172.30.53.20',
  stranger: '172.30.53.30',
};
const ZONE = 'lab.test';
const EXPIRE = 60;

const work = mkdtempSync(join(tmpdir(), 'dnslab-'));
let passed = 0;
let failed = 0;

const sh = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    }).trim();
  } catch (e) {
    if (opts.allowFail) return `${e.stdout || ''}${e.stderr || ''}`.trim();
    throw e;
  }
};
const docker = (...args) => sh('docker', args);
const dockerSoft = (...args) => sh('docker', args, { allowFail: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail = '') => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
// Путь Windows для тома docker (Git Bash / Docker Desktop принимают D:\...).
const vol = (p) => p;

/** kdig из отдельного контейнера в сети опыта. */
function dig(server, args, from = IP.stranger) {
  return dockerSoft(
    'run',
    '--rm',
    '--network',
    NET,
    '--ip',
    from,
    IMAGE,
    'kdig',
    `@${server}`,
    '+time=2',
    '+retry=0',
    ...args,
  );
}
const answer = (server, name, type = 'A') =>
  dig(server, [name, type, '+short'])
    .split('\n')
    .filter((l) => l && !l.startsWith(';'))
    .join(',');
const serial = (server) => answer(server, ZONE, 'SOA').split(' ')[2] || '';

function zoneFile(serialValue, extra = '') {
  return `$ORIGIN ${ZONE}.
$TTL 60
@   SOA ns1.${ZONE}. hostmaster.${ZONE}. ${serialValue} 30 10 ${EXPIRE} 60
@   NS  ns1.${ZONE}.
ns1 A   192.0.2.53
@   A   192.0.2.10
www A   192.0.2.11
${extra}`;
}

function setupDirs(name) {
  const base = join(work, name);
  for (const d of ['config', 'zones', 'storage', 'rundir'])
    mkdirSync(join(base, d), { recursive: true });
  chmodSync(join(base, 'storage'), 0o777);
  chmodSync(join(base, 'rundir'), 0o777);
  return base;
}

const keyYaml = (secret) => `key:
  - id: xfr
    algorithm: hmac-sha256
    secret: ${secret}
`;

function primaryConf(secret) {
  return `server:
  listen: 0.0.0.0@53
  rundir: /rundir
log:
  - target: stdout
    any: info
database:
  storage: /storage
${keyYaml(secret)}
remote:
  - id: secondary
    address: ${IP.secondary}@53
    key: xfr
acl:
  - id: secondary_xfr
    address: ${IP.secondary}
    key: xfr
    action: transfer
template:
  - id: default
    storage: /zones
zone:
  - domain: ${ZONE}
    file: ${ZONE}.zone
    notify: secondary
    acl: secondary_xfr
`;
}

function secondaryConf(secret, primaryIp) {
  return `server:
  listen: 0.0.0.0@53
  rundir: /rundir
log:
  - target: stdout
    any: info
database:
  storage: /storage
${keyYaml(secret)}
remote:
  - id: primary
    address: ${primaryIp}@53
    key: xfr
acl:
  - id: primary_notify
    address: ${primaryIp}
    key: xfr
    action: notify
template:
  - id: default
    storage: /storage
zone:
  - domain: ${ZONE}
    master: primary
    acl: primary_notify
`;
}

function startKnot(name, base, ip) {
  dockerSoft('rm', '-f', `dnslab-${name}`);
  docker(
    'run',
    '-d',
    '--name',
    `dnslab-${name}`,
    '--network',
    NET,
    '--ip',
    ip,
    '-v',
    `${vol(join(base, 'config'))}:/config:ro`,
    '-v',
    `${vol(join(base, 'zones'))}:/zones`,
    '-v',
    `${vol(join(base, 'storage'))}:/storage`,
    '-v',
    `${vol(join(base, 'rundir'))}:/rundir`,
    IMAGE,
    'knotd',
    '-c',
    '/config/knot.conf',
  );
}

async function waitFor(fn, timeoutMs, stepMs = 1000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(stepMs);
  }
  return false;
}

function cleanup() {
  for (const n of ['primary', 'primary2', 'secondary']) dockerSoft('rm', '-f', `dnslab-${n}`);
  dockerSoft('network', 'rm', NET);
  rmSync(work, { recursive: true, force: true });
}

// 0. Рост версии зоны — без Docker.
{
  const t = Date.parse('2026-11-02T10:00:00Z');
  const a = nextSerial({ nowMs: t, published: [] });
  check(
    '0. та же секунда — следующая версия больше',
    nextSerial({ nowMs: t, published: [a] }) === a + 1,
  );
  check(
    '0. часы назад на час — версия всё равно больше опубликованной',
    nextSerial({ nowMs: t - 3_600_000, published: [a] }) === a + 1,
  );
  check(
    '0. восстановление: учитывается наибольшая из записанной и отданных вторичными',
    nextSerial({ nowMs: t, published: [a, String(a + 500), '', null, 'abc', -1] }) === a + 501,
  );
  let threw = false;
  try {
    nextSerial({ nowMs: t, published: [SERIAL_MAX] });
  } catch {
    threw = true;
  }
  check('0. выход за 32 бита — отказ, а не перенос', threw);
}

try {
  cleanup();
  mkdirSync(work, { recursive: true });
  docker('network', 'create', '--subnet', SUBNET, NET);
  const secret = docker('run', '--rm', IMAGE, 'keymgr', '-t', 'xfr', 'hmac-sha256')
    .split('\n')
    .find((l) => l.includes('secret:'))
    .split('secret:')[1]
    .trim();

  // Первичный: serial = unixtime, как будет у выкладки из репозитория.
  const p = setupDirs('primary');
  // lastPublished — запись о последней выкладке (в работе — в репозитории).
  const s1 = nextSerial();
  let lastPublished = s1;
  writeFileSync(join(p, 'config', 'knot.conf'), primaryConf(secret));
  writeFileSync(join(p, 'zones', `${ZONE}.zone`), zoneFile(s1));
  chmodSync(join(p, 'zones'), 0o777);
  startKnot('primary', p, IP.primary);

  const sDir = setupDirs('secondary');
  writeFileSync(join(sDir, 'config', 'knot.conf'), secondaryConf(secret, IP.primary));
  await waitFor(() => answer(IP.primary, `www.${ZONE}`) === '192.0.2.11', 20_000);
  startKnot('secondary', sDir, IP.secondary);

  // 1
  const synced = await waitFor(() => serial(IP.secondary) === String(s1), 30_000);
  check(
    '1. вторичный забрал зону: тот же serial',
    synced,
    `первичный ${serial(IP.primary)}, вторичный ${serial(IP.secondary)}`,
  );
  check(
    '1. вторичный отвечает теми же записями',
    answer(IP.secondary, `www.${ZONE}`) === '192.0.2.11',
  );

  // 2. Отказ засчитывается только по явному ответу сервера (REFUSED/NOTAUTH),
  // а не по отсутствию записей: иначе сетевой сбой выглядел бы как защита.
  const fromSecondary = (...args) =>
    dockerSoft(
      'exec',
      'dnslab-secondary',
      'kdig',
      `@${IP.primary}`,
      '+time=2',
      '+retry=0',
      ...args,
    );
  const denied = (out) => /REFUSED|NOTAUTH|BADKEY|BADSIG/.test(out) && !/192\.0\.2\.11/.test(out);
  const why = (out) =>
    (out.match(/(REFUSED|NOTAUTH|BADKEY|BADSIG|failed)[^\n]*/) || ['нет явного отказа'])[0];
  const noKey = fromSecondary(ZONE, 'AXFR');
  check('2. передача без ключа (с адреса вторичного) — отказ', denied(noKey), why(noKey));
  const stranger = dig(IP.primary, [ZONE, 'AXFR', '-y', `hmac-sha256:xfr:${secret}`], IP.stranger);
  check('2. передача с чужого адреса, даже с ключом — отказ', denied(stranger), why(stranger));
  const allowed = fromSecondary(ZONE, 'AXFR', '-y', `hmac-sha256:xfr:${secret}`);
  check('2. контроль: с адреса вторичного и с ключом — передаётся', /192\.0\.2\.11/.test(allowed));

  // 3
  const s2 = nextSerial({ published: [lastPublished] });
  lastPublished = s2;
  writeFileSync(join(p, 'zones', `${ZONE}.zone`), zoneFile(s2, 'files A 192.0.2.12\n'));
  docker('exec', 'dnslab-primary', 'knotc', '-s', '/rundir/knot.sock', 'zone-reload', ZONE);
  const t3 = Date.now();
  const notified = await waitFor(
    () => answer(IP.secondary, `files.${ZONE}`) === '192.0.2.12',
    20_000,
    500,
  );
  check(
    '3. изменение дошло до вторичного по NOTIFY',
    notified,
    `за ${Math.round((Date.now() - t3) / 1000)} с (refresh 30 с)`,
  );

  // 4
  docker('stop', 'dnslab-primary');
  await sleep(3000);
  check(
    '4. первичный остановлен — вторичный отвечает',
    answer(IP.secondary, `files.${ZONE}`) === '192.0.2.12',
  );

  // 5
  console.log(`      … жду истечения SOA EXPIRE (${EXPIRE} с)`);
  // Засчитывается только явный SERVFAIL на свою зону при доступном сервере:
  // тишина или таймаут — не истечение, а сетевой сбой.
  const statusOf = (name) =>
    dig(IP.secondary, [name, 'SOA']).match(/status: (\w+)/)?.[1] || 'нет ответа';
  const expired = await waitFor(() => statusOf(ZONE) === 'SERVFAIL', (EXPIRE + 60) * 1000, 5000);
  const own = statusOf(ZONE);
  const foreign = statusOf('not-served.example');
  check(
    '5. после EXPIRE вторичный отвечает на свою зону явным SERVFAIL',
    expired && own === 'SERVFAIL',
    `своя зона: ${own}`,
  );
  check(
    '5. при этом вторичный доступен: на чужую зону — REFUSED',
    foreign === 'REFUSED',
    `чужая зона: ${foreign}`,
  );

  // 6 — «другая машина»: те же файлы, новый адрес, новый serial (unixtime)
  const p2 = setupDirs('primary2');
  // Часы новой машины отстают на час; версии вторичных после EXPIRE не
  // читаются — остаётся запись о последней выкладке.
  const fromSecondaries = [serial(IP.secondary)];
  const s3 = nextSerial({
    nowMs: Date.now() - 3_600_000,
    published: [lastPublished, ...fromSecondaries],
  });
  writeFileSync(join(p2, 'config', 'knot.conf'), primaryConf(secret));
  writeFileSync(
    join(p2, 'zones', `${ZONE}.zone`),
    zoneFile(s3, 'files A 192.0.2.12\napi A 192.0.2.13\n'),
  );
  chmodSync(join(p2, 'zones'), 0o777);
  startKnot('primary2', p2, IP.primary2);
  // У провайдера меняется адрес первичного — здесь это конфигурация вторичного.
  writeFileSync(join(sDir, 'config', 'knot.conf'), secondaryConf(secret, IP.primary2));
  docker('restart', 'dnslab-secondary');
  const back = await waitFor(() => answer(IP.secondary, `api.${ZONE}`) === '192.0.2.13', 40_000);
  check(
    '6. первичный на другой машине — вторичный снова отвечает и получил изменения',
    back,
    `serial ${serial(IP.secondary)}, прежний ${s2}, часы −1 ч`,
  );
} catch (e) {
  failed++;
  console.log(`FAIL  опыт прерван: ${e.message.split('\n')[0]}`);
} finally {
  cleanup();
}

console.log(`\n${passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
