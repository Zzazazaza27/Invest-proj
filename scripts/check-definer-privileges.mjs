#!/usr/bin/env node
/**
 * Гейт: ни одна функция SECURITY DEFINER не исполнима ролью PUBLIC.
 *
 * PostgreSQL выдаёт EXECUTE роли PUBLIC на каждую новую функцию по умолчанию, а
 * адресный GRANT нужным ролям этот default не отменяет. Поэтому «мы выдали
 * права только app_investments» — утверждение о намерении, а не о фактических
 * правах: проверить его можно только запросом к каталогу.
 *
 * Находка внешнего аудита (SEC-04) была именно такой: три функции, включая
 * подтверждение денежного транша и запись журнала от имени произвольного
 * актора, вызывались любой ролью с USAGE на схему.
 *
 * Запуск: node scripts/check-definer-privileges.mjs
 */
import pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

function loadDotEnv() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    process.env[trimmed.slice(0, eq).trim()] ??= trimmed.slice(eq + 1).trim();
  }
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
await client.connect();

console.warn('\n=== ПРАВА НА SECURITY DEFINER ===\n');

const { rows } = await client.query(`
  SELECT n.nspname || '.' || p.proname AS fn,
         pg_get_function_identity_arguments(p.oid) AS args,
         has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   ORDER BY 1`);

const open = rows.filter((row) => row.public_exec);
console.warn(`  функций SECURITY DEFINER: ${rows.length}`);
console.warn(`  из них исполнимы PUBLIC:  ${open.length}`);
for (const row of open) console.warn(`    FAIL ${row.fn}(${row.args})`);

// Отдельно — фактическая проверка запрета для конкретных ролей: наличие или
// отсутствие GRANT в каталоге и невозможность вызова — разные утверждения.
const NEGATIVE = [
  ['app_readonly', 'audit.app_emit_event'],
  ['app_backend', 'billing.confirm_tranche'],
  ['app_billing', 'billing.confirm_tranche'],
];
let denied = 0;
for (const [role, fn] of NEGATIVE) {
  const { rows: check } = await client.query(
    `SELECT has_function_privilege($1, p.oid, 'EXECUTE') AS allowed
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname || '.' || p.proname = $2 LIMIT 1`,
    [role, fn],
  );
  const allowed = check[0]?.allowed ?? null;
  if (allowed === false) {
    denied += 1;
    console.warn(`  OK   ${role} не может вызвать ${fn}`);
  } else {
    console.warn(`  FAIL ${role} может вызвать ${fn}`);
  }
}

// --------------------------------------------------------------- search_path
//
// У функции SECURITY DEFINER путь поиска — часть её границы безопасности: тело
// исполняется с правами владельца, и неквалифицированное имя уходит туда, куда
// укажет search_path. Два требования проверяются отдельно, потому что нарушаются
// они по-разному (SEC-14):
//
//  * `pg_temp` обязан стоять ПОСЛЕДНИМ. Если его не указать вовсе, он ищется
//    ПЕРВЫМ — и любой пользователь подменяет имя объектом в своей временной
//    схеме.
//  * `public` не должен встречаться. Исключение одно и названо поимённо:
//    `audit.app_emit_event` зовёт `digest` из pgcrypto, установленного в public.
const PUBLIC_ALLOWED = new Set(['audit.app_emit_event']);

const { rows: definers } = await client.query(
  `SELECT n.nspname || '.' || p.proname AS fn, p.proconfig
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY 1`,
);
let pathViolations = 0;
for (const row of definers) {
  const setting = (row.proconfig ?? []).find((c) => c.startsWith('search_path='));
  const parts = setting
    ? setting
        .slice('search_path='.length)
        .split(',')
        .map((x) => x.trim())
    : [];

  if (parts.length === 0) {
    pathViolations += 1;
    console.warn(`  FAIL ${row.fn}: search_path не задан вовсе`);
    continue;
  }
  if (parts[parts.length - 1] !== 'pg_temp') {
    pathViolations += 1;
    console.warn(`  FAIL ${row.fn}: pg_temp не последний (${parts.join(', ')})`);
    continue;
  }
  if (parts.includes('public') && !PUBLIC_ALLOWED.has(row.fn)) {
    pathViolations += 1;
    console.warn(`  FAIL ${row.fn}: public в пути без обоснования`);
    continue;
  }
  console.warn(`  OK   ${row.fn}: ${parts.join(', ')}`);
}

// Право создавать объекты в public — вторая половина того же запрета: пока его
// нет ни у кого, кроме владельца, подменить имя внутри исключения некому.
const { rows: creators } = await client.query(
  `SELECT rolname FROM pg_roles
    WHERE (rolname LIKE 'app%' OR rolname = 'public')
      AND has_schema_privilege(rolname, 'public', 'CREATE')`,
);
if (creators.length > 0) {
  pathViolations += 1;
  console.warn(
    `  FAIL создавать объекты в public могут: ${creators.map((r) => r.rolname).join(', ')}`,
  );
} else {
  console.warn('  OK   создавать объекты в public не может ни одна роль приложения');
}

await client.end();

const failures = open.length + (NEGATIVE.length - denied) + pathViolations;
console.warn(`\n=== ИТОГ: ${failures === 0 ? 'нарушений нет' : `нарушений: ${failures}`} ===\n`);
process.exitCode = failures > 0 ? 1 : 0;
