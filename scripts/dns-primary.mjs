#!/usr/bin/env node
/**
 * Скрытый первичный DNS (Knot) на VPS — схема из
 * docs/architecture/dns-independence-plan.md.
 *
 * Зоны лежат в репозитории (infra/dns/zones/*.zone, serial — {{SERIAL}}).
 * Команда раскладывает конфигурацию и зоны в DNS_STATE_DIR, проставляет
 * строго растущую версию зоны и поднимает или перезагружает контейнер.
 *
 *   node scripts/dns-primary.mjs up       выложить и поднять / перезагрузить
 *   node scripts/dns-primary.mjs status   состояние зон в Knot
 *   node scripts/dns-primary.mjs down     остановить и удалить контейнер
 *
 * Контейнер — в сети хоста: Knot должен видеть настоящие адреса вторичных,
 * иначе правило «передавать зону только им» не работает.
 *
 * Переменные (.env):
 *   DNS_PRIMARY_LISTEN   адрес прослушивания (VPS: внешний IPv4)
 *   DNS_TRANSFER_ALLOW   адреса вторичных через запятую; пусто — передача
 *                        запрещена всем, попытки видны в журнале
 *   DNS_NOTIFY           адреса для NOTIFY через запятую (необязательно)
 *   DNS_STATE_DIR        каталог состояния (по умолчанию /var/lib/fifth-dns)
 * Версия зоны = max(время, последняя записанная + 1, отдаваемая вторичными + 1)
 * — рост сохраняется при той же секунде, переводе часов и подъёме с нуля.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/backup.mjs';
import { nextSerial } from './lib/dns-serial.mjs';

loadEnv();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = 'cznic/knot:3.4';
const NAME = 'fifth-dns-primary';
const env = process.env;
const STATE = env.DNS_STATE_DIR || '/var/lib/fifth-dns';
const LISTEN = env.DNS_PRIMARY_LISTEN || '';
const list = (v) =>
  (v || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const ALLOW = list(env.DNS_TRANSFER_ALLOW);
const NOTIFY = list(env.DNS_NOTIFY);

const sh = (cmd, args, soft = false) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    if (soft) return `${e.stdout || ''}${e.stderr || ''}`.trim();
    throw e;
  }
};

function zones() {
  const dir = join(ROOT, 'infra', 'dns', 'zones');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.zone'))
    .map((f) => ({ name: f.replace(/\.zone$/, ''), src: join(dir, f) }));
}

/** Версии зоны, которые сейчас отдают её NS (вторичные), — для восстановления. */
function servedSerials(zone, nsNames) {
  const out = [];
  for (const ns of nsNames) {
    const r = sh(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'host',
        IMAGE,
        'kdig',
        `@${ns}`,
        '+time=3',
        '+retry=0',
        '+short',
        zone,
        'SOA',
      ],
      true,
    );
    const serial = r
      .split('\n')
      .find((l) => /^\S+ \S+ \d+ /.test(l))
      ?.split(' ')[2];
    if (serial) out.push(serial);
  }
  return out;
}

function knotConf(zoneNames) {
  const remotes = NOTIFY.length
    ? `remote:\n  - id: secondaries\n    address: [${NOTIFY.map((a) => `${a}@53`).join(', ')}]\n`
    : '';
  const acl = ALLOW.length
    ? `acl:\n  - id: transfer_to_secondaries\n    address: [${ALLOW.join(', ')}]\n    action: transfer\n`
    : '';
  const zonesYaml = zoneNames
    .map(
      (z) =>
        `  - domain: ${z}\n    file: ${z}.zone\n` +
        (ALLOW.length ? '    acl: transfer_to_secondaries\n' : '') +
        (NOTIFY.length ? '    notify: secondaries\n' : ''),
    )
    .join('');
  return `# Создано scripts/dns-primary.mjs — не править руками.
server:
  listen: ${LISTEN}@53
  rundir: /rundir
  identity: ""
  version: ""
log:
  - target: stdout
    any: info
database:
  storage: /storage
${remotes}${acl}mod-rrl:
  - id: default
    rate-limit: 50
    slip: 2
template:
  - id: default
    storage: /zones
    global-module: mod-rrl/default
    zonefile-sync: -1
    zonefile-load: whole
    journal-content: none
zone:
${zonesYaml}`;
}

function up() {
  if (!LISTEN) throw new Error('DNS_PRIMARY_LISTEN не задан');
  for (const d of ['config', 'zones', 'storage', 'rundir'])
    mkdirSync(join(STATE, d), { recursive: true });
  const serialFile = join(STATE, 'last-serial.json');
  const last = existsSync(serialFile) ? JSON.parse(readFileSync(serialFile, 'utf8')) : {};
  const all = zones();
  for (const z of all) {
    const text = readFileSync(z.src, 'utf8');
    const nsNames = [...text.matchAll(/^\S*\s+NS\s+(\S+?)\.?\s*$/gm)].map((m) => m[1]);
    const served = servedSerials(z.name, nsNames);
    const prev = last[z.name];
    const serial = nextSerial({ published: [prev, ...served] });
    writeFileSync(
      join(STATE, 'zones', `${z.name}.zone`),
      text.replace('{{SERIAL}}', String(serial)),
    );
    last[z.name] = serial;
    console.log(
      `${z.name}: serial ${serial} (записанная ${prev ?? '—'}, у вторичных ${served.join(',') || '—'})`,
    );
  }
  writeFileSync(join(STATE, 'config', 'knot.conf'), knotConf(all.map((z) => z.name)));
  // Проверка конфигурации и зон до применения: ошибка — стоп, рабочий
  // контейнер остаётся на прежней версии.
  for (const check of [
    ['knotc', '-c', '/config/knot.conf', 'conf-check'],
    ...all.map((z) => ['kzonecheck', '-o', z.name, `/zones/${z.name}.zone`]),
  ]) {
    sh('docker', [
      'run',
      '--rm',
      '-v',
      `${STATE}/config:/config:ro`,
      '-v',
      `${STATE}/zones:/zones:ro`,
      IMAGE,
      ...check,
    ]);
  }

  const running = sh('docker', ['ps', '-q', '-f', `name=^${NAME}$`], true);
  if (running) {
    sh('docker', ['exec', NAME, 'knotc', '-s', '/rundir/knot.sock', 'reload']);
    console.log('конфигурация и зоны перезагружены');
  } else {
    sh('docker', ['rm', '-f', NAME], true);
    sh('docker', [
      'run',
      '-d',
      '--name',
      NAME,
      '--restart',
      'unless-stopped',
      '--network',
      'host',
      '--memory',
      '128m',
      '--cpus',
      '0.25',
      '-v',
      `${STATE}/config:/config:ro`,
      '-v',
      `${STATE}/zones:/zones`,
      '-v',
      `${STATE}/storage:/storage`,
      '-v',
      `${STATE}/rundir:/rundir`,
      IMAGE,
      'knotd',
      '-c',
      '/config/knot.conf',
    ]);
    console.log('контейнер поднят');
  }
  // Версия записывается после успешной выкладки.
  writeFileSync(serialFile, JSON.stringify(last, null, 2));
}

const cmd = process.argv[2];
if (cmd === 'up') up();
else if (cmd === 'status')
  console.log(
    sh('docker', ['exec', NAME, 'knotc', '-s', '/rundir/knot.sock', 'zone-status'], true),
  );
else if (cmd === 'down') console.log(sh('docker', ['rm', '-f', NAME], true));
else {
  console.log('node scripts/dns-primary.mjs up | status | down');
  process.exit(2);
}
