#!/usr/bin/env node
/**
 * Перенос томов прежнего проекта Compose в новый (W09d): `unicorn-launch` → `fifth`.
 *
 *   node scripts/rename-stand.mjs copy [--dry]
 *   node scripts/rename-stand.mjs back
 *
 * Docker не переименовывает тома, поэтому данные копируются в новые при остановленных
 * службах. Прежние тома не меняются и не удаляются: они остаются для возврата до
 * приёмки. `copy` отказывает, если новый том уже есть и не пуст: данные поверх не
 * пишутся. `back` копирует данные обратно, если на новых томах появились новые записи.
 *
 * Сверка — по числу файлов и размеру каждого тома. Результат — строка JSON.
 * Код завершения: 0 готово, 1 не удалось, 2 отказ.
 */
import { spawnSync } from 'node:child_process';

const FROM = 'unicorn-launch';
const TO = 'fifth';
const IMAGE = process.env.FIFTH_COPY_IMAGE || 'fifth/postgres:16';
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const env = { ...process.env, MSYS_NO_PATHCONV: '1' };

function docker(args, allowFail = false) {
  const r = spawnSync('docker', args, { encoding: 'utf8', env, maxBuffer: 1 << 24 });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`docker ${args[0]}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
  }
  return r;
}

const volumes = (project) =>
  docker(['volume', 'ls', '-q'])
    .stdout.split('\n')
    .filter((v) => v.startsWith(`${project}_`))
    .sort();

/** Содержимое тома: файлов и байт. Томов с данными мало, считаем прямо в контейнере. */
function measure(volume) {
  const r = docker([
    'run',
    '--rm',
    '--user',
    'root',
    '--entrypoint',
    'sh',
    '-v',
    `${volume}:/v:ro`,
    IMAGE,
    '-c',
    "find /v -type f | wc -l; find /v -type f -printf '%s\\n' | awk '{s+=$1} END {print s+0}'",
  ]);
  const [files, bytes] = r.stdout.trim().split('\n').map(Number);
  return { files, bytes };
}

function copy(from, to) {
  docker(['volume', 'create', to]);
  docker([
    'run',
    '--rm',
    '--user',
    'root',
    '--entrypoint',
    'sh',
    '-v',
    `${from}:/from:ro`,
    '-v',
    `${to}:/to`,
    IMAGE,
    '-c',
    'cp -a /from/. /to/',
  ]);
}

function running(project) {
  return docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`])
    .stdout.trim()
    .split('\n')
    .filter(Boolean);
}

function run(from, to, { replace }) {
  const live = running(from);
  if (live.length && !DRY) {
    return {
      ok: false,
      refused: true,
      error: `в проекте ${from} работают контейнеры: ${live.length}`,
    };
  }
  const report = [];
  for (const source of volumes(from)) {
    const target = source.replace(`${from}_`, `${to}_`);
    const before = measure(source);
    const exists = volumes(to).includes(target);
    if (exists && !replace && measure(target).files > 0) {
      return { ok: false, refused: true, error: `том ${target} не пуст` };
    }
    if (DRY) {
      report.push({ source, target, ...before });
      continue;
    }
    if (exists && replace) docker(['volume', 'rm', target]);
    copy(source, target);
    const after = measure(target);
    if (after.files !== before.files || after.bytes !== before.bytes) {
      return { ok: false, error: `том ${target}: не сошлось`, before, after };
    }
    report.push({ source, target, ...after });
  }
  return { ok: true, dry: DRY, volumes: report };
}

const [command] = argv;
let result;
try {
  if (command === 'copy') result = run(FROM, TO, { replace: false });
  else if (command === 'back') result = run(TO, FROM, { replace: true });
  else result = { ok: false, refused: true, error: 'нужна команда copy или back' };
} catch (e) {
  result = { ok: false, error: e.message };
}
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : result.refused ? 2 : 1);
