/**
 * Действующая конфигурация узла для полного восстановления (работа № 5 раздела 01).
 *
 * Комплект копий берёт не файлы репозитория и не список `fifth-*`, а то, с чем узел работает
 * сейчас (условия Тэнка 12.11):
 *   * Compose — файлы, переменные и проекты по меткам запущенных контейнеров, примонтированные
 *     с узла файлы и каталоги;
 *   * юниты systemd — файл, drop-in и EnvironmentFile каждого локально установленного юнита,
 *     состояние включения и работы;
 *   * Caddy — файл из `ExecStart` службы и всё, что он импортирует;
 *   * всё, на что эти файлы ссылаются абсолютным или относительным путём (замыкание);
 *   * образы — по идентификатору каждого контейнера (сохраняет `backup.mjs set`);
 *   * код — отслеживаемые файлы серверной копии в их нынешнем виде;
 *   * пакеты и ОС узла, владельцы файлов — для протокола и площадки восстановления.
 *
 * Секретное (по пути или по содержимому) уходит только в зашифрованную часть: архив tar,
 * зашифрованный на ключ Томаса. Открытая часть — несекретные файлы и опись.
 *
 * Разбор (Caddy, systemd, пути, классы файлов) — чистые функции: их проверяет
 * `scripts/check-host-config.mjs` без узла.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, posix, resolve } from 'node:path';

/** Где на узле может лежать конфигурация; ссылки за эти пределы не берутся. */
export const CONFIG_ROOTS = ['/etc/', '/opt/', '/usr/local/', '/srv/', '/var/lib/fifth'];

/** Секретные места: только в зашифрованную часть. */
const SECRET_PATH = [
  /^\/etc\/fifth-openbao\//,
  /^\/etc\/fifth-tls\//,
  /^\/etc\/fifth-secrets?\//,
  /\/\.local\/secrets(\/|$)/,
  /\/\.local\/envs\/[^/]+\/secrets(\/|$)/,
  /\/secrets\//,
  /(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/,
  /(^|\/)[^/]*\.env$/,
  /\.(key|p12|pfx|jks|kdbx|gpg|asc)$/,
  /(^|\/)(id_rsa|id_ed25519|id_ecdsa)[^/]*$/,
  /\/approle\//,
  /(^|\/)(token|secret-id|role-id)$/,
];

/**
 * Хранится отдельно от комплекта намеренно: Static seal key OpenBao лежит в аварийном комплекте
 * Томаса, а не рядом со снимком (без верного ключа снимок не читается — в этом и защита);
 * `auto` — значения установки OpenBao, живут только до конца её шага.
 */
const SEPARATE_PATH = [/^\/etc\/fifth-openbao\/seal(\/|$)/, /^\/etc\/fifth-openbao\/auto(\/|$)/];

/** Состояние, которое восстанавливается не как конфигурация. */
const RUNTIME_PATH = [/^\/run\//, /^\/var\/run\//, /^\/proc\//, /^\/sys\//, /^\/dev\//, /^\/tmp\//];
const DATA_PATH = [
  /^\/var\/lib\/docker\//,
  /^\/var\/backups\//,
  /\/\.local\/backup[^/]*(\/|$)/,
  /\/\.local\/kits(\/|$)/,
  /\/\.local\/monitor-state(\/|$)/,
  /^\/var\/lib\/caddy\//,
  /^\/var\/log\//,
];

/** Предел одного каталога и одного файла открытой части. */
export const LIMITS = { dirFiles: 2000, dirBytes: 64 * 1024 * 1024, textBytes: 2 * 1024 * 1024 };

/**
 * Класс пути: `secret` — зашифрованная часть; `runtime` — создаётся службами при запуске;
 * `data` — данные, восстанавливаются своим путём (база, файлы, снимки) или не нужны;
 * `config` — открытая часть.
 */
export function classifyPath(p) {
  const path = normalize(p).replace(/\\/g, '/');
  if (SEPARATE_PATH.some((r) => r.test(path))) return 'separate';
  if (RUNTIME_PATH.some((r) => r.test(path))) return 'runtime';
  if (DATA_PATH.some((r) => r.test(path))) return 'data';
  if (SECRET_PATH.some((r) => r.test(path))) return 'secret';
  return 'config';
}

const SECRET_NAME = /(PASS|SECRET|KEY|TOKEN|KEK|PRIVATE|SALT|CREDENTIAL|SIGNING|DSN)/i;
const PLACEHOLDER = /^(|<.*>|\$\{.*\}|\$[A-Z_]+|changeme|example|none|null|false|true|\*+)$/i;

/**
 * Похоже ли содержимое на секрет: закрытый ключ, `ИМЯ=значение` с секретным именем и
 * настоящим значением, адрес с паролем. Открытая часть с таким файлом не собирается.
 */
export function looksSecret(text) {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return true;
  if (/\b[a-z][a-z0-9+.-]*:\/\/[^/@\s:]+:[^/@\s]+@/i.test(text)) return true;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*?)\s*$/);
    if (!m || !SECRET_NAME.test(m[1])) continue;
    if (/_(FILE|PATH|DIR|ID|NAME|MODE|URL_FILE)$/i.test(m[1])) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (!PLACEHOLDER.test(value) && !value.startsWith('/') && value.length >= 8) return true;
  }
  return false;
}

/** Абсолютные пути в тексте конфигурации, только из мест, где бывает конфигурация. */
export function absPathsIn(text) {
  const out = new Set();
  for (const m of text.matchAll(
    /(?<![\w.:/-])(\/(?:etc|opt|usr\/local|srv|var\/lib\/fifth)[\w./@+-]*)/g,
  )) {
    const p = m[1].replace(/[.,;:)]+$/, '');
    if (p.length > 5 && !p.includes('//')) out.add(posix.normalize(p));
  }
  return [...out];
}

/** Относительные пути (`./x`, `../x`) в файле Compose или Caddy — от его каталога. */
export function relPathsIn(text, dir) {
  const out = new Set();
  for (const m of text.matchAll(/(?<![\w/])(\.\.?\/[\w./@+-]+)/g)) {
    out.add(posix.normalize(posix.join(dir, m[1].replace(/[.,;:)]+$/, ''))));
  }
  return [...out];
}

/**
 * Импорты Caddyfile: `import <файл|шаблон> [аргументы]`. Имя фрагмента `(snippet)` — не файл:
 * файл отличает путь или шаблон. Относительный путь — от каталога Caddyfile.
 */
export function caddyImports(text, dir) {
  const snippets = new Set([...text.matchAll(/^\s*\(([^)\s]+)\)\s*\{/gm)].map((m) => m[1]));
  const out = [];
  for (const m of text.matchAll(/^\s*import\s+(\S+)/gm)) {
    const arg = m[1];
    if (snippets.has(arg)) continue;
    if (!/[/*]/.test(arg) && !/\.(caddy|conf|caddyfile)$/i.test(arg)) continue;
    out.push(arg.startsWith('/') ? posix.normalize(arg) : posix.normalize(posix.join(dir, arg)));
  }
  return out;
}

/** Путь файла настроек Caddy из ExecStart его службы; по умолчанию — /etc/caddy/Caddyfile. */
export function caddyConfigPath(execStart) {
  const m = String(execStart ?? '').match(/--config[= ]([^\s;]+)/);
  return m ? m[1] : '/etc/caddy/Caddyfile';
}

/** Адреса сайтов Caddyfile (для подмены имён на площадке восстановления). */
export function caddySiteNames(text) {
  const names = new Set();
  let depth = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (depth === 0 && line.endsWith('{') && !line.startsWith('(') && line !== '{') {
      for (const part of line.slice(0, -1).split(/[\s,]+/)) {
        const host = part.replace(/^[a-z]+:\/\//, '').replace(/[:/].*$/, '');
        if (/^[a-z0-9*][a-z0-9.*-]*\.[a-z]{2,}$/i.test(host) && !host.startsWith('*'))
          names.add(host);
      }
    }
    depth += (raw.match(/\{/g) ?? []).length - (raw.match(/\}/g) ?? []).length;
  }
  return [...names].sort();
}

/**
 * Разбор `systemctl show -p … <юниты>`: блоки через пустую строку. EnvironmentFiles —
 * «путь (ignore_errors=…)», DropInPaths — через пробел.
 */
export function parseSystemdShow(text) {
  const units = [];
  for (const block of text.split(/\n\s*\n/)) {
    const u = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) u[line.slice(0, i)] = line.slice(i + 1);
    }
    if (!u.Id) continue;
    units.push({
      id: u.Id,
      fragment: u.FragmentPath || null,
      dropIns: (u.DropInPaths || '').split(/\s+/).filter(Boolean),
      environmentFiles: (u.EnvironmentFiles || '')
        .split(/\s*\n\s*|(?<=\))\s+/)
        .map((s) => s.replace(/\s*\(ignore_errors=\w+\)\s*$/, '').trim())
        .filter(Boolean),
      unitFileState: u.UnitFileState || null,
      activeState: u.ActiveState || null,
      user: u.User || null,
      execStart: u.ExecStart || null,
      type: u.Type || null,
    });
  }
  return units;
}

/** Юнит относится к узлу 5Э: установлен локально (/etc) или имеет локальный drop-in. */
export function isLocalUnit(u) {
  if (u.fragment?.startsWith('/etc/systemd/system/')) return true;
  return u.dropIns.some((d) => d.startsWith('/etc/systemd/'));
}

/** Проекты Compose по описанию контейнеров (`docker inspect`). */
export function composeProjects(containers) {
  const projects = {};
  for (const c of containers) {
    const l = c.Config?.Labels ?? {};
    const name = l['com.docker.compose.project'];
    if (!name || l['com.docker.compose.oneoff'] === 'True') continue;
    const p = (projects[name] ??= {
      name,
      workingDir: l['com.docker.compose.project.working_dir'] ?? null,
      configFiles: [],
      envFiles: [],
      services: {},
    });
    for (const f of (l['com.docker.compose.project.config_files'] ?? '').split(',')) {
      if (f && !p.configFiles.includes(f)) p.configFiles.push(f);
    }
    for (const f of (l['com.docker.compose.project.environment_file'] ?? '').split(',')) {
      if (f && !p.envFiles.includes(f)) p.envFiles.push(f);
    }
    const service = l['com.docker.compose.service'];
    p.services[service] = {
      container: c.Name.replace(/^\//, ''),
      image: c.Config?.Image ?? null,
      imageId: c.Image,
      status: c.State?.Status ?? null,
      profiles: null,
      binds: (c.Mounts ?? []).filter((m) => m.Type === 'bind').map((m) => m.Source),
      volumes: (c.Mounts ?? [])
        .filter((m) => m.Type === 'volume')
        .map((m) => ({ name: m.Name, destination: m.Destination })),
    };
  }
  return projects;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function isText(buf) {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '').trim() };
}

/**
 * Съём конфигурации узла. Выполняется на узле под root (задание копий). Пишет открытые файлы в
 * `<outDir>/files/<путь>`, опись — `<outDir>/host.json`; список секретных путей возвращает —
 * их архив шифрует вызывающий. Ничего на узле не меняет.
 */
export function captureHost({ root, outDir }) {
  mkdirSync(join(outDir, 'files'), { recursive: true });
  const notes = [];
  const entries = new Map(); // путь → запись описи
  const secretPaths = new Set();
  const queue = [];
  const seen = new Set();
  const want = (p, why) => {
    if (!p || !isAbsolute(p)) return;
    const path = posix.normalize(p);
    if (seen.has(path)) return;
    seen.add(path);
    queue.push({ path, why });
  };

  // --- отслеживаемые файлы серверной копии: их несёт архив кода.
  const tracked = new Set();
  const git = run('git', ['-C', root, 'ls-files', '-z']);
  if (git.ok) for (const f of git.out.split('\0').filter(Boolean)) tracked.add(join(root, f));
  const modified = new Set();
  const status = run('git', ['-C', root, 'status', '--porcelain', '-z', '--untracked-files=no']);
  if (status.ok) {
    for (const rec of status.out.split('\0').filter(Boolean))
      modified.add(join(root, rec.slice(3)));
  }

  // --- Compose: по меткам контейнеров.
  const ids = run('docker', ['ps', '-aq']).out.split('\n').filter(Boolean);
  const containers = ids.length ? JSON.parse(run('docker', ['inspect', ...ids]).out || '[]') : [];
  const projects = composeProjects(containers);
  for (const p of Object.values(projects)) {
    for (const f of p.configFiles) want(f, `compose ${p.name}`);
    for (const f of p.envFiles) want(f, `compose ${p.name}: переменные`);
    for (const s of Object.values(p.services))
      for (const b of s.binds) want(b, `монтирование ${s.container}`);
  }
  const images = {};
  for (const c of containers) {
    const id = c.Image;
    const img = (images[id] ??= { id, tags: [], containers: [] });
    img.containers.push({ name: c.Name.replace(/^\//, ''), ref: c.Config?.Image ?? null });
  }
  for (const img of Object.values(images)) {
    const r = run('docker', [
      'image',
      'inspect',
      img.id,
      '--format',
      '{{json .RepoTags}}|{{json .RepoDigests}}|{{.Size}}',
    ]);
    if (r.ok) {
      const [tags, digests, size] = r.out.trim().split('|');
      img.tags = JSON.parse(tags || '[]') ?? [];
      img.digests = JSON.parse(digests || '[]') ?? [];
      img.size = Number(size);
    }
  }

  // --- systemd: все юниты, оставляем установленные на этом узле.
  let units = [];
  const files = run('systemctl', ['list-unit-files', '--no-legend', '--no-pager', '--plain']);
  if (files.ok) {
    const names = files.out
      .split('\n')
      .map((l) => l.split(/\s+/)[0])
      .filter((n) => /\.(service|timer|path|socket|mount)$/.test(n ?? '') && !n.includes('@.'));
    const instances = run('systemctl', [
      'list-units',
      '--all',
      '--no-legend',
      '--no-pager',
      '--plain',
    ])
      .out.split('\n')
      .map((l) => l.split(/\s+/)[0])
      .filter((n) => /@.+\.(service|timer)$/.test(n ?? ''));
    const all = [...new Set([...names, ...instances])];
    for (let i = 0; i < all.length; i += 200) {
      const r = run('systemctl', [
        'show',
        '-p',
        'Id,FragmentPath,DropInPaths,EnvironmentFiles,UnitFileState,ActiveState,User,ExecStart,Type',
        '--',
        ...all.slice(i, i + 200),
      ]);
      units.push(...parseSystemdShow(r.out));
    }
    units = units.filter(isLocalUnit);
    for (const u of units) {
      want(u.fragment, `юнит ${u.id}`);
      for (const d of u.dropIns) want(d, `drop-in ${u.id}`);
      for (const e of u.environmentFiles) want(e.replace(/^-/, ''), `EnvironmentFile ${u.id}`);
    }
  } else notes.push(`systemd недоступен: ${files.err}`);

  // --- Caddy: файл из ExecStart службы.
  const caddyUnit = units.find((u) => u.id === 'caddy.service');
  const caddyExec =
    caddyUnit?.execStart ?? run('systemctl', ['show', '-p', 'ExecStart', 'caddy.service']).out;
  const caddyFile = caddyConfigPath(caddyExec);
  const caddy = { config: caddyFile, imports: [], sites: [] };
  if (existsSync(caddyFile)) want(caddyFile, 'Caddy');

  // --- прочие места настроек узла.
  for (const p of [
    '/etc/docker/daemon.json',
    '/etc/apt/sources.list',
    '/etc/apt/sources.list.d',
    '/etc/apt/keyrings',
    '/etc/sysctl.d',
    '/etc/tmpfiles.d',
    '/etc/logrotate.d',
    '/etc/cron.d',
    '/etc/ufw',
    '/etc/fail2ban/jail.d',
    '/etc/fifth-openbao',
    '/etc/fifth-tls',
  ]) {
    if (existsSync(p)) want(p, 'настройки узла');
  }
  for (const dir of ['/usr/local/sbin', '/usr/local/bin']) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir))
      if (/^fifth-/.test(f)) want(join(dir, f), 'служебная команда');
  }

  // --- замыкание: каждый взятый текстовый файл может ссылаться на другие.
  const skipped = [];
  while (queue.length) {
    const { path, why } = queue.shift();
    const kind = classifyPath(path);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      if (kind === 'config' || kind === 'secret') {
        skipped.push({ path, why, reason: 'нет на узле', kind: 'missing' });
        continue;
      }
    }
    if (kind === 'runtime' || kind === 'data' || kind === 'separate') {
      skipped.push({
        path,
        why,
        reason: {
          runtime: 'создаётся службой при запуске',
          data: 'данные: восстанавливаются своим путём',
          separate: 'хранится отдельно: аварийный комплект Томаса',
        }[kind],
        kind,
      });
      continue;
    }
    if (st.isSymbolicLink()) {
      entries.set(path, {
        path,
        type: 'link',
        target: readlinkSync(path),
        why,
        uid: st.uid,
        gid: st.gid,
      });
      const target = resolve(dirname(path), readlinkSync(path));
      if (CONFIG_ROOTS.some((r) => target.startsWith(r))) want(target, `цель ссылки ${path}`);
      continue;
    }
    if (st.isDirectory()) {
      if (path === root) {
        skipped.push({ path, why, reason: 'код: архив серверной копии' });
        continue;
      }
      let count = 0;
      let bytes = 0;
      const walk = (d) => {
        for (const name of readdirSync(d)) {
          const full = join(d, name);
          const s = lstatSync(full);
          if (s.isDirectory()) walk(full);
          else {
            count += 1;
            bytes += s.size;
          }
        }
      };
      try {
        walk(path);
      } catch (e) {
        skipped.push({ path, why, reason: `каталог не прочитан: ${e.message}` });
        continue;
      }
      if (count > LIMITS.dirFiles || bytes > LIMITS.dirBytes) {
        skipped.push({ path, why, reason: `каталог велик (${count} файлов, ${bytes} байт)` });
        continue;
      }
      entries.set(path, {
        path,
        type: 'dir',
        mode: st.mode & 0o7777,
        uid: st.uid,
        gid: st.gid,
        why,
      });
      for (const name of readdirSync(path)) want(join(path, name), why);
      continue;
    }
    if (!st.isFile()) {
      skipped.push({ path, why, reason: 'не файл' });
      continue;
    }
    // Отслеживаемый и не изменённый файл копии — в архиве кода.
    if (tracked.has(path) && !modified.has(path)) {
      entries.set(path, { path, type: 'code', why });
      scanRefs(path, readFileSync(path));
      continue;
    }
    const buf = readFileSync(path);
    const text = isText(buf) && buf.length <= LIMITS.textBytes;
    const secret = kind === 'secret' || !text || looksSecret(buf.toString('utf8'));
    const entry = {
      path,
      type: 'file',
      mode: st.mode & 0o7777,
      uid: st.uid,
      gid: st.gid,
      size: st.size,
      secret,
      why,
    };
    if (secret) secretPaths.add(path);
    else {
      entry.sha256 = sha256(buf);
      const target = join(outDir, 'files', path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buf);
    }
    entries.set(path, entry);
    if (text) scanRefs(path, buf);
  }

  function scanRefs(path, buf) {
    if (!isText(buf) || buf.length > LIMITS.textBytes) return;
    const text = buf.toString('utf8');
    const dir = dirname(path);
    // В Compose абсолютные пути — по большей части пути внутри контейнера; пути узла из него
    // берутся по монтированиям запущенных контейнеров (выше), здесь — только относительные.
    if (!/\.ya?ml$/.test(path)) {
      for (const p of absPathsIn(text))
        if (CONFIG_ROOTS.some((r) => p.startsWith(r))) want(p, `ссылка из ${path}`);
    }
    if (/\.(ya?ml|caddy|conf)$|Caddyfile/.test(path)) {
      for (const p of relPathsIn(text, dir)) want(p, `ссылка из ${path}`);
    }
    if (path === caddyFile || caddy.imports.includes(path) || /\.caddy$/.test(path)) {
      for (const imp of caddyImports(text, dir)) {
        const matches = imp.includes('*') ? globFiles(imp) : [imp];
        for (const m of matches) {
          if (!caddy.imports.includes(m)) caddy.imports.push(m);
          want(m, `import Caddy из ${path}`);
        }
      }
      caddy.sites.push(...caddySiteNames(text));
    }
  }
  caddy.sites = [...new Set(caddy.sites)].sort();

  // --- владельцы: учётные записи, которых может не быть на чистом узле.
  const ids2 = new Set();
  for (const e of entries.values()) if (e.uid !== undefined) ids2.add(`${e.uid}:${e.gid}`);
  const users = [];
  const groups = [];
  for (const pair of ids2) {
    const [uid, gid] = pair.split(':');
    const pw = run('getent', ['passwd', uid]).out.trim();
    if (pw && !users.some((u) => u.uid === Number(uid))) {
      const [name, , , g, , home, shell] = pw.split(':');
      users.push({ name, uid: Number(uid), gid: Number(g), home, shell });
    }
    const gr = run('getent', ['group', gid]).out.trim();
    if (gr && !groups.some((g) => g.gid === Number(gid)))
      groups.push({ name: gr.split(':')[0], gid: Number(gid) });
  }
  for (const u of units) {
    if (u.user && !users.some((x) => x.name === u.user)) {
      const pw = run('getent', ['passwd', u.user]).out.trim();
      if (pw) {
        const [name, , uid, g, , home, shell] = pw.split(':');
        users.push({ name, uid: Number(uid), gid: Number(g), home, shell });
      }
    }
  }

  // --- ОС и пакеты — для протокола и подготовки чистого узла.
  const osRelease = existsSync('/etc/os-release') ? readFileSync('/etc/os-release', 'utf8') : '';
  const pkgs = run('dpkg-query', [
    '-W',
    '-f',
    '${Package}\t${Version}\n',
    'docker-ce',
    'docker.io',
    'docker-compose-plugin',
    'docker-compose-v2',
    'containerd.io',
    'caddy',
    'nodejs',
    'gnupg',
    'git',
    'rclone',
    'zabbix-agent2',
    'openssh-server',
  ]);
  const packages = {};
  for (const line of pkgs.out.split('\n')) {
    const [name, version] = line.split('\t');
    if (name && version) packages[name] = version;
  }
  const host = {
    format: 1,
    capturedAt: new Date().toISOString(),
    root,
    os: Object.fromEntries(
      osRelease
        .split('\n')
        .map((l) => l.match(/^([A-Z_]+)="?(.*?)"?$/))
        .filter(Boolean)
        .map((m) => [m[1], m[2]])
        .filter(([k]) => ['ID', 'VERSION_ID', 'PRETTY_NAME'].includes(k)),
    ),
    kernel: run('uname', ['-r']).out.trim(),
    versions: {
      docker: run('docker', ['version', '--format', '{{.Server.Version}}']).out.trim() || null,
      compose: run('docker', ['compose', 'version', '--short']).out.trim() || null,
      caddy: run('caddy', ['version']).out.trim().split(' ')[0] || null,
      node: process.version,
    },
    packages,
    users,
    groups,
    projects,
    units: units.map((u) => ({
      id: u.id,
      fragment: u.fragment,
      dropIns: u.dropIns,
      environmentFiles: u.environmentFiles,
      unitFileState: u.unitFileState,
      activeState: u.activeState,
      type: u.type,
    })),
    caddy,
    images: Object.values(images),
    entries: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)),
    skipped,
    notes,
  };
  writeFileSync(join(outDir, 'host.json'), JSON.stringify(host, null, 2));
  return { host, secretPaths: [...secretPaths].sort() };
}

function globFiles(pattern) {
  const dir = posix.dirname(pattern);
  const re = new RegExp(
    `^${posix
      .basename(pattern)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')}$`,
  );
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => re.test(f))
    .map((f) => posix.join(dir, f));
}

/**
 * Архив кода серверной копии: отслеживаемые файлы в нынешнем виде, без времени и владельцев,
 * в постоянном порядке — одинаковое содержимое даёт одинаковый архив (хранится один раз).
 */
export function codeArchive(root, target) {
  const list = run('git', ['-C', root, 'ls-files', '-z']);
  if (!list.ok) throw new Error(`git ls-files: ${list.err}`);
  const names = list.out
    .split('\0')
    .filter(Boolean)
    .filter((f) => existsSync(join(root, f)))
    .sort();
  const r = spawnSync(
    'sh',
    [
      '-c',
      'tar --null -T - --no-recursion --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner ' +
        '--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime -cf - | gzip -n -9',
    ],
    { cwd: root, input: `${names.join('\0')}\0`, maxBuffer: 1024 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(`архив кода: ${String(r.stderr).trim()}`);
  writeFileSync(target, r.stdout);
  return { files: names.length, sha256: sha256(r.stdout), size: r.stdout.length };
}
