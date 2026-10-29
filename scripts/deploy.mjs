#!/usr/bin/env node
/**
 * Выкатить текущий `main` на боевой стенд.
 *
 * До этого скрипта обновление сервера было набором команд по памяти: подтянуть,
 * поставить зависимости, собрать, накатить миграции, перезапустить два сервиса,
 * пересоздать прокси. Любой шаг можно было забыть или сделать не в том порядке,
 * а последнее обновление делал человек, который больше не в проекте.
 *
 * Что делает, по шагам:
 *   1. проверяет, что локально нечего терять и origin совпадает с локальным;
 *   2. снимает дамп базы НА СЕРВЕРЕ и убеждается, что он читается;
 *   3. запоминает текущий коммит сервера — точку отката;
 *   4. подтягивает код, ставит зависимости, собирает пакеты и фронтенды;
 *   5. останавливает и отключает сервисы, удалённые из кода (AI-шлюз);
 *   6. перед contract-миграцией останавливает ядро с фоновыми обработчиками;
 *   7. накатывает миграции и заводит логин-роли;
 *   8. запускает ядро, пересоздаёт прокси;
 *   9. проверяет health и маршруты снаружи.
 *
 * Если проверка не прошла — откатывает код на прежний коммит, пересобирает и
 * перезапускает, после чего проверяет снова. Но только если contract-миграция
 * НЕ применена: после неё прежний код обращается к удалённой схеме, поэтому
 * выпуск останавливается и ждёт решения человека (2.1-W05, M150). База не
 * откатывается никогда: миграции forward-only, и автоматический откат данных
 * опаснее самой неудачи. Дамп остаётся на сервере, путь печатается.
 *
 * Запуск:
 *   node scripts/deploy.mjs --dry-run   показать план, ничего не менять
 *   node scripts/deploy.mjs             выкатить
 *   node scripts/deploy.mjs --no-verify пропустить локальные гейты (не надо)
 */
import { execSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  dumpCommand,
  reconcileDatabaseNames,
  runRelease,
  serverDatabaseName,
} from './lib/deploy-release.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DRY = process.argv.includes('--dry-run');
const NO_VERIFY = process.argv.includes('--no-verify');

const HOST = 'root@193.233.217.210';
const KEY = resolve(homedir(), '.ssh', 'launchbridge_ed25519');
const APP_DIR = '/opt/unicorn-launch';
// Адрес стенда — из окружения: смена домена не требует правки скрипта.
const PUBLIC_URL = process.env.STAND_PUBLIC_URL ?? 'https://5espace.com';
const ROUTES = ['/', '/login/', '/lab/', '/investor/', '/admin/', '/v1/health'];

const step = (text) => console.warn(`\n▸ ${text}`);
const ok = (text) => console.warn(`  ok    ${text}`);
const info = (text) => console.warn(`  ·     ${text}`);
const fail = (text) => console.error(`  СБОЙ  ${text}`);

const local = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();

/**
 * Команда на сервере. Длинные шаги идут с выводом в консоль: сборка занимает
 * минуты, и молчащий терминал неотличим от зависшего.
 */
function remote(cmd, { show = false, allowFail = false } = {}) {
  const ssh = [
    'ssh',
    '-i',
    `"${KEY}"`,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=20',
    HOST,
    `"cd ${APP_DIR} && ${cmd.replace(/"/g, '\\"')}"`,
  ].join(' ');
  try {
    const out = execSync(ssh, {
      encoding: 'utf8',
      stdio: show ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return show ? '' : (out || '').trim();
  } catch (error) {
    if (allowFail) return null;
    fail(`команда на сервере не выполнилась: ${cmd.slice(0, 70)}`);
    const text = [error?.stderr, error?.stdout].filter(Boolean).join('\n').trim();
    if (text) console.error(text.split('\n').slice(-6).join('\n'));
    throw error;
  }
}

/** Запрос снаружи — средствами Node, без curl (на Windows он псевдоним). */
function probe(url) {
  const script = [
    'const c = new AbortController();',
    'const t = setTimeout(() => c.abort(), 15000);',
    'fetch(process.argv[1], { signal: c.signal })',
    '  .then((r) => process.stdout.write(String(r.status)))',
    "  .catch(() => process.stdout.write('0'))",
    '  .finally(() => clearTimeout(t));',
  ].join('');
  const out = spawnSync(process.execPath, ['-e', script, url], {
    encoding: 'utf8',
    timeout: 30000,
  });
  return Number((out.stdout || '0').trim()) || 0;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ------------------------------------------------------------------ 1. локально

step('Локальная проверка');

const dirty = local('git status --porcelain');
if (dirty) {
  fail('в рабочем дереве есть незакоммиченные изменения — выкатывать нечего или рано');
  console.error(dirty.split('\n').slice(0, 10).join('\n'));
  process.exit(1);
}
ok('дерево чистое');

local('git fetch origin main --quiet');
const head = local('git rev-parse --short HEAD');
const originHead = local('git rev-parse --short origin/main');
if (head !== originHead) {
  fail(`локальный main (${head}) не совпадает с origin/main (${originHead}) — сначала запушьте`);
  process.exit(1);
}
ok(`выкатываем ${head}: ${local('git log -1 --pretty=%s')}`);

if (!NO_VERIFY) {
  for (const gate of ['format:check', 'lint', 'typecheck']) {
    try {
      execSync(`npm run ${gate}`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      ok(`${gate} зелёный`);
    } catch {
      fail(`${gate} не проходит — на сервер такое не выкатывают`);
      process.exit(1);
    }
  }
}

// ------------------------------------------------------------------ 2. сервер

step('Состояние сервера');
const before = remote('git rev-parse --short HEAD');
ok(`сейчас ${before}: ${remote('git log -1 --pretty=%s')}`);
if (before === head) {
  ok('сервер уже на этом коммите — выкатывать нечего');
  process.exit(0);
}
info(`отставание: ${local(`git rev-list --count ${before}..HEAD`)} коммит(ов)`);

const serverDirty = remote('git status --porcelain');
if (serverDirty) {
  fail('на сервере есть изменения мимо git — разберитесь, иначе они пропадут');
  console.error(serverDirty.split('\n').slice(0, 10).join('\n'));
  process.exit(1);
}
ok('на сервере нет правок мимо git');

// Имена баз и `.env` сверяются ДО бэкапа: дамп и чтение миграций подключаются
// по `.env`, и прерванное переименование уронило бы их раньше, чем выпуск
// дошёл бы до его исправления.
step('Имена баз');
let nameActions;
try {
  nameActions = reconcileDatabaseNames({ remote }, { dryRun: DRY });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (nameActions.length === 0) ok('базы и .env согласованы');
for (const action of nameActions)
  info(`${DRY ? 'было бы восстановлено' : 'восстановлено'}: ${action}`);

if (DRY) {
  console.warn(`\nПробный прогон: выкатили бы ${before} → ${head}. Ничего не менялось.\n`);
  process.exit(0);
}

// ------------------------------------------------------------------ 3. бэкап

step('Бэкап базы');
// Имя базы — из конфигурации сервера, а не из кода: выпуск может как раз
// переименовывать базу (2.1, `unicorn_launch` → `fifth_element`), и до него
// на сервере действует прежнее имя.
const database = serverDatabaseName({ remote });
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const dump = `/root/backups/${database}_${stamp}.dump`;
remote('mkdir -p /root/backups');
remote(dumpCommand(database));
remote(`docker cp unicorn-postgres:/tmp/deploy.dump ${dump}`);

// Дамп без проверки — не страховка, а её видимость: битый файл ничем не
// отличается от целого, пока не понадобится.
const tables = remote(
  `docker exec unicorn-postgres pg_restore --list /tmp/deploy.dump | grep -c 'TABLE DATA'`,
  { allowFail: true },
);
if (!tables || Number(tables) < 10) {
  fail(`дамп нечитаем или пуст (таблиц с данными: ${tables ?? 0}) — выкат отменён`);
  process.exit(1);
}
ok(`${dump} — таблиц с данными: ${tables}`);

// ------------------------------------------------------------------ 4. выкат

// Порядок шагов и решение об откате — в `lib/deploy-release.mjs`: там их без
// сервера проверяет `check-deploy-release.mjs`.
const release = runRelease({
  ops: { remote, probe, sleep, log: { step, ok, info, fail } },
  before,
  head,
  publicUrl: PUBLIC_URL,
  routes: ROUTES,
});
const deployFailed = release.outcome !== 'released';
if (deployFailed) {
  console.error(`\nБаза НЕ откатывалась: миграции forward-only. Дамп: ${dump}\n`);
}

if (deployFailed) process.exit(1);

step('Отметка');
const tag = `stand-${new Date().toISOString().slice(0, 10)}`;
try {
  local(`git tag -f -a ${tag} ${head} -m "Развёрнуто на ${PUBLIC_URL}"`);
  local(`git push -f origin ${tag}`);
  ok(`тег ${tag} поставлен и отправлен`);
} catch {
  info(`тег ${tag} поставить не вышло — сделайте вручную`);
}

console.warn(`
Выкачено: ${before} → ${head}

  ${PUBLIC_URL}/         витрина
  ${PUBLIC_URL}/console/ консоль — только администратору

Дамп перед выкатом: ${dump}
Снимок состояния:   node scripts/stand-status.mjs
`);
