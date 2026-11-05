#!/usr/bin/env node
/**
 * Секреты из файлов для служебных скриптов (блок 5, задание 2). Узкая проверка, без контейнеров.
 *
 *   node scripts/check-secrets-to-files.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvFile, resolvedEnvText } from './lib/backup.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'secrets-files-'));
const env = join(dir, '.env');
const secrets = join(dir, 'secrets');
const original = [
  '# образец',
  'NODE_ENV=development',
  'POSTGRES_PASSWORD=first-secret-value',
  'S3_SECRET_ACCESS_KEY=second-secret-value',
  'DATABASE_URL=postgres://user:third-secret@127.0.0.1:5433/db',
  'REDIS_URL=redis://127.0.0.1:6379',
  'EMPTY_PASSWORD=',
  '',
].join('\n');
let passed = 0;
let failed = 0;
const check = (name, ok, details = '') => {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details ? ` — ${details}` : ''}`);
};
const tool = (...args) =>
  spawnSync(process.execPath, [join(ROOT, 'scripts', 'secrets-to-files.mjs'), ...args], {
    encoding: 'utf8',
  });

console.log('=== СЕКРЕТЫ В ФАЙЛАХ ===');
try {
  writeFileSync(env, original);
  const before = parseEnvFile(env);
  const applied = tool('apply', '--env', env, '--dir', secrets);
  check('перенос прошёл', applied.status === 0, applied.stdout.slice(0, 80));
  const text = readFileSync(env, 'utf8');
  check('значений в .env нет', !/secret-value|third-secret/.test(text));
  check('вывод не содержит значений', !/secret-value|third-secret/.test(applied.stdout));
  check(
    'несекретное осталось',
    text.includes('NODE_ENV=development') && text.includes('REDIS_URL='),
  );
  const after = parseEnvFile(env);
  check(
    'служебные скрипты читают те же значения',
    ['POSTGRES_PASSWORD', 'S3_SECRET_ACCESS_KEY', 'DATABASE_URL'].every(
      (k) => after[k] === before[k],
    ),
  );
  const resolved = resolvedEnvText(env);
  check('комплект ключей получает значения', resolved.includes('first-secret-value'));
  writeFileSync(env, `${readFileSync(env, 'utf8')}POSTGRES_PASSWORD=x\n`);
  let conflict = '';
  try {
    parseEnvFile(env);
  } catch (e) {
    conflict = e.message;
  }
  check(
    'значение рядом с файлом — отказ',
    conflict.includes('Заданы и POSTGRES_PASSWORD'),
    conflict,
  );
  writeFileSync(env, text);
  const backed = tool('back', '--env', env);
  check('возврат прошёл', backed.status === 0);
  check('значения вернулись', parseEnvFile(env).POSTGRES_PASSWORD === before.POSTGRES_PASSWORD);
  const driver = (value) =>
    spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'infra.mjs'), 'compose', 'config', '--services'],
      { encoding: 'utf8', env: { ...process.env, DOCKER_LOG_DRIVER: value } },
    ).status;
  check('journald без файлов секретов принимается', driver('journald') === 0);
  check('другой драйвер журналов — отказ', driver('json-file') === 2);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\nИТОГО: ${passed} пройдено, ${failed} провалено`);
process.exit(failed ? 1 : 0);
