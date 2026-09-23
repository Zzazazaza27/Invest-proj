#!/usr/bin/env node
/**
 * Временный контур для прогонов, меняющих общие справочники.
 *
 * ЗАЧЕМ. Часть браузерных проходов создаёт записи, которые нельзя удалить по
 * устройству: опубликованная версия анкеты неизменяема, политика страны
 * меняется только новой версией, версия условий вознаграждения — тоже.
 * Убрать их за собой прогон не может, а ослаблять неизменяемость ради
 * проверок нельзя. Значит нужна СВОЯ база, которая после прогона удаляется
 * целиком — вместе со всем, что в ней появилось.
 *
 * ЧТО ПОДНИМАЕТСЯ И ЧТО НЕТ. Выделяется ровно то, что прогон меняет или чем
 * может задеть рабочий стенд:
 *
 *   * СВОЯ база — прогон пишет в справочники;
 *   * СВОЁ ядро на отдельном порту — чтобы писало в эту базу;
 *   * СВОЯ точка входа — чтобы браузер ходил в это ядро.
 *
 * Общими остаются то, что прогоны только читают или чего не касаются вовсе:
 * хранилище объектов, счётчик частоты, брокер. Поднимать их копии значило бы
 * городить вторую платформу ради нескольких проверок — владелец прямо сказал,
 * что постоянная вторая платформа не нужна.
 *
 * ВНЕШНИЕ КАНАЛЫ ЗАКРЫТЫ ЖЁСТКО. Почта — `none`, вебхуки — `capture`,
 * платежи — тестовые. Временный контур не должен уметь отправить наружу
 * ничего, даже если прогон этого попросит.
 *
 * СБОРКА ИНТЕРФЕЙСА ТА ЖЕ. Фронтенды собраны с относительным адресом API
 * (`/v1`), поэтому одна и та же статика работает на любом origin: страница
 * спрашивает API там, откуда её открыли. Пересобирать ничего не нужно.
 *
 * Команды:
 *   node scripts/temp-stand.mjs up     поднять и напечатать адрес
 *   node scripts/temp-stand.mjs down   погасить и удалить базу
 *   node scripts/temp-stand.mjs status что сейчас поднято
 */
import pg from 'pg';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = join(ROOT, '.local', 'temp-stand');
const PID_FILE = join(STATE_DIR, 'core.pid');
const LOG_FILE = join(STATE_DIR, 'core.log');
loadDotEnv();

function loadDotEnv() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) process.env[trimmed.slice(0, eq).trim()] ??= trimmed.slice(eq + 1).trim();
  }
}

/** Имена и порты жёсткие: переменная позволила бы задеть рабочий стенд. */
const DB_NAME = 'unicorn_temp_stand';
const CORE_PORT = 4302;
const WEB_PORT = 8081;
const COMPOSE = ['-f', join(ROOT, 'infra', 'docker-compose.yml'), '--env-file', join(ROOT, '.env')];

const command = process.argv[2] ?? 'status';

function ownerUrl(database) {
  const url = new URL(process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL);
  url.pathname = `/${database}`;
  return url.href;
}

/**
 * Все адреса базы — на временную, но КАЖДЫЙ СВОЕЙ РОЛЬЮ.
 *
 * Первая версия подставляла ядру владельца базы. Контур поднимался, экраны
 * работали — и `smoke-lab` дал девять отказов подряд: «чужой проект
 * читается», «чужой проект изменяется». Продукт был ни при чём: владелец
 * базы ОБХОДИТ RLS, и построчные политики на временном контуре просто не
 * применялись. Проверка изоляции на таком контуре ничего не проверяет, зато
 * выглядит красной — худший вид ложного сигнала.
 *
 * Поэтому меняется только имя базы, а роль в каждом адресе остаётся своя:
 * ядро ходит `app_backend_user`, как на рабочем стенде, и границы доступа
 * ведут себя одинаково.
 */
function databaseUrlsForTemp() {
  const out = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^DATABASE_URL(_|$)/.test(key) || !value) continue;
    try {
      const url = new URL(value);
      url.pathname = `/${DB_NAME}`;
      out[key] = url.href;
    } catch {
      /* не адрес — не трогаем */
    }
  }
  return out;
}

async function withAdmin(work) {
  const client = new pg.Client({ connectionString: ownerUrl('postgres') });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

function run(cmd, args, env = {}) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    shell: cmd === 'npm',
  });
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

async function up() {
  mkdirSync(STATE_DIR, { recursive: true });
  console.warn('\n=== ВРЕМЕННЫЙ КОНТУР ===\n');

  // 1. База с нуля. Существующую сносим: контур на то и временный.
  await withAdmin(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${DB_NAME}`);
  });
  console.warn(`  ok    база создана: ${DB_NAME}`);

  const dbUrl = ownerUrl(DB_NAME);
  const migrated = run('npm', ['run', 'db:migrate'], {
    DATABASE_URL_OWNER: dbUrl,
    DATABASE_URL: dbUrl,
  });
  if (!migrated.ok) {
    console.error(`  ДЕФЕКТ миграции не применились:\n${migrated.out.slice(-600)}`);
    process.exit(1);
  }
  console.warn('  ok    миграции применены');

  /*
   * Анкета заявки — предусловие, а не данные: без активной версии мастер
   * заявки не открывается вовсе, и прогон проверял бы пустой экран.
   * Загружается отдельным скриптом, как на обычном стенде.
   */
  const form = run('node', [join(ROOT, 'scripts', 'seed-application-form.mjs')], {
    DATABASE_URL_OWNER: dbUrl,
    DATABASE_URL: dbUrl,
  });
  console.warn(
    form.ok
      ? '  ok    стартовая версия анкеты заведена'
      : `  ДЕФЕКТ анкета не завелась:\n${form.out.slice(-400)}`,
  );
  if (!form.ok) process.exit(1);

  /*
   * Учётные записи нужны: браузерные проходы входят demo-администратором.
   * Комплект грузится тот же, что на стенде, — иначе прогон проверял бы
   * пустоту вместо продукта.
   */
  const seeded = run('node', [join(ROOT, 'scripts', 'seed-demo.mjs'), 'load'], {
    DATABASE_URL_OWNER: dbUrl,
    DATABASE_URL: dbUrl,
  });
  console.warn(
    seeded.ok
      ? '  ok    демонстрационный комплект загружен'
      : `  ДЕФЕКТ комплект не загрузился:\n${seeded.out.slice(-400)}`,
  );
  if (!seeded.ok) process.exit(1);

  // 2. Конфиг точки входа: тот же шаблон, но с портом временного ядра.
  const template = readFileSync(join(ROOT, 'infra', 'nginx', 'temp-stand.conf.template'), 'utf8');
  writeFileSync(
    join(STATE_DIR, 'nginx.conf'),
    template.replaceAll('${TEMP_CORE_PORT}', String(CORE_PORT)),
    'utf8',
  );

  /*
   * 3. Ядро временного контура. Внешние каналы закрыты жёстко.
   *
   * Журнал пишется СРАЗУ В ФАЙЛ, а не через потоки процесса-родителя.
   * Первая версия слушала stdout и stderr — и команда `temp:up` не
   * завершалась никогда: узлы потоков держали событийный цикл живым, хотя
   * контур уже был поднят. Снаружи это выглядело как зависание.
   */
  /*
   * ПОРТ ОСВОБОЖДАЕТСЯ ДО ЗАПУСКА.
   *
   * Гашение убивало ядро по записанному PID. Если ядро когда-то стартовало
   * мимо этой записи (два подъёма подряд, оборванная команда), старый
   * процесс оставался жив и держал порт. Новое ядро тогда просто не
   * поднималось, а проверка здоровья отвечала 200 — от СТАРОГО, с прежними
   * настройками и прежней базой. Контур выглядел свежим и таковым не был:
   * `smoke-lab` дал девять отказов изоляции, потому что отвечало ядро,
   * ходившее в базу владельцем.
   *
   * Поэтому порт освобождается явно, до запуска, кто бы его ни занимал.
   */
  killPort(CORE_PORT);

  const logFd = openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [join(ROOT, 'apps', 'core', 'dist', 'main.js')], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      CORE_PORT: String(CORE_PORT),
      ...databaseUrlsForTemp(),
      DATABASE_URL_OWNER: dbUrl,
      MAIL_TRANSPORT: 'none',
      WEBHOOK_DELIVERY_MODE: 'capture',
      PAYMENTS_MODE: 'test',
    },
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid), 'utf8');

  const healthy = await waitFor(`http://127.0.0.1:${CORE_PORT}/v1/health`, 60_000);
  if (!healthy) {
    console.error(`  ДЕФЕКТ ядро не поднялось. Журнал: ${LOG_FILE}`);
    await down();
    process.exit(1);
  }
  console.warn(`  ok    ядро временного контура на ${CORE_PORT}`);

  // 4. Точка входа.
  const web = run('docker', [
    'compose',
    ...COMPOSE,
    '--profile',
    'testing',
    'up',
    '-d',
    'web-test',
  ]);
  if (!web.ok) {
    console.error(`  ДЕФЕКТ точка входа не поднялась:\n${web.out.slice(-400)}`);
    await down();
    process.exit(1);
  }
  const entry = await waitFor(`http://127.0.0.1:${WEB_PORT}/v1/health`, 60_000);
  console.warn(
    entry
      ? `  ok    точка входа: http://127.0.0.1:${WEB_PORT}`
      : '  ДЕФЕКТ точка входа не отвечает',
  );
  if (!entry) {
    await down();
    process.exit(1);
  }

  console.warn('\n  Запуск прогона на временном контуре:');
  console.warn(
    `    UNICORN_ENTRY=web WEB_PORT=${WEB_PORT} CORE_PORT=${CORE_PORT} \\\n` +
      '      node scripts/render-check-<имя>.mjs\n',
  );
  console.warn(`  Погасить: node scripts/temp-stand.mjs down\n`);
}

/**
 * Убить всё, что слушает порт.
 *
 * Не «на всякий случай»: временный контур обязан быть ИМЕННО тем, что
 * только что подняли. Чужое ядро на его порту — это молчаливая подмена
 * окружения, а не мелкое неудобство.
 */
function killPort(port) {
  if (process.platform === 'win32') {
    const found = run('netstat', ['-ano']);
    const pids = new Set();
    for (const line of found.out.split('\n')) {
      const m = line.match(/TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m && Number(m[1]) === port) pids.add(m[2]);
    }
    for (const pid of pids) {
      run('taskkill', ['/PID', pid, '/T', '/F']);
      console.warn(`  ok    порт ${port} освобождён (процесс ${pid})`);
    }
    return;
  }
  const found = run('lsof', ['-ti', `tcp:${port}`]);
  for (const pid of found.out
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)) {
    try {
      process.kill(Number(pid), 'SIGKILL');
      console.warn(`  ok    порт ${port} освобождён (процесс ${pid})`);
    } catch {
      /* уже мёртв */
    }
  }
}

async function waitFor(url, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.status === 200) return true;
    } catch {
      /* ещё не поднялось */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function down() {
  console.warn('\n=== ГАШЕНИЕ ВРЕМЕННОГО КОНТУРА ===\n');
  run('docker', ['compose', ...COMPOSE, '--profile', 'testing', 'rm', '-sf', 'web-test']);
  console.warn('  ok    точка входа остановлена');

  if (existsSync(PID_FILE)) {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    if (Number.isFinite(pid)) {
      // На Windows дерево процессов гасится через taskkill: process.kill
      // оставляет потомков.
      if (process.platform === 'win32') run('taskkill', ['/PID', String(pid), '/T', '/F']);
      else {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* уже мёртв */
        }
      }
    }
    rmSync(PID_FILE, { force: true });
    console.warn('  ok    ядро остановлено');
  }
  // И всё, что осталось на порту помимо записанного PID: см. killPort.
  killPort(CORE_PORT);

  await withAdmin(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  });
  console.warn(`  ok    база удалена: ${DB_NAME}\n`);
}

async function status() {
  const core = await waitFor(`http://127.0.0.1:${CORE_PORT}/v1/health`, 2000);
  const web = await waitFor(`http://127.0.0.1:${WEB_PORT}/v1/health`, 2000);
  const db = await withAdmin(async (client) => {
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
    return rows.length > 0;
  });
  console.warn('\n=== ВРЕМЕННЫЙ КОНТУР ===\n');
  console.warn(`  база ${DB_NAME}: ${db ? 'есть' : 'нет'}`);
  console.warn(`  ядро ${CORE_PORT}: ${core ? 'отвечает' : 'нет'}`);
  console.warn(`  вход ${WEB_PORT}: ${web ? 'отвечает' : 'нет'}\n`);
}

if (command === 'up') await up();
else if (command === 'down') await down();
else await status();
