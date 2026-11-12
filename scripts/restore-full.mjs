#!/usr/bin/env node
/**
 * Полное восстановление рабочей среды на чистом узле (работа № 5 раздела 01; 2.1.4, протокол
 * по 2.5). Запускается на самом узле восстановления под root — на испытательной площадке
 * WSL его вызывает `restore-site-wsl.mjs run`.
 *
 *   node scripts/restore-full.mjs --set <скачанный комплект> --secret-key <файл>
 *        --passphrase-file <файл> --openbao-keys <аварийный комплект>
 *        [--audit <вынесенная выгрузка аудита> --coverage-ack <покрыто до>] [--out <каталог>]
 *        [--site-info <json площадки>]
 *
 * Берёт только скачанный комплект: исходную площадку не читает и к ней не обращается.
 * Порядок:
 *   1. предварительные условия: чистый Docker, свободные порты, наружу закрыто, комплект сверен;
 *   2. ключи: комплект ключей и секретная часть конфигурации — ключом Томаса, в памяти;
 *   3. учётные записи, код, конфигурация и секреты — на прежние места, с правами;
 *   4. образы — из комплекта, по идентификатору; Compose не скачивает ничего;
 *   5. удержание внешних действий ДО первого запуска служб: ядро с закрытыми воротами
 *      (`CORE_RESTORE_HOLD`), почта `none`, оповещения Zabbix выключены, таймеры не запущены,
 *      Caddy без ACME (local_certs), имена сайтов — на этот узел; выход наружу закрыт
 *      площадкой (проверяется здесь же);
 *   6. OpenBao из снимка ключом аварийного комплекта; 7. база на момент T, ворота закрыты;
 *   8. Garage и файлы; 9. остальные службы; 10. юниты и Caddy;
 *   11. сверка и учёт удалений по 2.1.5 (`deletions-apply`) — только после неё ворота
 *       открываются; без источника событий работа не разрешается;
 *   12. контрольные операции через публичный вход: вход, запись, файл; Zabbix, NATS, юниты.
 *
 * Протокол — `<out>/protocol.json` и `protocol.md`: отметки UTC по 2.5, этапы, проверки,
 * удержанное, ОС, пакеты и внешние источники площадки. Значения секретов не печатаются.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setLimitations, verifyCatalog } from './lib/backup.mjs';

const TOOLS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const setDir = resolve(opt('--set', ''));
const secretKey = opt('--secret-key');
const passFile = opt('--passphrase-file');
const openbaoKit = opt('--openbao-keys');
const auditDir = opt('--audit');
const coverageAck = opt('--coverage-ack');
const outDir = resolve(opt('--out', '/var/lib/fifth-restore/report'));
const siteInfo = opt('--site-info') ? JSON.parse(readFileSync(opt('--site-info'), 'utf8')) : null;
const WORK = '/var/lib/fifth-restore';
const HOLD_DIR = join(WORK, 'hold');

// ------------------------------------------------------------------ протокол
const now = () => new Date().toISOString();
const protocol = {
  kind: 'restore-full',
  startedAt: now(),
  marks: {},
  stages: [],
  checks: [],
  held: [],
  limitations: [],
  notes: [],
  site: siteInfo,
};
let failed = 0;
const check = (name, ok, details = '') => {
  protocol.checks.push({
    at: now(),
    name,
    ok: Boolean(ok),
    details: String(details).slice(0, 800),
  });
  if (!ok) failed += 1;
  console.log(
    `  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details && !ok ? ` — ${String(details).slice(0, 400)}` : ''}`,
  );
  return Boolean(ok);
};
const hold = (what, how) => {
  protocol.held.push({ at: now(), what, how });
  console.log(`  HOLD  ${what}: ${how}`);
};
const limit = (s) => {
  protocol.limitations.push(s);
  console.log(`  ·     ограничение: ${s}`);
};
async function stage(name, fn) {
  const rec = { name, startedAt: now() };
  protocol.stages.push(rec);
  console.log(`\n▸ ${name}`);
  try {
    const r = await fn();
    rec.ok = true;
    return r;
  } catch (e) {
    rec.ok = false;
    rec.error = String(e.message ?? e).slice(0, 600);
    throw e;
  } finally {
    rec.finishedAt = now();
  }
}

// ------------------------------------------------------------------ команды
function sh(cmd, args, { input, env, allowFail = false, cwd, timeout = 1_800_000 } = {}) {
  const r = spawnSync(cmd, args, {
    input,
    cwd,
    env: { ...process.env, ...env },
    encoding: input instanceof Buffer ? undefined : 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
    timeout,
  });
  const out = r.stdout instanceof Buffer ? r.stdout : Buffer.from(r.stdout ?? '');
  const err = String(r.stderr ?? '').trim();
  if (r.status !== 0 && !allowFail) {
    throw new Error(
      `${cmd} ${args.slice(0, 3).join(' ')}: ${err.split('\n').slice(-3).join(' | ') || `код ${r.status}`}`,
    );
  }
  return { ok: r.status === 0, status: r.status, out, text: out.toString('utf8'), err };
}
const docker = (args, o) => sh('docker', args, o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// ------------------------------------------------------------------ комплект
const setId = readdirSync(join(setDir, 'sets'))
  .filter((d) => existsSync(join(setDir, 'sets', d, 'READY')))
  .sort()
  .pop();
if (!setId) {
  console.error('в каталоге нет пригодного комплекта (sets/<id>/READY)');
  process.exit(2);
}
const catalog = JSON.parse(readFileSync(join(setDir, 'sets', setId, 'catalog.json'), 'utf8'));
const host = catalog.host?.file
  ? JSON.parse(readFileSync(join(setDir, catalog.host.file), 'utf8'))
  : null;
protocol.set = { id: setId, T: catalog.at, commit: catalog.config?.commit ?? null };
protocol.tool = { commit: process.env.RESTORE_TOOL_COMMIT ?? null };
const ROOT = host?.root ?? '/opt/fifth-element';

/** Роли служб по записанным проектам Compose. */
function services() {
  const out = [];
  for (const p of Object.values(host.projects)) {
    for (const [name, s] of Object.entries(p.services)) {
      const img = host.images.find((i) => i.id === s.imageId);
      const tags = img?.tags ?? [];
      const ref = `${s.image ?? ''} ${tags.join(' ')}`;
      let role = 'other';
      if (/openbao\/openbao/.test(ref)) role = /agent/.test(name) ? 'openbao-agent' : 'openbao';
      else if (/dxflrs\/garage/.test(ref)) role = 'garage';
      else if (name === 'postgres') role = 'postgres';
      else if (/fifth\/core|core/.test(ref) && /^core|worker/.test(name)) role = 'core';
      else if (/zabbix-server/.test(ref)) role = 'zabbix-server';
      else if (/^nats/.test(s.image ?? '')) role = 'nats';
      out.push({ project: p.name, service: name, role, ...s });
    }
  }
  return out;
}

/** Команда Compose проекта: его файлы, переменные и файл удержания. */
function compose(project, args, o = {}) {
  const p = host.projects[project];
  const files = [...p.configFiles, join(HOLD_DIR, `${project}.yml`)].flatMap((f) => ['-f', f]);
  const envs = p.envFiles.flatMap((f) => ['--env-file', f]);
  return docker(
    ['compose', '-p', project, '--project-directory', p.workingDir, ...files, ...envs, ...args],
    o,
  );
}

/** Создание контейнеров проекта; внешняя сеть, которой ещё нет, — создаётся и повтор. */
function composeCreate(project, list) {
  for (let i = 0; i < 5; i++) {
    const r = compose(project, ['create', '--pull', 'never', '--no-build', ...list], {
      allowFail: true,
    });
    if (r.ok) return;
    const m = r.err.match(/network (\S+) declared as external, but could not be found/);
    if (!m)
      throw new Error(`compose create ${project}: ${r.err.split('\n').slice(-2).join(' | ')}`);
    docker(['network', 'create', m[1]]);
  }
}

async function waitFor(fn, seconds, what) {
  for (let i = 0; i < seconds; i++) {
    try {
      if (await fn()) return true;
    } catch {
      /* ещё не готово */
    }
    await sleep(1000);
  }
  throw new Error(`не дождались: ${what}`);
}

const psql = (container, db, sql, { allowFail = false } = {}) =>
  docker(
    [
      'exec',
      '-i',
      container,
      'psql',
      '-X',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'unicorn_owner',
      '-d',
      db,
    ],
    {
      input: sql,
      allowFail,
    },
  );

// =================================================================== ход
let env = {};
let secretsTar = null;
const state = {};
try {
  protocol.marks.trialStart = now(); // начало нарушения на стенде — момент начала испытания
  if (!host) throw new Error('в комплекте нет конфигурации узла (комплект до работы № 5)');

  // ------------------------------------------------------------ 1. условия
  await stage('Предварительные условия', () => {
    check(
      'Linux, root, systemd',
      process.platform === 'linux' &&
        process.getuid() === 0 &&
        readFileSync('/proc/1/comm', 'utf8').trim() === 'systemd',
    );
    const info = docker(['info', '--format', '{{json .}}']).text;
    const d = JSON.parse(info);
    protocol.docker = {
      id: d.ID,
      name: d.Name,
      rootDir: d.DockerRootDir,
      version: d.ServerVersion,
      os: d.OperatingSystem,
    };
    check(
      'Docker площадки пуст: нет контейнеров',
      d.Containers === 0,
      `контейнеров ${d.Containers}`,
    );
    check('Docker площадки пуст: нет томов', docker(['volume', 'ls', '-q']).text.trim() === '');
    const listen = sh('ss', ['-ltnH']).text;
    const busy = [80, 443].filter((p) => new RegExp(`:${p}\\s`).test(listen));
    check('порты 80 и 443 свободны', busy.length === 0, busy.join(','));
    // Выход наружу закрыт площадкой (restore-site-wsl prepare) — до любых служб.
    const out = sh('sh', ['-c', 'exec 3<>/dev/tcp/1.1.1.1/443'], {
      allowFail: true,
      timeout: 8000,
    });
    check('выход наружу с узла закрыт', !out.ok);
    if (!out.ok)
      hold(
        'выход наружу',
        'площадка: службы в сетевом пространстве без маршрута наружу; проверено до запуска служб',
      );
    const problems = verifyCatalog(catalog, setDir);
    check(
      'комплект сверен с описью (SHA-256 каждого файла)',
      problems.length === 0,
      problems.slice(0, 3).join('; '),
    );
    for (const l of setLimitations(catalog)) limit(`комплект: ${l}`);
    if (problems.length || failed)
      throw new Error('условия не выполнены — восстановление не начато');
    protocol.marks.restoreStart = now();
  });

  // --------------------------------------------------------------- 2. ключи
  await stage('Ключи: комплект ключей и секретная часть конфигурации', () => {
    const gnupg = mkdtempSync('/dev/shm/fifth-restore-gpg-');
    chmodSync(gnupg, 0o700);
    const pass = readFileSync(passFile, 'utf8').trim();
    const gpg = (file) =>
      sh(
        'gpg',
        ['-q', '--batch', '--pinentry-mode', 'loopback', '--passphrase-fd', '0', '--decrypt', file],
        {
          input: Buffer.from(pass),
          env: { GNUPGHOME: gnupg },
        },
      ).out;
    sh(
      'gpg',
      [
        '-q',
        '--batch',
        '--pinentry-mode',
        'loopback',
        '--passphrase-fd',
        '0',
        '--import',
        secretKey,
      ],
      {
        input: Buffer.from(pass),
        env: { GNUPGHOME: gnupg },
      },
    );
    try {
      for (const line of gpg(join(setDir, catalog.keys.file)).toString('utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
      }
      check('комплект ключей открыт ключом Томаса', Boolean(env.BACKUP_PGBACKREST_CIPHER_PASS));
      if (catalog.host.secrets) {
        secretsTar = gpg(join(setDir, catalog.host.secrets.file));
        check(
          'секретная часть конфигурации открыта',
          secretsTar.length > 0,
          `${catalog.host.secrets.count} файлов`,
        );
      }
    } finally {
      rmSync(gnupg, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------- 3. учётные записи и файлы
  await stage('Учётные записи, код, конфигурация, секреты', () => {
    for (const g of host.groups) {
      if (!sh('getent', ['group', g.name], { allowFail: true }).ok) {
        sh('groupadd', ['-g', String(g.gid), g.name], { allowFail: true });
      }
    }
    for (const u of host.users) {
      if (!sh('getent', ['passwd', u.name], { allowFail: true }).ok) {
        const r = sh(
          'useradd',
          [
            '-u',
            String(u.uid),
            '-g',
            String(u.gid),
            '-M',
            '-d',
            u.home,
            '-s',
            u.shell || '/usr/sbin/nologin',
            u.name,
          ],
          { allowFail: true },
        );
        if (!r.ok) limit(`учётная запись ${u.name} (uid ${u.uid}) не создана: ${r.err}`);
      }
    }
    // Код серверной копии.
    if (existsSync(ROOT) && readdirSync(ROOT).length) throw new Error(`${ROOT} уже не пуст`);
    mkdirSync(ROOT, { recursive: true });
    sh('tar', ['-xzf', join(setDir, catalog.host.code.file), '-C', ROOT]);
    check(
      'код серверной копии на месте',
      existsSync(join(ROOT, 'package.json')),
      `${catalog.host.code.files} файлов`,
    );
    // Каталоги, затем открытые файлы и ссылки — с правами и владельцами описи.
    const base = join(setDir, 'sets', setId, 'config', 'host', 'files');
    let files = 0;
    let wrong = 0;
    for (const e of host.entries.filter((x) => x.type === 'dir')) {
      mkdirSync(e.path, { recursive: true });
      chmodSync(e.path, e.mode);
      chownSync(e.path, e.uid, e.gid);
    }
    for (const e of host.entries) {
      if (e.type === 'file' && !e.secret) {
        const buf = readFileSync(join(base, e.path));
        if (sha256(buf) !== e.sha256) wrong += 1;
        mkdirSync(dirname(e.path), { recursive: true });
        writeFileSync(e.path, buf);
        chmodSync(e.path, e.mode);
        chownSync(e.path, e.uid, e.gid);
        files += 1;
      } else if (e.type === 'link') {
        rmSync(e.path, { force: true });
        mkdirSync(dirname(e.path), { recursive: true });
        symlinkSync(e.target, e.path);
      }
    }
    check(
      `открытая конфигурация разложена (${files} файлов), хеши сошлись`,
      wrong === 0,
      `расхождений ${wrong}`,
    );
    if (secretsTar) {
      sh('tar', ['-xpf', '-', '--numeric-owner', '-C', '/'], { input: secretsTar });
      const missing = host.entries.filter(
        (e) => e.type === 'file' && e.secret && !existsSync(e.path),
      );
      check(
        `секреты разложены (${catalog.host.secrets.count})`,
        missing.length === 0,
        missing
          .slice(0, 3)
          .map((e) => e.path)
          .join(', '),
      );
      secretsTar.fill(0);
    }
    const code = host.entries.filter((e) => e.type === 'code' && !existsSync(e.path));
    check(
      'файлы, взятые из кода, на месте',
      code.length === 0,
      code
        .slice(0, 3)
        .map((e) => e.path)
        .join(', '),
    );
    sh('systemd-tmpfiles', ['--create'], { allowFail: true });
    // Нужное службам (монтирования, юниты, EnvironmentFile) и не найденное — ограничение; ссылки
    // из текста настроек на пути, которых нет и на исходном узле, — только заметка протокола.
    for (const s of host.skipped.filter((x) => x.kind === 'missing')) {
      if (/^ссылка из|^import Caddy/.test(s.why))
        protocol.notes.push(`нет и на исходном узле: ${s.path} (${s.why})`);
      else limit(`на исходном узле не было: ${s.path} (${s.why})`);
    }
  });

  // -------------------------------------------------------------- 4. образы
  await stage('Образы из комплекта', () => {
    let loaded = 0;
    for (const img of catalog.host.images) {
      docker(['load', '-i', join(setDir, img.file)]);
      const id = docker(['image', 'inspect', img.id, '--format', '{{.Id}}'], {
        allowFail: true,
      }).text.trim();
      if (id !== img.id)
        throw new Error(`образ ${img.tags[0] ?? img.id}: после загрузки другой идентификатор`);
      // Ссылку с дайджестом тегом не назначить: такие службы получают образ по идентификатору ниже.
      for (const t of img.tags.filter((x) => !x.includes('@'))) docker(['tag', img.id, t]);
      loaded += 1;
    }
    check(
      `образы загружены, идентификаторы как в комплекте (${loaded})`,
      loaded === catalog.host.images.length,
    );
    for (const m of catalog.host.imagesMissing ?? []) limit(`образ не сохранён в комплекте: ${m}`);
    // Каждая служба — на своём образе по идентификатору: ссылки вида name@sha256 не
    // скачиваются, Compose берёт только загруженное.
    for (const s of services()) {
      s.tag = `fifth-restore/${s.project}-${s.service}:${s.imageId.replace(/^sha256:/, '').slice(0, 12)}`;
      docker(['tag', s.imageId, s.tag]);
    }
    state.services = services().map((s) => ({
      ...s,
      tag: `fifth-restore/${s.project}-${s.service}:${s.imageId.replace(/^sha256:/, '').slice(0, 12)}`,
    }));
  });

  // ------------------------------------------------- 5. удержание до запуска
  await stage('Удержание внешних действий до первого запуска служб', () => {
    mkdirSync(HOLD_DIR, { recursive: true });
    for (const p of Object.values(host.projects)) {
      const svc = {};
      for (const s of state.services.filter((x) => x.project === p.name)) {
        svc[s.service] = { image: s.tag, pull_policy: 'never' };
        if (s.role === 'core') {
          // Ворота среды закрыты (M167): людям 503, отправщики с внешними последствиями стоят.
          svc[s.service].environment = {
            CORE_RESTORE_HOLD: `restore-${setId}`,
            MAIL_TRANSPORT: 'none',
          };
        }
      }
      writeFileSync(
        join(HOLD_DIR, `${p.name}.yml`),
        `${JSON.stringify({ services: svc }, null, 2)}\n`,
      );
    }
    hold(
      'ядро',
      `CORE_RESTORE_HOLD=restore-${setId}: ворота закрыты, почта и вебхуки не отправляются`,
    );
    hold('почта ядра', 'MAIL_TRANSPORT=none на всё испытание');
    hold('образы', 'pull_policy: never — только образы комплекта');
    // Имена сайтов — на этот узел.
    const names = [...new Set(host.caddy.sites)];
    const hosts = readFileSync('/etc/hosts', 'utf8').replace(
      /\n# fifth-restore[\s\S]*?# \/fifth-restore\n/,
      '\n',
    );
    writeFileSync(
      '/etc/hosts',
      `${hosts.trimEnd()}\n# fifth-restore\n127.0.0.1 ${names.join(' ')}\n# /fifth-restore\n`,
    );
    hold('имена сайтов', `${names.length} имён → 127.0.0.1 (/etc/hosts)`);
    // Caddy без ACME: тот же Caddyfile с local_certs, через drop-in площадки.
    const cf = host.caddy.config;
    if (existsSync(cf)) {
      const text = readFileSync(cf, 'utf8');
      const held = /^\s*\{\s*$/m.test(text.split('\n').find((l) => l.trim()) ?? '')
        ? text.replace(/^\s*\{\s*$/m, '{\n\tlocal_certs')
        : `{\n\tlocal_certs\n}\n\n${text}`;
      writeFileSync(`${cf}.restore-hold`, held);
      const dropDir = '/etc/systemd/system/caddy.service.d';
      mkdirSync(dropDir, { recursive: true });
      writeFileSync(
        join(dropDir, 'zz-restore-hold.conf'),
        `# Площадка восстановления: без ACME. Удалить при разрешении работы.\n[Service]\nExecStart=\nExecStart=/usr/bin/caddy run --environ --config ${cf}.restore-hold --adapter caddyfile\nExecReload=\nExecReload=/usr/bin/caddy reload --config ${cf}.restore-hold --adapter caddyfile --force\n`,
      );
      hold('Caddy', 'local_certs: сертификаты не запрашиваются у ACME');
    } else limit(`Caddyfile ${cf} не восстановлен`);
  });

  // ------------------------------------------------------------- 6. OpenBao
  await stage('OpenBao из снимка', async () => {
    const bao = state.services.find((s) => s.role === 'openbao');
    if (!bao) {
      limit('OpenBao на исходном узле не работал');
      return;
    }
    // Static seal key — из аварийного комплекта Томаса, на место по монтированию службы.
    const gnupg = mkdtempSync('/dev/shm/fifth-restore-gpg-');
    const pass = readFileSync(passFile, 'utf8').trim();
    let kit;
    try {
      sh(
        'gpg',
        [
          '-q',
          '--batch',
          '--pinentry-mode',
          'loopback',
          '--passphrase-fd',
          '0',
          '--import',
          secretKey,
        ],
        { input: Buffer.from(pass), env: { GNUPGHOME: gnupg } },
      );
      kit = sh(
        'gpg',
        [
          '-q',
          '--batch',
          '--pinentry-mode',
          'loopback',
          '--passphrase-fd',
          '0',
          '--decrypt',
          openbaoKit,
        ],
        { input: Buffer.from(pass), env: { GNUPGHOME: gnupg } },
      ).text;
    } finally {
      rmSync(gnupg, { recursive: true, force: true });
    }
    const seal = kit.match(/^OPENBAO_STATIC_SEAL_B64=(.*)$/m)?.[1]?.trim();
    const recovery = kit.match(/^OPENBAO_RECOVERY_KEY=(.*)$/m)?.[1]?.trim();
    check('аварийный комплект открыт', Boolean(seal && recovery));
    const sealDir = bao.binds.find((b) => /\/seal$/.test(b)) ?? '/etc/fifth-openbao/seal';
    mkdirSync(sealDir, { recursive: true });
    writeFileSync(join(sealDir, 'static.key'), Buffer.from(seal, 'base64'), { mode: 0o400 });
    chownSync(join(sealDir, 'static.key'), 1990, 1990);
    composeCreate(bao.project, [bao.service]);
    compose(bao.project, ['start', bao.service]);
    const addr = (env.OPENBAO_ADDR || 'https://127.0.0.1:8200').replace(/\/$/, '');
    const ca =
      bao.binds.map((b) => join(b, 'ca.crt')).find((f) => existsSync(f)) ??
      bao.binds.map((b) => join(b, 'tls.crt')).find((f) => existsSync(f));
    const curl = (method, path, { token, body } = {}) => {
      const r = sh(
        'curl',
        [
          '-sS',
          '-m',
          '60',
          '-X',
          method,
          ...(ca ? ['--cacert', ca] : ['-k']),
          ...(token ? ['-H', `X-Vault-Token: ${token}`] : []),
          ...(body ? ['--data-binary', '@-'] : []),
          '-w',
          '\n%{http_code}',
          `${addr}/v1/${path}`,
        ],
        { input: body, allowFail: true },
      );
      const lines = r.text.trimEnd().split('\n');
      const code = Number(lines.pop());
      let json = {};
      try {
        json = JSON.parse(lines.join('\n') || '{}');
      } catch {
        /* не JSON */
      }
      return { code, json };
    };
    if (!ca)
      limit(
        'сертификат OpenBao для проверки не найден — обращение без проверки сертификата (петля узла)',
      );
    await waitFor(() => curl('GET', 'sys/health').code > 0, 90, 'OpenBao отвечает');
    const init = curl('PUT', 'sys/init', {
      body: JSON.stringify({ recovery_shares: 1, recovery_threshold: 1 }),
    });
    await waitFor(
      () => curl('GET', 'sys/health').code === 200,
      60,
      'OpenBao открыт после инициализации',
    );
    const snapshot = join(setDir, catalog.openbao.file);
    const r = sh(
      'curl',
      [
        '-sS',
        '-m',
        '300',
        '-X',
        'POST',
        ...(ca ? ['--cacert', ca] : ['-k']),
        '-H',
        `X-Vault-Token: ${init.json.root_token}`,
        '--data-binary',
        `@${snapshot}`,
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        `${addr}/v1/sys/storage/raft/snapshot-force`,
      ],
      { allowFail: true },
    );
    check('снимок OpenBao принят', r.text.trim() === '204', `код ${r.text.trim()}`);
    await waitFor(
      () => curl('GET', 'sys/health').code === 200,
      120,
      'OpenBao открылся ключом из комплекта',
    );
    check('OpenBao открылся сам Static seal key из аварийного комплекта', true);
    state.recoveryKeyPresent = Boolean(recovery);
  });

  // ------------------------------------------------------- 7. база на T
  await stage('База на момент T', async () => {
    const pg = state.services.find((s) => s.role === 'postgres');
    composeCreate(pg.project, [pg.service]);
    const data = pg.volumes.find((v) => /postgresql/.test(v.destination));
    const repo = join(setDir, 'pgbackrest');
    const pgbr = {
      PGBACKREST_STANZA: 'main',
      PGBACKREST_PG1_PATH: '/var/lib/postgresql/data',
      PGBACKREST_REPO1_PATH: '/var/lib/pgbackrest',
      PGBACKREST_REPO1_CIPHER_TYPE: 'aes-256-cbc',
      PGBACKREST_REPO1_CIPHER_PASS: env.BACKUP_PGBACKREST_CIPHER_PASS,
      PGBACKREST_LOG_LEVEL_CONSOLE: 'warn',
    };
    const r = docker(
      [
        'run',
        '--rm',
        '--network',
        'none',
        '-u',
        'root',
        ...Object.keys(pgbr).flatMap((k) => ['-e', k]),
        '-v',
        `${data.name}:/var/lib/postgresql/data`,
        '-v',
        `${repo}:/var/lib/pgbackrest:ro`,
        '--entrypoint',
        'sh',
        pg.tag,
        '-c',
        'chown postgres:postgres /var/lib/postgresql/data && chmod 700 /var/lib/postgresql/data && ' +
          `gosu postgres pgbackrest restore --set=${catalog.db.backup} --type=lsn --target=${catalog.target.lsn} --target-action=promote`,
      ],
      { env: pgbr, allowFail: true },
    );
    check('pgBackRest восстановил копию на LSN T', r.ok, r.err.split('\n').pop());
    compose(pg.project, ['start', pg.service]);
    await waitFor(
      () => psql(pg.container, 'postgres', 'SELECT pg_is_in_recovery()').text.trim() === 'f',
      600,
      'база вышла из восстановления',
    );
    const tx = psql(
      pg.container,
      'postgres',
      `SELECT txid_status(${Number(catalog.target.txid)})`,
    ).text.trim();
    check('транзакция момента T в базе есть', tx === 'committed', tx);
    const db = new URL(env.DATABASE_URL_OWNER || env.DATABASE_URL).pathname.slice(1);
    state.db = db;
    state.pg = pg;
    protocol.data = JSON.parse(
      psql(
        pg.container,
        db,
        `SELECT json_build_object('users',(SELECT count(*) FROM identity.users),'projects',(SELECT count(*) FROM lab.projects),'materials',(SELECT count(*) FROM lab.project_materials))`,
      ).text.trim(),
    );
    // Оповещения Zabbix выключены до запуска его сервера (его база — в этом же кластере).
    const z = psql(
      pg.container,
      'zabbix',
      'UPDATE media_type SET status = 1 WHERE status = 0 RETURNING mediatypeid',
      { allowFail: true },
    );
    if (z.ok)
      hold(
        'оповещения Zabbix',
        `способы оповещения выключены в восстановленной базе (${z.text.trim().split('\n').filter(Boolean).length})`,
      );
    else limit(`база Zabbix не найдена в кластере: ${z.err.split('\n').pop()}`);
  });

  // -------------------------------------------------- 8. Garage и файлы
  await stage('Garage и файлы', async () => {
    const nodes = state.services.filter((s) => s.role === 'garage');
    const agent = state.services.find((s) => s.role === 'openbao-agent');
    if (agent) {
      // Секреты служб (/run/fifth-secrets) выдаёт Agent из восстановленного OpenBao.
      composeCreate(agent.project, [agent.service]);
      compose(agent.project, ['start', agent.service]);
      await waitFor(
        () => existsSync('/run/fifth-secrets') && readdirSync('/run/fifth-secrets').length > 0,
        120,
        'Agent выдал секреты',
      );
      check(
        'OpenBao Agent выдал секреты служб',
        true,
        `${readdirSync('/run/fifth-secrets').length} файлов`,
      );
    }
    for (const n of nodes) composeCreate(n.project, [n.service]);
    for (const n of nodes) compose(n.project, ['start', n.service]);
    // Раскладка, бакеты и ключи — установщиком самой рабочей среды (его версия из комплекта).
    const init = sh(process.execPath, [join(ROOT, 'scripts', 'garage-init.mjs')], {
      cwd: ROOT,
      allowFail: true,
      timeout: 600_000,
    });
    check(
      'Garage настроен установщиком среды (garage-init)',
      init.ok,
      init.err.split('\n').slice(-2).join(' | '),
    );
    const g1 = nodes[0];
    const rc = {
      BACKUP_FILES_CRYPT_PASS: env.BACKUP_FILES_CRYPT_PASS,
      BACKUP_FILES_CRYPT_SALT: env.BACKUP_FILES_CRYPT_SALT,
      RCLONE_CONFIG_SRC_TYPE: 'crypt',
      RCLONE_CONFIG_SRC_REMOTE: '/backup/files',
      RCLONE_CONFIG_SRC_FILENAME_ENCRYPTION: 'standard',
      RCLONE_CONFIG_SRC_DIRECTORY_NAME_ENCRYPTION: 'true',
      RCLONE_CONFIG_DST_TYPE: 's3',
      RCLONE_CONFIG_DST_PROVIDER: 'Other',
      RCLONE_CONFIG_DST_ENDPOINT: 'http://127.0.0.1:3900',
      RCLONE_CONFIG_DST_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID,
      RCLONE_CONFIG_DST_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY,
      RCLONE_CONFIG_DST_REGION: env.S3_REGION || 'garage',
    };
    const lists = join(WORK, 'lists');
    mkdirSync(lists, { recursive: true });
    writeFileSync(
      join(lists, 'restore.tsv'),
      catalog.files.objects.map((o) => `${o.backupPath}\t${o.key}`).join('\n') + '\n',
    );
    const tool = state.services.find((s) => s.role === 'postgres').tag;
    const script = [
      'set -e',
      'export RCLONE_CONFIG_SRC_PASSWORD="$(printf %s "$BACKUP_FILES_CRYPT_PASS" | rclone obscure -)"',
      'export RCLONE_CONFIG_SRC_PASSWORD2="$(printf %s "$BACKUP_FILES_CRYPT_SALT" | rclone obscure -)"',
      `TAB="$(printf '\\t')"; while IFS="$TAB" read -r path key; do rclone copyto "SRC:$path" "DST:${catalog.files.bucket}/$key" --size-only; done < /lists/restore.tsv`,
      `rclone hashsum sha256 --download "DST:${catalog.files.bucket}"`,
    ].join('\n');
    const r = docker(
      [
        'run',
        '--rm',
        '--network',
        `container:${g1.container}`,
        '-v',
        `${join(setDir, 'files')}:/backup/files:ro`,
        '-v',
        `${lists}:/lists:ro`,
        ...Object.keys(rc).flatMap((k) => ['-e', k]),
        '--entrypoint',
        'sh',
        tool,
        '-c',
        script,
      ],
      { env: rc, allowFail: true },
    );
    check('файлы расшифрованы в Garage', r.ok, r.err.split('\n').pop());
    const got = new Map();
    for (const line of r.text.split('\n')) {
      const m = line.match(/^([0-9a-f]{64})\s+(.+)$/);
      if (m) got.set(m[2], m[1]);
    }
    const bad = catalog.files.objects.filter((o) => got.get(o.key) !== o.sha256);
    check(
      `все ${catalog.files.count} файлов на месте, SHA-256 как в каталоге`,
      bad.length === 0,
      bad
        .slice(0, 3)
        .map((o) => o.key)
        .join(', '),
    );
    protocol.files = { count: catalog.files.count, restored: got.size, mismatch: bad.length };
  });

  // ----------------------------------------------- 9. остальные службы
  await stage('Службы: запуск под удержанием', async () => {
    const running = state.services.filter((s) => s.status === 'running');
    const order = ['openbao', 'openbao-agent', 'postgres', 'garage'];
    for (const p of Object.keys(host.projects)) {
      const list = running
        .filter((s) => s.project === p && !order.includes(s.role))
        .map((s) => s.service);
      if (!list.length) continue;
      composeCreate(p, list);
      compose(p, ['start', ...list]);
    }
    const notRunning = state.services.filter((s) => s.status !== 'running');
    for (const s of notRunning)
      limit(
        `служба ${s.project}/${s.service} на исходном узле не работала (${s.status}) — не запускалась`,
      );
    await waitFor(
      () => {
        const st = running.map((s) =>
          docker(['inspect', '-f', '{{.State.Status}}', s.container], {
            allowFail: true,
          }).text.trim(),
        );
        return st.every((x) => x === 'running');
      },
      300,
      'все службы работают',
    );
    check(`службы исходного узла запущены (${running.length})`, true);
    const core = running.find((s) => s.role === 'core');
    state.core = core;
    // Ворота закрыты: людям 503, /v1/ready — не готов.
    const ready = docker(
      [
        'exec',
        core.container,
        'node',
        '-e',
        "fetch('http://127.0.0.1:'+(process.env.CORE_PORT||4300)+'/v1/ready').then(r=>console.log(r.status)).catch(()=>console.log(0))",
      ],
      { allowFail: true },
    ).text.trim();
    check('под удержанием ядро не готово (ворота закрыты)', ready !== '200', `ready ${ready}`);
  });

  // -------------------------------------------------- 10. юниты и Caddy
  await stage('Юниты systemd и Caddy', async () => {
    sh('systemctl', ['daemon-reload']);
    const heldUnit = /pulse|offsite|backup|audit-export|pilot|mail|telegram|deploy|release/;
    const started = [];
    for (const u of host.units) {
      if (u.id === 'caddy.service' || !existsSync(u.fragment ?? '')) continue;
      if (u.unitFileState === 'enabled' && !/\.timer$/.test(u.id))
        sh('systemctl', ['enable', u.id], { allowFail: true });
      if (/\.timer$/.test(u.id)) {
        hold(
          `таймер ${u.id}`,
          `установлен, не запущен (на исходном: ${u.unitFileState}/${u.activeState})`,
        );
        continue;
      }
      if (u.activeState === 'active' && u.type !== 'oneshot') {
        if (heldUnit.test(u.id)) {
          hold(`служба ${u.id}`, 'внешние последствия — не запущена до разрешения работы');
          continue;
        }
        // На площадке WSL службы узла — в её сетевом пространстве без выхода наружу.
        if (process.env.RESTORE_NETNS) {
          const d = `/etc/systemd/system/${u.id}.d`;
          mkdirSync(d, { recursive: true });
          writeFileSync(
            join(d, 'zz-restore-netns.conf'),
            `[Unit]\nRequires=fifth-restore-netns.service\nAfter=fifth-restore-netns.service\n[Service]\nNetworkNamespacePath=/run/netns/${process.env.RESTORE_NETNS}\n`,
          );
          sh('systemctl', ['daemon-reload']);
          hold(
            `служба ${u.id}`,
            `в сетевом пространстве ${process.env.RESTORE_NETNS} (без выхода наружу)`,
          );
        }
        const r = sh('systemctl', ['start', u.id], { allowFail: true });
        check(`служба ${u.id} запущена`, r.ok, r.err);
        started.push(u.id);
      }
    }
    const v = sh(
      'caddy',
      ['validate', '--config', `${host.caddy.config}.restore-hold`, '--adapter', 'caddyfile'],
      { allowFail: true },
    );
    check(
      'Caddyfile восстановлен и проходит проверку Caddy',
      v.ok,
      v.err.split('\n').slice(-2).join(' | '),
    );
    sh('systemctl', ['restart', 'caddy'], { allowFail: true });
    await waitFor(
      () => sh('systemctl', ['is-active', 'caddy'], { allowFail: true }).text.trim() === 'active',
      60,
      'Caddy работает',
    );
    check('Caddy работает', true);
    state.unitsStarted = started;
  });

  // ------------------------------------- 11. сверка и учёт удалений (2.1.5)
  const reconciled = await stage('Сверка и учёт удалений по 2.1.5', () => {
    if (!auditDir || !coverageAck) {
      limit(
        'источник событий 2.1.5 не передан (--audit, --coverage-ack): работа не разрешается, ворота остаются закрытыми',
      );
      return false;
    }
    const core = state.core;
    const url = new URL(env.DATABASE_URL_OWNER);
    url.hostname = '127.0.0.1';
    url.port = '5432';
    const common = [
      '--db',
      url.toString(),
      '--restore-id',
      `restore-${setId}`,
      '--source-export',
      '/audit/series',
      '--checkpoint',
      '/audit/checkpoint.json',
      '--secret-key',
      '/keys/secret.asc',
      '--passphrase-file',
      '/keys/pass.txt',
    ];
    const testExportKey = existsSync(join(resolve(auditDir), 'export-signing.pub'));
    if (testExportKey)
      limit('выгрузка аудита подписана испытательным ключом источника (не ключом рабочей среды)');
    const runApply = (cmd, extra = []) =>
      docker(
        [
          'run',
          '--rm',
          '--network',
          `container:${state.pg.container}`,
          '--user',
          'root',
          // Испытание на искусственном источнике: выгрузка подписана его ключом, не рабочим.
          ...(testExportKey ? ['-e', 'AUDIT_EXPORT_PUBLIC_KEY=/audit/export-signing.pub'] : []),
          '-v',
          `${join(TOOLS, 'scripts')}:/app/rs:ro`,
          '-v',
          `${resolve(auditDir)}:/audit:ro`,
          '-v',
          `${resolve(secretKey)}:/keys/secret.asc:ro`,
          '-v',
          `${resolve(passFile)}:/keys/pass.txt:ro`,
          '-v',
          `${outDir}:/report`,
          '--entrypoint',
          'node',
          core.tag,
          '/app/rs/deletions-apply.mjs',
          cmd,
          ...common,
          ...extra,
        ],
        { allowFail: true, timeout: 3_600_000 },
      );
    const a = runApply('apply', ['--report', '/report/deletions-apply.json']);
    check('учёт удалений применён', a.ok, a.err.split('\n').slice(-2).join(' | '));
    const v = runApply('verify');
    check('учёт удалений проверен', v.ok, v.err.split('\n').slice(-2).join(' | '));
    if (!a.ok || !v.ok) return false;
    const o = runApply('open', ['--coverage-ack', coverageAck]);
    check('ворота открыты после проверки', o.ok, o.err.split('\n').slice(-2).join(' | '));
    return o.ok;
  });

  if (reconciled) {
    await stage('Снятие удержания ядра (почта и выход наружу остаются удержаны)', async () => {
      for (const p of Object.values(host.projects)) {
        const f = join(HOLD_DIR, `${p.name}.yml`);
        const y = JSON.parse(readFileSync(f, 'utf8'));
        for (const s of Object.values(y.services))
          if (s.environment) delete s.environment.CORE_RESTORE_HOLD;
        writeFileSync(f, `${JSON.stringify(y, null, 2)}\n`);
      }
      const cores = state.services.filter((s) => s.role === 'core' && s.status === 'running');
      for (const p of [...new Set(cores.map((c) => c.project))]) {
        compose(p, [
          'up',
          '-d',
          '--no-deps',
          '--pull',
          'never',
          '--no-build',
          ...cores.filter((c) => c.project === p).map((c) => c.service),
        ]);
      }
      hold(
        'после сверки',
        'ворота открыты; почта none, выход наружу закрыт, оповещения Zabbix выключены, таймеры не запущены — до решения о разрешении работы',
      );
    });

    // -------------------------------------------- 12. контрольные операции
    await stage('Контрольные операции через публичный вход', async () => {
      const caRoot = '/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt';
      const r = sh(process.execPath, [join(TOOLS, 'scripts', 'restore-full-checks.mjs')], {
        env: {
          NODE_EXTRA_CA_CERTS: caRoot,
          RESTORE_BASE: env.PUBLIC_BASE_URL,
          RESTORE_CORE_CONTAINER: state.core.container,
          RESTORE_CORE_TAG: state.core.tag,
          RESTORE_PG_CONTAINER: state.pg.container,
          RESTORE_DB: state.db,
          RESTORE_SESSION_COOKIE: env.SESSION_COOKIE_NAME || 'ul_session',
          RESTORE_CSRF_COOKIE: env.CSRF_COOKIE_NAME || 'ul_csrf',
          RESTORE_NATS: JSON.stringify(catalog.config?.natsStreams ?? []),
          RESTORE_SINCE: protocol.marks.restoreStart,
        },
        allowFail: true,
        timeout: 900_000,
      });
      process.stdout.write(r.text);
      const res = JSON.parse(r.text.trim().split('\n').pop());
      for (const c of res.checks) check(c.name, c.ok, c.details);
      if (res.serviceReturn) protocol.marks.serviceReturn = res.serviceReturn;
    });
  }

  // Полное резервирование на одном узле — та же раскладка Garage, но не защита от потери узла.
  limit(
    'возврат полного резервирования не измеряется: площадка — один узел (копии Garage на одном диске), это не защита от потери узла',
  );
} catch (error) {
  failed += 1;
  protocol.error = String(error.message ?? error).slice(0, 800);
  console.error(`\nВОССТАНОВЛЕНИЕ ОСТАНОВЛЕНО: ${protocol.error}`);
} finally {
  env = {};
  protocol.finishedAt = now();
  protocol.failed = failed;
  protocol.passed = protocol.checks.filter((c) => c.ok).length;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'protocol.json'), JSON.stringify(protocol, null, 2));
  writeFileSync(join(outDir, 'protocol.md'), markdown(protocol));
  console.log(`\nпротокол: ${join(outDir, 'protocol.md')}`);
  console.log(`=== ИТОГ: ${protocol.passed} OK, ${failed} FAIL ===`);
  process.exit(failed ? 1 : 0);
}

function markdown(p) {
  const t = (s) => (s ? s.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—');
  const lines = [
    `# Протокол полного восстановления — комплект ${p.set?.id ?? '—'}`,
    '',
    `Момент T комплекта: ${t(p.set?.T)}; код комплекта: ${p.set?.commit ?? '—'}; инструмент: ${p.tool?.commit ?? '—'}.`,
    '',
    '## Отметки (UTC, 2.5)',
    '',
    '| Отметка | Время |',
    '| --- | --- |',
    `| Начало испытания (начало нарушения на стенде) | ${t(p.marks.trialStart)} |`,
    `| Начало восстановления | ${t(p.marks.restoreStart)} |`,
    `| Возврат обслуживания (контрольные операции прошли) | ${t(p.marks.serviceReturn)} |`,
    '| Возврат полного резервирования | не измеряется: один узел |',
    `| Окончание | ${t(p.finishedAt)} |`,
    '',
    '## Площадка',
    '',
    `- Docker: ${p.docker ? `${p.docker.version}, ${p.docker.os}, id ${p.docker.id}` : '—'}`,
    `- ОС и пакеты: ${p.site ? JSON.stringify({ os: p.site.os, packages: p.site.packages }) : '—'}`,
    `- Внешние источники: ${p.site?.sources ? p.site.sources.map((s) => `${s.what}: ${s.url}${s.sha256 ? ` (sha256 ${s.sha256.slice(0, 16)}…)` : ''}`).join('; ') : '—'}`,
    '',
    '## Этапы',
    '',
    '| Этап | Начало | Конец | Итог |',
    '| --- | --- | --- | --- |',
    ...p.stages.map(
      (s) =>
        `| ${s.name} | ${t(s.startedAt)} | ${t(s.finishedAt)} | ${s.ok ? 'да' : `нет: ${s.error ?? ''}`} |`,
    ),
    '',
    '## Удержано',
    '',
    ...p.held.map((h) => `- ${h.what}: ${h.how}`),
    '',
    `## Проверки (${p.passed} OK, ${p.failed} FAIL)`,
    '',
    ...p.checks.map(
      (c) =>
        `- ${c.ok ? 'OK' : '**FAIL**'} ${c.name}${c.details && !c.ok ? ` — ${c.details}` : ''}`,
    ),
    '',
    '## Ограничения',
    '',
    ...(p.limitations.length ? p.limitations.map((l) => `- ${l}`) : ['- нет']),
    ...(p.notes?.length ? ['', '## Заметки', '', ...p.notes.map((n) => `- ${n}`)] : []),
    ...(p.error ? ['', `**Остановлено:** ${p.error}`] : []),
    '',
  ];
  return lines.join('\n');
}
