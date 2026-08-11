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
  ['app_backend', 'billing.confirm_first_tranche'],
  ['app_billing', 'billing.confirm_first_tranche'],
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

await client.end();

const failures = open.length + (NEGATIVE.length - denied);
console.warn(`\n=== ИТОГ: ${failures === 0 ? 'нарушений нет' : `нарушений: ${failures}`} ===\n`);
process.exitCode = failures > 0 ? 1 : 0;
