#!/usr/bin/env node
/**
 * Безопасное применение зон скрытого первичного DNS (scripts/dns-primary.mjs;
 * замечание Тэнка 2026-11-02). Всё в Docker на машине разработчика, отдельный
 * контейнер и каталог — рабочий первичный на VPS не затрагивается.
 *
 *   1. правильная зона v1 применяется, первичный отдаёт v1;
 *   2. неверная зона — применение отклонено (код ≠ 0), рабочий файл зоны и
 *      записанная версия не изменились, первичный отдаёт v1;
 *   3. после перезапуска первичного — по-прежнему v1 (на диске не испорченный
 *      файл);
 *   4. следующая правильная зона v2 применяется, версия выросла;
 *   5. ошибка самой команды reload (управляющий сокет Knot удалён) при
 *      правильной зоне v3 — общий возврат: на диске снова v2, записанная
 *      версия прежняя, первичный отдаёт v2 (возврат подтверждён), и после
 *      перезапуска — тоже v2.
 *
 *   node scripts/check-dns-primary-apply.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'dnsapply-check';
const ZONE = 'apply.test';
const work = mkdtempSync(join(tmpdir(), 'dnsapply-'));
const state = join(work, 'state');
const zonesDir = join(work, 'zones');
mkdirSync(zonesDir, { recursive: true });

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const soft = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return `${e.stdout || ''}${e.stderr || ''}`.trim();
  }
};

const zone = (probe, extra = '') => `$ORIGIN ${ZONE}.
$TTL 60
@     SOA  ns.invalid. hostmaster.invalid. {{SERIAL}} 300 60 3600 60
@     NS   ns.invalid.
probe TXT  "${probe}"
${extra}`;

function apply() {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'dns-primary.mjs'), 'up'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DNS_STATE_DIR: state,
      DNS_ZONES_DIR: zonesDir,
      DNS_PRIMARY_LISTEN: '0.0.0.0',
      DNS_TRANSFER_ALLOW: '',
      DNS_NOTIFY: '',
      DNS_DOCKER_NETWORK: 'bridge',
      DNS_CONTAINER_NAME: NAME,
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const probe = () =>
  soft('docker', ['exec', NAME, 'kdig', '@127.0.0.1', '+time=2', '+short', `probe.${ZONE}`, 'TXT']);
const serial = () =>
  soft('docker', ['exec', NAME, 'kdig', '@127.0.0.1', '+time=2', '+short', ZONE, 'SOA']).split(
    ' ',
  )[2];
const liveHash = () =>
  createHash('sha256')
    .update(readFileSync(join(state, 'zones', `${ZONE}.zone`)))
    .digest('hex');
const lastSerial = () => JSON.parse(readFileSync(join(state, 'last-serial.json'), 'utf8'))[ZONE];
const wait = async (fn, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
};

try {
  soft('docker', ['rm', '-f', NAME]);

  // 1
  writeFileSync(join(zonesDir, `${ZONE}.zone`), zone('v1'));
  const a1 = apply();
  check('1. правильная зона v1 применена', a1.code === 0, a1.code === 0 ? '' : a1.out.slice(-300));
  check('1. первичный отдаёт v1', await wait(() => probe() === '"v1"'), probe());
  const s1 = serial();
  const h1 = liveHash();
  const l1 = lastSerial();

  // 2
  writeFileSync(join(zonesDir, `${ZONE}.zone`), zone('v-broken', 'bad   A    999.1.1.1\n'));
  const a2 = apply();
  check(
    '2. неверная зона — применение отклонено',
    a2.code !== 0,
    (a2.out.match(/ОТКАЗ[^\n]*/) || [''])[0],
  );
  check('2. рабочий файл зоны не изменился', liveHash() === h1);
  check('2. записанная версия не изменилась', lastSerial() === l1);
  check('2. первичный по-прежнему отдаёт v1', probe() === '"v1"', probe());

  // 3
  soft('docker', ['restart', NAME]);
  check('3. после перезапуска — по-прежнему v1', await wait(() => probe() === '"v1"'), probe());

  // 4
  writeFileSync(join(zonesDir, `${ZONE}.zone`), zone('v2'));
  const a4 = apply();
  check(
    '4. следующая правильная зона v2 применена',
    a4.code === 0,
    a4.code === 0 ? '' : a4.out.slice(-300),
  );
  check('4. первичный отдаёт v2', await wait(() => probe() === '"v2"'), probe());
  check('4. версия выросла', Number(serial()) > Number(s1), `${s1} → ${serial()}`);

  // 5
  const h2 = liveHash();
  const l2 = lastSerial();
  soft('docker', ['exec', NAME, 'rm', '-f', '/rundir/knot.sock']);
  writeFileSync(join(zonesDir, `${ZONE}.zone`), zone('v3'));
  const a5 = apply();
  check(
    '5. ошибка reload — применение отклонено',
    a5.code === 1,
    (a5.out.match(/ОТКАЗ[^\n]*/) || [`код ${a5.code}`])[0],
  );
  check('5. возврат подтверждён скриптом', /возврат подтверждён/.test(a5.out));
  check('5. на диске снова прежний файл зоны (v2)', liveHash() === h2);
  check('5. записанная версия не изменилась', lastSerial() === l2);
  check('5. первичный отдаёт v2', await wait(() => probe() === '"v2"'), probe());
  soft('docker', ['restart', NAME]);
  check('5. после перезапуска — по-прежнему v2', await wait(() => probe() === '"v2"'), probe());
} catch (e) {
  failed++;
  console.log(`FAIL  проверка прервана: ${e.message.split('\n')[0]}`);
} finally {
  soft('docker', ['rm', '-f', NAME]);
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
