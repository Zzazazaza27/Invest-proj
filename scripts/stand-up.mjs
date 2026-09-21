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
 *   npm run stand:up                поднять и проверить
 *   npm run stand:up -- --no-build  без пересборки статики (быстрее)
 *   npm run stand:up -- --check     только проверить, ничего не поднимая
 *
 * Останавливается командой `npm run stand:down`, состояние показывает
 * `npm run stand:status`.
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { PORTS } from './lib/ports.mjs';
import { commandLine, portOwner, stopTree } from './lib/stand-processes.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const CHECK_ONLY = process.argv.includes('--check');
const NO_BUILD = process.argv.includes('--no-build');
/** Перезапустить ядро, даже если оно уже отвечает: подхватить новую сборку. */
const RESTART_CORE = process.argv.includes('--restart-core');

/**
 * Маршруты и ожидаемый ответ БЕЗ входа.
 *
 * Служебная консоль анониму отвечает 404 — так решает привратник
 * `auth_request` (`infra/nginx/default.conf`): её прячут ролью, а не
 * отдельным контуром. Проверка, ждавшая от неё 200, красила поднятый стенд в
 * красный и требовала каждый раз вспоминать, что это норма.
 */
const ROUTES = [
  ['/', 200],
  ['/login/', 200],
  ['/lab/', 200],
  ['/investor/', 200],
  ['/expert/', 200],
  ['/admin/', 200],
  ['/console/', 404],
  ['/v1/health', 200],
];

const t0 = Date.now();
const step = (text) => console.warn(`\n▸ ${text}`);
const ok = (text) => console.warn(`  ok    ${text}`);
const warn = (text) => console.warn(`  прим. ${text}`);
const fail = (text) => console.error(`  СБОЙ  ${text}`);

/** Выполнить и вернуть stdout; при ошибке — null, чтобы шаг решал сам. */
let lastError = '';
function run(cmd, { quiet = true, env } = {}) {
  try {
    lastError = '';
    return execSync(cmd, {
      cwd: ROOT,
      encoding: 'utf8',
      env: env ? { ...process.env, ...env } : process.env,
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

/**
 * Сборка приложений.
 *
 * nginx раздаёт собранные каталоги `dist`, а не проксирует на dev-серверы: локальная
 * раздача устроена ровно как боевая. Плата за это — статика должна быть
 * собрана, и собрана ИЗ ТЕКУЩЕГО кода. Молчаливо раздать вчерашнюю сборку
 * хуже, чем не раздать ничего: проверяешь одно, а работает другое.
 *
 * Пропустить можно явно (`--no-build`) — когда код не менялся и нужен быстрый
 * подъём.
 */
function build() {
  step('Сборка приложений');
  if (NO_BUILD) {
    warn('пропущена по --no-build: nginx раздаст то, что собрано сейчас');
    return true;
  }
  const t = Date.now();
  // Адрес API для ЕДИНОЙ точки входа — относительный.
  //
  // В `.env` задан `VITE_API_BASE_URL=http://localhost:4300/v1` — он нужен
  // прямому запуску dev-серверами. Собранная же статика раздаётся nginx с
  // `127.0.0.1`, и зашитый `localhost:4300` превращает каждый запрос в
  // межсайтовый: вход проходит (201), а следующий запрос получает 401,
  // потому что cookie на чужой origin не уходит. Снаружи это выглядит как
  // «админка не пускает», и искать причину идут в авторизацию.
  //
  // `/v1` подходит обоим: кабинеты берут его как есть, админка снимает
  // версию (её пути уже содержат `/v1/`).
  if (run('npm run build', { quiet: true, env: { VITE_API_BASE_URL: '/v1' } }) === null) {
    fail('сборка не прошла');
    if (lastError) console.error(lastError.replace(/^/gm, '        '));
    return false;
  }
  ok(`собрано за ${Math.round((Date.now() - t) / 1000)} с`);
  return true;
}

/**
 * Dev-серверы Vite при поднятой единой точке входа — это ВТОРОЙ стенд.
 *
 * Те же приложения, но из исходников и на своих портах. Пока они работают,
 * «проверил на стенде» перестаёт быть однозначным: половина проверок ходит на
 * :5175, половина на единый адрес, и расхождение между собранным и исходным
 * кодом видно не сразу. Поэтому они останавливаются — но только свои, по
 * командной строке.
 */
function stopDevServers() {
  step('Дубли dev-серверов');
  const ports = [
    PORTS.webPublic,
    PORTS.admin,
    PORTS.lab,
    PORTS.investor,
    PORTS.expert,
    PORTS.auth,
    PORTS.console,
  ];
  let stopped = 0;
  for (const port of ports) {
    const pid = portOwner(port);
    if (!pid) continue;
    const cmd = commandLine(pid);
    if (!cmd.toLowerCase().includes('vite')) {
      warn(`:${port} занят не dev-сервером (pid ${pid}) — оставлен`);
      continue;
    }
    stopTree(pid);
    stopped += 1;
  }
  ok(stopped === 0 ? 'нет — работает только единая точка входа' : `остановлено: ${stopped}`);
  return true;
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

/**
 * Учётные роли БД.
 *
 * Шаг появился после того, как `infra:reset` унёс тома вместе с ролями: схему
 * миграции восстановили, а `app_backend_user` — нет, и ядро молча падало с
 * «password authentication failed». Снаружи это выглядело как «стенд не
 * поднялся», и причина находилась только в core.log.
 *
 * Операция идемпотентная: роли уже есть — пароли переустанавливаются из
 * окружения, и это же чинит расхождение паролей после смены `.env`.
 */
function roles() {
  step('Учётные роли БД');
  const out = run('npm run bootstrap:roles -w database');
  if (out === null) {
    fail('роли не заведены — запустите `npm run bootstrap:roles -w database` и прочтите вывод');
    return false;
  }
  ok('созданы и пароли на месте');
  return true;
}

/**
 * Схема тестовой базы.
 *
 * Тесты схемы работают против отдельной базы `unicorn_test` — RLS и триггеры
 * моком не проверить. Базу заводит init-скрипт контейнера при создании тома,
 * но заводит ПУСТОЙ: миграции туда никто не носил. После `infra:reset` это
 * означало 271 падение подряд с «relation identity.users does not exist» —
 * выглядит как сломанная схема, хотя сломан был только порядок подготовки.
 *
 * Шаг идемпотентный: миграции уже применены — раннер скажет «актуальны».
 */
function migrateTestDb() {
  step('Схема тестовой базы');
  const out = run('npm run migrate -w database', { env: { NODE_ENV: 'test' } });
  if (out === null) {
    warn('тестовая база не обновлена — прогоны схемы (`npm run test -w database`) упадут');
    return true;
  }
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
  const alive = probe('http://127.0.0.1:4300/v1/health').code === 200;
  if (alive && RESTART_CORE) {
    // Пересобранное ядро не подхватывается само: работающий процесс держит
    // прежний код, а `stand:up` видит здоровый :4300 и идёт дальше. Со
    // стороны это выглядит как «правка не работает», и ищут её в коде.
    const pid = portOwner(4300);
    if (pid) {
      stopTree(pid);
      ok(`прежнее ядро остановлено, pid ${pid}`);
    }
  } else if (alive) {
    ok('уже работает на :4300 (перезапуск — `--restart-core`)');
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

/**
 * Шлюз анализа. Без него разбор заявки падает, и падает невнятно: маршрут
 * анализа отвечает «сервис недоступен», а причина — что процесс не запущен.
 *
 * Не блокирует подъём стенда: витрина, кабинеты и покупка работают и без
 * него. Поэтому предупреждение, а не отказ.
 */
function gateway() {
  step('Шлюз анализа');
  if (probe(`http://127.0.0.1:${PORTS.aiGateway}/healthz`).code === 200) {
    ok(`уже работает на :${PORTS.aiGateway}`);
    return true;
  }
  const venv =
    existsSync(resolve(ROOT, 'apps/ai-gateway/.venv/Scripts/python.exe')) ||
    existsSync(resolve(ROOT, 'apps/ai-gateway/.venv/bin/python'));
  if (!venv) {
    warn('венв не создан — разбор заявки работать не будет');
    warn('  python -m venv apps/ai-gateway/.venv');
    warn(
      '  apps/ai-gateway/.venv/Scripts/python -m pip install -r apps/ai-gateway/requirements.txt',
    );
    return true;
  }
  const out = run('node scripts/dev-ai-gateway.mjs --detached');
  if (out === null) {
    warn('не запустился — смотрите ai-gateway.log; разбор заявки будет недоступен');
    return true;
  }
  const pid = /pid (\d+)/.exec(out)?.[1];
  ok(`запущен${pid ? `, pid ${pid}` : ''}, лог ai-gateway.log`);
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
    for (const [route, expected] of ROUTES) {
      const { code } = probe(`http://127.0.0.1${route}`);
      if (code !== expected) {
        bad.push(`${route} → ${code || 'нет ответа'} (ожидалось ${expected})`);
      }
    }
    if (bad.length === 0) break;
    sleep(2500);
  }

  if (bad.length > 0) {
    for (const b of bad) fail(b);
    return false;
  }
  ok(`все ${ROUTES.length} маршрутов отвечают как ожидалось`);
  ok('база отвечает — /v1/health вернул 200');
  return true;
}

// ---------------------------------------------------------------- выполнение

if (CHECK_ONLY) {
  const good = check();
  console.warn(good ? '\nСтенд работает: http://127.0.0.1/\n' : '\nСтенд НЕ работает\n');
  process.exit(good ? 0 : 1);
}

const steps = [
  build,
  ensureDocker,
  infra,
  migrate,
  roles,
  migrateTestDb,
  nats,
  core,
  gateway,
  stopDevServers,
  web,
  check,
];
for (const fn of steps) {
  const good = fn();
  if (!good) {
    console.error(`\nОстановился на шаге «${fn.name}». Стенд поднят не полностью.\n`);
    process.exit(1);
  }
}

console.warn(`
Стенд поднят за ${Math.round((Date.now() - t0) / 1000)} с.

  http://127.0.0.1/          витрина
  http://127.0.0.1/login/    вход
  http://127.0.0.1/lab/      кабинет основателя
  http://127.0.0.1/investor/ кабинет инвестора
  http://127.0.0.1/expert/   кабинет эксперта
  http://127.0.0.1/admin/    админка
  http://127.0.0.1/console/  служебная консоль (только администратору)

  Учётные записи для проверки: .local/приёмка.md (вне Git)
  Пересобрать этот файл:       node scripts/seed-acceptance.mjs

Остановить:  npm run stand:down
Состояние:   npm run stand:status
`);
