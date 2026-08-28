#!/usr/bin/env node
/**
 * Удаление тестовой учётной записи из базы — по решению владельца 2026-08-28
 * (учётка `ssurgut`, все пять ролей сразу).
 *
 * Почему скрипт, а не `DELETE FROM identity.users`: на `identity.users`
 * ссылаются 46 внешних ключей, и **ни один не объявляет ON DELETE**. По
 * умолчанию это NO ACTION — сервер отклонит удаление, пока жива хоть одна
 * ссылка. Список зависимостей поэтому не угадывается, а читается из каталога
 * в момент запуска: миграции добавляют таблицы, и захардкоженный список
 * устареет молча.
 *
 * ЖУРНАЛ АУДИТА НЕ ТРОГАЕТСЯ. `audit.events` append-only и связан hash-chain:
 * удаление строки рвёт цепочку, и проверка целостности после этого краснеет на
 * всей истории, а не только на удалённом. Записи журнала — следы действий, а
 * не сам пользователь; стирать их значило бы подделать журнал. Внешнего ключа
 * на `identity.users` у журнала нет по построению (`actor_id` — просто UUID),
 * поэтому удаление учётки его и не задевает: следы остаются, войти по ним
 * нельзя.
 *
 * ЧТО ОСТАЁТСЯ ПОСЛЕ УДАЛЕНИЯ: ничего, что открывает вход. Строка
 * `identity.users` с хешем пароля и зашифрованным контактом уходит целиком.
 *
 * Отказывается работать при NODE_ENV=production: в боевом контуре удаление
 * человека — отдельная процедура с основанием в журнале, а не скрипт
 * разработчика.
 *
 * Использование:
 *   node scripts/dev-remove-test-user.mjs                 # только показать
 *   node scripts/dev-remove-test-user.mjs --yes           # удалить
 *   node scripts/dev-remove-test-user.mjs --login someone --yes
 */
import pg from 'pg';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

if (process.env.NODE_ENV === 'production') {
  console.error('В production учётные записи так не удаляются.');
  process.exit(1);
}

const args = process.argv.slice(2);
const APPLY = args.includes('--yes');
const LOGIN = valueOf('--login') ?? 'ssurgut';
const EMAIL = LOGIN.includes('@') ? LOGIN : `${LOGIN}@unicorn.local`;

/** Журнал аудита: append-only и связан hash-chain, удалению не подлежит. */
const PROTECTED_SCHEMAS = new Set(['audit']);

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
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

/** Слепой индекс адреса — тот же HMAC, что заводит учётку в dev-seed-test-user. */
function blindIndex(value) {
  return createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${value.trim().toLowerCase()}`, 'utf8')
    .digest();
}

function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Неожиданное имя колонки: ${name}`);
  return `"${name}"`;
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });

const found = await pool.query(
  `SELECT id, display_name, primary_role, status, created_at, deleted_at
     FROM identity.users WHERE email_hmac = $1`,
  [blindIndex(EMAIL)],
);

if (found.rowCount === 0) {
  console.log(`Учётка ${EMAIL} в базе не найдена — удалять нечего.`);
  await pool.end();
  process.exit(0);
}

const user = found.rows[0];
console.log(`\n=== Учётка ${EMAIL} ===`);
console.log(`  id            ${user.id}`);
console.log(`  имя           ${user.display_name}`);
console.log(`  роль/статус   ${user.primary_role} / ${user.status}`);
console.log(`  создана       ${user.created_at.toISOString()}`);
console.log(`  deleted_at    ${user.deleted_at ? user.deleted_at.toISOString() : '—'}`);

// Все внешние ключи, указывающие на identity.users(id). Читаем из каталога:
// список меняется миграциями, и зафиксированный в коде устареет незаметно.
const fks = await pool.query(`
  SELECT c.conrelid::regclass::text AS table_name,
         a.attname                  AS column_name,
         n.nspname                  AS schema_name
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
   WHERE c.contype = 'f'
     AND c.confrelid = 'identity.users'::regclass
   ORDER BY 3, 1, 2`);

console.log(`\n=== Что ссылается на неё (${fks.rowCount} внешних ключей в схеме) ===`);

const withRows = [];
for (const fk of fks.rows) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM ${fk.table_name} WHERE ${quoteIdent(fk.column_name)} = $1`,
    [user.id],
  );
  if (rows[0].n > 0) {
    withRows.push({ ...fk, n: rows[0].n });
    const guard = PROTECTED_SCHEMAS.has(fk.schema_name) ? '  <- ЖУРНАЛ, не трогаем' : '';
    console.log(`  ${String(rows[0].n).padStart(6)}  ${fk.table_name}.${fk.column_name}${guard}`);
  }
}
if (withRows.length === 0) console.log('  ссылок нет');

const blocked = withRows.filter((r) => PROTECTED_SCHEMAS.has(r.schema_name));
const removable = withRows.filter((r) => !PROTECTED_SCHEMAS.has(r.schema_name));

if (!APPLY) {
  console.log('\nЭто показ без изменений. Для удаления добавь --yes.');
  await pool.end();
  process.exit(0);
}

if (blocked.length > 0) {
  // Ожидаемо недостижимо: журнал не объявляет внешнего ключа на users. Если
  // это изменится миграцией — лучше остановиться и посмотреть глазами, чем
  // выдумывать обходной путь: CHECK на таблице требует непустого контакта,
  // и «стереть всё, оставив якорь» она попросту не даст.
  const where = blocked.map((r) => `${r.table_name}: ${r.n}`).join(', ');
  console.error(`\nНа учётку ссылается защищённая схема (${where}).`);
  console.error('Удаление остановлено: разбери эти ссылки руками.');
  await pool.end();
  process.exit(1);
}

const client = await pool.connect();
let removedRows = 0;
try {
  await client.query('BEGIN');
  // Порядок: сначала всё, что ссылается, потом сама строка. Внутри одной
  // транзакции — чтобы отказ на любом шаге не оставил учётку разобранной
  // наполовину.
  for (const r of removable) {
    const res = await client.query(
      `DELETE FROM ${r.table_name} WHERE ${quoteIdent(r.column_name)} = $1`,
      [user.id],
    );
    removedRows += res.rowCount;
    console.log(`  удалено ${String(res.rowCount).padStart(6)}  ${r.table_name}`);
  }
  const res = await client.query('DELETE FROM identity.users WHERE id = $1', [user.id]);
  console.log(`  удалено ${String(res.rowCount).padStart(6)}  identity.users`);
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  console.error('\nОтказ, изменения откачены:', err.message);
  client.release();
  await pool.end();
  process.exit(1);
}
client.release();

// Проверка результата отдельным запросом: «команда прошла» и «строки нет» —
// разные утверждения.
const after = await pool.query('SELECT id, status FROM identity.users WHERE id = $1', [user.id]);
const byEmail = await pool.query(
  'SELECT count(*)::int AS n FROM identity.users WHERE email_hmac = $1',
  [blindIndex(EMAIL)],
);
console.log('\n=== Результат ===');
console.log(`  удалено связанных строк: ${removedRows}`);
console.log(
  after.rowCount === 0
    ? '  identity.users: строки нет'
    : `  identity.users: строка ОСТАЛАСЬ (status=${after.rows[0].status}) — это ошибка`,
);
console.log(`  поиск по адресу ${EMAIL}: ${byEmail.rows[0].n} совпадений`);

await pool.end();
process.exit(after.rowCount === 0 ? 0 : 1);
