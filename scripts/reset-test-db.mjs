#!/usr/bin/env node
/**
 * Сброс ТЕСТОВОЙ базы проекта до пустой: схемы приложения удаляются, роли,
 * расширения и посторонние базы не трогаются. После сброса — миграции и сиды.
 *
 * Разрешение владельца 2026-09-18 (план 0.2 §0г.6): данные локальных и
 * стендовых баз тестовые; сохранение их не должно усложнять архитектуру.
 * Сброс — не команда выката.
 *
 * Защиты (каждая — отказ до первого DROP):
 *  - имя базы передаётся явно: `--db unicorn_launch` или `--db unicorn_test`;
 *    другие имена не принимаются;
 *  - строка подключения берётся из DATABASE_URL_OWNER / DATABASE_URL_TEST и
 *    обязана указывать на ту же базу и на localhost / 127.0.0.1;
 *  - NODE_ENV=production — отказ;
 *  - без `--yes` только показывает, что будет удалено.
 *
 * Запуск:
 *   node scripts/reset-test-db.mjs --db unicorn_test --yes
 *   node scripts/reset-test-db.mjs --db unicorn_launch --yes
 * Затем:
 *   NODE_ENV=test npm run db:migrate   (для unicorn_test)
 *   npm run db:migrate                 (для unicorn_launch)
 *   node scripts/seed-application-form.mjs ; npm run demo:load
 */
import pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const ALLOWED_DBS = { unicorn_launch: 'DATABASE_URL_OWNER', unicorn_test: 'DATABASE_URL_TEST' };
/** Схемы, которые создают миграции проекта (M000, M048). Всё остальное — не наше. */
const APP_SCHEMAS = [
  'identity',
  'kyc',
  'lab',
  'investments',
  'scoring',
  'experts',
  'seasons',
  'comms',
  'billing',
  'audit',
  'integration',
  'content',
  'app',
];

const args = process.argv.slice(2);
const dbName = args[args.indexOf('--db') + 1];
const confirmed = args.includes('--yes');

if (process.env.NODE_ENV === 'production') fail('NODE_ENV=production — сброс запрещён.');
if (!dbName || !(dbName in ALLOWED_DBS)) {
  fail(`Укажите базу явно: --db ${Object.keys(ALLOWED_DBS).join(' | ')}`);
}
const envName = ALLOWED_DBS[dbName];
const url = process.env[envName];
if (!url) fail(`${envName} не задана.`);
const parsed = new URL(url);
if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
  fail(`${envName} указывает на ${parsed.hostname}: сбрасываются только локальные базы.`);
}
if (parsed.pathname.replace(/^\//, '') !== dbName) {
  fail(`${envName} ведёт в базу «${parsed.pathname.replace(/^\//, '')}», а запрошена «${dbName}».`);
}

const client = new pg.Client({ connectionString: url, application_name: 'reset-test-db' });
await client.connect();
try {
  const { rows: current } = await client.query('SELECT current_database() AS db');
  if (current[0].db !== dbName) fail(`Подключились к «${current[0].db}», ожидалась «${dbName}».`);

  const { rows: present } = await client.query(
    `SELECT nspname FROM pg_namespace WHERE nspname = ANY($1) ORDER BY nspname`,
    [APP_SCHEMAS],
  );
  const { rows: migrations } = await client.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'schema_migrations') AS has`,
  );
  console.warn(`База: ${dbName} @ ${parsed.hostname}:${parsed.port}`);
  console.warn(`Схемы приложения к удалению: ${present.map((r) => r.nspname).join(', ') || '—'}`);
  console.warn(`Реестр миграций public.schema_migrations: ${migrations[0].has ? 'есть' : 'нет'}`);
  console.warn(
    'Не трогаются: роли, расширения, схема public (кроме реестра), другие базы; у pg_partman чистится только конфигурация наших таблиц.',
  );

  if (!confirmed) {
    console.warn('\nПробный запуск. Добавьте --yes для выполнения.');
    process.exit(0);
  }

  // Остальные подключения к этой базе (ядро, тесты) мешают DROP SCHEMA:
  // просим их закрыться; отказ в праве — не ошибка, DROP тогда сам скажет.
  await client
    .query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    )
    .catch(() => undefined);

  await client.query('BEGIN');
  for (const schema of present.map((r) => r.nspname)) {
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
  }
  await client.query('DROP TABLE IF EXISTS public.schema_migrations');
  // pg_partman помнит партиционированные таблицы наших схем (audit.events) в
  // своей схеме partman: без чистки повторный M001 упадёт на create_parent.
  // Само расширение и схема partman остаются.
  const { rows: partman } = await client.query(
    `SELECT 1 FROM pg_namespace WHERE nspname = 'partman'`,
  );
  if (partman.length > 0) {
    const { rows: configs } = await client.query(
      `SELECT parent_table, template_table FROM partman.part_config
        WHERE split_part(parent_table, '.', 1) = ANY($1)`,
      [APP_SCHEMAS],
    );
    for (const row of configs) {
      if (row.template_table) await client.query(`DROP TABLE IF EXISTS ${row.template_table}`);
      await client.query(`DELETE FROM partman.part_config_sub WHERE sub_parent = $1`, [
        row.parent_table,
      ]);
      await client.query(`DELETE FROM partman.part_config WHERE parent_table = $1`, [
        row.parent_table,
      ]);
    }
    console.warn(
      `Конфигурация pg_partman очищена: ${configs.map((r) => r.parent_table).join(', ') || '—'}`,
    );
  }
  // Умолчания привилегий на уровне базы (pg_default_acl без схемы) переживают
  // DROP SCHEMA: M032 отбирает у PUBLIC право EXECUTE на новые функции, и на
  // сброшенной базе повторный M002 создал бы функции, которые app_backend не
  // может вызвать (на живой базе M002 шёл ДО M032). Возвращаем умолчания к
  // исходным, чтобы миграции повторились как на новой базе.
  const { rows: defaults } = await client.query(
    `SELECT r.rolname, d.defaclobjtype AS kind FROM pg_default_acl d
       JOIN pg_roles r ON r.oid = d.defaclrole
      WHERE d.defaclnamespace = 0`,
  );
  for (const row of defaults) {
    const role = client.escapeIdentifier(row.rolname);
    if (row.kind === 'f') {
      await client.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${role} GRANT EXECUTE ON FUNCTIONS TO PUBLIC`,
      );
    } else if (row.kind === 'T') {
      await client.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${role} GRANT USAGE ON TYPES TO PUBLIC`,
      );
    } else {
      console.warn(
        `  внимание: умолчание привилегий типа ${row.kind} для ${row.rolname} не сброшено — проверьте вручную`,
      );
    }
  }
  if (defaults.length > 0) {
    console.warn(
      `Умолчания привилегий базы возвращены к исходным: ${defaults.map((r) => `${r.rolname}/${r.kind}`).join(', ')}`,
    );
  }
  await client.query('COMMIT');
  console.warn(`\nГотово: ${dbName} пуста. Далее — миграции и сиды (см. шапку скрипта).`);
} finally {
  await client.end();
}

function fail(message) {
  console.error(message);
  process.exit(1);
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
