#!/usr/bin/env node
/**
 * Что сохраняется при обнулении стенда: таблицы классов system и content
 * (database/src/data-classes.ts) и схема intelligence — с числом строк.
 * Только чтение. Запуск: node --experimental-strip-types scripts/list-kept-data.mjs
 */
import pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) process.env[t.slice(0, eq).trim()] ??= t.slice(eq + 1).trim();
  }
}
const { DATA_CLASSES } = await import(
  new URL('../database/src/data-classes.ts', import.meta.url).href
);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
await client.connect();
const rows = [];
for (const [name, info] of Object.entries(DATA_CLASSES)) {
  const keep =
    info.kind === 'system' || info.kind === 'content' || name.startsWith('intelligence.');
  if (!keep) continue;
  const exists = (await client.query('SELECT to_regclass($1) IS NOT NULL AS ok', [name])).rows[0]
    .ok;
  if (!exists) continue;
  const n = Number((await client.query(`SELECT count(*) AS n FROM ${name}`)).rows[0].n);
  rows.push({
    name,
    kind: name.startsWith('intelligence.') ? 'MI' : info.kind,
    n,
    note: info.note ?? '',
  });
}
await client.end();
for (const r of rows.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`${r.kind}\t${r.name}\t${r.n}\t${r.note}`);
}
