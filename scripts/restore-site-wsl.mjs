#!/usr/bin/env node
/**
 * Испытательная площадка полного восстановления — отдельный дистрибутив WSL со своим
 * systemd и своим Docker (работа № 5 раздела 01). Запускается на ноутбуке Томаса (Windows).
 * Создание площадки и работа с настоящей копией prod — этап общей приёмки, по слову Томаса.
 *
 *   node scripts/restore-site-wsl.mjs create --rootfs <файл .tar> --sha256 <hex> --source <адрес>
 *   node scripts/restore-site-wsl.mjs prepare      пакеты, сетевое пространство без выхода наружу
 *   node scripts/restore-site-wsl.mjs check        назначения и изоляция (до восстановления)
 *   node scripts/restore-site-wsl.mjs run --set <скачанный комплект> --secret-key <файл>
 *        --passphrase-file <файл> --openbao-keys <аварийный комплект>
 *        [--audit <выгрузка аудита> --coverage-ack <покрыто до>]
 *   node scripts/restore-site-wsl.mjs destroy      удалить дистрибутив целиком
 *
 * Внешние источники площадки — образ ОС (адрес и SHA-256 даёт Томас, файл скачивается
 * отдельно, с его согласия) и репозитории пакетов Ubuntu на шаге prepare; оба попадают в
 * протокол. После prepare у Docker и Caddy площадки нет выхода наружу: они в сетевом
 * пространстве `fifth` с одной петлёй. Ключи Томаса передаются в память дистрибутива
 * (/dev/shm) и удаляются после прогона. Протокол — out/restore-full/<время>/.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISTRO = 'fifth-restore';
const HOME = join(ROOT, '.local', 'wsl', DISTRO);
const SITE = '/var/lib/fifth-restore';
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);

/** wsl.exe печатает свои сообщения в UTF-16. */
function wsl(args, { input, allowFail = false } = {}) {
  const r = spawnSync('wsl.exe', args, { input, maxBuffer: 256 * 1024 * 1024 });
  const decode = (b) => {
    const buf = Buffer.from(b ?? '');
    return buf.length > 1 && buf[1] === 0 ? buf.toString('utf16le') : buf.toString('utf8');
  };
  const out = decode(r.stdout);
  const err = decode(r.stderr).trim();
  if (r.status !== 0 && !allowFail)
    throw new Error(`wsl ${args.slice(0, 4).join(' ')}: ${err || out.trim()}`);
  return { ok: r.status === 0, out, err };
}
const inSite = (script, o) => wsl(['-d', DISTRO, '-u', 'root', '--', 'bash', '-c', script], o);
const distros = () =>
  wsl(['-l', '-q'])
    .out.split(/\r?\n/)
    .map((s) => s.replace(/\0/g, '').trim())
    .filter(Boolean);
const siteFile = (name) => join(HOME, name);

/** Каталог Windows → каталог площадки: поток tar через stdin wsl (диски Windows там не видны). */
function push(from, to) {
  return new Promise((done, fail) => {
    const tar = spawn('tar.exe', ['-cf', '-', '-C', from, '.'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const w = spawn(
      'wsl.exe',
      ['-d', DISTRO, '-u', 'root', '--', 'sh', '-c', `mkdir -p '${to}' && tar -xf - -C '${to}'`],
      {
        stdio: ['pipe', 'inherit', 'inherit'],
      },
    );
    tar.stdout.pipe(w.stdin);
    let n = 0;
    const end = (code) => {
      if (code !== 0) fail(new Error(`передача ${from} оборвалась (код ${code})`));
      else if (++n === 2) done();
    };
    tar.on('close', end);
    w.on('close', end);
  });
}

function sha256File(file) {
  return new Promise((done, fail) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => done(h.digest('hex')))
      .on('error', fail);
  });
}

async function create() {
  if (distros().includes(DISTRO))
    throw new Error(`дистрибутив ${DISTRO} уже есть — сначала destroy`);
  const rootfs = resolve(opt('--rootfs', ''));
  const want = opt('--sha256');
  const source = opt('--source');
  if (!existsSync(rootfs) || !want || !source)
    throw new Error('нужны --rootfs <файл>, --sha256 и --source <адрес>');
  const got = await sha256File(rootfs);
  if (got !== want.toLowerCase()) throw new Error(`SHA-256 образа ОС не совпал: ${got}`);
  mkdirSync(HOME, { recursive: true });
  wsl(['--import', DISTRO, HOME, rootfs, '--version', '2']);
  pushScript();
  inSite(`bash ${SITE}/site.sh wslconf`);
  wsl(['--terminate', DISTRO]);
  writeFileSync(
    siteFile('sources.json'),
    JSON.stringify([{ what: 'образ ОС', url: source, sha256: got, file: rootfs }], null, 2),
  );
  console.log(`дистрибутив ${DISTRO} создан из ${source}; дальше — prepare`);
}

/** Скрипт площадки — внутрь дистрибутива (без дисков Windows). */
function pushScript() {
  const text = readFileSync(join(ROOT, 'infra', 'restore', 'site.sh'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
  inSite(`mkdir -p ${SITE} && cat > ${SITE}/site.sh && chmod 700 ${SITE}/site.sh`, { input: text });
}

function prepare() {
  pushScript();
  const r = inSite(`bash ${SITE}/site.sh prepare`);
  process.stdout.write(r.out);
  const info = JSON.parse(inSite(`bash ${SITE}/site.sh info`).out);
  const sources = JSON.parse(readFileSync(siteFile('sources.json'), 'utf8'));
  for (const s of info.aptSources) sources.push({ what: 'пакеты Ubuntu (prepare)', url: s });
  writeFileSync(siteFile('sources.json'), JSON.stringify(sources, null, 2));
  writeFileSync(siteFile('site-info.json'), JSON.stringify({ ...info, sources }, null, 2));
  console.log(`площадка подготовлена: ${info.os}, пакеты ${Object.keys(info.packages).length}`);
}

/** Назначения и изоляция: каждое условие — отказ, если не выполнено. */
function check() {
  pushScript();
  const s = JSON.parse(inSite(`bash ${SITE}/site.sh check`).out);
  const laptop = spawnSync('docker', ['info', '--format', '{{.ID}}'], {
    encoding: 'utf8',
  }).stdout?.trim();
  const rules = [
    ['systemd — PID 1', s.pid1 === 'systemd'],
    ['диски Windows не подключены', s.windowsDrives === 'no'],
    ['запуск программ Windows выключен', s.interop === 'absent' || /disabled/.test(s.interop)],
    [
      'свой Docker: идентификатор отличается от Docker ноутбука',
      Boolean(s.docker.id) && s.docker.id !== laptop,
    ],
    [
      'свой Docker: сокет внутри дистрибутива, DOCKER_HOST не задан',
      s.socket === '/run/docker.sock' && !s.dockerHost,
    ],
    ['Docker площадки работает в пространстве fifth', s.dockerdNetns === s.fifthNetns],
    ['в пространстве fifth нет маршрута наружу', !s.nsDefaultRoute],
    ['в пространстве fifth только петля', s.nsLinks.trim() === 'lo'],
    ['наружу из пространства fifth не выйти', s.outside === 'closed'],
    ['Docker площадки пуст', s.docker.containers === 0],
  ];
  let bad = 0;
  for (const [name, ok] of rules) {
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}`);
    if (!ok) bad += 1;
  }
  writeFileSync(
    siteFile('check.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        laptopDocker: laptop,
        site: s,
        rules: rules.map(([n, ok]) => ({ name: n, ok })),
      },
      null,
      2,
    ),
  );
  if (bad) throw new Error(`изоляция не подтверждена (${bad}) — восстановление не начинать`);
  console.log('назначения и изоляция подтверждены');
}

async function run() {
  check();
  const set = resolve(opt('--set', ''));
  const key = resolve(opt('--secret-key', ''));
  const pass = resolve(opt('--passphrase-file', ''));
  const kit = resolve(opt('--openbao-keys', ''));
  for (const f of [set, key, pass, kit]) if (!existsSync(f)) throw new Error(`нет ${f}`);
  const commit = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).stdout.trim();
  console.log('▸ передача комплекта и инструмента на площадку');
  await push(set, `${SITE}/set`);
  await push(join(ROOT, 'scripts'), `${SITE}/tools/scripts`);
  const keys = '/dev/shm/fifth-restore-keys';
  inSite(`mkdir -m 700 -p ${keys} && cat > ${keys}/secret.asc`, { input: readFileSync(key) });
  inSite(`cat > ${keys}/pass.txt`, { input: readFileSync(pass) });
  inSite(`cat > ${keys}/emergency.gpg`, { input: readFileSync(kit) });
  inSite(`cat > ${SITE}/site-info.json`, { input: readFileSync(siteFile('site-info.json')) });
  let auditArgs = '';
  if (opt('--audit')) {
    await push(resolve(opt('--audit')), `${SITE}/audit`);
    auditArgs = `--audit ${SITE}/audit --coverage-ack '${opt('--coverage-ack', '').replace(/'/g, '')}'`;
  }
  // node — из образа ядра комплекта.
  const setId = readdirSync(join(set, 'sets'))
    .filter((d) => existsSync(join(set, 'sets', d, 'READY')))
    .sort()
    .pop();
  const catalog = JSON.parse(readFileSync(join(set, 'sets', setId, 'catalog.json'), 'utf8'));
  const core = catalog.host?.images?.find((i) => i.tags.some((t) => t.startsWith('fifth/core')));
  if (!core) throw new Error('в комплекте нет образа ядра');
  inSite(`bash ${SITE}/site.sh node ${SITE}/set/${core.file}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const report = `${SITE}/report/${stamp}`;
  try {
    const r = spawnSync(
      'wsl.exe',
      [
        '-d',
        DISTRO,
        '-u',
        'root',
        '--',
        'bash',
        '-c',
        `cd ${SITE}/tools && RESTORE_TOOL_COMMIT=${commit} RESTORE_NETNS=fifth ip netns exec fifth node scripts/restore-full.mjs ` +
          `--set ${SITE}/set --secret-key ${keys}/secret.asc --passphrase-file ${keys}/pass.txt ` +
          `--openbao-keys ${keys}/emergency.gpg ${auditArgs} --site-info ${SITE}/site-info.json --out ${report}`,
      ],
      { stdio: 'inherit' },
    );
    console.log(`восстановление завершилось с кодом ${r.status}`);
  } finally {
    inSite(`rm -rf ${keys}`, { allowFail: true });
    const local = join(ROOT, 'out', 'restore-full', stamp);
    mkdirSync(local, { recursive: true });
    for (const f of ['protocol.json', 'protocol.md', 'deletions-apply.json']) {
      const r = inSite(`cat ${report}/${f}`, { allowFail: true });
      if (r.ok) writeFileSync(join(local, f), r.out);
    }
    for (const f of ['check.json', 'site-info.json']) {
      if (existsSync(siteFile(f)))
        writeFileSync(join(local, `site-${f}`), readFileSync(siteFile(f)));
    }
    console.log(`протокол: ${join(local, 'protocol.md')}`);
  }
}

function destroy() {
  if (!distros().includes(DISTRO)) return console.log('дистрибутива нет');
  wsl(['--unregister', DISTRO]);
  console.log(`дистрибутив ${DISTRO} удалён вместе с данными`);
}

const commands = { create, prepare, check, run, destroy };
if (!commands[cmd]) {
  console.error(`команды: ${Object.keys(commands).join(', ')}`);
  process.exit(2);
}
try {
  await commands[cmd]();
} catch (e) {
  console.error(`ОШИБКА: ${e.message ?? e}`);
  process.exit(1);
}
