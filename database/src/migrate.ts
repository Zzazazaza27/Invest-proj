/**
 * Раннер миграций Пятый элемент.
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

/**
 * Ограничения времени миграции (блок 09, задание 2; Тэнк 09.11): ожидание блокировки 5 с и
 * выполнение 5 мин по умолчанию. Миграция не держит запросы пользователей бесконечно:
 * превышение — ошибка, прогон и выпуск останавливаются. Переопределение — метками в файле
 * (`-- migrate:lock-timeout=30s`, `-- migrate:statement-timeout=20min`); тяжёлой миграции
 * нужна отдельная оценка длительности, метка её не заменяет.
 */
export const DEFAULT_LOCK_TIMEOUT = '5s';
export const DEFAULT_STATEMENT_TIMEOUT = '5min';
const DURATION = /^\d{1,6}(ms|s|min)$/;

export function timeoutsOf(sql: string): { lock: string; statement: string } {
  const pick = (name: string, fallback: string) => {
    const match = new RegExp(`^\\s*--\\s*migrate:${name}=(\\S+)\\s*$`, 'm').exec(sql);
    if (!match) return fallback;
    if (!DURATION.test(match[1]!)) {
      throw new Error(`метка migrate:${name}=${match[1]} — нужен вид 500ms, 30s или 10min`);
    }
    return match[1]!;
  };
  return {
    lock: pick('lock-timeout', DEFAULT_LOCK_TIMEOUT),
    statement: pick('statement-timeout', DEFAULT_STATEMENT_TIMEOUT),
  };
}

/**
 * Индексы, которые строит миграция вне транзакции: `CREATE [UNIQUE] INDEX CONCURRENTLY IF
 * NOT EXISTS имя ON [схема.]таблица`. Только для них есть предусмотренное продолжение после
 * обрыва: непригодный индекс удаляется и строится заново этой же миграцией.
 */
export interface ExpectedIndex {
  schema: string;
  name: string;
  /** Таблица, на которой миграция строит индекс. */
  table: string;
  /** Определение из миграции в однозначной форме; null — форма не разбирается однозначно. */
  definition: SimpleIndex | null;
  /** Текст оператора — для диагностики. */
  text: string;
}

export function concurrentIndexesOf(sql: string): ExpectedIndex[] {
  const re =
    /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+"?(\w+)"?\s+ON\s+(?:ONLY\s+)?"?(\w+)"?(?:\."?(\w+)"?)?/i;
  const found: ExpectedIndex[] = [];
  for (const statement of splitStatements(sql)) {
    const body = statement.replace(/^(?:\s*--[^\n]*\n)+/, '').trim();
    const m = re.exec(body);
    if (!m) continue;
    found.push({
      name: m[1]!,
      schema: m[3] ? m[2]! : 'public',
      table: m[3] ?? m[2]!,
      definition: parseSimpleIndex(body),
      text: body,
    });
  }
  return found;
}

/**
 * Однозначно разбираемая форма индекса — только для неё доказывается соответствие и
 * допускается автоматическое восстановление (Тэнк, 09.11):
 *
 *   CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] имя ON [ONLY] [схема.]таблица
 *     [USING метод] (колонка[, колонка…])
 *
 * Имена — только без кавычек: PostgreSQL приводит их к нижнему регистру, поэтому сравнение
 * в нижнем регистре здесь точное. Кавычки, выражения, WHERE, INCLUDE, порядок сортировки,
 * классы операторов, WITH — всё, где регистр и литералы значимы, не разбирается: null, и
 * непригодный индекс не удаляется — остановка. Универсального разбора SQL здесь нет
 * намеренно: прежнее упрощение (нижний регистр и снятые кавычки для всего текста) путало
 * 'ACTIVE' с 'active' и "Status" со status.
 */
export interface SimpleIndex {
  unique: boolean;
  method: string;
  columns: string[];
}

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const SIMPLE_INDEX = new RegExp(
  `^CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}` +
    `\\s+ON\\s+(?:ONLY\\s+)?(?:${IDENT}\\.)?${IDENT}\\s*(?:USING\\s+(${IDENT})\\s*)?` +
    `\\(\\s*(${IDENT}(?:\\s*,\\s*${IDENT})*)\\s*\\)\\s*;?\\s*$`,
  'i',
);

export function parseSimpleIndex(text: string): SimpleIndex | null {
  const m = SIMPLE_INDEX.exec(text.trim());
  if (!m) return null;
  return {
    unique: Boolean(m[1]),
    method: (m[2] ?? 'btree').toLowerCase(),
    columns: m[3]!.split(',').map((c) => c.trim().toLowerCase()),
  };
}

interface InvalidIndex {
  schema: string;
  name: string;
  tableSchema: string;
  table: string;
  definition: string;
}

/** Непригодные индексы кластера: оборванный CREATE INDEX CONCURRENTLY оставляет такой. */
async function invalidIndexes(client: pg.Client): Promise<InvalidIndex[]> {
  const { rows } = await client.query<InvalidIndex>(
    `SELECT n.nspname AS schema, c.relname AS name,
            tn.nspname AS "tableSchema", t.relname AS "table",
            pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace tn ON tn.oid = t.relnamespace
      WHERE NOT i.indisvalid OR NOT i.indisready
      ORDER BY 1, 2`,
  );
  return rows;
}

/** Совпадает ли непригодный индекс с тем, что строит миграция: имя, таблица, определение. */
function sameIndex(found: InvalidIndex, expected: ExpectedIndex): boolean {
  const actual = parseSimpleIndex(found.definition);
  const want = expected.definition;
  // Любая из сторон не в однозначной форме — соответствие не доказано.
  if (!actual || !want) return false;
  return (
    found.schema === expected.schema &&
    found.name === expected.name &&
    found.tableSchema === expected.schema &&
    found.table === expected.table &&
    actual.unique === want.unique &&
    actual.method === want.method &&
    actual.columns.join(',') === want.columns.join(',')
  );
}

const qualified = (ix: { schema: string; name: string }) => `${ix.schema}.${ix.name}`;

async function main(): Promise<void> {
  const statusOnly = process.argv.includes('--status');
  const client = new pg.Client({
    connectionString: ownerConnectionString(),
    ssl: sslConfig(),
    application_name: 'fifth-migrate',
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

    // Непригодный индекс до прогона. Свой — тот, что строит ожидающая миграция вне
    // транзакции: его продолжение предусмотрено (удалить и построить заново). Чужой —
    // остановка с диагностикой: общая починка могла бы задеть не тот объект и скрыть
    // причину отказа (Тэнк, 09.11).
    const owned = new Map<string, { file: string; expected: ExpectedIndex }>();
    for (const file of pending) {
      if (!/^\s*--\s*migrate:no-transaction\s*$/m.test(file.sql)) continue;
      for (const ix of concurrentIndexesOf(file.sql)) {
        owned.set(qualified(ix), { file: file.id, expected: ix });
      }
    }
    const invalid = await invalidIndexes(client);
    // Совпадение имени — не доказательство: таблица и определение сверяются с ожидаемой
    // операцией. Не совпало или не разобрать — остановка без удаления (Тэнк, 09.11).
    const mismatched = invalid.filter((ix) => {
      const own = owned.get(qualified(ix));
      return own && !sameIndex(ix, own.expected);
    });
    if (mismatched.length > 0) {
      throw new Error(
        'Непригодный индекс с именем из ожидающей миграции не совпадает с тем, что она строит:\n' +
          mismatched
            .map((ix) => {
              const own = owned.get(qualified(ix))!;
              return (
                `  ${qualified(ix)} на ${ix.tableSchema}.${ix.table}: ${ix.definition}\n` +
                `  ожидалось (${own.file}) на ${own.expected.schema}.${own.expected.table}: ${own.expected.text}` +
                (own.expected.definition && parseSimpleIndex(ix.definition)
                  ? ''
                  : '\n  (форма индекса не разбирается однозначно — автоматическое восстановление только для простых индексов по колонкам)')
              );
            })
            .join('\n') +
          '\nПрогон остановлен, индекс не тронут: соответствие не доказано. Разобрать вручную.',
      );
    }
    const foreign = invalid.filter((ix) => !owned.has(qualified(ix)));
    if (foreign.length > 0) {
      throw new Error(
        `Найдены непригодные индексы, которых не строит ни одна ожидающая миграция: ` +
          `${foreign.map(qualified).join(', ')}.\n` +
          'Прогон остановлен: автоматически такой индекс не чинится. Выясни, откуда он ' +
          '(SELECT * FROM pg_stat_progress_create_index; журнал прошлого прогона), и реши ' +
          'отдельно — удалить или достроить.',
      );
    }

    if (pending.length === 0) {
      console.warn(`Миграции актуальны (применено ${applied.size}).`);
      return;
    }

    for (const file of pending) {
      const started = Date.now();
      console.warn(`→ ${file.id}`);
      const limits = timeoutsOf(file.sql);
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
        if (!concurrent) {
          await client.query('BEGIN');
          // SET LOCAL — только на эту транзакцию: реестр и следующая миграция не наследуют.
          await client.query(`SET LOCAL lock_timeout = '${limits.lock}'`);
          await client.query(`SET LOCAL statement_timeout = '${limits.statement}'`);
        }
        if (concurrent) {
          // Вне транзакции SET LOCAL не действует — ограничения на сеанс, снимаются в finally.
          await client.query(`SET lock_timeout = '${limits.lock}'`);
          await client.query(`SET statement_timeout = '${limits.statement}'`);
          // Свой непригодный индекс от прошлого оборванного прогона — продолжение,
          // предусмотренное этой миграцией: удалить и построить заново. IF NOT EXISTS сам
          // по себе пропустил бы его и оставил непригодным.
          // Сюда доходят только сверенные: несовпавший остановил прогон выше.
          for (const ix of invalid.filter((i) => owned.get(qualified(i))?.file === file.id)) {
            console.warn(
              `  непригодный индекс ${qualified(ix)} от прошлого прогона — строится заново`,
            );
            await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${ix.schema}"."${ix.name}"`);
          }
          // Несколько выражений, отправленных ОДНОЙ строкой, PostgreSQL
          // оборачивает в неявную транзакцию — и CONCURRENTLY снова падает,
          // хотя явного BEGIN нет. Поэтому такая миграция выполняется по
          // одному выражению за запрос.
          for (const statement of splitStatements(file.sql)) {
            await client.query(statement);
          }
          // Построенные индексы обязаны быть пригодными: иначе миграция не применена.
          const after = await invalidIndexes(client);
          const broken = concurrentIndexesOf(file.sql).filter((ix) =>
            after.some((a) => qualified(a) === qualified(ix)),
          );
          if (broken.length > 0) {
            throw new Error(`индекс построен непригодным: ${broken.map(qualified).join(', ')}`);
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
        else {
          await client.query('RESET lock_timeout');
          await client.query('RESET statement_timeout');
        }
        console.warn(
          `  применена за ${Date.now() - started} мс${concurrent ? ' (вне транзакции)' : ''}`,
        );
      } catch (error) {
        if (!concurrent) await client.query('ROLLBACK').catch(() => undefined);
        // Превышение ограничения — отдельный понятный текст: это не ошибка SQL, а сигнал
        // остановить выпуск и оценить миграцию.
        const code = (error as { code?: string }).code;
        if (code === '55P03' || code === '57014') {
          throw new Error(
            `Миграция ${file.id} остановлена: ${code === '55P03' ? `ожидание блокировки дольше ${limits.lock}` : `выполнение дольше ${limits.statement}`}. ` +
              'Выпуск не продолжается; миграции нужна оценка длительности или другой порядок.',
            { cause: error },
          );
        }
        if (concurrent) {
          await client.query('RESET lock_timeout').catch(() => undefined);
          await client.query('RESET statement_timeout').catch(() => undefined);
        }
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
