#!/usr/bin/env node
/**
 * Узел-источник искусственного комплекта для испытания полного восстановления (работа № 5
 * раздела 01): дистрибутив WSL `fifth-source` с раскладкой рабочей среды. Ноутбук Томаса.
 *
 *   node scripts/restore-source-wsl.mjs build --rootfs <файл> --sha256 <hex> --source <адрес> --out <каталог>
 *   node scripts/restore-source-wsl.mjs destroy
 *
 * build: дистрибутив → пакеты → node и образы fifth/* из Docker ноутбука (собраны из HEAD) →
 * код (git bundle HEAD) → .env стенда с подменами (адрес, каталоги, без Telegram и внешней
 * почты, испытательный ключ получателя копий) → службы, Caddy, юниты → демонстрационные данные
 * → копия базы и комплект → выгрузка аудита (испытательный ключ подписи) → комплект и вынос
 * выгрузки — в <каталог> на ноутбуке → источник выключается (`wsl --terminate`).
 * Образы, которых нет в Docker ноутбука (valkey, zabbix), источник берёт из Docker Hub —
 * записано в sources.json. Значения секретов не печатаются.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DISTRO = 'fifth-source';
const HOME = join(ROOT, '.local', 'wsl', DISTRO);
const SITE = '/var/lib/fifth-restore';
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const KEYS = join(ROOT, '.local', 'backup-keys-local-stand');

function wsl(args, { input, allowFail = false } = {}) {
  const r = spawnSync('wsl.exe', args, { input, maxBuffer: 256 * 1024 * 1024 });
  const dec = (b) => {
    const buf = Buffer.from(b ?? '');
    return buf.length > 1 && buf[1] === 0 ? buf.toString('utf16le') : buf.toString('utf8');
  };
  const out = dec(r.stdout);
  const err = dec(r.stderr).trim();
  if (r.status !== 0 && !allowFail)
    throw new Error(`wsl ${args.slice(-1)[0].slice(0, 120)}: ${err || out.trim().slice(-600)}`);
  return { ok: r.status === 0, out, err };
}
const inSrc = (script, o) => wsl(['-d', DISTRO, '-u', 'root', '--', 'bash', '-c', script], o);
const step = (name) => console.log(`\n▸ ${name}`);
const say = (r) => process.stdout.write(r.out.trim() ? `${r.out.trim()}\n` : '');
const distros = () =>
  wsl(['-l', '-q'])
    .out.split(/\r?\n/)
    .map((s) => s.replace(/\0/g, '').trim())
    .filter(Boolean);

/** Поток из процесса Windows во внутреннюю команду источника. */
function pipeIn(cmd, args, script) {
  return new Promise((done, fail) => {
    const a = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    const b = spawn('wsl.exe', ['-d', DISTRO, '-u', 'root', '--', 'bash', '-c', script], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    a.stdout.pipe(b.stdin);
    let n = 0;
    const end = (code) =>
      code !== 0 ? fail(new Error(`${cmd}: код ${code}`)) : ++n === 2 && done();
    a.on('close', end);
    b.on('close', end);
  });
}
/** Каталог источника → каталог ноутбука (tar). */
function pipeOut(dir, to) {
  mkdirSync(to, { recursive: true });
  return new Promise((done, fail) => {
    const a = spawn(
      'wsl.exe',
      ['-d', DISTRO, '-u', 'root', '--', 'tar', '-cf', '-', '-C', dir, '.'],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    // Каталог — рабочей папкой, не -C: tar из Git для Windows принимает «D:…» за адрес машины.
    const b = spawn('tar.exe', ['-xf', '-'], { cwd: to, stdio: ['pipe', 'inherit', 'inherit'] });
    a.stdout.pipe(b.stdin);
    let n = 0;
    const end = (code) =>
      code !== 0 ? fail(new Error(`вынос ${dir}: код ${code}`)) : ++n === 2 && done();
    a.on('close', end);
    b.on('close', end);
  });
}
const sha256File = (file) =>
  new Promise((done, fail) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => done(h.digest('hex')))
      .on('error', fail);
  });

/** .env источника: значения стенда (искусственные) с подменами раскладки рабочего узла. */
function sourceEnv() {
  const text = readFileSync(join(ROOT, '.env'), 'utf8').replace(/\r\n/g, '\n');
  const set = {
    FIFTH_CORE_IMAGE: 'fifth/core:src',
    FIFTH_WEB_IMAGE: 'fifth/web:src',
    FIFTH_POSTGRES_IMAGE: 'fifth/postgres:16',
    WEB_PORT: '8080',
    PUBLIC_BASE_URL: 'https://src.5espace.test',
    CORE_PUBLIC_URL: 'https://src.5espace.test',
    CORS_ALLOWED_ORIGINS: 'https://src.5espace.test',
    BACKUP_DIR: '/var/backups/fifth-element',
    BACKUP_PGBACKREST_DIR: '/var/backups/fifth-element/pgbackrest',
    BACKUP_KEYS_RECIPIENT: '/opt/fifth-element/.local/backup-keys/recipient.asc',
    MONITOR_STATE_DIR: '/var/lib/fifth-monitor',
    MONITOR_PULSE_PUBLIC_DIR: '/var/lib/fifth-monitor/pulse-public',
    // Наружу источник ничего не шлёт.
    BACKUP_TELEGRAM_BOT_TOKEN: '',
    BACKUP_TELEGRAM_CHAT_ID: '',
    TELEGRAM_BOT_TOKEN: '',
    MAIL_TRANSPORT: 'file',
    MAIL_OUTBOX_DIR: '/tmp/fifth-mail',
    WEBHOOK_DELIVERY_MODE: 'capture',
  };
  let out = text;
  for (const [k, v] of Object.entries(set)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    out = re.test(out) ? out.replace(re, `${k}=${v}`) : `${out.replace(/\n?$/, '\n')}${k}=${v}\n`;
  }
  return out;
}

async function build() {
  const rootfs = resolve(opt('--rootfs', ''));
  const want = opt('--sha256');
  const source = opt('--source');
  const outDir = resolve(opt('--out', join(ROOT, '.local', 'restore-trial')));
  if (!existsSync(rootfs) || !want || !source)
    throw new Error('нужны --rootfs, --sha256, --source');
  // --resume: дистрибутив уже создан и пакеты стоят — продолжить с переноса образов.
  const resume = argv.includes('--resume') && distros().includes(DISTRO);
  if (!resume && distros().includes(DISTRO))
    throw new Error(`${DISTRO} уже есть — destroy или --resume`);
  const sources = [];
  // WSL гасит дистрибутив без подключённых сеансов: держатель на всё время сборки.
  let keeper = null;
  const keep = () => {
    keeper = spawn('wsl.exe', ['-d', DISTRO, '-u', 'root', '--', 'sleep', '86400'], {
      stdio: 'ignore',
    });
  };
  process.on('exit', () => keeper?.kill());

  step('образ ОС и дистрибутив');
  const site = readFileSync(join(ROOT, 'infra', 'restore', 'site.sh'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
  const src = readFileSync(join(ROOT, 'infra', 'restore', 'source.sh'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
  const got = await sha256File(rootfs);
  if (got !== want.toLowerCase()) throw new Error(`SHA-256 образа ОС не совпал: ${got}`);
  sources.push({ what: 'образ ОС источника', url: source, sha256: got });
  if (!resume) {
    mkdirSync(HOME, { recursive: true });
    wsl(['--import', DISTRO, HOME, rootfs, '--version', '2']);
    inSrc(`mkdir -p ${SITE} && cat > ${SITE}/site.sh`, { input: site });
    inSrc(`bash ${SITE}/site.sh wslconf ${DISTRO}`);
    wsl(['--terminate', DISTRO]);
  }
  keep();
  inSrc(`mkdir -p ${SITE} && cat > ${SITE}/source.sh && chmod 700 ${SITE}/source.sh`, {
    input: src,
  });

  step('пакеты Ubuntu');
  if (!resume) say(inSrc(`bash ${SITE}/source.sh packages`));
  const apt = inSrc(
    "grep -rh '^URIs:\\|^deb ' /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null | sort -u",
  )
    .out.trim()
    .split('\n');
  for (const a of apt) sources.push({ what: 'пакеты Ubuntu (источник)', url: a });

  step('образы fifth/* и node — из Docker ноутбука');
  await pipeIn(
    'docker',
    ['save', 'fifth/core:src', 'fifth/web:src', 'fifth/postgres:16'],
    'docker load | tail -3',
  );
  say(inSrc(`bash ${SITE}/source.sh node`));

  step('код (git bundle HEAD)');
  const bundle = join(HOME, 'head.bundle');
  const b = spawnSync('git', ['-C', ROOT, 'bundle', 'create', bundle, 'HEAD', 'main'], {
    encoding: 'utf8',
  });
  if (b.status !== 0) throw new Error(`git bundle: ${b.stderr}`);
  inSrc(`cat > /tmp/head.bundle`, { input: readFileSync(bundle) });
  say(inSrc(`bash ${SITE}/source.sh code /tmp/head.bundle`));
  inSrc(`cat > /opt/fifth-element/.env && chmod 600 /opt/fifth-element/.env`, {
    input: sourceEnv(),
  });
  inSrc(
    `mkdir -p /opt/fifth-element/.local/backup-keys && cat > /opt/fifth-element/.local/backup-keys/recipient.asc`,
    {
      input: readFileSync(join(KEYS, 'recipient.asc')),
    },
  );
  // Ключ подписи выгрузки аудита — испытательный, только для этого источника.
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  inSrc(
    'mkdir -m 700 -p /etc/fifth-audit-export && cat > /etc/fifth-audit-export/signing.key && chmod 600 /etc/fifth-audit-export/signing.key',
    {
      input: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    },
  );
  const pub = publicKey.export({ type: 'spki', format: 'pem' });

  step('службы, Caddy, юниты');
  say(inSrc(`bash ${SITE}/source.sh up`));
  for (const r of ['valkey/valkey', 'zabbix/zabbix', 'nats', 'dxflrs/garage'])
    sources.push({ what: `образы Docker Hub (источник): ${r}*`, url: 'registry-1.docker.io' });

  step('демонстрационные данные');
  say(inSrc(`bash ${SITE}/source.sh seed`));

  step('копия базы и комплект на момент T');
  say(inSrc(`bash ${SITE}/source.sh set`));

  step('выгрузка аудита (после T: покрывает комплект)');
  say(inSrc(`bash ${SITE}/source.sh audit`));

  await exportSet(outDir, pub, sources);

  step('источник выключен');
  keeper?.kill();
  wsl(['--terminate', DISTRO]);
}

/** Комплект и выгрузка аудита — с источника на ноутбук; вынос выгрузки как у Томаса. */
async function exportSet(outDir, pub, sources) {
  step('комплект и выгрузка — на ноутбук');
  say(inSrc(`rm -rf ${SITE}/pull && bash ${SITE}/source.sh pull ${SITE}/pull`));
  rmSync(outDir, { recursive: true, force: true });
  const setId = inSrc(`ls ${SITE}/pull`).out.trim().split('\n').pop();
  await pipeOut(`${SITE}/pull/${setId}`, join(outDir, 'set'));
  await pipeOut('/var/lib/fifth-audit-export/out', join(outDir, 'audit-source', 'prod', 'out'));
  writeFileSync(join(outDir, 'export-signing.pub'), pub);
  writeFileSync(join(outDir, 'sources.json'), JSON.stringify(sources, null, 2));
  // Вынос как на ноутбуке Томаса: подпись, продолжение серии, контрольная точка.
  const off = spawnSync(
    process.execPath,
    [
      join(ROOT, 'scripts', 'audit-offsite.mjs'),
      'pull',
      '--env',
      'prod',
      '--to',
      join(outDir, 'audit'),
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FIFTH_AUDIT_SOURCE_DIR: join(outDir, 'audit-source'),
        AUDIT_EXPORT_PUBLIC_KEY: join(outDir, 'export-signing.pub'),
      },
    },
  );
  process.stdout.write(off.stdout.slice(-600));
  if (off.status !== 0) throw new Error(`вынос выгрузки: ${off.stderr.trim().slice(-400)}`);
  writeFileSync(join(outDir, 'audit', 'prod', 'export-signing.pub'), pub);
  const act = inSrc('cat /var/lib/fifth-restore/activity.json', { allowFail: true });
  if (act.ok) writeFileSync(join(outDir, 'audit', 'prod', 'activity.json'), act.out);
  console.log(
    `комплект ${setId}: ${join(outDir, 'set')}; выгрузка: ${join(outDir, 'audit', 'prod')}`,
  );
}

/** Новый код (HEAD) на источник, новые комплект и выгрузка, перенос — без пересборки узла. */
async function refresh() {
  const keeper = spawn('wsl.exe', ['-d', DISTRO, '-u', 'root', '--', 'sleep', '86400'], {
    stdio: 'ignore',
  });
  try {
    step('код источника — HEAD');
    const bundle = join(HOME, 'head.bundle');
    const b = spawnSync('git', ['-C', ROOT, 'bundle', 'create', bundle, 'HEAD', 'main'], {
      encoding: 'utf8',
    });
    if (b.status !== 0) throw new Error(`git bundle: ${b.stderr}`);
    inSrc('cat > /tmp/head.bundle', { input: readFileSync(bundle) });
    say(
      inSrc(
        'git -C /opt/fifth-element pull -q --ff-only /tmp/head.bundle main && git -C /opt/fifth-element rev-parse --short HEAD',
      ),
    );
    const src = readFileSync(join(ROOT, 'infra', 'restore', 'source.sh'), 'utf8').replace(
      /\r\n/g,
      '\n',
    );
    inSrc(`cat > ${SITE}/source.sh && chmod 700 ${SITE}/source.sh`, { input: src });
    // Служба соединения узлов Garage — как на рабочем узле (и в конфигурацию комплекта).
    inSrc(
      'cp /opt/fifth-element/infra/systemd/fifth-garage-connect.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable fifth-garage-connect.service',
    );
    step('Caddy источника');
    say(inSrc(`bash ${SITE}/source.sh caddy`));
    step('активность до комплекта');
    say(inSrc(`bash ${SITE}/source.sh activity before`));
    step('комплект на момент T');
    say(inSrc(`bash ${SITE}/source.sh set`));
    step('после комплекта: снятие публикации (учёт удалений должен его воспроизвести)');
    say(inSrc(`bash ${SITE}/source.sh activity after`));
    step('выгрузка аудита');
    say(inSrc(`bash ${SITE}/source.sh audit`));
  } finally {
    keeper.kill();
  }
  await exportOnly();
}

/** Повтор переноса без новой сборки: комплект уже снят на источнике. */
async function exportOnly() {
  const outDir = resolve(opt('--out', join(ROOT, '.local', 'restore-trial')));
  const keeper = spawn('wsl.exe', ['-d', DISTRO, '-u', 'root', '--', 'sleep', '86400'], {
    stdio: 'ignore',
  });
  try {
    const key = createPrivateKey(inSrc('cat /etc/fifth-audit-export/signing.key').out);
    const pub = createPublicKey(key).export({ type: 'spki', format: 'pem' });
    const sources = [
      {
        what: 'образ ОС источника',
        url: opt('--source', '(см. сборку)'),
        sha256: opt('--sha256', null),
      },
    ];
    const aptList = inSrc(
      "grep -rh '^URIs:\\|^deb ' /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null | sort -u",
    );
    for (const a of aptList.out.trim().split('\n'))
      sources.push({ what: 'пакеты Ubuntu (источник)', url: a });
    for (const r of ['valkey/valkey', 'zabbix/zabbix', 'nats', 'dxflrs/garage'])
      sources.push({ what: `образы Docker Hub (источник): ${r}*`, url: 'registry-1.docker.io' });
    await exportSet(outDir, pub, sources);
  } finally {
    keeper.kill();
  }
  step('источник выключен');
  wsl(['--terminate', DISTRO]);
}

function destroy() {
  if (!distros().includes(DISTRO)) return console.log('источника нет');
  wsl(['--unregister', DISTRO]);
  console.log(`${DISTRO} удалён вместе с данными`);
}

const commands = { build, refresh, export: exportOnly, destroy };
if (!commands[argv[0]]) {
  console.error('команды: build, refresh, export, destroy');
  process.exit(2);
}
try {
  await commands[argv[0]]();
} catch (e) {
  console.error(`ОШИБКА: ${e.message ?? e}`);
  process.exit(1);
}
