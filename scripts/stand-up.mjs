#!/usr/bin/env node
/**
 * Поднять локальный стенд одной командой.
 *
 * Последовательность одна и та же каждый раз: починить сокет Docker, дождаться
 * демона, поднять контейнеры, накатить миграции, создать стрим NATS, запустить
 * ядро, поднять единую точку входа, проверить маршруты. Семь шагов, каждый со
 * своими граблями — и всё это выполнялось вручную при каждом запуске.
 *
 * Шаги идемпотентны: поднятое не трогается, недостающее добавляется. Повторный
 * запуск на работающем стенде безопасен и заканчивается проверкой.
 *
 * Запуск:
 *   npm run stand:up              поднять и проверить
 *   npm run stand:up -- --check   только проверить, ничего не поднимая
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CHECK_ONLY = process.argv.includes('--check');

const ROUTES = [
  '/',
  '/login/',
  '/lab/',
  '/investor/',
  '/expert/',
  '/admin/',
  '/console/',
  '/v1/health',
];

const t0 = Date.now();
const step = (text) => console.warn(`\n▸ ${text}`);
const ok = (text) => console.warn(`  ok    ${text}`);
const warn = (text) => console.warn(`  прим. ${text}`);
const fail = (text) => console.error(`  СБОЙ  ${text}`);

/** Выполнить и вернуть stdout; при ошибке — null, чтобы шаг решал сам. */
let lastError = '';
function run(cmd, { quiet = true } = {}) {
  try {
    lastError = '';
    return execSync(cmd, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
  } catch (error) {
    // Причину сбоя надо показать, а не проглотить: «контейнеры не поднялись»
    // без текста ошибки отправляет разбираться с нуля.
    lastError = [error?.stderr, error?.stdout, error?.message]
      .filter(Boolean)
      .join('\n')
      .trim()
      .split('\n')
      .slice(-4)
      .join('\n');
    return null;
  }
}

/**
 * Готовность демона. `docker info` начинает отвечать РАНЬШЕ, чем движок
 * принимает команды: первый запуск stand:up словил «демон поднялся за 5 с» и
 * тут же провалился на контейнерах. Поэтому спрашиваем ещё и `docker ps` —
 * команду, которая реально ходит в движок.
 */
const dockerAlive = () =>
  run('docker info --format "{{.ServerVersion}}"') !== null && run('docker ps --quiet') !== null;

/** Пауза без внешних зависимостей: Atomics.wait блокирует поток. */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Запрос к стенду средствами Node, а не через `curl`.
 *
 * На Windows `curl` в PowerShell — псевдоним Invoke-WebRequest, и флаги
 * `-s -o /dev/null -w` он не понимает: первая версия проверки получала «нет
 * ответа» на всех маршрутах при полностью работающем стенде.
 *
 * Синхронность нужна, чтобы шаги шли по порядку: запрос делает отдельный
 * процесс Node, результат приходит строкой.
 */
function probe(url) {
  const script = [
    'const c = new AbortController();',
    'const t = setTimeout(() => c.abort(), 10000);',
    'fetch(process.argv[1], { signal: c.signal })',
    '  .then((r) => process.stdout.write(String(r.status)))',
    "  .catch(() => process.stdout.write('0'))",
    '  .finally(() => clearTimeout(t));',
  ].join('');
  const out = spawnSync(process.execPath, ['-e', script, url], {
    encoding: 'utf8',
    timeout: 20000,
  });
  return { code: Number((out.stdout || '0').trim()) || 0 };
}

function ensureDocker() {
  step('Docker');
  if (dockerAlive()) {
    ok(`демон уже работает (${run('docker info --format "{{.ServerVersion}}"').trim()})`);
    return true;
  }

  // Залипший сокет секрет-движка — самая частая причина, по которой Docker
  // не стартует вовсе. Чиним ДО запуска, иначе он упадёт окном с ошибкой.
  const fix = spawnSync(process.execPath, [resolve(ROOT, 'scripts/fix-docker-socket.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  for (const line of (fix.stderr || '').trim().split('\n').filter(Boolean)) {
    console.warn(`  ${line}`);
  }

  if (process.platform === 'win32') {
    const exe = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';
    if (!existsSync(exe)) {
      fail('Docker Desktop не найден — запустите вручную');
      return false;
    }
    run(`powershell -NoProfile -Command "Start-Process '${exe}'"`);
    warn('Docker Desktop запущен, жду демона (до 4 минут)');
  } else {
    fail('демон Docker не отвечает — запустите его сами');
    return false;
  }

  for (let i = 0; i < 48; i += 1) {
    sleep(5000);
    if (dockerAlive()) {
      ok(`демон поднялся за ~${(i + 1) * 5} с`);
      return true;
    }
  }
  fail('демон не поднялся за 4 минуты');
  return false;
}

function infra() {
  step('Инфраструктура');
  if (run('node scripts/infra.mjs up') === null) {
    fail('контейнеры не поднялись');
    if (lastError) console.error(lastError.replace(/^/gm, '        '));
    return false;
  }
  const ps = run('docker ps --format "{{.Names}}"') || '';
  ok(`контейнеров работает: ${ps.trim().split('\n').filter(Boolean).length}`);
  return true;
}

function migrate() {
  step('Миграции');
  const out = run('npm run db:migrate');
  if (out === null) {
    fail('миграции не прошли — запустите `npm run db:migrate` и прочтите вывод');
    return false;
  }
  // npm печатает в stdout только заголовок «> команда», а сам скрипт пишет в
  // stderr — поэтому ищем осмысленную строку, а не берём последнюю подряд.
  const said = (out.match(/^(Миграции актуальны.*|Готово\..*|Применено.*)$/m) || [])[0];
  ok(said || 'применены');
  return true;
}

function nats() {
  step('Поток событий NATS');
  if (run('node scripts/nats-init-stream.mjs') === null) {
    warn('стрим создать не удалось — события будут копиться в outbox');
  } else {
    ok('стрим LAUNCH готов');
  }
  return true;
}

function core() {
  step('Ядро');
  if (probe('http://127.0.0.1:4300/v1/health').code === 200) {
    ok('уже работает на :4300');
    return true;
  }
  const out = run('node scripts/dev-core.mjs --detached');
  if (out === null) {
    fail('ядро не запустилось — смотрите core.log');
    return false;
  }
  const pid = /pid (\d+)/.exec(out)?.[1];
  ok(`запущено${pid ? `, pid ${pid}` : ''}, лог core.log`);
  return true;
}

function web() {
  step('Единая точка входа');
  if (run('node scripts/infra.mjs web-up') === null) {
    fail('прокси не поднялся — возможно, занят порт 80');
    if (lastError) console.error(lastError.replace(/^/gm, '        '));
    return false;
  }
  ok('nginx раздаёт витрину и кабинеты');
  return true;
}

/** Ядру нужно время на старт: первые секунды маршруты отвечают отказом. */
function check() {
  step('Проверка');
  let bad = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    bad = [];
    for (const route of ROUTES) {
      const { code } = probe(`http://127.0.0.1${route}`);
      if (code !== 200) bad.push(`${route} → ${code || 'нет ответа'}`);
    }
    if (bad.length === 0) break;
    sleep(2500);
  }

  if (bad.length > 0) {
    for (const b of bad) fail(b);
    return false;
  }
  ok(`все ${ROUTES.length} маршрутов отвечают 200`);
  ok('база отвечает — /v1/health вернул 200');
  return true;
}

// ---------------------------------------------------------------- выполнение

if (CHECK_ONLY) {
  const good = check();
  console.warn(good ? '\nСтенд работает: http://127.0.0.1/\n' : '\nСтенд НЕ работает\n');
  process.exit(good ? 0 : 1);
}

const steps = [ensureDocker, infra, migrate, nats, core, web, check];
for (const fn of steps) {
  const good = fn();
  if (!good) {
    console.error(`\nОстановился на шаге «${fn.name}». Стенд поднят не полностью.\n`);
    process.exit(1);
  }
}

console.warn(`
Стенд поднят за ${Math.round((Date.now() - t0) / 1000)} с.

  http://127.0.0.1/         витрина
  http://127.0.0.1/login/   вход — учётки demo-* из
                            docs/product/чек-лист-сценариев.md
  http://127.0.0.1/console/ служебная консоль

Остановить: npm run web:down && npm run infra:down
`);
