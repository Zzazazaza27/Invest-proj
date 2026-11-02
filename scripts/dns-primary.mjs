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
 *   DNS_ZONES_DIR, DNS_DOCKER_NETWORK, DNS_CONTAINER_NAME — только для
 *                        проверок (scripts/check-dns-primary-apply.mjs)
 *
 * Применение безопасное (замечание Тэнка 2026-11-02): новый комплект
 * (конфигурация + зоны) собирается и проверяется в STATE/staging. Рабочие
 * каталоги не трогаются, пока проверка не прошла. Затем прежний комплект
 * копируется в STATE/previous, новый ставится пофайловой заменой (каждый
 * файл — через временный и rename; комплект целиком атомарно не
 * переключается), Knot перезагружается или запускается, и проверяется, что
 * каждая зона загружена с новой версией. Любая ошибка на этих шагах —
 * установка, reload, запуск, не та версия — ведёт к общему возврату:
 * прежний комплект на место, перезагрузка (при её ошибке — перезапуск
 * контейнера) и подтверждение, что загружены прежние версии.
 * Версия зоны = max(время, последняя записанная + 1, отдаваемая вторичными + 1)
 * — рост сохраняется при той же секунде, переводе часов и подъёме с нуля.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/backup.mjs';
import { nextSerial } from './lib/dns-serial.mjs';

loadEnv();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = 'cznic/knot:3.4';
const NAME = process.env.DNS_CONTAINER_NAME || 'fifth-dns-primary';
const NETWORK = process.env.DNS_DOCKER_NETWORK || 'host';
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
  const dir = env.DNS_ZONES_DIR || join(ROOT, 'infra', 'dns', 'zones');
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

const knotc = (...args) =>
  sh('docker', ['exec', NAME, 'knotc', '-s', '/rundir/knot.sock', ...args]);

/** Проверка комплекта в каталоге dir: конфигурация и каждая зона. */
function checkSet(dir, zoneNames) {
  for (const check of [
    ['knotc', '-c', '/config/knot.conf', 'conf-check'],
    ...zoneNames.map((z) => ['kzonecheck', '-o', z, `/zones/${z}.zone`]),
  ]) {
    sh('docker', [
      'run',
      '--rm',
      '-v',
      `${dir}/config:/config:ro`,
      '-v',
      `${dir}/zones:/zones:ro`,
      IMAGE,
      ...check,
    ]);
  }
}

/** Файлы комплекта: config/knot.conf и zones/<зона>.zone. */
const setFiles = (zoneNames) => [
  join('config', 'knot.conf'),
  ...zoneNames.map((z) => join('zones', `${z}.zone`)),
];

/** Поставить файлы из from в рабочие каталоги: копия во временный файл и rename. */
function install(from, files) {
  for (const rel of files) {
    const src = join(from, rel);
    if (!existsSync(src)) continue;
    const dst = join(STATE, rel);
    copyFileSync(src, `${dst}.tmp`);
    renameSync(`${dst}.tmp`, dst);
  }
}

/** Версия из строки SOA файла зоны (null, если не найдена). */
const soaSerial = (text) =>
  text.match(/^\S+\s+(?:\d+\s+)?(?:IN\s+)?SOA\s+\S+\s+\S+\s+(\d+)/m)?.[1] ?? null;

/** Загружены ли зоны с ожидаемыми версиями (ждём до 15 с). */
function loaded(expected) {
  const end = Date.now() + 15_000;
  let last = '';
  while (Date.now() < end) {
    last = sh('docker', ['exec', NAME, 'knotc', '-s', '/rundir/knot.sock', 'zone-status'], true);
    const ok = Object.entries(expected).every(([z, serial]) =>
      new RegExp(`\\[${z.replace(/\./g, '\\.')}\\.\\].*serial: ${serial}\\b`).test(last),
    );
    if (ok) return { ok: true, last };
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
  }
  return { ok: false, last };
}

function startContainer() {
  sh('docker', ['rm', '-f', NAME], true);
  sh('docker', [
    'run',
    '-d',
    '--name',
    NAME,
    '--restart',
    'unless-stopped',
    '--network',
    NETWORK,
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
}

function up() {
  if (!LISTEN) throw new Error('DNS_PRIMARY_LISTEN не задан');
  for (const d of ['config', 'zones', 'storage', 'rundir'])
    mkdirSync(join(STATE, d), { recursive: true });
  const serialFile = join(STATE, 'last-serial.json');
  const last = existsSync(serialFile) ? JSON.parse(readFileSync(serialFile, 'utf8')) : {};
  const all = zones();
  const names = all.map((z) => z.name);

  // 1. Новый комплект — в отдельном каталоге.
  const staging = join(STATE, 'staging');
  rmSync(staging, { recursive: true, force: true });
  for (const d of ['config', 'zones']) mkdirSync(join(staging, d), { recursive: true });
  const next = {};
  for (const z of all) {
    const text = readFileSync(z.src, 'utf8');
    if ((text.match(/{{SERIAL}}/g) || []).length !== 1)
      throw new Error(`${z.name}: заглушка {{SERIAL}} должна встречаться ровно один раз (в SOA)`);
    const nsNames = [...text.matchAll(/^\S*\s+NS\s+(\S+?)\.?\s*$/gm)].map((m) => m[1]);
    const served = servedSerials(z.name, nsNames);
    const prev = last[z.name];
    next[z.name] = nextSerial({ published: [prev, ...served] });
    writeFileSync(
      join(staging, 'zones', `${z.name}.zone`),
      text.replaceAll('{{SERIAL}}', String(next[z.name])),
    );
    console.log(
      `${z.name}: serial ${next[z.name]} (записанная ${prev ?? '—'}, у вторичных ${served.join(',') || '—'})`,
    );
  }
  writeFileSync(join(staging, 'config', 'knot.conf'), knotConf(names));

  // 2. Проверка комплекта. Ошибка — стоп: рабочие файлы не тронуты.
  try {
    checkSet(staging, names);
  } catch (e) {
    console.error(
      `ОТКАЗ: новый комплект не прошёл проверку — рабочая версия не тронута.\n${`${e.stderr || e.message}`.trim()}`,
    );
    process.exit(1);
  }

  // 3. Прежний комплект — в previous (для возврата).
  const files = setFiles(names);
  const previous = join(STATE, 'previous');
  rmSync(previous, { recursive: true, force: true });
  for (const d of ['config', 'zones']) mkdirSync(join(previous, d), { recursive: true });
  const existed = new Set();
  const prevSerials = {};
  for (const rel of files) {
    if (!existsSync(join(STATE, rel))) continue;
    existed.add(rel);
    copyFileSync(join(STATE, rel), join(previous, rel));
  }
  for (const z of names) {
    const rel = join('zones', `${z}.zone`);
    if (existed.has(rel)) prevSerials[z] = soaSerial(readFileSync(join(previous, rel), 'utf8'));
  }
  const isRunning = () => Boolean(sh('docker', ['ps', '-q', '-f', `name=^${NAME}$`], true));

  /** Привести Knot к файлам на диске: reload, при ошибке — перезапуск. */
  const activate = () => {
    if (!isRunning()) return startContainer();
    try {
      knotc('reload');
    } catch {
      sh('docker', ['restart', NAME]);
    }
  };

  /** Общий возврат: прежние файлы на место, активация, подтверждение. */
  const rollback = (reason) => {
    console.error(`ОТКАЗ: ${reason}\nВозврат прежнего комплекта.`);
    for (const rel of files) {
      if (existed.has(rel)) install(previous, [rel]);
      else rmSync(join(STATE, rel), { force: true });
    }
    try {
      activate();
    } catch (e) {
      console.error(
        `ВОЗВРАТ НЕ ЗАВЕРШЁН: не удалось перезагрузить или запустить Knot — ${`${e.stderr || e.message}`.trim()}`,
      );
      process.exit(2);
    }
    const expectPrev = Object.fromEntries(Object.entries(prevSerials).filter(([, v]) => v));
    if (Object.keys(expectPrev).length) {
      const back = loaded(expectPrev);
      if (!back.ok) {
        console.error(`ВОЗВРАТ НЕ ПОДТВЕРЖДЁН: прежние версии не загружены.\n${back.last}`);
        process.exit(2);
      }
      console.error(
        `возврат подтверждён: ${Object.entries(expectPrev)
          .map(([z, v]) => `${z} ${v}`)
          .join(', ')}`,
      );
    }
    process.exit(1);
  };

  // 4. Установка, применение и проверка версий — под общим возвратом.
  const wasRunning = isRunning();
  try {
    install(staging, files);
    if (wasRunning) knotc('reload');
    else startContainer();
  } catch (e) {
    rollback(
      `ошибка установки или применения — ${`${e.stderr || e.message}`.trim().split('\n')[0]}`,
    );
  }
  const res = loaded(next);
  if (!res.ok) rollback(`Knot не загрузил новые версии.\n${res.last}`);
  console.log(wasRunning ? 'конфигурация и зоны перезагружены' : 'контейнер поднят');
  // Версия записывается только после подтверждённой загрузки.
  writeFileSync(serialFile, JSON.stringify({ ...last, ...next }, null, 2));
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
