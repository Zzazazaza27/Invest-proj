#!/usr/bin/env node
/**
 * Испытание прогона миграций: обрыв, ограничения времени и непригодные индексы
 * (блок 09, задание 2; уточнения Тэнка 09.11).
 *
 * Своя временная база и свой набор миграций — рабочие миграции и данные стенда не
 * затрагиваются. Прогон — настоящий `database/src/migrate.ts`, отдельным процессом, как
 * при выпуске.
 *
 *   1. Ограничения по умолчанию (5 с / 5 мин) действуют и в транзакционной, и в
 *      нетранзакционной миграции.
 *   2. Транзакционная миграция с ошибкой посередине откатывается целиком; исправленная —
 *      применяется.
 *   3. Ожидание блокировки дольше предела останавливает транзакционную миграцию.
 *   4. CREATE INDEX CONCURRENTLY, оборванный пределом ожидания, оставляет непригодный
 *      индекс; следующий прогон этой же миграции строит его заново, индекс пригоден.
 *   5. Предел выполнения останавливает и транзакционную, и нетранзакционную миграцию.
 *   6. Чужой непригодный индекс — остановка с диагностикой, индекс не тронут.
 *
 * Требуется: PostgreSQL стенда, DATABASE_URL_OWNER с правом CREATE DATABASE.
 * Запуск: node scripts/check-migrate-interrupt.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB = 'fifth_migrate_probe';

function ownerUrl() {
  if (process.env.DATABASE_URL_OWNER) return process.env.DATABASE_URL_OWNER;
  const line = readFileSync(join(ROOT, '.env'), 'utf8').match(/^DATABASE_URL_OWNER=(.*)$/m);
  if (!line) throw new Error('DATABASE_URL_OWNER не задан');
  return line[1].trim();
}
const OWNER = ownerUrl();
const withDb = (name) => {
  const u = new URL(OWNER);
  u.pathname = `/${name}`;
  return u.toString();
};
const PROBE_URL = withDb(DB);

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.warn(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function admin(sql) {
  const c = new pg.Client({ connectionString: withDb('postgres') });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}
async function probe(sql, params = []) {
  const c = new pg.Client({ connectionString: PROBE_URL });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

const DIR = mkdtempSync(join(tmpdir(), 'fifth-migrate-probe-'));
const MIG = join(DIR, 'migrations');
mkdirSync(MIG);
const put = (name, sql) => writeFileSync(join(MIG, `${name}.sql`), sql);
const drop = (name) => rmSync(join(MIG, `${name}.sql`), { force: true });

/** Настоящий прогон миграций отдельным процессом. */
function migrate() {
  const started = Date.now();
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', join(ROOT, 'database', 'src', 'migrate.ts')],
    {
      cwd: join(ROOT, 'database'),
      env: { ...process.env, DATABASE_URL_OWNER: PROBE_URL, FIFTH_MIGRATIONS_DIR: MIG },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  return {
    ok: r.status === 0 && !/ОШИБКА МИГРАЦИИ/.test(r.stderr ?? ''),
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    seconds: (Date.now() - started) / 1000,
  };
}
const applied = async () =>
  (await probe('SELECT id FROM public.schema_migrations ORDER BY id')).map((r) => r.id);
const indexState = async (name) =>
  (
    await probe(
      `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = $1`,
      [name],
    )
  )[0] ?? null;

/** Держит блокировку таблицы в отдельном соединении, пока не отпустят. */
async function holdLock(table, mode) {
  const c = new pg.Client({ connectionString: PROBE_URL });
  await c.connect();
  await c.query('BEGIN');
  await c.query(`LOCK TABLE ${table} IN ${mode} MODE`);
  return async () => {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  };
}

console.warn('\n=== ПРОГОН МИГРАЦИЙ: ОБРЫВ, ОГРАНИЧЕНИЯ ВРЕМЕНИ, НЕПРИГОДНЫЕ ИНДЕКСЫ ===\n');
await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin(`CREATE DATABASE ${DB}`);

try {
  put(
    'M000_registry',
    `CREATE TABLE public.schema_migrations (
       id text PRIMARY KEY, checksum bytea NOT NULL, duration_ms integer,
       applied_at timestamptz NOT NULL DEFAULT now());
     CREATE TABLE public.items (id serial PRIMARY KEY, v integer NOT NULL);
     INSERT INTO public.items (v) SELECT g FROM generate_series(1, 1000) g;`,
  );

  console.warn('[1] Ограничения по умолчанию действуют в обоих видах миграций');
  put(
    'M001_settings_tx',
    `CREATE TABLE public.settings_tx AS
       SELECT current_setting('lock_timeout') AS l, current_setting('statement_timeout') AS s;`,
  );
  put(
    'M002_settings_nt',
    `-- migrate:no-transaction
     CREATE TABLE IF NOT EXISTS public.settings_nt AS
       SELECT current_setting('lock_timeout') AS l, current_setting('statement_timeout') AS s;`,
  );
  {
    const r = migrate();
    check('прогон прошёл', r.ok, r.ok ? '' : r.out.slice(-300));
    const tx = (await probe('SELECT l, s FROM public.settings_tx'))[0];
    const nt = (await probe('SELECT l, s FROM public.settings_nt'))[0];
    check('транзакционная: 5s / 5min', tx?.l === '5s' && tx?.s === '5min', JSON.stringify(tx));
    check('нетранзакционная: 5s / 5min', nt?.l === '5s' && nt?.s === '5min', JSON.stringify(nt));
  }

  console.warn('\n[2] Ошибка посередине транзакционной миграции');
  put(
    'M003_half',
    `CREATE TABLE public.half (id int);
     INSERT INTO public.half VALUES (1);
     SELECT 1/0;`,
  );
  {
    const r = migrate();
    check('прогон остановлен', !r.ok);
    const t = await probe(`SELECT to_regclass('public.half') AS t`);
    check('изменения миграции откатились целиком', t[0]?.t === null);
    check('миграция не записана применённой', !(await applied()).includes('M003_half'));
    put('M003_half', `CREATE TABLE public.half (id int);\nINSERT INTO public.half VALUES (1);`);
    const again = migrate();
    check('исправленная миграция применена повтором', again.ok, again.out.slice(-200));
  }

  console.warn('\n[3] Ожидание блокировки дольше предела — транзакционная');
  put('M004_alter', `ALTER TABLE public.items ADD COLUMN note text;`);
  {
    const release = await holdLock('public.items', 'ACCESS SHARE');
    const r = migrate();
    await release();
    check('прогон остановлен', !r.ok);
    check(
      'причина названа: ожидание блокировки',
      /ожидание блокировки дольше 5s/.test(r.out),
      r.out.match(/остановлена: [^\n]*/)?.[0]?.slice(0, 80) ?? r.out.slice(-160),
    );
    check('остановка по пределу, не бесконечное ожидание', r.seconds < 30, `${r.seconds} с`);
    check('миграция не записана применённой', !(await applied()).includes('M004_alter'));
    const again = migrate();
    check('после снятия блокировки применена', again.ok, again.out.slice(-200));
  }

  console.warn('\n[4] Оборванный CREATE INDEX CONCURRENTLY — свой индекс достраивается');
  put(
    'M005_index',
    `-- migrate:no-transaction
     CREATE INDEX CONCURRENTLY IF NOT EXISTS items_v_ix ON public.items (v);`,
  );
  {
    // Открытая транзакция с записью в таблицу: CONCURRENTLY ждёт её завершения — ожидание
    // ограничено пределом блокировки, после него индекс остаётся непригодным.
    const c = new pg.Client({ connectionString: PROBE_URL });
    await c.connect();
    await c.query('BEGIN');
    await c.query('UPDATE public.items SET v = v WHERE id = 1');
    const r = migrate();
    await c.query('ROLLBACK');
    await c.end();
    check(
      'прогон остановлен пределом ожидания',
      !r.ok && /ожидание блокировки/.test(r.out),
      r.out.match(/остановлена: [^\n]*/)?.[0]?.slice(0, 80) ?? r.out.slice(-200),
    );
    const state = await indexState('items_v_ix');
    check('остался непригодный индекс', state?.valid === false, JSON.stringify(state));
    check('миграция не записана применённой', !(await applied()).includes('M005_index'));
    const again = migrate();
    check('повтор той же миграции прошёл', again.ok, again.out.slice(-200));
    check('повтор назвал продолжение', /строится заново/.test(again.out));
    check('индекс пригоден', (await indexState('items_v_ix'))?.valid === true);
  }

  console.warn('\n[5] Предел выполнения');
  put('M006_slow_tx', `-- migrate:statement-timeout=1s\nSELECT pg_sleep(3);`);
  {
    const r = migrate();
    check(
      'транзакционная остановлена',
      !r.ok && /выполнение дольше 1s/.test(r.out),
      r.out.match(/остановлена: [^\n]*/)?.[0]?.slice(0, 80) ?? r.out.slice(-160),
    );
    drop('M006_slow_tx');
  }
  put(
    'M006_slow_nt',
    `-- migrate:no-transaction\n-- migrate:statement-timeout=1s\nSELECT pg_sleep(3);`,
  );
  {
    const r = migrate();
    check(
      'нетранзакционная остановлена',
      !r.ok && /выполнение дольше 1s/.test(r.out),
      r.out.match(/остановлена: [^\n]*/)?.[0]?.slice(0, 80) ?? r.out.slice(-160),
    );
    drop('M006_slow_nt');
  }

  console.warn('\n[6] Чужой непригодный индекс — остановка, индекс не тронут');
  {
    await probe('CREATE TABLE public.dups (v int)');
    await probe('INSERT INTO public.dups VALUES (1), (1)');
    await probe('CREATE UNIQUE INDEX CONCURRENTLY foreign_ix ON public.dups (v)').catch(
      () => undefined,
    );
    check('подготовлен непригодный индекс', (await indexState('foreign_ix'))?.valid === false);
    put('M007_next', `CREATE TABLE public.next_step (id int);`);
    const r = migrate();
    check('прогон остановлен', !r.ok);
    check(
      'в диагностике назван индекс',
      /public\.foreign_ix/.test(r.out),
      r.out.match(/Найдены[^\n]*/)?.[0]?.slice(0, 120) ?? '',
    );
    check('индекс не тронут', (await indexState('foreign_ix'))?.valid === false);
    check('следующая миграция не применена', !(await applied()).includes('M007_next'));
    await probe('DROP INDEX public.foreign_ix');
    drop('M007_next');
  }

  // Тэнк 09.11: принадлежность определялась только именем — ожидающая миграция с тем же
  // именем разрешала удалить непригодный индекс на другой таблице или с другим определением.
  const sharedState = async () =>
    (
      await probe(
        `SELECT i.indisvalid AS valid, t.relname AS "table", pg_get_indexdef(i.indexrelid) AS def
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_class t ON t.oid = i.indrelid WHERE c.relname = 'shared_idx'`,
      )
    )[0] ?? null;
  put(
    'M008_shared',
    `-- migrate:no-transaction
     CREATE INDEX CONCURRENTLY IF NOT EXISTS shared_idx ON public.items (v);`,
  );

  console.warn('\n[7] То же имя, другая таблица — индекс не тронут');
  {
    await probe('CREATE TABLE public.other_t (v int)');
    await probe('INSERT INTO public.other_t VALUES (1), (1)');
    await probe('CREATE UNIQUE INDEX CONCURRENTLY shared_idx ON public.other_t (v)').catch(
      () => undefined,
    );
    const before = await sharedState();
    check(
      'подготовлен непригодный shared_idx на other_t',
      before?.valid === false && before?.table === 'other_t',
    );
    const r = migrate();
    check('прогон остановлен', !r.ok);
    check(
      'причина: не совпадает с тем, что строит миграция',
      /не совпадает/.test(r.out),
      r.out.match(/public\.shared_idx на [^\n]*/)?.[0]?.slice(0, 120) ?? r.out.slice(-160),
    );
    const after = await sharedState();
    check(
      'индекс на other_t не тронут',
      after?.valid === false && after?.table === 'other_t' && after?.def === before?.def,
      after?.def,
    );
    check('миграция не применена', !(await applied()).includes('M008_shared'));
    await probe('DROP INDEX public.shared_idx');
  }

  console.warn('\n[8] То же имя и таблица, другое определение — индекс не тронут');
  {
    await probe('INSERT INTO public.items (v) VALUES (1)');
    await probe('CREATE UNIQUE INDEX CONCURRENTLY shared_idx ON public.items (v)').catch(
      () => undefined,
    );
    const before = await sharedState();
    check(
      'подготовлен непригодный уникальный shared_idx на items',
      before?.valid === false && /UNIQUE/.test(before?.def ?? ''),
    );
    const r = migrate();
    check('прогон остановлен', !r.ok && /не совпадает/.test(r.out));
    const after = await sharedState();
    check('индекс не тронут', after?.valid === false && after?.def === before?.def, after?.def);
    await probe('DROP INDEX public.shared_idx');
    const again = migrate();
    check('после разбора миграция применена', again.ok, again.out.slice(-160));
    check(
      'построен ожидаемый индекс',
      (await sharedState())?.valid === true && !/UNIQUE/.test((await sharedState())?.def ?? ''),
    );
  }
} finally {
  await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
  rmSync(DIR, { recursive: true, force: true });
}

console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено.\n`);
if (failed > 0) process.exitCode = 1;
