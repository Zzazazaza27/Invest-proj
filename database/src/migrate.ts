/**
 * Раннер миграций UNICORN LAUNCH.
 *
 * Свойства, ради которых он написан руками, а не взят готовым:
 *  - advisory-лок на весь прогон: два параллельных деплоя не применят одну
 *    миграцию дважды;
 *  - checksum каждой применённой миграции: правка уже применённого файла
 *    роняет раннер, а не создаёт расхождение между средами;
 *  - каждая миграция — в своей транзакции: частично применённых нет;
 *  - forward-only: down-скрипты не предполагаются, production правится
 *    следующей миграцией (docs/architecture/Database_Launch.md §16).
 *
 * Запуск:  npm run migrate  ·  npm run migrate:status
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { MIGRATIONS_DIR, ownerConnectionString, sslConfig } from './env.ts';

const LOCK_KEY = 4_820_147_339; // произвольная, но фиксированная константа проекта

interface MigrationFile {
  id: string;
  path: string;
  sql: string;
  checksum: Buffer;
}

function loadMigrations(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const path = join(MIGRATIONS_DIR, file);
      const sql = readFileSync(path, 'utf8');
      return {
        id: file.replace(/\.sql$/, ''),
        path,
        sql,
        checksum: createHash('sha256').update(sql, 'utf8').digest(),
      };
    });
}

async function ensureRegistry(client: pg.Client): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'schema_migrations'
     ) AS exists`,
  );
  return rows[0]?.exists ?? false;
}

async function appliedMigrations(client: pg.Client): Promise<Map<string, Buffer>> {
  if (!(await ensureRegistry(client))) return new Map();
  const { rows } = await client.query<{ id: string; checksum: Buffer }>(
    'SELECT id, checksum FROM public.schema_migrations',
  );
  return new Map(rows.map((r) => [r.id, r.checksum]));
}

async function main(): Promise<void> {
  const statusOnly = process.argv.includes('--status');
  const client = new pg.Client({
    connectionString: ownerConnectionString(),
    ssl: sslConfig(),
    application_name: 'unicorn-migrate',
  });
  await client.connect();

  try {
    // Один прогон миграций в кластере одновременно.
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

    const files = loadMigrations();
    const applied = await appliedMigrations(client);

    // Изменение уже применённого файла — расхождение сред. Останавливаемся.
    for (const file of files) {
      const known = applied.get(file.id);
      if (known && !known.equals(file.checksum)) {
        throw new Error(
          `Миграция ${file.id} изменена после применения.\n` +
            `  применён checksum: ${known.toString('hex').slice(0, 16)}…\n` +
            `  текущий checksum:  ${file.checksum.toString('hex').slice(0, 16)}…\n` +
            'Уже применённые миграции не правятся. Добавь следующую миграцию (forward-only).',
        );
      }
    }

    const pending = files.filter((f) => !applied.has(f.id));

    if (statusOnly) {
      console.warn(`\nПрименено: ${applied.size}, ожидает: ${pending.length}\n`);
      for (const f of files) {
        console.warn(`  ${applied.has(f.id) ? '✔' : ' '} ${f.id}`);
      }
      console.warn('');
      return;
    }

    if (pending.length === 0) {
      console.warn(`Миграции актуальны (применено ${applied.size}).`);
      return;
    }

    for (const file of pending) {
      const started = Date.now();
      console.warn(`→ ${file.id}`);
      // Часть операций PostgreSQL не выполняется внутри транзакции —
      // в первую очередь CREATE INDEX CONCURRENTLY, единственный способ
      // построить индекс на живой таблице без блокировки записи. Такая
      // миграция помечает себя сама и идёт вне транзакции.
      //
      // Плата за это названа прямо: откатить её нечем. Поэтому в такой
      // миграции допустимы только идемпотентные операции (IF NOT EXISTS), а
      // повторный прогон после падения обязан быть безопасным. Проверяет это
      // линтер миграций, а не доверие к автору.
      const concurrent = /^\s*--\s*migrate:no-transaction\s*$/m.test(file.sql);
      try {
        if (!concurrent) await client.query('BEGIN');
        if (concurrent) {
          // Несколько выражений, отправленных ОДНОЙ строкой, PostgreSQL
          // оборачивает в неявную транзакцию — и CONCURRENTLY снова падает,
          // хотя явного BEGIN нет. Поэтому такая миграция выполняется по
          // одному выражению за запрос.
          for (const statement of splitStatements(file.sql)) {
            await client.query(statement);
          }
        } else {
          await client.query(file.sql);
        }
        // M000 создаёт реестр, поэтому запись возможна только после его прогона.
        await client.query(
          `INSERT INTO public.schema_migrations (id, checksum, duration_ms)
           VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET checksum = EXCLUDED.checksum`,
          [file.id, file.checksum, Date.now() - started],
        );
        if (!concurrent) await client.query('COMMIT');
        console.warn(
          `  применена за ${Date.now() - started} мс${concurrent ? ' (вне транзакции)' : ''}`,
        );
      } catch (error) {
        if (!concurrent) await client.query('ROLLBACK').catch(() => undefined);
        const detail = error instanceof Error ? error.message : String(error);
        // cause сохраняется: без него теряются position/hint из ошибки PostgreSQL,
        // а именно они показывают конкретное место в SQL.
        throw new Error(`Миграция ${file.id} не применена: ${detail}`, { cause: error });
      }
    }

    console.warn(`\nГотово. Применено миграций за прогон: ${pending.length}.`);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

/**
 * Разбор SQL на отдельные выражения для миграций вне транзакции.
 *
 * Наивный split(';') разрезал бы литерал с точкой с запятой, поэтому кавычки и
 * долларовые кавычки учитываются. Такие миграции линтер и так ограничивает
 * операциями с индексами, но разбор, который «обычно работает», — ровно тот
 * класс кода, который однажды режет чужой текст пополам.
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: string | null = null;
  let i = 0;

  while (i < sql.length) {
    const rest = sql.slice(i);

    if (quote === null) {
      const dollar = /^\$[A-Za-z_]*\$/.exec(rest);
      if (dollar) {
        quote = dollar[0];
        current += dollar[0];
        i += dollar[0].length;
        continue;
      }
      if (sql[i] === "'") {
        quote = "'";
        current += "'";
        i += 1;
        continue;
      }
      if (rest.startsWith('--')) {
        const end = sql.indexOf('\n', i);
        const line = end === -1 ? rest : sql.slice(i, end + 1);
        current += line;
        i += line.length;
        continue;
      }
      if (sql[i] === ';') {
        if (current.trim()) statements.push(current.trim());
        current = '';
        i += 1;
        continue;
      }
    } else if (quote === "'") {
      if (sql[i] === "'") quote = null;
    } else if (rest.startsWith(quote)) {
      current += quote;
      i += quote.length;
      quote = null;
      continue;
    }

    current += sql[i];
    i += 1;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

main().catch((error: unknown) => {
  console.error(`\nОШИБКА МИГРАЦИИ:\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
