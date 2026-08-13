#!/usr/bin/env node
/**
 * Гейт согласованности KEK-доменов (Ф27).
 *
 * Карта «домен → таблица» в `rotate-kek.mjs` ведётся вручную, и до этого гейта
 * ничто не мешало разъехаться четырём источникам правды:
 *   1. тип `KekDomain` в `apps/core/src/crypto/crypto.service.ts`;
 *   2. фактические вызовы `seal/sealMany/sealDirect/openDirect/openField`
 *      в `apps/core/src`;
 *   3. карты `ENVELOPE` и `NOT_ENVELOPE` в `scripts/rotate-kek.mjs`;
 *   4. колонки `*_wrapped_dek` в миграциях БД.
 *
 * Правила:
 *   - домен, используемый конвертом (`seal`/`sealMany`), обязан быть в ENVELOPE —
 *     иначе ротация о его таблице не узнает;
 *   - домен, используемый напрямую (`sealDirect`) или как HMAC, обязан быть в
 *     NOT_ENVELOPE — там записано, почему конвертная ротация к нему неприменима;
 *   - каждая колонка `*_wrapped_dek` из миграций обязана быть покрыта записью
 *     ENVELOPE (главный риск: новая колонка, о которой карта не знает);
 *   - домен без единого вызова допустим только в списке RESERVED ниже;
 *   - домен из RESERVED, получивший вызов, обязан покинуть список и получить
 *     запись в карте ротации.
 *
 * Домены, зарезервированные схемой БД, но не реализованные в коде
 * (решение Ф27 по вопросу Ф25): удалять их значило бы контракт-миграцию
 * CHECK-ограничений M010/M023 и реестра M011 ради экономии трёх строк .env;
 * назначение колонок под них уже описано в M003. Остаются объявленными,
 * значения в .env опциональны (env-схема даёт '').
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const RESERVED = new Set(['kyc_documents', 'nominal_account_evidence', 'billing_documents']);

/**
 * Колонки, объявленные миграциями «на вырост»: код в них ещё не пишет, поэтому
 * в карте ротации их нет. Инвариант: зарезервированная колонка ПУСТА — это
 * проверяется живым запросом ниже (при доступной БД). Как только код начнёт
 * писать в колонку, живая проверка упадёт, и колонку нужно перенести из этого
 * списка в ENVELOPE-карту rotate-kek.mjs.
 */
const RESERVED_DEK_COLUMNS = new Set([
  'kyc.kyc_verifications.evidence_wrapped_dek', // KEK-домен kyc_documents (M003)
  'kyc.kyb_verifications.evidence_wrapped_dek',
  'kyc.kyb_verifications.beneficial_owners_wrapped_dek',
  'kyc.business_entities.registry_payload_wrapped_dek',
  'investments.investment_tranches.evidence_wrapped_dek', // nominal_account_evidence
  'billing.invoices.pdf_wrapped_dek', // billing_documents; таблица пуста до генератора PDF
  'scoring.passport_facts.value_wrapped_dek', // факты пишутся в value_jsonb, шифрование не включено
  'audit.encryption_keys_registry.wrapped_dek', // реестр ключей, а не данных: хранит обёртку самого ключа
]);

const failures = [];

// --- 1. Тип KekDomain ---------------------------------------------------------
const cryptoSrc = readFileSync(join(ROOT, 'apps/core/src/crypto/crypto.service.ts'), 'utf8');
const typeBlock = cryptoSrc.match(/export type KekDomain =([\s\S]*?);/);
if (!typeBlock) {
  console.error('не найден тип KekDomain');
  process.exit(2);
}
const declared = new Set([...typeBlock[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));

// --- 2. Вызовы в apps/core/src -------------------------------------------------
function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) yield p;
  }
}
const envelopeUsed = new Set();
const directUsed = new Set();
for (const file of walk(join(ROOT, 'apps/core/src'))) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\.(seal|sealMany|openField)\(\s*'([a-z_]+)'/g))
    envelopeUsed.add(m[2]);
  for (const m of src.matchAll(/\.(sealDirect|openDirect)\(\s*'([a-z_]+)'/g)) directUsed.add(m[2]);
}
// hmacIndex использует search_index внутри самого сервиса — фиксируем явно,
// если он там по-прежнему есть.
if (/kek\('search_index'\)/.test(cryptoSrc)) directUsed.add('search_index');

// --- 3. Карты rotate-kek.mjs ----------------------------------------------------
const rotateSrc = readFileSync(join(ROOT, 'scripts/rotate-kek.mjs'), 'utf8');
function extractMapKeys(name) {
  const m = rotateSrc.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`));
  if (!m) {
    console.error(`не найдена карта ${name} в rotate-kek.mjs`);
    process.exit(2);
  }
  return { body: m[1], keys: new Set([...m[1].matchAll(/^ {2}([a-z_]+):/gm)].map((k) => k[1])) };
}
const envelopeMap = extractMapKeys('ENVELOPE');
const notEnvelopeMap = extractMapKeys('NOT_ENVELOPE');
const envByDomainMap = extractMapKeys('ENV_BY_DOMAIN');

// Пары (таблица, колонка DEK), которые карта ENVELOPE знает.
const mappedDekColumns = new Set(
  [...envelopeMap.body.matchAll(/table:\s*'([a-z_.]+)'[\s\S]*?dek:\s*'([a-z_]+)'/g)].map(
    (m) => `${m[1]}.${m[2]}`,
  ),
);

// --- 4. Колонки *_wrapped_dek в миграциях ---------------------------------------
const migrationsDir = join(ROOT, 'database', 'migrations');
const dekColumns = new Set();
for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'))) {
  const sql = readFileSync(join(migrationsDir, f), 'utf8');
  // CREATE TABLE schema.table (... col_wrapped_dek ...)
  for (const tbl of sql.matchAll(/CREATE TABLE ([a-z_]+\.[a-z_]+)\s*\(([\s\S]*?)\n\);/g)) {
    for (const col of tbl[2].matchAll(/^\s*([a-z_]*wrapped_dek)\s/gm)) {
      dekColumns.add(`${tbl[1]}.${col[1]}`);
    }
  }
  // ALTER TABLE ... ADD COLUMN col_wrapped_dek
  for (const m of sql.matchAll(
    /ALTER TABLE ([a-z_]+\.[a-z_]+)[\s\S]{0,200}?ADD COLUMN (?:IF NOT EXISTS )?([a-z_]*wrapped_dek)\b/g,
  )) {
    dekColumns.add(`${m[1]}.${m[2]}`);
  }
}

// --- Проверки -------------------------------------------------------------------
for (const d of envelopeUsed) {
  if (!envelopeMap.keys.has(d))
    failures.push(
      `домен '${d}' используется конвертом (seal/sealMany), но его нет в ENVELOPE rotate-kek.mjs`,
    );
}
for (const d of directUsed) {
  if (!notEnvelopeMap.keys.has(d) && !envelopeMap.keys.has(d))
    failures.push(
      `домен '${d}' используется напрямую, но его нет ни в NOT_ENVELOPE, ни в ENVELOPE`,
    );
}
for (const col of dekColumns) {
  if (!mappedDekColumns.has(col) && !RESERVED_DEK_COLUMNS.has(col))
    failures.push(
      `колонка ${col} есть в миграциях, но не покрыта ни картой ENVELOPE rotate-kek.mjs, ни списком RESERVED_DEK_COLUMNS`,
    );
}
for (const col of RESERVED_DEK_COLUMNS) {
  if (!dekColumns.has(col))
    failures.push(`RESERVED_DEK_COLUMNS содержит ${col}, которой нет в миграциях`);
  if (mappedDekColumns.has(col))
    failures.push(`${col} одновременно в ENVELOPE и в RESERVED_DEK_COLUMNS — выбери одно`);
}
for (const col of mappedDekColumns) {
  if (!dekColumns.has(col))
    failures.push(`карта ENVELOPE ссылается на ${col}, которой нет в миграциях`);
}
const used = new Set([...envelopeUsed, ...directUsed]);
for (const d of declared) {
  if (!used.has(d) && !RESERVED.has(d))
    failures.push(
      `домен '${d}' объявлен в KekDomain, но не используется и не помечен зарезервированным`,
    );
  if (used.has(d) && RESERVED.has(d))
    failures.push(
      `домен '${d}' помечен зарезервированным, но уже используется — убери из RESERVED и внеси в карту ротации`,
    );
  if (!envByDomainMap.keys.has(d))
    failures.push(
      `домен '${d}' объявлен в KekDomain, но отсутствует в ENV_BY_DOMAIN rotate-kek.mjs`,
    );
}
for (const d of [...envelopeMap.keys, ...notEnvelopeMap.keys, ...envByDomainMap.keys]) {
  if (!declared.has(d))
    failures.push(`домен '${d}' есть в картах rotate-kek.mjs, но не объявлен в KekDomain`);
}

// --- Живая проверка: зарезервированные колонки пусты ----------------------------
// Требует БД; в CI её нет — часть пропускается с явным сообщением (как в
// check-secret-reuse). Пустота колонки — единственное, что делает законным её
// отсутствие в карте ротации.
let liveNote = 'живая проверка пустоты зарезервированных колонок ПРОПУЩЕНА (нет .env/БД)';
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  const m = readFileSync(envPath, 'utf8').match(/^DATABASE_URL_OWNER=(.*)$/m);
  if (m && m[1]) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: m[1].trim(), max: 1 });
    try {
      let checked = 0;
      for (const col of RESERVED_DEK_COLUMNS) {
        const lastDot = col.lastIndexOf('.');
        const table = col.slice(0, lastDot);
        const column = col.slice(lastDot + 1);
        const res = await pool.query(
          `SELECT count(*) AS n FROM ${table} WHERE ${column} IS NOT NULL`,
        );
        checked += 1;
        if (Number(res.rows[0].n) > 0) {
          failures.push(
            `зарезервированная колонка ${col} НЕ пуста (${res.rows[0].n} строк) — код начал писать, ` +
              `перенеси её в ENVELOPE-карту rotate-kek.mjs, иначе ротация домена пропустит таблицу`,
          );
        }
      }
      liveNote = `живая проверка: ${checked} зарезервированных колонок пусты`;
      if (failures.some((f) => f.includes('НЕ пуста')))
        liveNote = 'живая проверка: найдены НЕпустые зарезервированные колонки';
    } finally {
      await pool.end();
    }
  }
}

const summary =
  `доменов объявлено: ${declared.size}, используется: ${used.size} ` +
  `(конверт: ${[...envelopeUsed].sort().join(', ') || '—'}; напрямую: ${[...directUsed].sort().join(', ') || '—'}), ` +
  `зарезервировано схемой: ${[...RESERVED].sort().join(', ')}; колонок *_wrapped_dek в миграциях: ${dekColumns.size}; ` +
  liveNote;

if (failures.length > 0) {
  console.error('check-kek-domains: ПРОВАЛ —', failures.length, 'расхождений:');
  for (const f of failures) console.error('  ✗', f);
  console.error('  ', summary);
  process.exit(1);
}
console.warn('check-kek-domains: OK —', summary);
