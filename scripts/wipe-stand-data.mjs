#!/usr/bin/env node
/**
 * Обнуление прикладных данных стенда с сохранением справочников и схемы.
 *
 * Поручение Томаса 29.10.2026: оба нынешних стенда (локальный и 5espace.com)
 * очищаются от всех накопленных прикладных данных независимо от
 * происхождения; демо и приёмка заново не загружаются. Перед запуском MVP-
 * прода операция повторяется (12.1 «Чистый старт»).
 *
 * ЧТО УДАЛЯЕТСЯ — по классам `database/src/data-classes.ts`:
 *   operational (люди, проекты, материалы, заявки, сессии, платежи …),
 *   journal (аудит, outbox, отозванные токены, акцепты …),
 *   run (тестовые сессии),
 *   а также интеграционные клиенты и адреса их подписок (решение Томаса).
 * ЧТО СОХРАНЯЕТСЯ:
 *   system и content (справочники, настройки и тексты платформы), схема и
 *   реестр миграций, роли БД; схема `intelligence` целиком — Market
 *   Intelligence заморожен, его данные сохраняются по решению Томаса.
 *
 * Справочники ссылаются на авторов-пользователей. Поэтому два шага:
 *
 *   truncate  — очистить всё, кроме identity.users (при остановленных ядре
 *               и AI-шлюзе);
 *   finish    — после регистрации служебного автора и администратора через
 *               API: переназначить авторство сохраняемых записей на
 *               служебного автора и удалить всех прочих пользователей.
 *
 * Внешние ключи из сохраняемых таблиц в удаляемые проверяются ДО очистки:
 * TRUNCATE … CASCADE унёс бы справочник. Найдена такая связь — отказ.
 * Файлы, поток NATS и счётчики чистятся отдельно.
 *
 * Запуск из корня репозитория стенда (данные о классах — его версии кода):
 *   node --experimental-strip-types scripts/wipe-stand-data.mjs truncate [--yes]
 *   node --experimental-strip-types scripts/wipe-stand-data.mjs finish \
 *        --author <uuid> --keep <uuid,uuid> [--yes]
 * Строка подключения — DATABASE_URL_OWNER (владелец схемы).
 */
import pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) process.env[trimmed.slice(0, eq).trim()] ??= trimmed.slice(eq + 1).trim();
  }
}

const MODE = process.argv[2];
const APPLY = process.argv.includes('--yes');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
if (MODE !== 'truncate' && MODE !== 'finish') {
  console.error('Режим: truncate | finish');
  process.exit(2);
}

const WIPE_CLASSES = new Set(['operational', 'journal', 'run']);
const KEEP_SCHEMAS = new Set(['intelligence']);
// Сверх классов: клиенты Integration API и их подписки — данные прогонов.
const EXTRA_WIPE = new Set(['integration.service_accounts', 'integration.webhook_endpoints']);
// Родительская таблица журнала: классы заданы для её партиций по префиксу.
const EXTRA_JOURNAL = new Set(['audit.events']);
const USERS = 'identity.users';

const { DATA_CLASSES, PREFIX_CLASSES } = await import(
  pathToFileURL(join(ROOT, 'database/src/data-classes.ts')).href
);

function classOf(table) {
  if (EXTRA_JOURNAL.has(table)) return 'journal';
  if (DATA_CLASSES[table]) return DATA_CLASSES[table].kind;
  return PREFIX_CLASSES.find((p) => table.startsWith(p.prefix))?.kind ?? null;
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
await client.connect();

async function plan() {
  const { rows: tables } = await client.query(
    `SELECT n.nspname || '.' || c.relname AS name, c.relispartition AS partition
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'partman')
        AND n.nspname NOT LIKE 'pg_%'
      ORDER BY 1`,
  );
  const wipe = [];
  const keep = [];
  for (const { name, partition } of tables) {
    if (partition) continue; // очищаются вместе с родительской таблицей
    const kind = classOf(name);
    const schema = name.split('.')[0];
    if (!KEEP_SCHEMAS.has(schema) && (EXTRA_WIPE.has(name) || (kind && WIPE_CLASSES.has(kind)))) {
      wipe.push(name);
    } else {
      keep.push(name);
    }
  }
  const { rows: fks } = await client.query(
    `SELECT src.nspname || '.' || sc.relname AS source,
            dst.nspname || '.' || dc.relname AS target,
            a.attname AS column, a.attnotnull AS not_null, con.conname
       FROM pg_constraint con
       JOIN pg_class sc ON sc.oid = con.conrelid
       JOIN pg_namespace src ON src.oid = sc.relnamespace
       JOIN pg_class dc ON dc.oid = con.confrelid
       JOIN pg_namespace dst ON dst.oid = dc.relnamespace
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND cardinality(con.conkey) = 1`,
  );
  return { wipe, keep, fks };
}

async function count(name) {
  return Number((await client.query(`SELECT count(*) AS n FROM ${name}`)).rows[0].n);
}

try {
  const { wipe, keep, fks } = await plan();
  const wipeSet = new Set(wipe);
  const keepSet = new Set(keep);

  if (MODE === 'truncate') {
    const now = wipe.filter((t) => t !== USERS);
    const nowSet = new Set(now);
    // Сохраняемая таблица, ссылающаяся на очищаемую (кроме пользователей, их
    // авторство переносится на шаге finish), — отказ до любого изменения.
    const blocking = fks.filter((fk) => nowSet.has(fk.target) && keepSet.has(fk.source));
    if (blocking.length > 0) {
      console.error('ОТКАЗ: сохраняемые таблицы ссылаются на очищаемые:');
      for (const fk of blocking) console.error(`  ${fk.source}.${fk.column} → ${fk.target}`);
      process.exit(1);
    }
    let total = 0;
    for (const name of now) {
      const n = await count(name);
      total += n;
      if (n > 0) console.warn(`  ${name}: ${n}`);
    }
    console.warn(`Очистка: таблиц ${now.length}, строк ${total} (пользователи — на шаге finish)`);
    if (!APPLY) {
      console.warn('Пробный режим. Для удаления: --yes');
      process.exit(0);
    }
    await client.query('BEGIN');
    await client.query(`TRUNCATE ${now.join(', ')} RESTART IDENTITY`);
    await client.query('COMMIT');
    const left = [];
    for (const name of now) if ((await count(name)) > 0) left.push(name);
    console.warn(
      left.length === 0 ? 'Очищено: все таблицы пусты.' : `НЕ ПУСТО: ${left.join(', ')}`,
    );
    process.exit(left.length === 0 ? 0 : 1);
  }

  // finish: авторство → служебный автор, прочие пользователи удаляются.
  const author = arg('--author');
  const keepUsers = (arg('--keep') ?? '').split(',').filter(Boolean);
  if (!author || !keepUsers.includes(author)) {
    console.error('Нужны --author <uuid> и --keep <uuid,…>, и автор должен входить в --keep');
    process.exit(2);
  }
  const refs = fks.filter((fk) => fk.target === USERS && fk.source !== USERS);
  const keptRefs = refs.filter((fk) => keepSet.has(fk.source));
  const wipedRefs = refs.filter((fk) => wipeSet.has(fk.source));
  await client.query('BEGIN');
  // Опубликованные версии справочников защищены триггерами неизменности.
  // Меняется только поле автора, поэтому на время переназначения триггеры
  // выключены; перед удалением пользователей режим возвращается, и БД сама
  // проверяет внешними ключами, что ссылок на удаляемых не осталось.
  await client.query(`SET LOCAL session_replication_role = replica`);
  for (const fk of keptRefs) {
    const { rowCount } = await client.query(
      `UPDATE ${fk.source} SET ${fk.column} = $1
        WHERE ${fk.column} IS NOT NULL AND NOT (${fk.column} = ANY($2::uuid[]))`,
      [author, keepUsers],
    );
    if (rowCount > 0) console.warn(`  авторство ${fk.source}.${fk.column}: ${rowCount}`);
  }
  // Записи о новых учётках (акцепты, роли, журнал) созданы регистрацией после
  // очистки и относятся к оставляемым пользователям; прочих строк в
  // очищаемых таблицах быть не должно.
  for (const fk of wipedRefs) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM ${fk.source}
        WHERE ${fk.column} IS NOT NULL AND NOT (${fk.column} = ANY($1::uuid[]))`,
      [keepUsers],
    );
    if (rows[0].n > 0)
      throw new Error(`${fk.source}.${fk.column}: ${rows[0].n} строк чужих пользователей`);
  }
  await client.query(`SET LOCAL session_replication_role = origin`);
  await client.query(
    `UPDATE identity.users SET status_changed_by = NULL
      WHERE status_changed_by IS NOT NULL AND NOT (status_changed_by = ANY($1::uuid[]))`,
    [keepUsers],
  );
  const { rowCount: removed } = await client.query(
    'DELETE FROM identity.users WHERE NOT (id = ANY($1::uuid[]))',
    [keepUsers],
  );
  console.warn(`Удалено пользователей: ${removed}; оставлено: ${keepUsers.length}`);
  if (!APPLY) {
    await client.query('ROLLBACK');
    console.warn('Пробный режим: изменения откатаны. Для применения: --yes');
  } else {
    await client.query('COMMIT');
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  console.error('ОТКАЗ:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
