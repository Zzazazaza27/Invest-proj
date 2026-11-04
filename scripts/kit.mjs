#!/usr/bin/env node
/**
 * Комплект выпуска (W09c): манифест и полная локальная копия образов.
 *
 *   node scripts/kit.mjs manifest --build <номер> --commit <sha> --images <файл.json> --out <файл>
 *   node scripts/kit.mjs fetch    --build <номер> [--run <запуск CI>]
 *   node scripts/kit.mjs pack     --build <номер> --from <метка>
 *   node scripts/kit.mjs load     --build <номер>
 *   node scripts/kit.mjs check    --build <номер>
 *   node scripts/kit.mjs pin      --env <среда> [--current <номер>] [--rollback <номер>] [--pending <номер|none>] [--partial <номер|none>]
 *
 * Образы собирает один раз CI и кладёт в GHCR; здесь они только скачиваются по
 * неизменяемому дайджесту. `fetch` сохраняет `images.tar`, поэтому установка и
 * возврат работают без GitHub. Хранятся текущий и предыдущий комплекты (`.local/kits`,
 * FIFTH_KITS_DIR). `pack` собирает комплект из локальных образов — для испытаний.
 *
 * Файл запуска лежит внутри комплекта (`compose.yml`), его хеш сверяется с манифестом:
 * комплект не зависит от рабочей копии. Очистка не трогает закреплённые комплекты:
 * установленный, выбранный для возврата, устанавливаемый и частично установленный:
 * после сбоя на обновлении его образы могут работать в среде (`pins/<среда>.json`).
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
const KEEP = Number(process.env.FIFTH_KIT_KEEP || 2);

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

/**
 * Метки сборки на образах перед сохранением. Образ, сохранённый по дайджесту, после
 * `docker load` остаётся без имени, и найти его на другой машине нечем.
 */
function tagForKit(build, refOf) {
  return COMPONENTS.map((c) => {
    const tag = `fifth/${c}:${build}`;
    run('docker', ['tag', refOf(c), tag]);
    return tag;
  });
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
function storeKit(build, kit, composeFile, tarOf) {
  const dir = kitDir(build);
  if (existsSync(join(dir, 'kit.json'))) throw new Refused(`комплект ${build} уже есть`);
  const composeText = readFileSync(composeFile);
  if (sha256(composeText) !== kit.compose.sha256) {
    throw new Error(`файл запуска сборки ${build} не совпал с манифестом`);
  }
  const tmp = `${dir}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, 'compose.yml'), composeText);
  tarOf(join(tmp, 'images.tar'));
  return { tmp, dir, kit };
}

const pinsDir = () => join(KITS, 'pins');

/** Комплекты, которые нельзя удалять: их используют среды. */
function pinnedBuilds() {
  if (!existsSync(pinsDir())) return new Set();
  const out = new Set();
  for (const f of readdirSync(pinsDir())) {
    const pins = JSON.parse(readFileSync(join(pinsDir(), f), 'utf8'));
    for (const v of Object.values(pins).flat()) if (v) out.add(v);
  }
  return out;
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
  const pinned = pinnedBuilds();
  for (const old of all.slice(0, -KEEP)) {
    if (!pinned.has(old)) rmSync(kitDir(old), { recursive: true, force: true });
  }
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
  if (kit.build !== build) throw new Refused(`манифест от сборки ${kit.build}`);
  const refs = COMPONENTS.map((c) => kit.images[c].digest);
  for (const ref of refs) run('docker', ['pull', ref]);
  const stagedCompose = join(staging, 'compose.yml');
  if (!existsSync(stagedCompose))
    throw new Refused(`в артефакте сборки ${build} нет файла запуска`);
  const tags = tagForKit(build, (c) => kit.images[c].digest);
  const staged = storeKit(build, kit, stagedCompose, (tar) =>
    run('docker', ['save', '-o', tar, ...tags]),
  );
  rmSync(staging, { recursive: true, force: true });
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
  const tags = tagForKit(build, (c) => images[c].ref);
  const staged = storeKit(build, kit, COMPOSE, (tar) =>
    run('docker', ['save', '-o', tar, ...tags]),
  );
  const sealed = await commitKit(staged);
  finish({ ok: true, build, tar: sealed.tar }, 0);
}

async function readKit(build) {
  const file = join(kitDir(build), 'kit.json');
  if (!existsSync(file)) throw new Refused(`комплекта ${build} нет`);
  const kit = JSON.parse(readFileSync(file, 'utf8'));
  const tar = await sha256File(join(kitDir(build), 'images.tar'));
  if (tar !== kit.tar.sha256) throw new Error(`images.tar сборки ${build}: хеш не сошёлся`);
  const composeFile = join(kitDir(build), 'compose.yml');
  if (!existsSync(composeFile) || sha256(readFileSync(composeFile)) !== kit.compose.sha256) {
    throw new Error(`файл запуска сборки ${build}: хеш не сошёлся`);
  }
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
  await readKit(build);
  // Содержимое подтверждено хешем архива из манифеста, поэтому имя образа здесь — метка.
  const tagOf = (c) => `fifth/${c}:${build}`;
  const known = (ref) =>
    spawnSync('docker', ['image', 'inspect', ref], { stdio: 'ignore' }).status === 0;
  if (!COMPONENTS.every((c) => known(tagOf(c)))) {
    run('docker', ['load', '-i', join(kitDir(build), 'images.tar')]);
  }
  const local = {};
  for (const c of COMPONENTS) {
    local[c] = run('docker', ['image', 'inspect', tagOf(c), '--format', '{{.Id}}']);
  }
  writeFileSync(join(kitDir(build), 'local-images.json'), `${JSON.stringify(local, null, 2)}\n`);
  finish({ ok: true, build, images: local }, 0);
}

/** Закрепление комплектов за средой; `none` снимает значение. */
function pin() {
  const env = flag('--env');
  if (!/^(prod|test-[1-9][0-9]*)$/.test(env ?? '')) throw new Refused('нужен --env <среда>');
  const file = join(pinsDir(), `${env}.json`);
  const pins = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  for (const key of ['current', 'rollback', 'pending']) {
    const value = flag(`--${key}`);
    if (value === null) continue;
    if (value === 'none') {
      delete pins[key];
      continue;
    }
    if (!existsSync(join(kitDir(value), 'kit.json'))) throw new Refused(`комплекта ${value} нет`);
    pins[key] = value;
  }
  // Частичных может быть несколько: смесь образов держит каждую из сборок.
  const partial = flag('--partial');
  if (partial === 'none') delete pins.partial;
  else if (partial) {
    if (!existsSync(join(kitDir(partial), 'kit.json')))
      throw new Refused(`комплекта ${partial} нет`);
    pins.partial = [...new Set([...(pins.partial ?? []), partial])];
  }
  mkdirSync(pinsDir(), { recursive: true });
  writeFileSync(file, `${JSON.stringify(pins, null, 2)}\n`);
  finish({ ok: true, env, pins }, 0);
}

const COMMANDS = { manifest, fetch: fetchKit, pack, load, check, pin };

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
