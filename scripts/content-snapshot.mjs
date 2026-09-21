#!/usr/bin/env node
/**
 * Комплект подготовленного содержимого: выгрузка, расхождения, загрузка.
 *
 * ЗАЧЕМ. Словарь, ЧАВО, вопросы заявки, тарифы, страны и шаблоны владелец
 * заполняет в админке, и живут они только в базе. Любой сброс — и работа
 * пропала; на прод её тоже переносить нечем. Комплект делает содержимое
 * файлами: они лежат в Git, правки видно в диффе, перенос — одна команда.
 *
 * ЧТО ЭТО НЕ ДЕЛАЕТ. Это не резервная копия базы (`npm run db:backup`) и не
 * перенос пользователей. В комплект попадают только таблицы класса `content`
 * с пометкой «выгружается» (`database/src/data-classes.ts`). Секреты — ключи
 * провайдеров, подписи вебхуков, служебные учётки интеграций — помечены «не
 * выгружается» и в файлы не попадают никогда. Ссылки на людей (`created_by`)
 * не выгружаются тоже: комплект отвечает на вопрос «какое содержимое есть», а
 * не «кто его набрал», и персональным данным в Git не место.
 *
 * ПОЧЕМУ НЕ ПО ПЕРВИЧНОМУ КЛЮЧУ. Содержимое, засеянное миграциями, в каждой
 * базе получает свой `uuid`: те же 24 шаблона писем на стенде и в тестовой
 * базе — это разные идентификаторы. Перенос по первичному ключу положил бы
 * на прод второй комплект рядом с первым. Поэтому строка узнаётся по
 * ЕСТЕСТВЕННОМУ ключу (`code`+`version`, `namespace`+`key`, …), а ссылки между
 * таблицами комплекта записываются как ключ родителя, а не как его `uuid`.
 *
 * СНИМОК, А НЕ ЗЕРКАЛО. Выгрузка фиксирует состояние на момент запуска и
 * пишет опись: когда снята, с какой базы, сколько строк, отпечаток каждого
 * файла. `status` сравнивает базу с описью и говорит, что изменилось после
 * снимка, — чтобы «я это выгружал» не расходилось с тем, что в файлах.
 *
 * ЧЕЙ СЛЕД НЕ ПОПАДАЕТ. Записи содержимого умеют заводить и проверки: прогон
 * админки создаёт записи ЧАВО прямо в `content.text_entries`. Отбор идёт по
 * ДОКАЗУЕМОМУ происхождению автора (M127), а не по виду ключа.
 *
 *   node scripts/content-snapshot.mjs export     снять снимок в файлы
 *   node scripts/content-snapshot.mjs status     что изменилось после снимка
 *   node scripts/content-snapshot.mjs load       показать, что даст загрузка
 *   node scripts/content-snapshot.mjs load --yes применить
 *          --overwrite   переписывать строки, различающиеся с файлами
 *          --dir <путь>  другой каталог комплекта (проверка переноса)
 */
import pg from 'pg';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_CLASSES } from '../database/src/data-classes.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const COMMAND = process.argv[2] ?? 'status';
if (!['export', 'load', 'status'].includes(COMMAND)) {
  console.error(`неизвестная команда «${COMMAND}»; допустимы: export, status, load`);
  process.exit(1);
}
const APPLY = process.argv.includes('--yes');
const OVERWRITE = process.argv.includes('--overwrite');
const dirArg = process.argv.find((a) => a.startsWith('--dir='));
const dirPos =
  process.argv.indexOf('--dir') >= 0 ? process.argv[process.argv.indexOf('--dir') + 1] : null;
const CONTENT_DIR = dirArg
  ? dirArg.slice('--dir='.length)
  : (dirPos ?? join(ROOT, 'database', 'content'));
const MANIFEST = join(CONTENT_DIR, 'manifest.json');

/** Следы прогонов: их авторство доказуемо, и в комплект они не идут. */
const PROBE_ORIGINS = ['render_check', 'load_test'];

/** Служебные отметки времени в комплект не идут: в каждой базе они свои. */
const VOLATILE = new Set(['created_at', 'updated_at']);

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

const connectionString =
  process.env.NODE_ENV === 'test' ? process.env.DATABASE_URL_TEST : process.env.DATABASE_URL_OWNER;
if (!connectionString) {
  console.error('строка подключения не задана (DATABASE_URL_OWNER / DATABASE_URL_TEST)');
  process.exit(1);
}
const DB_NAME = new URL(connectionString).pathname.replace(/^\//, '');
const client = new pg.Client({ connectionString });
await client.connect();

const TABLES = Object.entries(DATA_CLASSES)
  .filter(([, value]) => value.kind === 'content' && value.exportable === true)
  .map(([name]) => name)
  .sort();

for (const table of TABLES) {
  if (!DATA_CLASSES[table].naturalKey?.length) {
    console.error(`у таблицы ${table} не объявлен естественный ключ — перенос невозможен`);
    process.exit(1);
  }
}

// ------------------------------------------------------- устройство таблиц

const meta = new Map();

async function describe(table) {
  if (meta.has(table)) return meta.get(table);
  const [schema, name] = table.split('.');

  const { rows: columns } = await client.query(
    `SELECT a.attname AS name, t.typname AS udt, pg_get_expr(d.adbin, d.adrelid) IS NOT NULL AS has_default
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t ON t.oid = a.atttypid
       LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [schema, name],
  );

  const { rows: pkRows } = await client.query(
    `SELECT a.attname AS name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)`,
    [schema, name],
  );
  const pk = pkRows.map((r) => r.name);

  const { rows: fkRows } = await client.query(
    `SELECT a.attname AS col, rn.nspname || '.' || rc.relname AS parent
       FROM pg_constraint co
       JOIN pg_class c ON c.oid = co.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class rc ON rc.oid = co.confrelid
       JOIN pg_namespace rn ON rn.oid = rc.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(co.conkey)
      WHERE co.contype = 'f' AND n.nspname = $1 AND c.relname = $2`,
    [schema, name],
  );

  const userRefs = new Set(fkRows.filter((r) => r.parent === 'identity.users').map((r) => r.col));

  /**
   * Ссылка на родителя записывается его естественным ключом — но только там,
   * где родитель узнаётся по суррогату. `country_code` и `locale` ссылаются на
   * справочники с осмысленным ключом: их значение и так переносимо.
   */
  const refs = {};
  for (const { col, parent } of fkRows) {
    const parentClass = DATA_CLASSES[parent];
    if (!parentClass?.exportable || !parentClass.naturalKey) continue;
    const parentPk = await primaryKeyOf(parent);
    if (parentPk.length !== 1) continue;
    if (parentClass.naturalKey.length === 1 && parentClass.naturalKey[0] === parentPk[0]) continue;
    refs[col] = { table: parent, key: [...parentClass.naturalKey] };
  }

  const naturalKey = [...DATA_CLASSES[table].naturalKey];
  /** Суррогатный ключ в файлы не идёт: в другой базе он всё равно будет свой. */
  const surrogate = pk.length === 1 && !naturalKey.includes(pk[0]) ? pk[0] : null;

  const exported = columns
    .map((c) => c.name)
    .filter((n) => !VOLATILE.has(n) && !userRefs.has(n) && n !== surrogate);

  const value = {
    table,
    columns,
    byName: new Map(columns.map((c) => [c.name, c])),
    pk,
    naturalKey,
    refs,
    userRefs,
    surrogate,
    surrogateHasDefault: surrogate
      ? (columns.find((c) => c.name === surrogate)?.has_default ?? false)
      : false,
    exported,
  };
  meta.set(table, value);
  return value;
}

async function primaryKeyOf(table) {
  const [schema, name] = table.split('.');
  const { rows } = await client.query(
    `SELECT a.attname AS name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)`,
    [schema, name],
  );
  return rows.map((r) => r.name);
}

/**
 * Порядок загрузки считается по связям, а не задаётся руками.
 *
 * Руками написанный порядок ломается на следующей миграции молча: таблица
 * добавилась, её забыли переставить, и загрузка падает на внешнем ключе уже
 * у того, кто переносит содержимое на прод.
 */
async function loadOrder(tables) {
  const set = new Set(tables);
  const { rows } = await client.query(
    `SELECT n.nspname || '.' || c.relname AS child,
            rn.nspname || '.' || rc.relname AS parent
       FROM pg_constraint co
       JOIN pg_class c ON c.oid = co.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class rc ON rc.oid = co.confrelid
       JOIN pg_namespace rn ON rn.oid = rc.relnamespace
      WHERE co.contype = 'f'`,
  );
  const deps = new Map(tables.map((t) => [t, new Set()]));
  for (const { child, parent } of rows) {
    if (child === parent) continue;
    if (set.has(child) && set.has(parent)) deps.get(child).add(parent);
  }
  const ordered = [];
  const done = new Set();
  let guard = tables.length + 1;
  while (ordered.length < tables.length && guard-- > 0) {
    for (const t of tables) {
      if (done.has(t)) continue;
      if ([...deps.get(t)].every((p) => done.has(p))) {
        ordered.push(t);
        done.add(t);
      }
    }
  }
  for (const t of tables) if (!done.has(t)) ordered.push(t);
  return ordered;
}

async function probeAuthors() {
  const { rows } = await client.query(
    `SELECT id FROM identity.users WHERE origin = ANY($1::text[])`,
    [PROBE_ORIGINS],
  );
  return new Set(rows.map((r) => r.id));
}

// ------------------------------------------------------ значения и отпечатки

function encode(value, column) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return { __bytea__: value.toString('base64') };
  if (value instanceof Date) return value.toISOString();
  if (column && (column.udt === 'jsonb' || column.udt === 'json')) return value;
  return value;
}

function decode(value, column) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && value.__bytea__ !== undefined) {
    return Buffer.from(value.__bytea__, 'base64');
  }
  if (column && (column.udt === 'jsonb' || column.udt === 'json')) return JSON.stringify(value);
  return value;
}

/** Ключ строки в переносимом виде: ссылки представлены ключами родителей. */
function keyOf(row, info) {
  return info.naturalKey.map((c) => JSON.stringify(row[c] ?? null)).join('');
}

function fingerprint(row, info) {
  return createHash('sha256')
    .update(info.exported.map((c) => JSON.stringify(row[c] ?? null)).join(''))
    .digest('hex')
    .slice(0, 16);
}

const fileFor = (table) => join(CONTENT_DIR, `${table}.json`);
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// -------------------------------------------------------------------- чтение

/** Соответствие «идентификатор родителя → его естественный ключ». */
const parentKeyCache = new Map();

async function parentKeys(table) {
  if (parentKeyCache.has(table)) return parentKeyCache.get(table);
  const info = await describe(table);
  const pk = info.pk[0];
  const { rows } = await client.query(`SELECT * FROM ${table}`);
  const map = new Map();
  for (const row of rows) {
    map.set(
      row[pk],
      info.naturalKey.map((c) => encode(row[c], info.byName.get(c))),
    );
  }
  parentKeyCache.set(table, map);
  return map;
}

/** Строки содержимого из базы в переносимом виде, без следов прогонов. */
async function readFromDatabase(table, probes) {
  const info = await describe(table);
  const order = info.pk.length > 0 ? info.pk.map((c) => `"${c}"`).join(', ') : '1';
  const { rows } = await client.query(`SELECT * FROM ${table} ORDER BY ${order}`);
  const kept = [];
  let skipped = 0;
  for (const row of rows) {
    const authors = [...info.userRefs].map((c) => row[c]).filter(Boolean);
    if (authors.some((id) => probes.has(id))) {
      skipped += 1;
      continue;
    }
    const out = {};
    for (const name of info.exported) {
      const ref = info.refs[name];
      if (ref) {
        const map = await parentKeys(ref.table);
        const parentKey = row[name] === null ? null : map.get(row[name]);
        if (row[name] !== null && !parentKey) {
          throw new Error(
            `${table}.${name}: строка ссылается на ${ref.table}, которого нет в выдаче — ` +
              'перенос такой ссылки невозможен',
          );
        }
        out[name] = parentKey ? { __ref__: parentKey } : null;
      } else {
        out[name] = encode(row[name], info.byName.get(name));
      }
    }
    kept.push(out);
  }
  // Порядок — по естественному ключу, а не по первичному: суррогат в каждой
  // базе свой, и выгрузка того же содержимого давала бы другой порядок строк.
  // Тогда файл в Git менялся бы целиком при каждом снимке, а сверка переноса
  // показывала бы различия там, где их нет.
  kept.sort((a, b) =>
    keyOf(a, info) < keyOf(b, info) ? -1 : keyOf(a, info) > keyOf(b, info) ? 1 : 0,
  );
  return { info, rows: kept, skipped };
}

function readFromFiles(table) {
  const path = fileFor(table);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  return { rows: JSON.parse(text).rows ?? [], hash: sha256(text) };
}

function readManifest() {
  if (!existsSync(MANIFEST)) return null;
  return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}

// ------------------------------------------------------------------- команды

async function doExport() {
  const probes = await probeAuthors();
  const order = await loadOrder(TABLES);
  mkdirSync(CONTENT_DIR, { recursive: true });

  console.warn('\n=== ВЫГРУЗКА СОДЕРЖИМОГО ===\n');
  const manifest = {
    exportedAt: new Date().toISOString(),
    database: DB_NAME,
    loadOrder: order,
    tables: {},
  };
  let total = 0;
  let skippedTotal = 0;
  for (const table of order) {
    const { info, rows, skipped } = await readFromDatabase(table, probes);
    // Ключи ссылок сортируются: порядок внешних ключей в системном каталоге
    // от базы к базе свой, и файл различался бы при одинаковом содержимом —
    // сверка переноса объявляла бы расхождение там, где его нет.
    const refs = Object.fromEntries(
      Object.keys(info.refs)
        .sort()
        .map((name) => [name, info.refs[name]]),
    );
    const body = JSON.stringify(
      {
        table,
        naturalKey: info.naturalKey,
        columns: info.exported,
        refs,
        rows,
      },
      null,
      2,
    );
    writeFileSync(fileFor(table), `${body}\n`, 'utf8');
    manifest.tables[table] = { rows: rows.length, sha256: sha256(`${body}\n`) };
    total += rows.length;
    skippedTotal += skipped;
    const tail = skipped > 0 ? `  (пропущено следов прогонов: ${skipped})` : '';
    console.warn(`  ${String(rows.length).padStart(5)}  ${table}${tail}`);
  }

  for (const file of readdirSync(CONTENT_DIR)) {
    if (!file.endsWith('.json') || file === 'manifest.json') continue;
    const table = file.replace(/\.json$/, '');
    if (!manifest.tables[table]) {
      rmSync(join(CONTENT_DIR, file));
      console.warn(`  удалён лишний файл: ${file}`);
    }
  }

  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.warn(`\n  всего строк: ${total}`);
  if (skippedTotal > 0) console.warn(`  следов прогонов пропущено: ${skippedTotal}`);
  console.warn(`  снимок: ${manifest.exportedAt}  (база ${DB_NAME})`);
  console.warn(`  каталог: ${CONTENT_DIR}\n`);
}

async function diff() {
  const probes = await probeAuthors();
  const manifest = readManifest();
  const result = [];
  for (const table of TABLES) {
    const inDb = await readFromDatabase(table, probes);
    const inFiles = readFromFiles(table);
    const dbMap = new Map(inDb.rows.map((r) => [keyOf(r, inDb.info), r]));
    const fileMap = new Map((inFiles?.rows ?? []).map((r) => [keyOf(r, inDb.info), r]));

    const added = [];
    const changed = [];
    const missing = [];
    for (const [key, row] of dbMap) {
      if (!fileMap.has(key)) added.push(row);
      else if (fingerprint(row, inDb.info) !== fingerprint(fileMap.get(key), inDb.info)) {
        changed.push({ key, db: row, file: fileMap.get(key) });
      }
    }
    for (const [key, row] of fileMap) if (!dbMap.has(key)) missing.push({ key, row });

    const manifestHash = manifest?.tables?.[table]?.sha256 ?? null;
    result.push({
      table,
      info: inDb.info,
      db: inDb.rows.length,
      file: inFiles?.rows.length ?? null,
      added,
      changed,
      missing,
      editedByHand: Boolean(inFiles && manifestHash && inFiles.hash !== manifestHash),
    });
  }
  return { manifest, tables: result };
}

async function doStatus() {
  const { manifest, tables } = await diff();
  console.warn('\n=== СОДЕРЖИМОЕ: БАЗА И КОМПЛЕКТ ===\n');
  if (!manifest) {
    console.warn('  комплект ещё не снимали — `npm run content:export`\n');
  } else {
    console.warn(`  снимок от:   ${new Date(manifest.exportedAt).toLocaleString('ru-RU')}`);
    console.warn(`  снят с базы: ${manifest.database}`);
    console.warn(`  сверяем с:   ${DB_NAME}\n`);
  }
  let dirty = 0;
  let handEdited = 0;
  for (const t of tables) {
    const marks = [];
    if (t.added.length) marks.push(`+${t.added.length}`);
    if (t.changed.length) marks.push(`~${t.changed.length}`);
    if (t.missing.length) marks.push(`-${t.missing.length}`);
    if (t.editedByHand) handEdited += 1;
    if (marks.length === 0 && !t.editedByHand) continue;
    dirty += 1;
    const hand = t.editedByHand ? '  (файл правили после снимка)' : '';
    console.warn(`  ${t.table.padEnd(38)} ${marks.join(' ').padStart(12)}${hand}`);
  }
  if (dirty === 0) {
    console.warn('  расхождений нет: комплект соответствует базе');
  } else {
    console.warn(`\n  таблиц с расхождением: ${dirty}`);
    console.warn(
      '  + есть в базе, нет в комплекте · ~ различается · - есть в комплекте, нет в базе',
    );
    console.warn('\n  Снять новый снимок: npm run content:export');
  }
  if (handEdited > 0) {
    console.warn(`  файлов изменено помимо выгрузки: ${handEdited} — сверьте диффом`);
  }
  console.warn('');
}

/** Значение ссылки в идентификатор родителя В ЭТОЙ базе. */
async function resolveRef(value, ref) {
  if (value === null || value === undefined) return null;
  const parent = await describe(ref.table);
  const conditions = ref.key.map((c, i) => `"${c}" = $${i + 1}`).join(' AND ');
  const { rows } = await client.query(
    `SELECT "${parent.pk[0]}" AS id FROM ${ref.table} WHERE ${conditions}`,
    value.__ref__,
  );
  if (rows.length === 0) {
    throw new Error(
      `в ${ref.table} нет строки с ключом ${JSON.stringify(value.__ref__)} — ` +
        'сначала должен загрузиться родитель',
    );
  }
  return rows[0].id;
}

async function doLoad() {
  const { manifest, tables } = await diff();
  if (!manifest) {
    console.error('\n  комплекта нет — загружать нечего\n');
    process.exitCode = 1;
    return;
  }
  const order = manifest.loadOrder ?? TABLES;
  const byName = new Map(tables.map((t) => [t.table, t]));

  console.warn('\n=== ЗАГРУЗКА СОДЕРЖИМОГО ===\n');
  console.warn(`  комплект от: ${new Date(manifest.exportedAt).toLocaleString('ru-RU')}`);
  console.warn(`  в базу:      ${DB_NAME}\n`);

  let toInsert = 0;
  let conflicts = 0;
  for (const table of order) {
    const t = byName.get(table);
    if (!t) continue;
    toInsert += t.missing.length;
    conflicts += t.changed.length;
    if (t.missing.length === 0 && t.changed.length === 0) continue;
    const parts = [];
    if (t.missing.length) parts.push(`добавить ${t.missing.length}`);
    if (t.changed.length) parts.push(`расходится ${t.changed.length}`);
    console.warn(`  ${table.padEnd(38)} ${parts.join(', ')}`);
  }
  if (toInsert === 0 && conflicts === 0) {
    console.warn('  база уже соответствует комплекту — делать нечего\n');
    return;
  }

  if (conflicts > 0) {
    console.warn(
      `\n  РАСХОЖДЕНИЯ: ${conflicts} строк в базе отличаются от комплекта по содержимому\n` +
        '  при том же естественном ключе.' +
        (OVERWRITE
          ? ' Указан --overwrite: комплект перепишет базу.\n'
          : '\n  По умолчанию загрузка их НЕ трогает: в базе может быть свежая правка,\n' +
            '  которой нет в файлах. Посмотрите `npm run content:status`, затем либо\n' +
            '  снимите новый снимок, либо переписывайте комплектом: --overwrite\n'),
    );
  }

  if (!APPLY) {
    console.warn('\n  Это предварительный показ. Применить: --yes\n');
    return;
  }

  let inserted = 0;
  let updated = 0;
  await client.query('BEGIN');
  try {
    for (const table of order) {
      const t = byName.get(table);
      if (!t) continue;
      const fromFile = readFromFiles(table);
      if (!fromFile) continue;
      const info = t.info;
      const missingKeys = new Set(t.missing.map((m) => m.key));
      const changedKeys = new Set(t.changed.map((c) => c.key));

      for (const row of fromFile.rows) {
        const key = keyOf(row, info);
        const isNew = missingKeys.has(key);
        const isConflict = changedKeys.has(key);
        if (!isNew && !(isConflict && OVERWRITE)) continue;

        // Ссылки на родителей переводятся в идентификаторы ЭТОЙ базы.
        const values = {};
        for (const name of info.exported) {
          const ref = info.refs[name];
          values[name] = ref
            ? await resolveRef(row[name], ref)
            : decode(row[name], info.byName.get(name));
        }

        if (isNew) {
          const names = [...info.exported];
          const params = names.map((n) => values[n]);
          const placeholders = names.map((_, i) => `$${i + 1}`);
          // Суррогатный ключ без значения по умолчанию заполняем сами:
          // идентификатор исходной базы сюда переносить нельзя.
          if (info.surrogate && !info.surrogateHasDefault) {
            names.unshift(info.surrogate);
            placeholders.unshift('public.uuid_generate_v7()');
          }
          await client.query(
            `INSERT INTO ${table} (${names.map((n) => `"${n}"`).join(', ')})
             VALUES (${placeholders.join(', ')})`,
            params,
          );
          inserted += 1;
        } else {
          const assignable = info.exported.filter((n) => !info.naturalKey.includes(n));
          if (assignable.length === 0) continue;
          const sets = assignable.map((n, i) => `"${n}" = $${i + 1}`);
          const params = assignable.map((n) => values[n]);
          const where = info.naturalKey.map((n, i) => `"${n}" = $${assignable.length + i + 1}`);
          await client.query(
            `UPDATE ${table} SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`,
            [...params, ...info.naturalKey.map((n) => values[n])],
          );
          updated += 1;
        }
      }
    }
    await client.query('COMMIT');
    console.warn(`\n  добавлено: ${inserted}, переписано: ${updated}\n`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(
      `\n  загрузка не выполнена, изменений нет:\n  ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (COMMAND === 'export') await doExport();
else if (COMMAND === 'status') await doStatus();
else await doLoad();

await client.end();
