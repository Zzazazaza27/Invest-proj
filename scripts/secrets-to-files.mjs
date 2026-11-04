#!/usr/bin/env node
/**
 * Перенос секретов рабочей среды из `.env` в файлы (блок 5, задание 2).
 *
 *   node scripts/secrets-to-files.mjs apply [--env <файл>] [--dir <каталог>]
 *   node scripts/secrets-to-files.mjs back  [--env <файл>]
 *
 * В `.env` остаётся `<ИМЯ>_FILE=<путь>`, значение уходит в файл. Путь одинаков на узле и
 * в контейнере ядра, поэтому его читают и служебные скрипты, и образы, в том числе
 * прежних комплектов. Значения не печатаются. `back` возвращает значения в `.env`.
 * Владельца файлов задаёт FIFTH_SECRETS_GID: ядро работает не от root.
 */
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSecretVar, resolvedEnvText } from './lib/backup.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const ENV = resolve(flag('--env') || join(ROOT, '.env'));
const DIR = resolve(flag('--dir') || join(ROOT, '.local', 'secrets'));
const GID = process.env.FIFTH_SECRETS_GID ? Number(process.env.FIFTH_SECRETS_GID) : null;

// Попадают под общее правило по имени, но секретами не являются.
const NOT_SECRET = /(_PORT|_TTL_SEC|_ID|_RECIPIENT|KEYCLOAK_ADMIN)$/;

function protect(path, mode) {
  chmodSync(path, mode);
  if (GID !== null) chownSync(path, 0, GID);
}

function apply() {
  mkdirSync(DIR, { recursive: true });
  protect(DIR, 0o750);
  const moved = [];
  const lines = readFileSync(ENV, 'utf8')
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) return line;
      const [, name, raw] = m;
      const value = raw.trim().replace(/^(["'])(.*)\1$/, '$2');
      if (!value || name.endsWith('_FILE') || NOT_SECRET.test(name) || !isSecretVar(name, value)) {
        return line;
      }
      const file = join(DIR, name);
      writeFileSync(file, `${value}\n`);
      protect(file, 0o440);
      moved.push(name);
      return `${name}_FILE=${file.replace(/\\/g, '/')}`;
    });
  const text = lines.join('\n');
  writeFileSync(
    ENV,
    /^FIFTH_SECRETS_DIR=/m.test(text)
      ? text
      : `${text.replace(/\n*$/, '\n')}FIFTH_SECRETS_DIR=${DIR.replace(/\\/g, '/')}\n`,
  );
  return { ok: true, moved: moved.length, names: moved };
}

function back() {
  const text = resolvedEnvText(ENV).replace(/^FIFTH_SECRETS_DIR=.*\n?/m, '');
  writeFileSync(ENV, text);
  return { ok: true };
}

const [command] = argv;
let result;
try {
  if (!existsSync(ENV)) throw new Error(`нет файла ${ENV}`);
  if (command === 'apply') result = apply();
  else if (command === 'back') result = back();
  else result = { ok: false, error: 'нужна команда apply или back' };
} catch (e) {
  result = { ok: false, error: e.message };
}
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
