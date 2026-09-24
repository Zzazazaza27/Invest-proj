#!/usr/bin/env node
/**
 * Быстрая проверка перед отправкой: только файлы, которые уходят в origin.
 *
 * ЗАЧЕМ. До 2026-09-24 перед отправкой не проверялось ничего, кроме чужих
 * коммитов в origin. Форматирование, линтер и semgrep впервые запускались в
 * CI — ошибка становилась видна через четыре минуты после отправки, а при
 * долгом накоплении коммитов всплывала пачкой (48 коммитов, 36 файлов без
 * форматирования и одна настоящая находка semgrep).
 *
 * ЧТО ПРОВЕРЯЕТ — то же, что CI, но на изменённых файлах:
 *   1. prettier --check — те же расширения, что `npm run format:check`;
 *   2. eslint — js/ts-файлы;
 *   3. semgrep с ПРОЕКТНЫМИ правилами (`.semgrep/guardian.yml`) — в докере,
 *      тем же образом по дайджесту, что и CI. Наборы `p/...` из реестра здесь
 *      не гоняются: это сеть и минуты, их оставляем CI.
 *
 * ЧЕГО НЕ ЗАМЕНЯЕТ. Типы, сборка, тесты, миграции, секрет-скан — только в CI.
 * Зелёная локальная проверка не означает зелёный CI.
 *
 * Нет докера — semgrep пропускается С ПРЕДУПРЕЖДЕНИЕМ, остальное работает.
 * Отправить без проверки: git push --no-verify.
 *
 * Диапазон берётся из стандартного ввода хука pre-push (строки
 * `<local ref> <local sha> <remote ref> <remote sha>`). Запуск руками без
 * ввода — сравнение с origin/main.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ZERO = /^0+$/;
// Тот же образ, что в .github/workflows/ci.yml (SEC-18: дайджест, не тег).
const SEMGREP_IMAGE =
  'semgrep/semgrep@sha256:ae27024c16f7848cdbfd49c24ed0b78b13f13b85fcd7b87c679aaa8b0c0dce98';
const FORMAT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml)$/;
const LINT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const WIN = process.platform === 'win32';

function git(args) {
  const out = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return out.status === 0 ? out.stdout.trim() : null;
}

function readStdin() {
  if (process.stdin.isTTY) return '';
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Файлы, которые уходят этой отправкой (добавленные и изменённые, существующие). */
function changedFiles() {
  const ranges = [];
  for (const line of readStdin().split('\n')) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // удаление ветки
    const base =
      remoteSha && !ZERO.test(remoteSha) ? remoteSha : git(['merge-base', localSha, 'origin/main']);
    if (base) ranges.push(`${base}..${localSha}`);
  }
  if (ranges.length === 0) ranges.push('origin/main..HEAD');
  const files = new Set();
  for (const range of ranges) {
    const out = git([
      '-c',
      'core.quotepath=off',
      'diff',
      '--name-only',
      '--diff-filter=ACMR',
      range,
    ]);
    for (const file of (out ?? '').split('\n'))
      if (file && existsSync(join(ROOT, file))) files.add(file);
  }
  return [...files];
}

function run(title, command, args, options = {}) {
  console.warn(`\n  ${title}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: WIN && !options.noShell,
    ...options,
  });
  if (result.error) return { ok: false, missing: true };
  return { ok: result.status === 0 };
}

/** Аргументы пачками: на Windows длина командной строки ограничена. */
function inChunks(files, size = 60) {
  const chunks = [];
  for (let i = 0; i < files.length; i += size) chunks.push(files.slice(i, i + size));
  return chunks;
}

const files = changedFiles();
console.warn(
  `pre-push: проверка ${files.length} изменённых файлов (prettier, eslint, semgrep guardian)`,
);
if (files.length === 0) process.exit(0);

const failures = [];
const quote = (file) => (WIN ? `"${file}"` : file);

const toFormat = files.filter((file) => FORMAT_EXT.test(file));
for (const chunk of inChunks(toFormat)) {
  // --ignore-unknown и .prettierignore: игнорируемые файлы пропускаются молча, как в CI.
  const r = run('prettier', 'npx', [
    'prettier',
    '--check',
    '--ignore-unknown',
    ...chunk.map(quote),
  ]);
  if (!r.ok) failures.push('prettier — исправить: npx prettier --write <файл>');
}

const toLint = files.filter((file) => LINT_EXT.test(file));
for (const chunk of inChunks(toLint)) {
  const r = run('eslint', 'npx', ['eslint', '--no-warn-ignored', ...chunk.map(quote)]);
  if (!r.ok) failures.push('eslint');
}

const toScan = files.filter((file) => LINT_EXT.test(file));
if (toScan.length > 0) {
  const docker = spawnSync('docker', ['info'], { stdio: 'ignore' });
  if (docker.status !== 0) {
    console.warn('\n  semgrep ПРОПУЩЕН: докер недоступен. Проектные правила проверит только CI.');
  } else {
    for (const chunk of inChunks(toScan)) {
      const r = run(
        'semgrep (проектные правила)',
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${ROOT}:/src`,
          '-w',
          '/src',
          SEMGREP_IMAGE,
          'semgrep',
          'scan',
          '--config',
          '.semgrep/guardian.yml',
          '--severity',
          'ERROR',
          '--error',
          '--metrics',
          'off',
          '--quiet',
          ...chunk,
        ],
        // Путь внутри контейнера не должен переписываться оболочкой Git Bash.
        { noShell: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
      );
      if (!r.ok) failures.push('semgrep (проектные правила)');
    }
  }
}

if (failures.length > 0) {
  console.error(`\npre-push: ОСТАНОВЛЕНО — ${[...new Set(failures)].join('; ')}.`);
  console.error('Исправь и отправь снова. Отправить без проверки: git push --no-verify');
  process.exit(1);
}
console.warn('\npre-push: изменённые файлы чистые. Типы, сборку и тесты проверит CI.');
