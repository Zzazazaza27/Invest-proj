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
 *   5. накатывает миграции и заводит логин-роли;
 *   6. перезапускает ядро и AI-шлюз, пересоздаёт прокси;
 *   7. проверяет health и маршруты снаружи.
 *
 * Если проверка не прошла — откатывает код на прежний коммит, пересобирает и
 * перезапускает, после чего проверяет снова. База при этом НЕ откатывается:
 * миграции forward-only, и автоматический откат данных опаснее самой неудачи.
 * Дамп остаётся на сервере, путь печатается.
 *
 * Запуск:
 *   node scripts/deploy.mjs --dry-run   показать план, ничего не менять
 *   node scripts/deploy.mjs             выкатить
 *   node scripts/deploy.mjs --no-verify пропустить локальные гейты (не надо)
 */
import { execSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const DRY = process.argv.includes('--dry-run');
const NO_VERIFY = process.argv.includes('--no-verify');

const HOST = 'root@193.233.217.210';
const KEY = resolve(homedir(), '.ssh', 'launchbridge_ed25519');
const APP_DIR = '/opt/unicorn-launch';
// Адрес стенда — из окружения: смена домена не требует правки скрипта.
const PUBLIC_URL = process.env.STAND_PUBLIC_URL ?? 'https://5espace.com';
const ROUTES = ['/', '/login/', '/lab/', '/investor/', '/expert/', '/admin/', '/v1/health'];

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

if (DRY) {
  console.warn(`\nПробный прогон: выкатили бы ${before} → ${head}. Ничего не менялось.\n`);
  process.exit(0);
}

// ------------------------------------------------------------------ 3. бэкап

step('Бэкап базы');
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const dump = `/root/backups/unicorn_launch_${stamp}.dump`;
remote('mkdir -p /root/backups');
remote(
  `PGPASSWORD=$(grep -m1 '^POSTGRES_PASSWORD=' .env | cut -d= -f2-) ` +
    `docker exec -e PGPASSWORD -i unicorn-postgres pg_dump -U unicorn_owner ` +
    `-d unicorn_launch --format=custom -f /tmp/deploy.dump`,
);
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

let deployFailed = false;

try {
  step('Код и сборка');
  remote(`git fetch origin main --quiet && git reset --hard ${head} --quiet`);
  ok(`код на ${remote('git rev-parse --short HEAD')}`);

  info('npm ci — займёт минуту');
  remote('npm ci --no-audit --no-fund', { show: true });

  info('сборка пакетов и фронтендов');
  remote('npm run build', { show: true });
  // Консоль собирается отдельной командой намеренно: `npm run build` её не
  // трогает, чтобы она не уезжала туда, где не нужна. Здесь нужна — доступ к
  // ней закрыт привратником, а не отсутствием файлов.
  remote('npm run build:console', { show: true });
  // Фронты обязаны быть production-сборкой: отладочный React удваивает запросы
  // (StrictMode) и тянет предупреждения в консоль (этап 5.6.4д).
  remote('npm run check:front-builds', { show: true });
  ok('собрано, сборки production');

  step('База');
  remote('npm run db:migrate', { show: true });
  remote('npm run bootstrap:roles -w database', { show: true });
  ok('миграции и роли применены');

  step('Перезапуск');
  remote('systemctl restart unicorn-core unicorn-ai-gateway');

  // Ядру нужно время подняться: сразу после restart оно ещё не слушает порт,
  // а следом идёт проверка конфигурации nginx, которая ходит именно в него.
  let coreUp = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    sleep(3000);
    if (
      remote('curl -s -o /dev/null -w "%{http_code}" -m 5 http://127.0.0.1:4300/v1/health', {
        allowFail: true,
      }) === '200'
    ) {
      coreUp = true;
      break;
    }
  }
  if (!coreUp) throw new Error('ядро не поднялось после перезапуска');
  ok('ядро отвечает');

  remote('npm run web:up', { show: true });

  // compose НЕ пересоздаёт контейнер, если его определение не менялось, —
  // а конфиг nginx лежит в смонтированном каталоге и меняется вместе с кодом.
  // nginx же читает конфигурацию только при старте. Без явного reload новый
  // console.conf приехал бы файлом, но не применился: ровно так 2026-09-13
  // консоль осталась открытой при обновлённом коде.
  const confOk = remote('docker exec unicorn-web nginx -t', { allowFail: true });
  if (confOk === null) throw new Error('конфигурация nginx не проходит проверку — reload отменён');
  remote('docker exec unicorn-web nginx -s reload');
  ok('ядро, шлюз и прокси подняты, конфигурация nginx перечитана');

  step('Проверка снаружи');
  let bad = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    bad = ROUTES.filter((r) => probe(`${PUBLIC_URL}${r}`) !== 200);
    if (bad.length === 0) break;
    sleep(5000);
  }
  if (bad.length > 0) throw new Error(`не отвечают: ${bad.join(', ')}`);
  ok(`все ${ROUTES.length} маршрутов отвечают 200`);

  // Консоль обязана быть закрыта анониму: это и проверяем снаружи, а не
  // верим конфигурации.
  const consoleCode = probe(`${PUBLIC_URL}/console/`);
  if (consoleCode === 200) {
    throw new Error('/console/ открыта анониму — привратник не работает');
  }
  ok(`/console/ закрыта анониму (${consoleCode})`);
} catch (error) {
  deployFailed = true;
  fail(error instanceof Error ? error.message : String(error));

  step('Откат кода');
  try {
    remote(`git reset --hard ${before} --quiet`);
    remote('npm ci --no-audit --no-fund', { show: true });
    remote('npm run build', { show: true });
    remote('npm run build:console', { show: true });
    remote('systemctl restart unicorn-core unicorn-ai-gateway');
    remote('npm run web:up', { show: true });
    const back = ROUTES.filter((r) => probe(`${PUBLIC_URL}${r}`) !== 200);
    if (back.length === 0) ok(`откатились на ${before}, стенд отвечает`);
    else fail(`откатились на ${before}, но стенд отвечает не полностью: ${back.join(', ')}`);
  } catch {
    fail('ОТКАТ НЕ УДАЛСЯ — стенд требует ручного вмешательства');
  }
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
