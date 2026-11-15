#!/usr/bin/env node
/**
 * CHK-HOST-ENV — окружение узла (пакет «окружение узла», Тэнк 15.11): правила сверки, «не
 * проверено» отдельно от совпадения, полнота утверждённого описания, опись без догадок, подпись
 * архива своим доменом, архив в идентификаторе комплекта и в копии, проверка архива. Без сети и
 * Docker: сборка архива и установка без репозиториев проверяются на площадке
 * (restore-site-wsl hostenv), см. docs/runbooks/host-environment.md.
 */
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kitId } from './lib/compat-report.mjs';
import { pinnedHostEnvs, trustForArchive, verifyArchive } from './lib/host-env-archive.mjs';
import {
  compareDebVersions,
  compareEnvironment,
  factsOfHost,
  gapsOf,
  inventoryOfHost,
  summarize,
  validateEnvironment,
} from './lib/host-env.mjs';
import { kitSignatureValid, signHostEnv, signKit, hostEnvSignatureValid } from './lib/kit-sign.mjs';

let ok = 0;
let fail = 0;
const check = (name, cond, details = '') => {
  if (cond) ok++;
  else fail++;
  console.log(`  ${cond ? 'OK  ' : 'FAIL'}  ${name}${cond || !details ? '' : ` — ${details}`}`);
};
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// --- сравнение версий Debian (значения сверены с dpkg --compare-versions).
const cmp = [
  ['1:2.43.0-1ubuntu7.4', '1:2.43.0-1ubuntu7.3', 1],
  ['2.4.4-2ubuntu17', '2.4.4-2ubuntu17.4', -1],
  ['1.0~rc1', '1.0', -1],
  ['5:29.7.2-1~ubuntu.24.04~noble', '5:29.7.2-1~ubuntu.24.04~noble', 0],
  ['2:1.0', '1:9.9', 1],
  ['1.0-1', '1.0', 1],
  ['1.10', '1.9', 1],
];
check(
  'версии Debian: эпоха, ~, ревизия, числа',
  cmp.every(([a, b, s]) => Math.sign(compareDebVersions(a, b)) === s),
  JSON.stringify(cmp.map(([a, b]) => Math.sign(compareDebVersions(a, b)))),
);

// --- описание и факты.
const env = {
  format: 1,
  id: 'hostenv-chk-1',
  status: 'draft',
  approved: null,
  os: { id: 'ubuntu', versionId: '24.04', arch: 'amd64' },
  kernel: { compare: false },
  sources: [
    { name: 'ubuntu', uri: 'http://archive.ubuntu.com/ubuntu' },
    {
      name: 'docker',
      uri: 'https://download.docker.com/linux/ubuntu',
      suite: 'noble',
      components: ['stable'],
      keyFile: '/etc/apt/keyrings/docker.asc',
      keyUrl: 'https://download.docker.com/linux/ubuntu/gpg',
      keyFingerprint: '9DC858229FC7DD38854AE2D88D81803C0EBFCD88',
    },
  ],
  components: [
    {
      name: 'Docker Engine',
      source: 'docker',
      match: 'exact',
      packages: { 'docker-ce': '5:29.7.2-1~ubuntu.24.04~noble' },
    },
    {
      name: 'Ubuntu',
      source: 'ubuntu',
      match: 'ubuntu-security',
      packages: { git: '1:2.43.0-1ubuntu7.3' },
    },
  ],
  security: { autoUpdates: 'security-only', excludeManaged: true },
};
const host = (over = {}) => ({
  os: { ID: 'ubuntu', VERSION_ID: '24.04' },
  arch: 'amd64',
  kernel: '6.8.0-147-generic',
  environment: {
    installed: {
      'docker-ce': { version: '5:29.7.2-1~ubuntu.24.04~noble' },
      git: { version: '1:2.43.0-1ubuntu7.4' },
    },
    holds: ['docker-ce'],
    origins: {
      'docker-ce': ['https://download.docker.com/linux/ubuntu noble/stable amd64 Packages'],
    },
  },
  ...over,
});
const run = (h, opts) => compareEnvironment(env, factsOfHost(h), opts);
const state = (rows, subject) => rows.find((r) => r.subject === subject)?.state;

let rows = run(host(), { holds: true });
check(
  'совпадение: всё ok, итог ok',
  summarize(rows).verdict === 'ok',
  JSON.stringify(summarize(rows)),
);
check('ядро не сравнивается (WSL ≠ VPS)', state(rows, 'ядро') === 'ok');
check('пакет Ubuntu новее ревизией — допустим', state(rows, 'Ubuntu: git') === 'ok');

const h2 = host();
h2.environment.installed.git.version = '1:2.43.0-1ubuntu7.2';
check('пакет Ubuntu старше ревизией — расхождение', state(run(h2), 'Ubuntu: git') === 'differ');
const h3 = host();
h3.environment.installed.git.version = '1:2.44.0-1ubuntu1';
check(
  'пакет Ubuntu другой версии программы — расхождение',
  state(run(h3), 'Ubuntu: git') === 'differ',
);
const h4 = host();
h4.environment.installed['docker-ce'].version = '5:29.7.3-1~ubuntu.24.04~noble';
check('пакет поставщика — только точно', state(run(h4), 'Docker Engine: docker-ce') === 'differ');
const h5 = host();
delete h5.environment.installed['docker-ce'];
check(
  'нет пакета при полном списке — «нет»',
  state(run(h5), 'Docker Engine: docker-ce') === 'missing',
);
rows = run({
  os: { ID: 'ubuntu', VERSION_ID: '24.04' },
  arch: null,
  packages: { git: '1:2.43.0-1ubuntu7.3' },
});
check(
  'запись до 15.11: нет пакета — «не проверено», а не «нет»',
  state(rows, 'Docker Engine: docker-ce') === 'unverified',
);
check('архитектура не записана — «не проверено»', state(rows, 'архитектура') === 'unverified');
check('итог с «не проверено» — не совпадение', summarize(rows).verdict === 'unverified');
const h6 = host();
h6.environment.origins = { 'docker-ce': null };
check(
  'источник не определён — «не проверено»',
  state(run(h6), 'Docker Engine: docker-ce (источник)') === 'unverified',
);
const h7 = host();
h7.environment.origins['docker-ce'] = [
  'http://archive.ubuntu.com/ubuntu noble/universe amd64 Packages',
];
check(
  'источник не поставщика — расхождение',
  state(run(h7), 'Docker Engine: docker-ce (источник)') === 'differ',
);
// Узел из архива окружения (Тэнк 16.11): проверенный архив — допустимый источник; связь —
// метка происхождения, сверяемая с описанием, суммой и версией.
const SRC = 'Docker Engine: docker-ce (источник)';
const DOCKER = '5:29.7.2-1~ubuntu.24.04~noble';
const sha = 'c'.repeat(64);
const mark = (over = {}) => ({
  archive: `hostenv-chk-1.${sha.slice(0, 12)}`,
  archiveSha256: sha,
  provenance: 'confirmed',
  packages: { 'docker-ce': DOCKER },
  ...over,
});
const fromArchive = (m) => {
  const h = host();
  h.environment.origins['docker-ce'] = ['/var/lib/dpkg/status'];
  h.environment.installedFrom = m;
  return h;
};
check(
  'узел из архива без метки — расхождение (нет источника поставщика)',
  state(run(fromArchive(null)), SRC) === 'differ',
);
check(
  'метка подтверждённого архива — источник ok, итог ok',
  state(run(fromArchive(mark())), SRC) === 'ok' &&
    summarize(run(fromArchive(mark()), { holds: true })).verdict === 'ok',
);
check(
  'метка без подтверждённого происхождения — «не проверено», не совпадение',
  state(run(fromArchive(mark({ provenance: 'unconfirmed' }))), SRC) === 'unverified',
);
check(
  'метка: идентификатор не сходится с суммой — расхождение',
  state(run(fromArchive(mark({ archiveSha256: 'd'.repeat(64) }))), SRC) === 'differ',
);
check(
  'метка другого описания — расхождение',
  state(run(fromArchive(mark({ archive: `hostenv-other-1.${sha.slice(0, 12)}` }))), SRC) ===
    'differ',
);
check(
  'метка: архив ставил другую версию — расхождение',
  state(
    run(fromArchive(mark({ packages: { 'docker-ce': '5:29.7.1-1~ubuntu.24.04~noble' } }))),
    SRC,
  ) === 'differ',
);
check(
  'сверка назвала другой архив — расхождение',
  state(run(fromArchive(mark()), { archive: 'hostenv-chk-1.0123456789ab' }), SRC) === 'differ',
);
const back = fromArchive(mark());
back.environment.origins['docker-ce'] = [
  'https://download.docker.com/linux/ubuntu noble/stable amd64 Packages',
  '/var/lib/dpkg/status',
];
check('источники поставщика подключены обратно — ok по поставщику', state(run(back), SRC) === 'ok');
const foreign = fromArchive(mark());
foreign.environment.origins['docker-ce'] = [
  'http://mirror.example/ubuntu noble/stable amd64 Packages',
  '/var/lib/dpkg/status',
];
check(
  'метка есть, но версия и из постороннего источника — расхождение',
  state(run(foreign), SRC) === 'differ',
);
const h9 = host();
h9.environment.holds = [];
check(
  'управляемый пакет не закреплён — расхождение',
  state(run(h9, { holds: true }), 'закрепление docker-ce') === 'differ',
);
const h10 = host();
h10.environment.holds = null;
check(
  'закрепления не прочитаны — «не проверено»',
  state(run(h10, { holds: true }), 'закрепление docker-ce') === 'unverified',
);

// --- описание: утверждённое без пробелов, черновик — с ними.
check(
  'черновик описания проходит структуру',
  validateEnvironment(env).length === 0,
  validateEnvironment(env).join('; '),
);
const gappy = JSON.parse(JSON.stringify(env));
gappy.sources[1].keyFingerprint = null;
gappy.status = 'approved';
gappy.approved = { by: 'Томас', at: '2026-11-15' };
check(
  'утверждённое описание с пробелом — не принимается',
  validateEnvironment(gappy).some((p) => /неполно/.test(p)),
);
check(
  'пробел виден в списке неполных сведений',
  gapsOf(gappy).some((g) => /keyFingerprint/.test(g)),
);

// --- опись без догадок.
const inv = inventoryOfHost(
  { os: { ID: 'ubuntu', VERSION_ID: '24.04' }, kernel: 'k', packages: { 'docker-ce': '5:1' } },
  {
    id: 'hostenv-inv-1',
    files: {
      '/etc/apt/sources.list.d/docker.list':
        'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n',
    },
  },
);
check('опись: черновик, не утверждено', inv.env.status === 'draft' && inv.env.approved === null);
check(
  'опись: нет записи — null и пробел, а не значение',
  inv.env.os.arch === null &&
    inv.env.components[0].packages['docker-ce-cli'] === null &&
    inv.gaps.some((g) => /docker-ce-cli/.test(g)) &&
    inv.gaps.some((g) => /caddy: uri/.test(g)),
);
check(
  'опись: источник Docker разобран из файла узла',
  inv.env.sources.find((s) => s.name === 'docker').suite === 'noble' &&
    inv.env.sources.find((s) => s.name === 'docker').components.join() === 'stable',
);

// --- подпись своим доменом.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pub = publicKey.export({ type: 'spki', format: 'pem' });
const bytes = Buffer.from('{"x":1}\n');
check('подпись архива проверяется', hostEnvSignatureValid(bytes, signHostEnv(bytes, priv), pub));
check(
  'подпись комплекта не выдать за подпись архива и наоборот',
  !hostEnvSignatureValid(bytes, signKit(bytes, priv), pub) &&
    !kitSignatureValid(bytes, signHostEnv(bytes, priv), pub),
);

// --- комплект: архив в идентификаторе, прежние идентификаторы не меняются.
const kit = {
  build: '2.1-b150',
  commit: 'c',
  images: {},
  compose: { sha256: 'x' },
  migrations: [],
};
const withEnv = { ...kit, hostEnv: { id: 'hostenv-a-1.0123456789ab', sha256: 'a'.repeat(64) } };
const otherEnv = { ...kit, hostEnv: { id: 'hostenv-a-1.0123456789ab', sha256: 'b'.repeat(64) } };
check(
  'идентификатор комплекта: без архива прежний, с архивом — другой, другая сумма — другой',
  kitId(kit) ===
    createHash('sha256')
      .update(
        JSON.stringify({
          build: kit.build,
          commit: 'c',
          images: {},
          compose: 'x',
          prodCompose: null,
          migrations: [],
        }),
      )
      .digest('hex') &&
    kitId(withEnv) !== kitId(kit) &&
    kitId(withEnv) !== kitId(otherEnv),
);

// --- копия: архивы закреплённых комплектов.
const work = mkdtempSync(join(tmpdir(), 'chk-hostenv-'));
try {
  const kits = join(work, 'kits');
  for (const [b, k] of [
    ['2.1-b150', withEnv],
    ['2.1-b149', kit],
  ]) {
    mkdirSync(join(kits, b), { recursive: true });
    writeFileSync(join(kits, b, 'kit.json'), JSON.stringify(k));
  }
  mkdirSync(join(kits, 'pins'));
  writeFileSync(
    join(kits, 'pins', 'prod.json'),
    JSON.stringify({ core: '2.1-b150', web: '2.1-b149' }),
  );
  const pinned = pinnedHostEnvs(kits);
  check(
    'копия берёт архивы закреплённых комплектов; комплект без архива пропускается',
    pinned.length === 1 &&
      pinned[0].id === withEnv.hostEnv.id &&
      pinned[0].builds.join() === '2.1-b150',
  );

  // --- проверка архива: собранного вручную, без Docker.
  let archives = 0;
  const build = (id, mutate) => {
    const root = join(work, `a-${++archives}`);
    const envBytes = Buffer.from(JSON.stringify(env));
    const deb = Buffer.from('fake deb');
    const archive = {
      format: 1,
      envId: env.id,
      envSha256: sha256(envBytes),
      packages: [
        { file: 'x_1_amd64.deb', sha256: sha256(deb), package: 'x', version: '1', arch: 'amd64' },
      ],
      requested: ['x=1'],
      keys: {},
    };
    const aBytes = Buffer.from(`${JSON.stringify(archive)}\n`);
    const realId = id ?? `${env.id}.${sha256(aBytes).slice(0, 12)}`;
    const dir = join(root, 'hostenv', realId);
    mkdirSync(join(dir, 'debs'), { recursive: true });
    writeFileSync(join(dir, 'environment.json'), envBytes);
    writeFileSync(join(dir, 'archive.json'), aBytes);
    writeFileSync(join(dir, 'archive.json.sig'), signHostEnv(aBytes, priv));
    writeFileSync(
      join(dir, 'debs', 'x_1_amd64.deb'),
      mutate === 'deb' ? Buffer.from('changed') : deb,
    );
    if (mutate === 'extra') writeFileSync(join(dir, 'debs', 'y.deb'), 'y');
    if (mutate === 'env') writeFileSync(join(dir, 'environment.json'), '{}');
    spawnSync('tar', ['-cf', 'a.tar', 'hostenv'], { cwd: root });
    return join(root, 'a.tar');
  };
  const good = build();
  const v = verifyArchive(good, { publicPem: pub, expectSha256: sha256(readFileSync(good)) });
  check(
    'архив: суммы, описание, подпись — ok',
    v.ok,
    v.checks
      .filter((c) => !c.ok)
      .map((c) => c.name)
      .join('; '),
  );
  check('архив без ключа — подпись «не проверено», не ok', !verifyArchive(good).ok);
  check('подменён пакет — отказ', !verifyArchive(build(null, 'deb'), { publicPem: pub }).ok);
  check('лишний файл в debs — отказ', !verifyArchive(build(null, 'extra'), { publicPem: pub }).ok);
  check('подменено описание — отказ', !verifyArchive(build(null, 'env'), { publicPem: pub }).ok);
  check(
    'имя не равно сумме описи — отказ',
    !verifyArchive(build('hostenv-chk-1.000000000000'), { publicPem: pub }).ok,
  );
  check(
    'сумма архива не как закреплено — отказ',
    !verifyArchive(good, { publicPem: pub, expectSha256: '0'.repeat(64) }).ok,
  );
  const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  check('чужой ключ — отказ', !verifyArchive(good, { publicPem: other }).ok);
} finally {
  rmSync(work, { recursive: true, force: true });
}

// Доверие к подписи (Тэнк 16.11): ключ из копии не заменяет доверенный.
const refuses = (o) => {
  try {
    trustForArchive(o);
    return false;
  } catch {
    return true;
  }
};
check('ключа вне копии нет — отказ, ключ копии сам не берётся', refuses({ copyKey: 'copy.pub' }));
check(
  'ключ из копии — только явно, происхождение «не подтверждено»',
  trustForArchive({ copyKey: 'copy.pub', allowUnconfirmed: true }).provenance === 'unconfirmed',
);
check(
  'явный или закреплённый ключ важнее ключа копии — подтверждено',
  trustForArchive({ pub: 'a.pub', copyKey: 'copy.pub' }).file === 'a.pub' &&
    trustForArchive({ pinned: 'g.pub', copyKey: 'copy.pub', allowUnconfirmed: true }).provenance ===
      'confirmed',
);

console.log(`=== ИТОГ: ${ok} OK, ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
