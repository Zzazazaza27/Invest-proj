#!/usr/bin/env node
/**
 * Опись компонентов и отчёт лицензий сборки (блок 11; условия Тэнка 09.11).
 *
 *   node scripts/sbom.mjs --out <каталог> [--commit <sha>]
 *
 * Источник — package-lock.json, без установки пакетов: ровно то дерево, которое ставит
 * `npm ci` при сборке образов. `npm sbom` не годится: он отказывает на записях удалённых
 * приложений, которые ещё лежат в lock-файле, — они показаны здесь отдельным видом.
 *
 * Виды npm-пакетов (по достижимости от объявленных зависимостей):
 *   shipped — поставляемые: зависимости рабочих пакетов (dependencies, optional, peer);
 *             попадают в образ ядра (node_modules после prune) или в собранную статику;
 *   build   — средства сборки: devDependencies рабочих пакетов (vite, typescript…);
 *   local   — локальные инструменты: devDependencies корня (линтеры, тесты, браузер прогонов);
 *   orphan  — есть в lock-файле, но ни от чего не достижимы (остатки удалённых приложений).
 *
 * Опись построена по lock-файлу и достижимости, а не снята с образов: фактический состав
 * node_modules образа ядра и бандлов статики ею полностью не подтверждён.
 *
 * Образы описаны списком ссылок с закреплением. Это НЕ опись пакетов внутри образов:
 * системные пакеты базовых образов (Debian, Alpine) и содержимое сторонних образов здесь
 * не перечислены — охват указан в images.json и в отчёте.
 *
 * Отчёт лицензий — перечень для разбора, а не запрет: скрипт ничего не объявляет
 * недопустимым и ничего не заменяет. Отдельно видны неизвестные, составные выражения и
 * обязательства сохранять уведомления.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const OUT = arg('--out');
if (!OUT) {
  console.error('нужен --out <каталог>');
  process.exit(2);
}
const COMMIT = arg('--commit') ?? null;

const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
const pkgs = lock.packages;
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** Рабочие пакеты, существующие сейчас (записи удалённых приложений в lock не считаются). */
const workspaces = Object.keys(pkgs).filter(
  (k) => k && !k.includes('node_modules') && existsSync(join(ROOT, k, 'package.json')),
);

/** Разрешение имени так же, как Node: вверх по каталогам node_modules. */
function resolveDep(from, name) {
  let base = from;
  for (;;) {
    const cand = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (pkgs[cand]) return cand;
    if (!base) return null;
    const cut = base.lastIndexOf('/node_modules/');
    if (cut >= 0) base = base.slice(0, cut);
    else if (base.startsWith('node_modules/')) base = '';
    else base = ''; // рабочий пакет: дальше только корневой node_modules
  }
}
const follow = (path) => (pkgs[path]?.link ? pkgs[path].resolved : path);

function walk(starts, mark, scope) {
  const stack = [...starts];
  while (stack.length) {
    const [from, name] = stack.pop();
    const hit = resolveDep(from, name);
    if (!hit) continue;
    const path = follow(hit);
    if (mark.has(path)) continue;
    mark.set(path, scope);
    const e = pkgs[path] ?? {};
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const d of Object.keys(e[field] ?? {})) {
        if (field === 'peerDependencies' && e.peerDependenciesMeta?.[d]?.optional) {
          if (!resolveDep(path, d)) continue;
        }
        stack.push([path, d]);
      }
    }
  }
}

const scopeOf = new Map();
const prodStarts = [];
const buildStarts = [];
for (const ws of ['', ...workspaces]) {
  const e = ws ? pkgs[ws] : rootPkg;
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const d of Object.keys(e[field] ?? {})) prodStarts.push([ws, d]);
  }
  if (ws) for (const d of Object.keys(e.devDependencies ?? {})) buildStarts.push([ws, d]);
}
walk(prodStarts, scopeOf, 'shipped');
walk(buildStarts, scopeOf, 'build');
walk(
  Object.keys(rootPkg.devDependencies ?? {}).map((d) => ['', d]),
  scopeOf,
  'local',
);

const nameOf = (path) => pkgs[path].name ?? path.slice(path.lastIndexOf('node_modules/') + 13);
const components = [];
for (const [path, e] of Object.entries(pkgs)) {
  if (!path.includes('node_modules/') || e.link) continue;
  const name = nameOf(path);
  const version = e.version ?? null;
  const purl = `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`;
  const hashes = [];
  const m = /^sha512-(.+)$/.exec(e.integrity ?? '');
  if (m) hashes.push({ alg: 'SHA-512', content: Buffer.from(m[1], 'base64').toString('hex') });
  components.push({
    path,
    name,
    version,
    license: e.license ?? null,
    scope: scopeOf.get(path) ?? 'orphan',
    purl,
    hashes,
    resolved: e.resolved ?? null,
  });
}
components.sort((a, b) => a.path.localeCompare(b.path));

// --- Лицензии ------------------------------------------------------------------------
const PERMISSIVE = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'BlueOak-1.0.0',
  'Zlib',
  'Python-2.0',
  'CC0-1.0',
  'Unlicense',
  'MIT-0',
  'CC-BY-4.0',
  'W3C',
]);
/** Не требуют сохранять уведомление об авторстве. */
const NO_NOTICE = new Set(['CC0-1.0', 'Unlicense', '0BSD', 'MIT-0']);

function classify(license) {
  if (!license) return { kind: 'unknown', note: 'лицензия не указана в lock-файле' };
  if (/\s(OR|AND|WITH)\s|[()]/.test(license))
    return { kind: 'compound', note: 'составное выражение — разобрать вручную' };
  if (!PERMISSIVE.has(license))
    return { kind: 'review', note: 'не из списка разрешительных — разобрать' };
  return { kind: 'permissive', note: null };
}
const lic = components.map((c) => ({ ...c, ...classify(c.license) }));
const notice = lic.filter((c) => c.scope === 'shipped' && !NO_NOTICE.has(c.license ?? ''));

// --- Образы --------------------------------------------------------------------------
const IMAGE_FILES = [
  'infra/images/core.Dockerfile',
  'infra/images/web.Dockerfile',
  'infra/postgres/Dockerfile',
  'infra/docker-compose.yml',
  'infra/docker-compose.env.yml',
  'infra/docker-compose.env-production.yml',
  'infra/openbao/docker-compose.yml',
  'scripts/dns-primary.mjs',
  // Локальный инструмент нагрузки (k6, AGPL-3.0): запускается на ноутбуке, в поставку не входит.
  'scripts/load/run.mjs',
];
const images = [];
for (const file of IMAGE_FILES) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const re = /^[ \t]*(?:FROM\s+(\S+)|image:\s*(\S+)|const (?:K6_)?IMAGE =\s*'([^']+)')/gm;
  for (const m of text.matchAll(re)) {
    const ref = m[1] ?? m[2] ?? m[3];
    if (ref.startsWith('${')) continue; // свои образы: дайджест — в kit.json
    const line = text.slice(0, m.index).split('\n').length;
    // fifth/… — свой образ под локальной меткой: версию задаёт выпуск (release.mjs), не ссылка.
    const pinned = ref.startsWith('fifth/') ? 'own' : /@sha256:[0-9a-f]{64}$/.test(ref);
    images.push({ ref, pinned, where: `${file}:${line}` });
  }
}
/** Записи рабочих пакетов в lock-файле, каталога которых уже нет (удалённые приложения). */
const staleWorkspaces = Object.keys(pkgs).filter(
  (k) => k && !k.includes('node_modules') && !existsSync(join(ROOT, k, 'package.json')),
);
const imagesDoc = {
  coverage:
    'Список ссылок на образы и их закрепление. Не опись пакетов внутри образов: системные ' +
    'пакеты базовых образов (Debian в node, Alpine в nginx, Debian в pgvector) и содержимое ' +
    'сторонних образов (nats, valkey, garage, openbao, zabbix, knot, mailpit, keycloak) не ' +
    'перечислены. Свои образы core, web, postgres — по дайджесту в kit.json.',
  images,
};

// --- Вывод ---------------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
const cdx = (list, label) => ({
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    component: {
      type: 'application',
      name: 'fifth-element',
      version: rootPkg.version ?? '0.0.0',
      ...(COMMIT ? { properties: [{ name: 'fifth:commit', value: COMMIT }] } : {}),
    },
    properties: [{ name: 'fifth:sbom-view', value: label }],
  },
  components: list.map((c) => ({
    type: 'library',
    name: c.name,
    version: c.version,
    purl: c.purl,
    ...(c.license
      ? {
          licenses: [
            classify(c.license).kind === 'compound'
              ? { expression: c.license }
              : { license: { id: c.license } },
          ],
        }
      : {}),
    ...(c.hashes.length ? { hashes: c.hashes } : {}),
    properties: [
      { name: 'fifth:scope', value: c.scope },
      { name: 'fifth:lock-path', value: c.path },
    ],
  })),
});
const write = (name, data) =>
  writeFileSync(
    join(OUT, name),
    typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`,
  );

const count = (scope) => components.filter((c) => c.scope === scope).length;
write(
  'sbom-shipped.cdx.json',
  cdx(
    components.filter((c) => c.scope === 'shipped'),
    'shipped',
  ),
);
write('sbom-all.cdx.json', cdx(components, 'all'));
write('images.json', imagesDoc);
write('licenses.json', {
  commit: COMMIT,
  counts: {
    shipped: count('shipped'),
    build: count('build'),
    local: count('local'),
    orphan: count('orphan'),
  },
  toReview: lic
    .filter((c) => c.kind !== 'permissive')
    .map(({ name, version, license, scope, kind, note }) => ({
      name,
      version,
      license,
      scope,
      kind,
      note,
    })),
  noticeRequired: notice.length,
  staleWorkspaces,
});

const byLicense = new Map();
for (const c of lic) {
  const k = `${c.scope}\t${c.license ?? '(нет)'}`;
  byLicense.set(k, (byLicense.get(k) ?? 0) + 1);
}
const SCOPES = {
  shipped: 'поставляемые',
  build: 'средства сборки',
  local: 'локальные инструменты',
  orphan: 'не используются (остатки в lock)',
};
const md = [];
md.push('# Лицензии компонентов — перечень для разбора', '');
md.push(`Сборка: ${COMMIT ?? 'рабочая копия'}. Источник: package-lock.json.`, '');
md.push(
  'Опись npm построена по lock-файлу и достижимости зависимостей. Фактический состав образа ' +
    'ядра (node_modules после prune) и собранной статики (что вошло в бандлы) ею полностью не ' +
    'подтверждён.',
  '',
);
md.push('Это перечень, а не решение: ничего не объявлено запрещённым и ничего не заменено.', '');
md.push('## Охват', '');
for (const [s, t] of Object.entries(SCOPES)) md.push(`- ${t}: ${count(s)}`);
if (staleWorkspaces.length)
  md.push(
    '',
    `Lock-файл ещё содержит записи удалённых рабочих пакетов: ${staleWorkspaces.join(', ')} — в опись не входят.`,
  );
md.push(
  '',
  `Образы: ${images.length} ссылок, закреплены ${images.filter((i) => i.pinned === true).length}, свои под меткой выпуска ${images.filter((i) => i.pinned === 'own').length}. ${imagesDoc.coverage}`,
  '',
);
md.push('## К разбору', '');
const review = lic.filter((c) => c.kind !== 'permissive');
if (!review.length) md.push('Нет.');
else {
  md.push('| Пакет | Версия | Лицензия | Вид | Почему |', '|---|---|---|---|---|');
  for (const c of review)
    md.push(`| ${c.name} | ${c.version} | ${c.license ?? '—'} | ${SCOPES[c.scope]} | ${c.note} |`);
}
md.push('', '## Уведомления', '');
md.push(
  `Поставляемых пакетов, лицензия которых требует сохранять уведомление об авторстве ` +
    `(MIT, BSD, ISC, Apache и др.): ${notice.length}. В образе ядра уведомления лежат в ` +
    `node_modules вместе с пакетами; в собранной статике сборщик их не переносит — это ` +
    `открытый пункт разбора. Apache-2.0 дополнительно требует передавать файл NOTICE, если он есть: ` +
    `${notice.filter((c) => c.license === 'Apache-2.0').length} поставляемых.`,
);
md.push('', '## Лицензии по видам', '', '| Вид | Лицензия | Пакетов |', '|---|---|---|');
for (const [k, n] of [...byLicense].sort())
  md.push(`| ${SCOPES[k.split('\t')[0]]} | ${k.split('\t')[1]} | ${n} |`);
md.push('', '## Образы', '', '| Ссылка | Закреплён | Где |', '|---|---|---|');
for (const i of images)
  md.push(
    `| \`${i.ref}\` | ${i.pinned === 'own' ? 'свой, версия — выпуск' : i.pinned ? 'да' : '**нет**'} | ${i.where} |`,
  );
write('licenses.md', `${md.join('\n')}\n`);

const sums = {};
for (const f of [
  'sbom-shipped.cdx.json',
  'sbom-all.cdx.json',
  'images.json',
  'licenses.json',
  'licenses.md',
]) {
  sums[f] = createHash('sha256')
    .update(readFileSync(join(OUT, f)))
    .digest('hex');
}
write(
  'SHA256SUMS',
  Object.entries(sums)
    .map(([f, h]) => `${h}  ${f}`)
    .join('\n') + '\n',
);
console.log(
  JSON.stringify({
    ok: true,
    out: OUT,
    counts: {
      shipped: count('shipped'),
      build: count('build'),
      local: count('local'),
      orphan: count('orphan'),
    },
    review: review.length,
    images: {
      total: images.length,
      pinned: images.filter((i) => i.pinned === true).length,
      unpinned: images.filter((i) => i.pinned === false).map((i) => i.ref),
    },
  }),
);
