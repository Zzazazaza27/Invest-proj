#!/usr/bin/env node
/**
 * Копия пилотной среды вне сервера: забирает последнюю готовую копию, сверяет хеши описи и только
 * потом кладёт в каталог назначения и отмечает на сервере, что вынос состоялся.
 *
 *   node scripts/pilot-offsite.mjs [--to <каталог>] [--keep <число>]
 *
 * Файлы остаются зашифрованными на ключ Томаса: здесь они не открываются. Отметку читает
 * `backup.mjs check`: давний вынос становится проблемой в наблюдении. Значения не печатаются.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const option = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const TARGET = resolve(option('--to', 'D:/cloud@mail.ru/projects/5E/test-2-backups'));
const KEEP = Number(option('--keep', 14));
const FILES = ['db.dump.gpg', 'roles.sql.gpg', 'files.tar.gpg', 'env.tar.gpg'];

const read = (command) => {
  const r = spawnSync(
    'ssh',
    [
      '-i',
      join(homedir(), '.ssh', 'maus_5e'),
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
      'maus@193.233.217.210',
      `sudo -n /usr/local/sbin/fifth-backup-read ${command}`,
    ],
    { maxBuffer: 1 << 30 },
  );
  if (r.status !== 0) throw new Error(`${command.split(' ')[0]}: код ${r.status ?? r.signal}`);
  return r.stdout;
};

const set = read('pilot-latest').toString().trim();
if (!/^[0-9TZ]+$/.test(set)) throw new Error('готовых копий нет');
const final = join(TARGET, set);
if (!existsSync(final)) {
  const work = join(TARGET, `.${set}.part`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const manifestBytes = read(`pilot-file ${set}/manifest.json`);
  const manifest = JSON.parse(manifestBytes.toString());
  for (const name of FILES) {
    const bytes = read(`pilot-file ${set}/${name}`);
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256[name]) {
      rmSync(work, { recursive: true, force: true });
      throw new Error(`${name}: хеш не совпал с описью`);
    }
    writeFileSync(join(work, name), bytes);
  }
  writeFileSync(join(work, 'manifest.json'), manifestBytes);
  renameSync(work, final);
}
const sets = readdirSync(TARGET)
  .filter((name) => /^[0-9TZ]+$/.test(name))
  .sort();
for (const old of sets.slice(0, Math.max(0, sets.length - KEEP))) {
  rmSync(join(TARGET, old), { recursive: true, force: true });
}
read(`pilot-ack ${set}`);
console.log(`копия ${set} вне сервера: ${final}, всего копий ${Math.min(sets.length, KEEP)}`);
