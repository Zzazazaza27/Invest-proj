#!/usr/bin/env node
/**
 * Комплект выпуска (W09c): манифест и полная локальная копия образов.
 *
 *   node scripts/kit.mjs manifest --build <номер> --commit <sha> --images <файл.json> --out <файл>
 *   node scripts/kit.mjs fetch    --build <номер> [--run <запуск CI>]
 *   node scripts/kit.mjs pack     --build <номер> --from <метка>
 *   node scripts/kit.mjs load     --build <номер>
 *   node scripts/kit.mjs check    --build <номер>
 *
 * Образы собирает один раз CI и кладёт в GHCR; здесь они только скачиваются по
 * неизменяемому дайджесту. `fetch` сохраняет `images.tar`, поэтому установка и
 * возврат работают без GitHub. Хранятся текущий и предыдущий комплекты (`.local/kits`,
 * FIFTH_KITS_DIR). `pack` собирает комплект из локальных образов — для испытаний.
 *
 * Результат — строка JSON. Код завершения: 0 готово, 1 не удалось, 2 отказ.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KITS = process.env.FIFTH_KITS_DIR || join(ROOT, '.local', 'kits');
const COMPOSE = join(ROOT, 'infra', 'docker-compose.env.yml');
const MIGRATIONS = join(ROOT, 'database', 'migrations');
const COMPONENTS = ['core', 'web', 'postgres'];
const KEEP = 2;

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

class Refused extends Error {}

const finish = (result, code) => {
  console.log(JSON.stringify(result));
  process.exit(code);
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function sha256File(path) {
  return new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => ok(h.digest('hex')))
      .on('error', fail);
  });
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args[0]}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
  }
  return r.stdout.trim();
}

/** Порядок сборок: `2.1-b<запуск>.<попытка>`. */
export function buildOrder(build) {
  const m = /^(\d+)\.(\d+)-b(\d+)\.(\d+)$/.exec(build ?? '');
  if (!m) return null;
  return m.slice(1).map(Number);
}

function needBuild() {
  const build = flag('--build');
  if (!buildOrder(build)) throw new Refused(`неверный номер сборки: ${build ?? '(нет)'}`);
  return build;
}

function manifestOf({ build, commit, images, previous }) {
  const migrations = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({
      id: f.replace(/\.sql$/, ''),
      sha256: sha256(readFileSync(join(MIGRATIONS, f))),
    }));
  return {
    format: 1,
    build,
    release: build.split('-b')[0],
    commit,
    createdAt: new Date().toISOString(),
    images,
    compose: { file: 'infra/docker-compose.env.yml', sha256: sha256(readFileSync(COMPOSE)) },
    settingsVersion: 1,
    migrations,
    previous: previous ?? null,
    checks: ['status: /live и /ready', 'verify: дайджесты экземпляров и миграции'],
    stopConditions: [
      'нет блокировки',
      'образ не совпал с манифестом',
      'проверка готовности не прошла',
    ],
  };
}

function manifest() {
  const build = needBuild();
  const commit = flag('--commit');
  const file = flag('--images');
  const out = flag('--out');
  if (!commit || !file || !out) throw new Refused('нужны --commit, --images и --out');
  const images = JSON.parse(readFileSync(file, 'utf8'));
  for (const c of COMPONENTS) {
    if (!images[c]?.digest || !images[c]?.imageId) throw new Refused(`в образах нет ${c}`);
  }
  const kit = manifestOf({ build, commit, images, previous: flag('--previous') });
  writeFileSync(out, `${JSON.stringify(kit, null, 2)}\n`);
  finish({ ok: true, build, file: out }, 0);
}

const kitDir = (build) => join(KITS, build);

/** Комплект только добавляется: занятый номер не заменяется. */
function storeKit(build, kit, tarOf) {
  const dir = kitDir(build);
  if (existsSync(join(dir, 'kit.json'))) throw new Refused(`комплект ${build} уже есть`);
  const tmp = `${dir}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  tarOf(join(tmp, 'images.tar'));
  return { tmp, dir, kit };
}

async function commitKit({ tmp, dir, kit }) {
  const tar = join(tmp, 'images.tar');
  const sealed = { ...kit, tar: { sha256: await sha256File(tar), size: statSync(tar).size } };
  writeFileSync(join(tmp, 'kit.json'), `${JSON.stringify(sealed, null, 2)}\n`);
  mkdirSync(KITS, { recursive: true });
  renameSync(tmp, dir);
  // Хранятся текущий и предыдущий; сборки упорядочены по номеру.
  const order = (b) => buildOrder(b) ?? [];
  const all = readdirSync(KITS)
    .filter((d) => buildOrder(d))
    .sort((a, b) => {
      const [x, y] = [order(a), order(b)];
      return x.reduce((r, v, i) => r || v - y[i], 0);
    });
  for (const old of all.slice(0, -KEEP)) rmSync(kitDir(old), { recursive: true, force: true });
  return sealed;
}

async function fetchKit() {
  const build = needBuild();
  const staging = join(KITS, `.fetch-${build}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const runId = flag('--run');
  run('gh', [
    'run',
    'download',
    ...(runId ? [runId] : []),
    '--name',
    `kit-${build}`,
    '--dir',
    staging,
  ]);
  const kit = JSON.parse(readFileSync(join(staging, 'kit.json'), 'utf8'));
  rmSync(staging, { recursive: true, force: true });
  if (kit.build !== build) throw new Refused(`манифест от сборки ${kit.build}`);
  const refs = COMPONENTS.map((c) => kit.images[c].digest);
  for (const ref of refs) run('docker', ['pull', ref]);
  const staged = storeKit(build, kit, (tar) => run('docker', ['save', '-o', tar, ...refs]));
  const sealed = await commitKit(staged);
  finish({ ok: true, build, tar: sealed.tar }, 0);
}

async function pack() {
  const build = needBuild();
  const from = flag('--from');
  if (!from) throw new Refused('нужен --from <метка>');
  const images = {};
  for (const c of COMPONENTS) {
    const ref = `fifth/${c}:${from}`;
    const imageId = run('docker', ['image', 'inspect', ref, '--format', '{{.Id}}']);
    images[c] = { ref, digest: ref, imageId };
  }
  const kit = manifestOf({
    build,
    commit: run('git', ['rev-parse', 'HEAD']),
    images,
    previous: flag('--previous'),
  });
  const refs = COMPONENTS.map((c) => images[c].ref);
  const staged = storeKit(build, kit, (tar) => run('docker', ['save', '-o', tar, ...refs]));
  const sealed = await commitKit(staged);
  finish({ ok: true, build, tar: sealed.tar }, 0);
}

async function readKit(build) {
  const file = join(kitDir(build), 'kit.json');
  if (!existsSync(file)) throw new Refused(`комплекта ${build} нет`);
  const kit = JSON.parse(readFileSync(file, 'utf8'));
  const tar = await sha256File(join(kitDir(build), 'images.tar'));
  if (tar !== kit.tar.sha256) throw new Error(`images.tar сборки ${build}: хеш не сошёлся`);
  return kit;
}

async function check() {
  const build = needBuild();
  const kit = await readKit(build);
  finish({ ok: true, build, commit: kit.commit, previous: kit.previous }, 0);
}

/**
 * Загрузка в Docker этой машины. Содержимое подтверждает дайджест реестра, а
 * идентификатор образа зависит от хранилища Docker: он свой на каждой машине и
 * записывается рядом с манифестом, для сверки запущенных контейнеров.
 */
async function load() {
  const build = needBuild();
  const kit = await readKit(build);
  const known = (ref) =>
    spawnSync('docker', ['image', 'inspect', ref], { stdio: 'ignore' }).status === 0;
  if (!COMPONENTS.every((c) => known(kit.images[c].digest))) {
    run('docker', ['load', '-i', join(kitDir(build), 'images.tar')]);
  }
  const local = {};
  for (const c of COMPONENTS) {
    const { digest } = kit.images[c];
    local[c] = run('docker', ['image', 'inspect', digest, '--format', '{{.Id}}']);
    run('docker', ['tag', digest, `fifth/${c}:${build}`]);
  }
  writeFileSync(join(kitDir(build), 'local-images.json'), `${JSON.stringify(local, null, 2)}\n`);
  finish({ ok: true, build, images: local }, 0);
}

const COMMANDS = { manifest, fetch: fetchKit, pack, load, check };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command] = argv;
    if (!COMMANDS[command]) throw new Refused(`команды нет: ${command ?? '(нет)'}`);
    await COMMANDS[command]();
  } catch (e) {
    const refused = e instanceof Refused;
    finish({ ok: false, refused, error: e.message }, refused ? 2 : 1);
  }
}
