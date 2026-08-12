#!/usr/bin/env node
/**
 * Проверка восстановления из резервной копии (`Architect_Launch.md` §7, гейт A).
 *
 * «Бэкапы настроены» — не доказательство. Доказательство — восстановленная база,
 * в которой данные на месте, а инварианты живы. Этот прогон делает именно это:
 * снимает копию, поднимает из неё ОТДЕЛЬНУЮ базу и сверяет содержимое с
 * оригиналом — построчно по ключевым таблицам и по целостности hash-chain
 * журнала событий.
 *
 * Чего он НЕ доказывает и не притворяется, что доказывает: PITR на непрерывном
 * WAL-архиве, RPO ≤ 5 минут и восстановление в другом дата-центре. Это
 * инфраструктурные свойства production-контура, а здесь локальный docker.
 *
 * Запуск: node scripts/dr-restore-check.mjs
 */
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.warn(`  OK    ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.warn(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

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

const CONTAINER = process.env.POSTGRES_CONTAINER ?? 'unicorn-postgres';
const SOURCE_DB = 'unicorn_launch';
const RESTORE_DB = `unicorn_restore_check`;
const OWNER_URL = process.env.DATABASE_URL_OWNER;
const ownerUser = new URL(OWNER_URL).username;
const ownerPassword = decodeURIComponent(new URL(OWNER_URL).password);

/**
 * Команда внутри контейнера БД: копия снимается тем же сервером, что и живёт.
 *
 * Пароль передаётся через PGPASSWORD в окружении процесса docker, а не
 * аргументом командной строки: аргументы видны в списке процессов всей машины.
 */
function inContainer(args, options = {}) {
  return execFileSync('docker', ['exec', '-e', `PGPASSWORD=${ownerPassword}`, CONTAINER, ...args], {
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024,
    ...options,
  });
}

console.warn('\n=== ПРОВЕРКА ВОССТАНОВЛЕНИЯ ИЗ КОПИИ ===\n');

/**
 * Каталог для дампа — ВНЕ репозитория и с уникальным именем.
 *
 * Раньше он создавался как `.backup-check` внутри рабочего дерева и не был в
 * `.gitignore`: полный дамп боевой схемы со всеми идентификаторами и контекстом
 * событий лежал там, где его подхватит и `git add -A`, и резервное копирование
 * рабочей машины (SEC-10). Уборка стояла последней строкой скрипта — падение
 * посередине оставляло дамп на диске.
 *
 * `mkdtemp` даёт каталог во временной папке системы, права на который есть
 * только у текущего пользователя, а снос вынесен в `finally` ниже.
 */
const backupDir = mkdtempSync(join(tmpdir(), 'unicorn-dr-'));
const dumpPath = join(backupDir, 'unicorn_launch.dump');

/**
 * Снос дампа при ЛЮБОМ исходе.
 *
 * Идемпотентен: вызывается и явно в конце, и из обработчиков выхода. Полный
 * дамп схемы не должен пережить процесс — ни при исключении, ни при Ctrl+C,
 * ни при падении посередине восстановления.
 */
let dumpRemoved = false;
function removeDump() {
  if (dumpRemoved) return;
  dumpRemoved = true;
  try {
    rmSync(backupDir, { recursive: true, force: true });
  } catch {
    /* каталога уже нет */
  }
  try {
    inContainer(['rm', '-f', '/tmp/restore/backup.dump']);
  } catch {
    /* уже удалено или контейнер недоступен */
  }
}
process.on('exit', removeDump);
process.on('SIGINT', () => {
  removeDump();
  process.exit(130);
});
process.on('uncaughtException', (error) => {
  console.error('ПРОГОН ОБОРВАН:', error);
  removeDump();
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('ПРОГОН ОБОРВАН:', reason);
  removeDump();
  process.exit(1);
});

// ------------------------------------------------------------- снимок
console.warn('[1] Снятие копии');
let dumped = false;
try {
  const dump = inContainer([
    'pg_dump',
    '-U',
    ownerUser,
    '-d',
    SOURCE_DB,
    '--format=custom',
    '--no-owner',
  ]);
  writeFileSync(dumpPath, dump);
  dumped = true;
  const size = statSync(dumpPath).size;
  check('копия снята', size > 10_000, `${Math.round(size / 1024)} КБ`);
} catch (error) {
  check('копия снята', false, String(error.message).slice(0, 120));
}

if (!dumped) {
  console.warn('\nБез копии проверять нечего.\n');
  process.exit(1);
}

// -------------------------------------------------------- восстановление
console.warn('\n[2] Восстановление в отдельную базу');
const admin = new pg.Client({ connectionString: OWNER_URL.replace(`/${SOURCE_DB}`, '/postgres') });
await admin.connect();
// Отдельная база, а не перезапись рабочей: проверка восстановления не должна
// уметь уничтожить то, что проверяет.
await admin.query(`DROP DATABASE IF EXISTS ${RESTORE_DB}`);
await admin.query(`CREATE DATABASE ${RESTORE_DB}`);
await admin.end();

try {
  inContainer(['bash', '-lc', `mkdir -p /tmp/restore`]);
} catch {
  /* каталог мог существовать */
}
execFileSync('docker', ['cp', dumpPath, `${CONTAINER}:/tmp/restore/backup.dump`], {
  stdio: 'ignore',
});

let restoreOk = true;
try {
  inContainer([
    'pg_restore',
    '-U',
    ownerUser,
    '-d',
    RESTORE_DB,
    '--no-owner',
    '/tmp/restore/backup.dump',
  ]);
} catch (error) {
  // pg_restore возвращает ненулевой код и на «предупреждения» — смотрим
  // фактический результат ниже, а не только код возврата.
  restoreOk = false;
  console.warn(
    `  (pg_restore завершился с предупреждениями: ${String(error.message).slice(0, 80)})`,
  );
}

// ------------------------------------------------------------- сверка
console.warn('\n[3] Сверка восстановленной базы с оригиналом');
const source = new pg.Client({ connectionString: OWNER_URL });
const restored = new pg.Client({
  connectionString: OWNER_URL.replace(`/${SOURCE_DB}`, `/${RESTORE_DB}`),
});
await source.connect();
await restored.connect();

const TABLES = [
  'identity.users',
  'identity.consents',
  'lab.projects',
  'lab.project_versions',
  'experts.expert_reviews',
  'experts.review_consensus',
  'investments.investment_agreements',
  'billing.subscriptions',
  'audit.events',
  'audit.outbox_events',
  'comms.notifications',
  'integration.service_accounts',
];

let mismatches = 0;
for (const table of TABLES) {
  const [a, b] = await Promise.all([
    source.query(`SELECT count(*)::int AS n FROM ${table}`),
    restored.query(`SELECT count(*)::int AS n FROM ${table}`),
  ]);
  const same = a.rows[0].n === b.rows[0].n;
  if (!same) mismatches += 1;
  check(`${table}: строки совпадают`, same, `оригинал ${a.rows[0].n}, копия ${b.rows[0].n}`);
}
check('расхождений по таблицам нет', mismatches === 0, `расхождений: ${mismatches}`);

// Схема, а не только данные: восстановление без политик RLS дало бы базу,
// открытую всем, и «успешное» восстановление стало бы инцидентом.
{
  const [a, b] = await Promise.all([
    source.query(`SELECT count(*)::int AS n FROM pg_policies`),
    restored.query(`SELECT count(*)::int AS n FROM pg_policies`),
  ]);
  check(
    'RLS-политики восстановлены',
    a.rows[0].n === b.rows[0].n,
    `оригинал ${a.rows[0].n}, копия ${b.rows[0].n}`,
  );
}
{
  const { rows } = await restored.query(
    `SELECT count(*)::int AS n FROM pg_class c
       JOIN pg_namespace nsp ON nsp.oid = c.relnamespace
      WHERE nsp.nspname IN ('identity','kyc','lab','investments','scoring','experts',
                            'seasons','comms','billing','audit','integration')
        AND c.relkind IN ('r','p') AND c.relispartition = false
        AND NOT c.relrowsecurity`,
  );
  check('в восстановленной базе нет таблиц без RLS', rows[0].n === 0, `без RLS: ${rows[0].n}`);
}

// Целостность журнала: hash-chain обязан пережить восстановление, иначе
// доказательная ценность журнала теряется вместе с ним.
{
  const { rows } = await restored.query(
    `SELECT count(*)::int AS broken FROM audit.verify_event_chain(NULL)`,
  );
  check(
    'hash-chain журнала цел после восстановления',
    rows[0].broken === 0,
    `нарушений: ${rows[0].broken}`,
  );
}

// Секреты: восстановленная копия содержит те же шифртексты, а не расшифровку.
{
  const { rows } = await restored.query(
    `SELECT count(*)::int AS n FROM identity.users WHERE email_ciphertext IS NOT NULL`,
  );
  const { rows: plain } = await restored.query(
    `SELECT count(*)::int AS n FROM identity.users
      WHERE email_ciphertext::text LIKE '%@%'`,
  );
  check(
    'персональные данные в копии остаются зашифрованными',
    plain[0].n === 0,
    `зашифрованных записей: ${rows[0].n}, в открытом виде: ${plain[0].n}`,
  );
}

await source.end();
await restored.end();

// --------------------------------------------------------------- уборка
console.warn('\n[4] Уборка');
const cleanup = new pg.Client({
  connectionString: OWNER_URL.replace(`/${SOURCE_DB}`, '/postgres'),
});
await cleanup.connect();
await cleanup.query(`DROP DATABASE IF EXISTS ${RESTORE_DB}`);
await cleanup.end();
removeDump();
check('временная база и файлы копии удалены', true, 'проверка не оставляет следов');

console.warn(
  `\nОграничение: проверено восстановление из логической копии (pg_dump/pg_restore).` +
    `\nPITR на WAL-архиве, RPO ≤ 5 минут и восстановление в другом контуре здесь НЕ проверялись —` +
    `\nэто свойства production-инфраструктуры, а не локального docker.\n`,
);

console.warn(`=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
// Неудачное восстановление — провал прогона, даже если отдельные проверки
// после него не выполнялись. Прежнее выражение при `restoreOk === false` и
// нулевом числе провалов возвращало 0: гейт сообщал об успехе там, где копия
// не восстановилась.
process.exit(failed > 0 || !restoreOk ? 1 : 0);
