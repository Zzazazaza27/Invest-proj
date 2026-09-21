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
 *   2. загрузка снимка в ТЕСТОВУЮ базу (`unicorn_test`), с переписыванием;
 *   3. обратный снимок уже с тестовой базы;
 *   4. пофайловое сравнение: расхождений быть не должно;
 *   5. отдельно — что в комплект не попало то, чему там не место.
 *
 * Рабочая база не меняется: в неё только читают. Меняется тестовая — она для
 * этого и существует.
 *
 *   node scripts/check-content-transfer.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = join(ROOT, 'scripts', 'content-snapshot.mjs');

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
      [
        'scoring.ai_provider_credentials',
        'integration.service_accounts',
        'integration.webhook_endpoints',
      ].some((secret) => f.startsWith(secret)),
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

  // -------------------------------------------------- 3. загрузка в тестовую базу
  let loaded = '';
  try {
    loaded = run(['load', '--dir', fromStand, '--yes', '--overwrite'], { NODE_ENV: 'test' });
    check(
      'комплект загружен в тестовую базу',
      /добавлено: \d+/.test(loaded) || /делать нечего/.test(loaded),
      (loaded.match(/добавлено: \d+, переписано: \d+/) ?? ['без изменений'])[0],
    );
  } catch (error) {
    check('комплект загружен в тестовую базу', false, String(error.message).slice(0, 200));
  }

  // Повторная загрузка ничего не меняет — иначе перенос не идемпотентен и
  // второй запуск на проде наделает дублей.
  try {
    const again = run(['load', '--dir', fromStand, '--yes', '--overwrite'], { NODE_ENV: 'test' });
    check('повторная загрузка ничего не меняет', /делать нечего/.test(again));
  } catch (error) {
    check('повторная загрузка ничего не меняет', false, String(error.message).slice(0, 160));
  }

  // ---------------------------------------------------------- 4. обратный снимок
  try {
    run(['export', '--dir', fromTest], { NODE_ENV: 'test' });
    check('обратный снимок с тестовой базы снят', existsSync(join(fromTest, 'manifest.json')));
  } catch (error) {
    check('обратный снимок с тестовой базы снят', false, String(error.message).slice(0, 160));
  }

  // -------------------------------------------------------------- 5. сравнение
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
}

console.warn(`\nпройдено: ${passed}, дефектов: ${defects.length}\n`);
process.exit(defects.length === 0 ? 0 : 1);
