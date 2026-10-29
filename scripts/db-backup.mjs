#!/usr/bin/env node
/**
 * Копия базы перед опасной работой.
 *
 * Зачем отдельной командой. Копию снимали руками и вспоминали о ней после
 * сноса: 2026-09-21 дамп перед уборкой спас разбор — без него нельзя было
 * доказать, что в словаре и ЧАВО не было ничего, кроме следов прогонов.
 * Команда, которую надо вспомнить, — команда, которую не выполнят.
 *
 * Что делает: снимает логическую копию базы стенда в `.local/backups/`
 * (каталог вне Git) и печатает путь. Ничего не удаляет и не восстанавливает.
 *
 * Копия снимается ТЕМ ЖЕ сервером, что и живёт: pg_dump запускается внутри
 * контейнера, пароль уходит переменной окружения процесса docker, а не
 * аргументом — аргументы видны в списке процессов всей машины.
 *
 *   node scripts/db-backup.mjs                  копия с меткой времени
 *   node scripts/db-backup.mjs --label до-сессий   своя пометка в имени
 *   node scripts/db-backup.mjs --list           что уже лежит
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKUPS = join(ROOT, '.local', 'backups');

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

if (process.argv.includes('--list')) {
  if (!existsSync(BACKUPS)) {
    console.warn('\n  копий пока нет\n');
    process.exit(0);
  }
  const files = readdirSync(BACKUPS)
    .filter((f) => f.endsWith('.dump'))
    .map((f) => ({ f, s: statSync(join(BACKUPS, f)) }))
    .sort((a, b) => b.s.mtimeMs - a.s.mtimeMs);
  console.warn('\n=== КОПИИ БАЗЫ ===\n');
  if (files.length === 0) console.warn('  копий пока нет');
  for (const { f, s } of files) {
    console.warn(
      `  ${s.mtime.toLocaleString('ru-RU')}  ${String(Math.round(s.size / 1024)).padStart(7)} КБ  ${f}`,
    );
  }
  console.warn('');
  process.exit(0);
}

const labelArg = process.argv.find((a) => a.startsWith('--label='));
const labelPos =
  process.argv.indexOf('--label') >= 0 ? process.argv[process.argv.indexOf('--label') + 1] : null;
const rawLabel = labelArg ? labelArg.slice('--label='.length) : labelPos;
/** В имени файла — только то, что не создаёт сюрпризов в оболочке и путях. */
const label = rawLabel ? rawLabel.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40) : null;

const OWNER_URL = process.env.DATABASE_URL_OWNER;
if (!OWNER_URL) {
  console.error('DATABASE_URL_OWNER не задан — копию снимать нечем.');
  process.exit(1);
}
const owner = new URL(OWNER_URL);
const ownerUser = owner.username;
const ownerPassword = decodeURIComponent(owner.password);
const database = owner.pathname.replace(/^\//, '') || 'fifth_element';
const CONTAINER = process.env.POSTGRES_CONTAINER ?? 'unicorn-postgres';

const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '');
const name = label ? `${stamp}-${label}.dump` : `${stamp}.dump`;
const target = join(BACKUPS, name);

mkdirSync(BACKUPS, { recursive: true });

console.warn('\n=== КОПИЯ БАЗЫ ===\n');
console.warn(`  база:  ${database}`);
console.warn(`  файл:  ${target}`);

let dump;
try {
  dump = execFileSync(
    'docker',
    [
      'exec',
      '-e',
      `PGPASSWORD=${ownerPassword}`,
      CONTAINER,
      'pg_dump',
      '-U',
      ownerUser,
      '-d',
      database,
      '--format=custom',
      '--no-owner',
    ],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 },
  );
} catch (error) {
  console.error(`\n  копия НЕ снята: ${String(error.message).slice(0, 200)}\n`);
  process.exit(1);
}

writeFileSync(target, dump);
const size = statSync(target).size;
if (size < 10_000) {
  console.error(`\n  копия подозрительно мала (${size} байт) — проверьте вывод pg_dump\n`);
  process.exit(1);
}

console.warn(`  снята: ${Math.round(size / 1024)} КБ`);
console.warn('\n  Восстановление — отдельная операция, сама не вызывается:');
console.warn(
  `  docker exec -i ${CONTAINER} pg_restore -U ${ownerUser} -d <база> --clean < ${name}\n`,
);
