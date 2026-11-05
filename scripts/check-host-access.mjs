#!/usr/bin/env node
/**
 * Обёртки maus не выводят за каталог копий (блок 5, шаг 3.0). Узкая проверка, без контейнеров.
 *
 *   node scripts/check-host-access.mjs
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = mkdtempSync(join(tmpdir(), 'host-access-'));
const copies = join(base, 'copies');
// На сервере файл лежит вне пакета; здесь расширение отделяет его от модулей репозитория.
const TOOL = join(base, 'fifth-backup-read.cjs');
const outside = join(base, 'outside.txt');
const ID = '20261105T000000Z-abc123';
let passed = 0;
let failed = 0;
const check = (name, ok, details = '') => {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details ? ` — ${details}` : ''}`);
};
const run = (args, input) =>
  spawnSync(process.execPath, [TOOL, ...args], {
    env: { ...process.env, FIFTH_BACKUP_READ_ROOT: copies },
    input,
    maxBuffer: 1 << 26,
  });
const put = (rel, text) => {
  mkdirSync(dirname(join(copies, rel)), { recursive: true });
  writeFileSync(join(copies, rel), text);
};
const catalog = (paths, id = ID) =>
  put(`sets/${id}/catalog.json`, JSON.stringify({ id, manifest: paths.map((path) => ({ path })) }));
const tarNames = (buf) =>
  spawnSync('tar', ['-tf', '-'], { input: buf, encoding: 'utf8' })
    .stdout.split('\n')
    .filter(Boolean);

console.log('=== ОБЁРТКИ MAUS ===');
try {
  copyFileSync(join(ROOT, 'infra', 'host', 'fifth-backup-read'), TOOL);
  writeFileSync(outside, 'вне копий');
  put('keys/a.env.gpg', 'ключи');
  put('files/one.bin', 'данные');
  put('extra/not-in-catalog', 'лишнее');
  put(`sets/${ID}/READY`, '');
  catalog(['keys/a.env.gpg', 'files/one.bin']);

  check('latest называет готовый комплект', run(['latest']).stdout.toString().trim() === ID);
  const good = run(['tar', ID]);
  const names = tarNames(good.stdout);
  check('tar отдаёт файлы описи', good.status === 0 && names.includes('files/one.bin'));
  check('файла вне описи в потоке нет', !names.includes('extra/not-in-catalog'));
  const asked = run(['tar', ID], '../outside.txt\nextra/not-in-catalog\n');
  check(
    'список на входе не влияет',
    !tarNames(asked.stdout).some((n) => n.includes('outside') || n.includes('extra')),
  );
  check('чужое имя комплекта — отказ', run(['catalog', '../../etc']).status === 2);
  check('команда вне списка — отказ', run(['cat', ID]).status === 2);
  check('лишние аргументы — отказ', run(['tar', ID, '--to-command=sh']).status === 2);

  catalog(['../outside.txt']);
  check('выход наверх в описи — отказ', run(['tar', ID]).status === 2);
  catalog([outside]);
  check('абсолютный путь в описи — отказ', run(['tar', ID]).status === 2);
  catalog(['files']);
  check('каталог в описи — отказ', run(['tar', ID]).status === 2);

  let linked = true;
  try {
    symlinkSync(outside, join(copies, 'files', 'link'));
  } catch {
    linked = false;
  }
  if (linked) {
    catalog(['files/link']);
    check('ссылка наружу — отказ', run(['tar', ID]).status === 2);
  } else {
    console.log('  SKIP  ссылка наружу — система не дала создать ссылку');
  }

  const option = '--checkpoint-action=exec=x';
  put(`files/${option}`, 'имя как параметр');
  catalog([`files/${option}`]);
  check('имя-параметр остаётся именем', tarNames(run(['tar', ID]).stdout).length === 3);

  const sudoers = readFileSync(join(ROOT, 'infra', 'host', 'sudoers-maus'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'));
  const commands = sudoers
    .join(' ')
    .split('NOPASSWD:')[1]
    ?.split(',')
    .map((s) => s.trim());
  check(
    'в sudo только обёртки',
    sudoers.length === 1 &&
      commands?.length === 2 &&
      commands.every((c) => /^\/usr\/local\/sbin\/fifth-(backup-read|diag)$/.test(c)),
  );
} finally {
  rmSync(base, { recursive: true, force: true });
}
console.log(`\nИТОГО: ${passed} пройдено, ${failed} провалено`);
process.exit(failed ? 1 : 0);
