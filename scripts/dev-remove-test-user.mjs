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
/**
 * Куда передать строки, где ссылка на пользователя объявлена NOT NULL и
 * удаление означало бы потерю рабочего объекта. Такая строка сейчас одна:
 * `scoring.ai_provider_credentials.set_by` — это ключ живого LLM-провайдера,
 * и снести его вместе с учёткой значит выключить скоринг. Правда о том, кто
 * ключ поставил, остаётся в журнале аудита: он не переписывается.
 */
const REASSIGN_TO = valueOf('--reassign-to');
const EMAIL = LOGIN.includes('@') ? LOGIN : `${LOGIN}@unicorn.local`;

/**
 * Что не удаляется никогда. Только `audit.events`: она связана hash-chain, и
 * вырезанная строка ломает проверку целостности на всей истории. Остальные
 * таблицы схемы `audit` (`agent_runs`, `node_checkpoints`) — обычные записи
 * прогонов под RLS, без цепочки и без append-only триггера; их строки уходят
 * вместе с учёткой штатным порядком.
 */
const PROTECTED_TABLES = new Set(['audit.events']);

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
    const guard = PROTECTED_TABLES.has(fk.table_name) ? '  <- ЖУРНАЛ, не трогаем' : '';
    console.log(`  ${String(rows[0].n).padStart(6)}  ${fk.table_name}.${fk.column_name}${guard}`);
  }
}
if (withRows.length === 0) console.log('  ссылок нет');

// Подробности по тому, что нельзя удалить механически.
const projects = await pool.query(
  `SELECT p.id, p.title, p.stage, p.listing_status,
          (SELECT count(*)::int FROM lab.founders_projects f2 WHERE f2.project_id = p.id) AS founders
     FROM lab.projects p
     JOIN lab.founders_projects f ON f.project_id = p.id
    WHERE f.user_id = $1`,
  [user.id],
);
if (projects.rowCount > 0) {
  console.log('');
  console.log('=== Проекты, где учётка — основатель ===');
  for (const p of projects.rows) {
    console.log(
      `  ${p.id}  ${p.stage.padEnd(14)}  ${p.listing_status.padEnd(12)}  ` +
        `основателей: ${p.founders}  ${p.title}`,
    );
  }
}

const creds = await pool.query(
  `SELECT provider, model_name, key_fingerprint, is_active, set_at
     FROM scoring.ai_provider_credentials WHERE set_by = $1`,
  [user.id],
);
if (creds.rowCount > 0) {
  console.log('');
  console.log('=== Ключи провайдеров, поставленные этой учёткой ===');
  for (const c of creds.rows) {
    console.log(
      `  ${c.provider.padEnd(12)}  ${(c.model_name ?? '—').padEnd(24)}  ` +
        `отпечаток ${c.key_fingerprint}  ${c.is_active ? 'ДЕЙСТВУЮЩИЙ' : 'отозван'}`,
    );
  }
  console.log('  Удаление учётки снесёт их вместе с ней — используй --reassign-to <логин>.');
}

const blocked = withRows.filter((r) => PROTECTED_TABLES.has(r.table_name));
const removable = withRows.filter((r) => !PROTECTED_TABLES.has(r.table_name));

// Ссылки, объявленные NOT NULL: их нельзя ни удалить по отдельности, ни
// обнулить — только передать другой учётке.
const MUST_REASSIGN = new Set(['scoring.ai_provider_credentials.set_by']);
const needReassign = removable.filter((r) => MUST_REASSIGN.has(`${r.table_name}.${r.column_name}`));
// Проект без второго основателя тоже требует наследника — иначе он повиснет
// в каталоге без владельца.
const soleFounderProjects = projects.rows.filter((p) => p.founders === 1).length;

let heirId = null;
if (REASSIGN_TO) {
  const heirEmail = REASSIGN_TO.includes('@') ? REASSIGN_TO : `${REASSIGN_TO}@unicorn.local`;
  const heir = await pool.query(
    `SELECT u.id FROM identity.users u
       JOIN identity.user_roles r ON r.user_id = u.id AND r.role = 'admin'
      WHERE u.email_hmac = $1 AND u.deleted_at IS NULL`,
    [blindIndex(heirEmail)],
  );
  if (heir.rowCount === 0) {
    console.error(`Наследник ${heirEmail} не найден или не администратор.`);
    await pool.end();
    process.exit(1);
  }
  heirId = heir.rows[0].id;
  console.log('');
  console.log(`Наследник обязательных ссылок: ${heirEmail} (${heirId})`);
}

if (!APPLY) {
  console.log('\nЭто показ без изменений. Для удаления добавь --yes.');
  await pool.end();
  process.exit(0);
}

if ((needReassign.length > 0 || soleFounderProjects > 0) && !heirId) {
  const what = needReassign.map((r) => `${r.table_name}.${r.column_name} (${r.n})`).join(', ');
  console.error(`
Есть обязательные ссылки: ${what}.`);
  console.error('Удаление остановлено: укажи --reassign-to <логин администратора>,');
  console.error('иначе вместе с учёткой уедет рабочий объект (например, ключ провайдера).');
  await pool.end();
  process.exit(1);
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

  // Второй уровень зависимостей. Эти строки ссылаются не на пользователя, а на
  // объекты, которые уходят вместе с ним, — прямого внешнего ключа на users у
  // них нет, и каталожный обход выше их не видит.
  const checkpoints = await client.query(
    `DELETE FROM audit.node_checkpoints
      WHERE run_id IN (SELECT id FROM audit.agent_runs WHERE user_id = $1)`,
    [user.id],
  );
  if (checkpoints.rowCount > 0) {
    console.log(`  удалено ${String(checkpoints.rowCount).padStart(6)}  audit.node_checkpoints`);
    removedRows += checkpoints.rowCount;
  }

  // Проекты, где учётка — единственный основатель, ПЕРЕДАЮТСЯ наследнику.
  // Удалить их целиком не выйдет и не нужно: на проекте висит рейтинг
  // (`scoring.irs_scores`), а он защищён триггером append-only — «rating is
  // not for sale». Защита правильная, обходить её ради уборки нельзя. Просто
  // порвать связь тоже нельзя: проект остался бы в каталоге без владельца.
  const orphans = projects.rows.filter((p) => p.founders === 1).map((p) => p.id);
  if (orphans.length > 0) {
    const res = await client.query(
      `UPDATE lab.founders_projects SET user_id = $2
        WHERE user_id = $1 AND project_id = ANY($3::uuid[])`,
      [user.id, heirId, orphans],
    );
    console.log(`  передано ${String(res.rowCount).padStart(5)}  lab.founders_projects (проекты)`);
  }
  // Порядок: сначала всё, что ссылается, потом сама строка. Внутри одной
  // транзакции — чтобы отказ на любом шаге не оставил учётку разобранной
  // наполовину.
  for (const r of removable) {
    if (MUST_REASSIGN.has(`${r.table_name}.${r.column_name}`)) {
      const res = await client.query(
        `UPDATE ${r.table_name} SET ${quoteIdent(r.column_name)} = $2 WHERE ${quoteIdent(r.column_name)} = $1`,
        [user.id, heirId],
      );
      console.log(`  передано ${String(res.rowCount).padStart(5)}  ${r.table_name}.${r.column_name}`);
      continue;
    }
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
