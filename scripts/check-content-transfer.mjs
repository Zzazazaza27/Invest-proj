#!/usr/bin/env node
/**
 * Проверка переноса подготовленного содержимого целиком.
 *
 * Проверяется не команда, а СВОЙСТВО: содержимое, снятое с одной базы,
 * приезжает в другую тем же самым. Без такой проверки «экспорт работает»
 * означает «файлы создались» — а выяснится это на проде, где во второй базе
 * окажется второй комплект шаблонов рядом с первым.
 *
 * Как устроен прогон:
 *   1. снимок со стенда во временный каталог;
 *   2. СВЕЖАЯ база, накат всех миграций — это и есть боевая процедура:
 *      пустая база, миграции, загрузка содержимого;
 *   3. загрузка снимка в неё;
 *   4. обратный снимок уже с неё;
 *   5. пофайловое сравнение: расхождений быть не должно;
 *   6. отдельно — что в комплект не попало то, чему там не место.
 *
 * Почему своя база, а не `fifth_element_test`. Первая версия грузила комплект в
 * тестовую базу и оставляла его там: после прогона три теста схемы падали на
 * «уже есть черновик анкеты» — комплект принёс свой. Проверка, которая
 * ломает соседние проверки, чинится не уборкой за собой, а собственной
 * базой. Свежая база заодно проверяет то, чего не проверяла прежняя: что
 * содержимое встаёт на схему, поднятую с нуля.
 *
 * Рабочая и тестовая базы не меняются: из рабочей только читают.
 *
 *   node scripts/check-content-transfer.mjs
 */
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = join(ROOT, 'scripts', 'content-snapshot.mjs');

loadDotEnv();

function loadDotEnv() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

/** Своя база на один прогон: имя с pid, чтобы два прогона не мешали друг другу. */
const SCRATCH_DB = `fifth_element_content_check_${process.pid}`;
const ownerUrl = new URL(process.env.DATABASE_URL_OWNER ?? '');
const scratchUrl = new URL(ownerUrl.toString());
scratchUrl.pathname = `/${SCRATCH_DB}`;
/** Подключение к служебной базе: из неё создаём и удаляем свою. */
const adminUrl = new URL(ownerUrl.toString());
adminUrl.pathname = '/postgres';

async function withAdmin(fn) {
  const client = new pg.Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

let passed = 0;
const defects = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.warn(`  ok    ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    defects.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.error(`  ДЕФЕКТ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * Вывод снимка идёт в stderr — там ему и место: это ход работы, а не данные.
 * Проверка читает оба потока: иначе она судит по пустой строке и объявляет
 * дефектом собственную невнимательность.
 */
function run(args, env = {}) {
  const result = spawnSync('node', ['--experimental-strip-types', SNAPSHOT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0)
    throw new Error(output.trim().slice(-300) || `код возврата ${result.status}`);
  return output;
}

const workdir = mkdtempSync(join(tmpdir(), 'unicorn-content-'));
const fromStand = join(workdir, 'stand');
const fromTest = join(workdir, 'test');

console.warn('\n=== ПЕРЕНОС СОДЕРЖИМОГО ===\n');

await withAdmin(async (client) => {
  await client.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await client.query(`CREATE DATABASE ${SCRATCH_DB} OWNER ${ownerUrl.username}`);
});

try {
  // ------------------------------------------------------------- 1. снимок
  let out = '';
  try {
    out = run(['export', '--dir', fromStand]);
    check('снимок со стенда снят', /всего строк: \d+/.test(out));
  } catch (error) {
    check('снимок со стенда снят', false, String(error.message).slice(0, 160));
  }

  const files = existsSync(fromStand)
    ? readdirSync(fromStand).filter((f) => f.endsWith('.json') && f !== 'manifest.json')
    : [];
  check('в комплекте есть таблицы', files.length > 0, `${files.length} файлов`);

  const manifestPath = join(fromStand, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  check('опись снимка записана', Boolean(manifest?.exportedAt && manifest?.loadOrder));

  // ------------------------------------------- 2. чего в комплекте быть не должно
  const wholeKit = files.map((f) => readFileSync(join(fromStand, f), 'utf8')).join('\n');
  check(
    'секретных таблиц в комплекте нет',
    !files.some((f) =>
      ['integration.service_accounts', 'integration.webhook_endpoints'].some((secret) =>
        f.startsWith(secret),
      ),
    ),
  );
  check(
    'ссылок на людей в комплекте нет',
    !/"(created_by|updated_by|published_by)"\s*:/.test(wholeKit),
    'колонки авторства не выгружаются',
  );
  check(
    'следов прогонов в комплекте нет',
    !/_probe_/.test(wholeKit),
    'записи, заведённые проверками, отбираются по происхождению автора',
  );

  // ------------------------------------------- 3. свежая база и накат миграций
  const intoScratch = { DATABASE_URL_OWNER: scratchUrl.toString(), NODE_ENV: 'development' };
  const migrated = spawnSync(
    'node',
    ['--experimental-strip-types', join(ROOT, 'database', 'src', 'migrate.ts')],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...intoScratch } },
  );
  check(
    'схема поднята на пустой базе',
    migrated.status === 0,
    migrated.status === 0
      ? SCRATCH_DB
      : `${migrated.stdout ?? ''}${migrated.stderr ?? ''}`.trim().slice(-200),
  );

  // ------------------------------------------------------- 4. загрузка комплекта
  let loaded = '';
  try {
    loaded = run(['load', '--dir', fromStand, '--yes', '--overwrite'], intoScratch);
    check(
      'комплект загружен в свежую базу',
      /добавлено: \d+/.test(loaded),
      (loaded.match(/добавлено: \d+, переписано: \d+/) ?? ['ничего не добавлено'])[0],
    );
  } catch (error) {
    check('комплект загружен в свежую базу', false, String(error.message).slice(0, 200));
  }

  // Повторная загрузка ничего не меняет — иначе перенос не идемпотентен и
  // второй запуск на проде наделает дублей.
  try {
    const again = run(['load', '--dir', fromStand, '--yes', '--overwrite'], intoScratch);
    check('повторная загрузка ничего не меняет', /делать нечего/.test(again));
  } catch (error) {
    check('повторная загрузка ничего не меняет', false, String(error.message).slice(0, 160));
  }

  // ---------------------------------------------------------- 5. обратный снимок
  try {
    run(['export', '--dir', fromTest], intoScratch);
    check('обратный снимок снят', existsSync(join(fromTest, 'manifest.json')));
  } catch (error) {
    check('обратный снимок снят', false, String(error.message).slice(0, 160));
  }

  // -------------------------------------------------------------- 6. сравнение
  const different = [];
  for (const file of files) {
    const a = readFileSync(join(fromStand, file), 'utf8');
    const b = existsSync(join(fromTest, file)) ? readFileSync(join(fromTest, file), 'utf8') : null;
    if (a !== b) different.push(file);
  }
  check(
    'содержимое после переноса совпадает',
    different.length === 0,
    different.length === 0 ? `${files.length} таблиц` : `различаются: ${different.join(', ')}`,
  );
} finally {
  rmSync(workdir, { recursive: true, force: true });
  // База одноразовая: оставлять её значит копить мусор в кластере и однажды
  // подключиться к ней вместо рабочей.
  await withAdmin(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  });
}

console.warn(`\nпройдено: ${passed}, дефектов: ${defects.length}\n`);
process.exit(defects.length === 0 ? 0 : 1);
