/**
 * Архив окружения узла (Тэнк 15.11): неизменяемый tar — описание, установочные пакеты критичных
 * компонентов с зависимостями, контрольные суммы и подпись. Комплект выпуска и копия закрепляют
 * его идентификатор и сумму; сам архив хранится в копиях (дедупликация по содержимому) и
 * уезжает на ноутбук обычным `backup pull` — ссылка на файл только на VPS восстановления не даёт.
 *
 * Раскладка `hostenv/<id>/`:
 *   environment.json      описание, по которому собран архив (байт в байт)
 *   debs/*.deb            пакеты и зависимости, которых нет в чистой Ubuntu той же версии
 *   archive.json          опись: id описания, сумма описания, пакеты {file, sha256, package,
 *                         version, arch}, отпечатки ключей источников, образ сборки
 *   archive.json.sig      Ed25519 ключом комплектов, домен `fifth-hostenv-v1` (kit-sign.mjs)
 *
 * Идентификатор архива: `<id описания>.<12 знаков sha256(archive.json)>`; имя файла — он же.
 * Сборка — в чистом контейнере ubuntu той же версии и архитектуры, полное замыкание зависимостей
 * (не полагаясь на состав образа сборки); ключ каждого источника
 * скачивается с адреса поставщика и принимается, только если отпечаток совпал с описанием.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { gapsOf, upstreamOf, validateEnvironment } from './host-env.mjs';
import { hostEnvSignatureValid, signHostEnv } from './kit-sign.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const ID_RE = /^hostenv-[0-9a-z.-]+\.[0-9a-f]{12}$/;

/** Сценарий сборки в контейнере: только пакеты, точные версии, ключи по отпечатку. */
function builderScript(env) {
  const lines = [
    'set -euo pipefail',
    'export DEBIAN_FRONTEND=noninteractive',
    // Полное замыкание зависимостей — относительно ПУСТОГО состояния dpkg: архив не должен
    // полагаться на то, что стоит в образе сборки (15.11: gnupg 17.6 требует gpgv 17.6, а в
    // базовом образе gpgv старше). Площадка ставит из него только недостающее и более старое.
    ': > /tmp/status.base',
    'apt-get update -q >/dev/null',
    'apt-get install -y -q --no-install-recommends ca-certificates curl gnupg >/dev/null',
    'install -d -m 0755 /etc/apt/keyrings',
    'out=/out; mkdir -p $out/debs',
    'echo "{" > $out/keys.json',
  ];
  let first = true;
  for (const s of env.sources.filter((x) => x.name !== 'ubuntu')) {
    const key = `/etc/apt/keyrings/hostenv-${s.name}.gpg`;
    lines.push(
      `curl -1sLf --retry 5 '${s.keyUrl}' | gpg --dearmor > ${key}`,
      `fpr=$(gpg --batch --with-colons --show-keys ${key} | awk -F: '$1=="fpr"{print $10; exit}')`,
      `[ "$fpr" = '${s.keyFingerprint}' ] || { echo "ключ ${s.name}: отпечаток $fpr, в описании ${s.keyFingerprint}" >&2; exit 4; }`,
      `echo 'deb [arch=${env.os.arch} signed-by=${key}] ${s.uri} ${s.suite} ${(s.components ?? ['main']).join(' ')}' > /etc/apt/sources.list.d/hostenv-${s.name}.list`,
      `printf '%s"${s.name}": "%s"' '${first ? '' : ','}' "$fpr" >> $out/keys.json`,
    );
    first = false;
  }
  lines.push('echo "}" >> $out/keys.json', 'apt-get update -q >/dev/null');
  // Пакет Ubuntu (ubuntu-security): точная версия, если архив Ubuntu её ещё держит, иначе
  // кандидат той же версии программы и не старше — то же правило, что у сверки.
  const pick = [];
  for (const c of env.components) {
    for (const [name, version] of Object.entries(c.packages)) {
      if (c.match === 'exact') pick.push(`echo '${name}=${version}'`);
      else
        pick.push(
          `if apt-cache madison ${name} | awk '{print $3}' | grep -qx '${version}'; then echo '${name}=${version}'; ` +
            `else c=$(apt-cache policy ${name} | awk '/Candidate:/{print $2}'); ` +
            `[ "$(echo "$c" | sed -E 's/^[0-9]+://; s/-[^-]*$//')" = '${upstreamOf(version)}' ] && dpkg --compare-versions "$c" ge '${version}' ` +
            `|| { echo "${name}: нет ${version} и подходящей ревизии (кандидат $c)" >&2; exit 5; }; echo "${name}=$c"; fi`,
        );
    }
  }
  lines.push(
    `want=$( { ${pick.join('; ')}; } | tr '\\n' ' ')`,
    'echo "$want" > $out/want.txt',
    // --download-only: пакеты и все зависимости, которых нет в чистом образе.
    'apt-get install -y -q --download-only --no-install-recommends -o Dir::State::status=/tmp/status.base -o Dir::Cache::archives=$out/debs $want >/dev/null',
    'rm -rf $out/debs/partial $out/debs/lock',
    'for f in $out/debs/*.deb; do dpkg-deb -f "$f" Package Version Architecture | paste -sd"\\t" -; done > $out/debs.tsv',
  );
  return lines.join('\n');
}

/**
 * Сборка архива. Описание должно быть без пробелов в сведениях (черновик допустим — архив
 * черновика помечается в archive.json и для выпуска не годится).
 */
export function buildArchive({ envFile, outDir, signKey, docker = 'docker' }) {
  const envBytes = readFileSync(envFile);
  const env = JSON.parse(envBytes);
  const problems = validateEnvironment(env);
  const gaps = gapsOf(env);
  if (problems.length) throw new Error(`описание: ${problems.join('; ')}`);
  if (gaps.length) throw new Error(`в описании неполные сведения: ${gaps.join('; ')}`);
  for (const s of env.sources)
    if (s.name !== 'ubuntu' && !s.keyUrl) throw new Error(`источник ${s.name}: нет keyUrl`);
  const image = `ubuntu:${env.os.versionId}`;
  const platform = `linux/${env.os.arch}`;
  const work = mkdtempSync(join(tmpdir(), 'hostenv-'));
  try {
    const out = join(work, 'out');
    mkdirSync(out);
    writeFileSync(join(work, 'build.sh'), builderScript(env));
    const pull = spawnSync(docker, ['pull', '-q', '--platform', platform, image], {
      encoding: 'utf8',
    });
    if (pull.status !== 0) throw new Error(`образ ${image}: ${pull.stderr.trim()}`);
    const digest = spawnSync(
      docker,
      ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', image],
      { encoding: 'utf8' },
    ).stdout.trim();
    const r = spawnSync(
      docker,
      [
        'run',
        '--rm',
        '--platform',
        platform,
        '-v',
        `${work}:/w`,
        '-v',
        `${out}:/out`,
        image,
        'bash',
        '/w/build.sh',
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (r.status !== 0)
      throw new Error(`сборка архива: ${(r.stderr || r.stdout).trim().slice(-800)}`);

    const keys = JSON.parse(readFileSync(join(out, 'keys.json'), 'utf8'));
    const meta = readFileSync(join(out, 'debs.tsv'), 'utf8').trim().split('\n');
    const files = readdirSync(join(out, 'debs'))
      .filter((f) => f.endsWith('.deb'))
      .sort();
    const packages = files.map((file, i) => {
      const [pkg, version, arch] = meta[i].split('\t');
      return {
        file,
        sha256: sha256(readFileSync(join(out, 'debs', file))),
        package: pkg,
        version,
        arch,
      };
    });
    const archive = {
      format: 1,
      envId: env.id,
      envStatus: env.status,
      envSha256: sha256(envBytes),
      createdAt: new Date().toISOString(),
      builder: { image: digest || image, platform },
      requested: readFileSync(join(out, 'want.txt'), 'utf8').trim().split(/\s+/),
      keys,
      packages,
    };
    const archiveBytes = Buffer.from(`${JSON.stringify(archive, null, 2)}\n`);
    const id = `${env.id}.${sha256(archiveBytes).slice(0, 12)}`;
    const root = join(work, 'hostenv', id);
    mkdirSync(join(root, 'debs'), { recursive: true });
    for (const f of files) writeFileSync(join(root, 'debs', f), readFileSync(join(out, 'debs', f)));
    writeFileSync(join(root, 'environment.json'), envBytes);
    writeFileSync(join(root, 'archive.json'), archiveBytes);
    if (signKey)
      writeFileSync(join(root, 'archive.json.sig'), `${signHostEnv(archiveBytes, signKey)}\n`);
    mkdirSync(outDir, { recursive: true });
    const tarFile = join(outDir, `${id}.tar`);
    if (existsSync(tarFile)) throw new Error(`${tarFile} уже есть — архив неизменяем`);
    // Детерминированный tar: порядок имён, нулевые владельцы и время.
    const t = spawnSync(
      'tar',
      [
        '--sort=name',
        '--owner=0',
        '--group=0',
        '--numeric-owner',
        '--mtime=@0',
        '-cf',
        `${id}.tar`,
        '-C',
        work,
        `hostenv/${id}`,
      ],
      { encoding: 'utf8', cwd: outDir },
    );
    if (t.status !== 0) throw new Error(`tar: ${t.stderr.trim()}`);
    return {
      id,
      file: tarFile,
      sha256: sha256(readFileSync(tarFile)),
      signed: Boolean(signKey),
      packages: packages.length,
      requested: archive.requested,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Проверка архива: имя = идентификатор, суммы пакетов и описания, подпись. Без открытого ключа
 * подпись — «не проверено» (ok: false): происхождение не подтверждено.
 */
export function verifyArchive(tarFile, { publicPem = null, expectSha256 = null } = {}) {
  const checks = [];
  const check = (name, ok, details = '') => checks.push({ name, ok: Boolean(ok), details });
  const work = mkdtempSync(join(tmpdir(), 'hostenv-v-'));
  try {
    const tarBytes = readFileSync(tarFile);
    if (expectSha256)
      check('сумма архива как закреплено', sha256(tarBytes) === expectSha256, sha256(tarBytes));
    const x = spawnSync('tar', ['-xf', basename(tarFile), '-C', work], {
      encoding: 'utf8',
      cwd: dirname(tarFile),
    });
    if (!check('архив распакован', x.status === 0, x.stderr?.trim())) return { ok: false, checks };
    const ids = existsSync(join(work, 'hostenv')) ? readdirSync(join(work, 'hostenv')) : [];
    if (
      !check(
        'в архиве один каталог hostenv/<id>',
        ids.length === 1 && ID_RE.test(ids[0]),
        ids.join(','),
      )
    )
      return { ok: false, checks };
    const id = ids[0];
    const root = join(work, 'hostenv', id);
    const archiveBytes = readFileSync(join(root, 'archive.json'));
    const archive = JSON.parse(archiveBytes);
    check(
      'идентификатор = описание + сумма archive.json',
      id === `${archive.envId}.${sha256(archiveBytes).slice(0, 12)}`,
      id,
    );
    check(
      'описание как при сборке',
      sha256(readFileSync(join(root, 'environment.json'))) === archive.envSha256,
    );
    const bad = archive.packages.filter((p) => {
      const f = join(root, 'debs', p.file);
      return !existsSync(f) || sha256(readFileSync(f)) !== p.sha256;
    });
    const extra = readdirSync(join(root, 'debs')).filter(
      (f) => !archive.packages.some((p) => p.file === f),
    );
    check(
      `пакеты: ${archive.packages.length}, суммы сошлись`,
      !bad.length && !extra.length,
      [...bad.map((p) => p.file), ...extra].join(', '),
    );
    const sigFile = join(root, 'archive.json.sig');
    if (!existsSync(sigFile)) check('подпись архива', false, 'подписи нет');
    else if (!publicPem) check('подпись архива', false, 'не проверено: нет открытого ключа');
    else
      check(
        'подпись архива (ключ комплектов, домен fifth-hostenv-v1)',
        hostEnvSignatureValid(archiveBytes, readFileSync(sigFile, 'utf8'), publicPem),
        'подпись не подтверждена',
      );
    return { ok: checks.every((c) => c.ok), checks, id, archive, root: null };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Архивы окружения, закреплённые комплектами среды (pins/*.json → kit.json → hostEnv): копия
 * сохраняет каждый из них (Тэнк 15.11). Комплекты без поля — до архива окружения, пропускаются.
 */
export function pinnedHostEnvs(kitsDir) {
  const out = new Map();
  const pins = join(kitsDir, 'pins');
  if (!existsSync(pins)) return [];
  for (const f of readdirSync(pins)) {
    const p = JSON.parse(readFileSync(join(pins, f), 'utf8'));
    for (const build of Object.values(p).flat()) {
      const file = build && join(kitsDir, build, 'kit.json');
      if (!file || !existsSync(file)) continue;
      const h = JSON.parse(readFileSync(file, 'utf8')).hostEnv;
      if (!h) continue;
      const e = out.get(h.id) ?? { id: h.id, sha256: h.sha256, builds: [] };
      if (e.sha256 !== h.sha256) throw new Error(`архив ${h.id}: разные суммы в комплектах`);
      e.builds.push(build);
      out.set(h.id, e);
    }
  }
  return [...out.values()];
}
