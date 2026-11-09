#!/usr/bin/env node
/**
 * Расхождение основного Caddyfile сервера с копией в Git (блок 11; Тэнк 09.11).
 *
 *   node scripts/caddy-drift.mjs
 *
 * Только читает /etc/caddy/Caddyfile на VPS. Хеши паролей basic_auth заменяются
 * подстановками так же, как в infra/caddy/Caddyfile, и в вывод не попадают: печатаются
 * только номера и текст несовпадающих строк уже без секретов.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const HOST = process.env.FIFTH_VPS ?? 'maus@193.233.217.210';
const KEY = join(homedir(), '.ssh', 'maus_5e');

const mask = (text) =>
  text.replace(
    /^(\t+)([A-Za-z0-9_-]+)[ \t]+\$2[aby]\$\S+[ \t]*$/gm,
    (_a, ind, user) => `${ind}${user} {$CADDY_AUTH_${user.toUpperCase()}}`,
  );

const server = mask(
  execFileSync(
    'ssh',
    [
      '-i',
      KEY,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
      HOST,
      'cat /etc/caddy/Caddyfile',
    ],
    { encoding: 'utf8', timeout: 60_000 },
  ),
);
if (/\$2[aby]\$/.test(server)) throw new Error('в копии сервера остался хеш — вывод остановлен');
// Заголовок копии в Git — строки комментария до первой пустой.
const repo = readFileSync(join(ROOT, 'infra/caddy/Caddyfile'), 'utf8').replace(
  /^(#[^\n]*\n)+\n?/,
  '',
);

const a = server.split('\n');
const b = repo.split('\n');
const diff = [];
for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
  if (a[i] !== b[i]) diff.push({ line: i + 1, server: a[i] ?? null, git: b[i] ?? null });
}
console.log(JSON.stringify({ same: diff.length === 0, differences: diff.slice(0, 20) }, null, 2));
process.exit(diff.length === 0 ? 0 : 1);
