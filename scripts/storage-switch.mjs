#!/usr/bin/env node
/**
 * Переключение хранилища MinIO ↔ Garage одним согласованным набором
 * настроек (D-001; docs/architecture/garage-migration-plan.md).
 *
 * Потребители хранилища и что их переключает:
 *   - ядро — S3_ENDPOINT (адрес не меняется: :9000 у MinIO, потом у Garage)
 *     и ключ S3_ACCESS_KEY_ID; читает .env при старте;
 *   - копии W07 — BACKUP_S3_SOURCE_ENDPOINT и BACKUP_S3_*; таймеры
 *     fifth-backup-* читают .env при каждом запуске;
 *   - архив событий — ARCHIVE_S3_BUCKET и ARCHIVE_S3_*; запуск вручную;
 *   - вход файлов (Caddy) — 127.0.0.1:9000 в files.caddy, не меняется.
 * Кто на самом деле отвечает на :9000 — решает, куда идут ядро и Caddy.
 *
 *   node scripts/storage-switch.mjs consumers
 *       куда смотрит каждый потребитель; итог «все — MinIO», «все — Garage»
 *       или «РАЗНОБОЙ» (код 1). Ядро, запущенное раньше изменения .env,
 *       названо: оно работает на прежних значениях.
 *   node scripts/storage-switch.mjs apply <набор окна> --save <файл>
 *       заменить в .env переменные набора (атомарно), прежние значения — в
 *       --save (600, не перезаписывается); значения не печатаются;
 *   node scripts/storage-switch.mjs restore <файл --save>
 *       вернуть прежние значения (отсутствовавшие — удалить).
 *   node scripts/storage-switch.mjs quiesce [--wait-min N] [--stop]
 *       дождаться завершения заданий, читающих настройки (копии W07,
 *       проверка копий, прикладная проба); --stop — штатно остановить
 *       оставшиеся. Таймеры останавливаются ДО этой команды.
 *
 * «apply» — замена файла настроек, не переключение компонентов: реальное
 * переключение подтверждается их запуском и проверками.
 */
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ENV_PATH, parseEnvFile, ROOT } from './lib/backup.mjs';

const [command, file] = process.argv.slice(2);
const opt = (n) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : null;
};
const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

/** Переписать .env: заданные переменные заменить/дописать, null — удалить. */
function rewriteEnv(changes) {
  const lines = readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
  const done = new Set();
  const out = [];
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m && m[1] in changes) {
      done.add(m[1]);
      if (changes[m[1]] !== null) out.push(`${m[1]}=${changes[m[1]]}`);
      continue;
    }
    out.push(line);
  }
  for (const [k, v] of Object.entries(changes))
    if (!done.has(k) && v !== null) out.push(`${k}=${v}`);
  const tmp = `${ENV_PATH}.switch.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  writeFileSync(fd, `${out.join('\n').replace(/\n+$/, '')}\n`);
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, ENV_PATH);
}

function apply() {
  const save = opt('--save');
  if (!file || !save) throw new Error('apply <набор окна> --save <файл прежних значений>');
  if (existsSync(save)) throw new Error(`${save} уже есть — не перезаписываю`);
  const next = parseEnvFile(file);
  const now = parseEnvFile(ENV_PATH);
  const prev = Object.fromEntries(Object.keys(next).map((k) => [k, now[k] ?? null]));
  const fd = openSync(save, 'wx', 0o600);
  writeFileSync(
    fd,
    `# Прежние значения .env до переключения хранилища (${new Date().toISOString()}).\n` +
      '# __ABSENT__ — переменной не было. Возврат: storage-switch.mjs restore.\n' +
      `${Object.entries(prev)
        .map(([k, v]) => `${k}=${v ?? '__ABSENT__'}`)
        .join('\n')}\n`,
  );
  fsyncSync(fd);
  closeSync(fd);
  rewriteEnv(next);
  console.log(`применено: переменных ${Object.keys(next).length}; прежние — в ${save}`);
}

function restore() {
  if (!file) throw new Error('restore <файл прежних значений>');
  const prev = parseEnvFile(file);
  rewriteEnv(
    Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, v === '__ABSENT__' ? null : v])),
  );
  console.log(`возвращено: переменных ${Object.keys(prev).length}`);
}

/** Кто из контейнеров отвечает на порт петли. */
function listener(port) {
  const out = sh('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}']) ?? '';
  // Публикации вида «127.0.0.1:9000->9000/tcp» и диапазоны «127.0.0.1:9000-9001->…».
  const p = Number(port);
  const row = out
    .split('\n')
    .find((l) =>
      [...l.matchAll(/127\.0\.0\.1:(\d+)(?:-(\d+))?->/g)].some(
        ([, a, b]) => p >= Number(a) && p <= Number(b ?? a),
      ),
    );
  return row ? row.split('\t')[0] : null;
}
const storeOf = (name) =>
  !name ? 'никто' : /garage/.test(name) ? 'Garage' : /minio/.test(name) ? 'MinIO' : name;
const keyKind = (id) => (/^GK[0-9a-f]{24}$/.test(id ?? '') ? 'Garage' : id ? 'MinIO' : 'нет');

function consumers() {
  const env = parseEnvFile(ENV_PATH);
  const port = (env.S3_ENDPOINT || 'http://localhost:9000').match(/:(\d+)/)?.[1] ?? '9000';
  const onPort = storeOf(listener(port));
  const caddyPort =
    readFileSync(join(ROOT, 'infra', 'caddy', 'files.caddy'), 'utf8').match(
      /reverse_proxy 127\.0\.0\.1:(\d+)/,
    )?.[1] ?? '?';
  const w07Host = (env.BACKUP_S3_SOURCE_ENDPOINT || 'http://minio:9000').match(/\/\/([^:/]+)/)?.[1];
  const rows = [
    ['ядро: адрес', `S3_ENDPOINT :${port} → отвечает ${onPort}`, onPort],
    ['ядро: ключ', keyKind(env.S3_ACCESS_KEY_ID), keyKind(env.S3_ACCESS_KEY_ID)],
    [
      'вход файлов (Caddy)',
      `:${caddyPort} → ${storeOf(listener(caddyPort))}`,
      storeOf(listener(caddyPort)),
    ],
    ['копии W07: источник', `BACKUP_S3_SOURCE_ENDPOINT → ${w07Host}`, storeOf(w07Host)],
    ['копии W07: ключ', keyKind(env.BACKUP_S3_ACCESS_KEY_ID), keyKind(env.BACKUP_S3_ACCESS_KEY_ID)],
    [
      'архив событий',
      `${env.ARCHIVE_S3_BUCKET ? `бакет ${env.ARCHIVE_S3_BUCKET}` : 'бакет файлов'}, ключ ${keyKind(env.ARCHIVE_S3_ACCESS_KEY_ID)}`,
      keyKind(env.ARCHIVE_S3_ACCESS_KEY_ID),
    ],
  ];
  // Ядро на VPS — юнит systemd: запущено раньше изменения .env — на прежних значениях.
  const started = sh('systemctl', [
    'show',
    'unicorn-core',
    '-p',
    'ActiveEnterTimestamp',
    '--value',
  ]);
  const envChanged = statSync(ENV_PATH).mtime;
  let coreNote = 'ядро не под systemd (стенд) — перечитывает .env при перезапуске';
  if (started) {
    const at = new Date(started);
    coreNote =
      at < envChanged
        ? `ВНИМАНИЕ: ядро запущено ${at.toISOString()}, .env изменён ${envChanged.toISOString()} — ядро работает на ПРЕЖНИХ значениях`
        : `ядро запущено после последнего изменения .env (${at.toISOString()})`;
  }
  const timers = [
    'fifth-backup-set.timer',
    'fifth-backup-check.timer',
    'fifth-monitor-app-probe.timer',
  ]
    .map(
      (t) =>
        `${t}: ${sh('systemctl', ['is-active', t]) ?? sh('systemctl', ['show', t, '-p', 'ActiveState', '--value']) ?? 'нет'}`,
    )
    .join(', ');
  for (const [name, what] of rows) console.log(`  ${name.padEnd(22)} ${what}`);
  console.log(`  ${coreNote}`);
  if (started) console.log(`  таймеры: ${timers}`);
  const targets = new Set(rows.map((r) => r[2]));
  if (targets.size === 1) {
    console.log(`ИТОГ: все потребители — ${[...targets][0]}`);
    return;
  }
  console.log(`ИТОГ: РАЗНОБОЙ — ${[...targets].join(', ')}`);
  process.exitCode = 1;
}

/**
 * Задания, читающие настройки хранилища при каждом запуске. Остановка
 * таймера не останавливает уже идущее задание, поэтому перед заменой набора
 * они должны завершиться (или быть штатно остановлены — `--stop`): иначе
 * работающий процесс дочитает прежний набор после переключения.
 */
const JOBS = [
  'fifth-backup-set.service',
  'fifth-backup-check.service',
  'fifth-monitor-app-probe.service',
];
async function quiesce() {
  const waitMin = Number(opt('--wait-min') ?? 15);
  const deadline = Date.now() + waitMin * 60_000;
  const active = () =>
    JOBS.filter((j) =>
      ['active', 'activating', 'deactivating', 'reloading'].includes(
        sh('systemctl', ['show', j, '-p', 'ActiveState', '--value']) ?? '',
      ),
    );
  let left = active();
  while (left.length && Date.now() < deadline) {
    console.log(`идут: ${left.join(', ')} — жду завершения`);
    await new Promise((r) => setTimeout(r, 10_000));
    left = active();
  }
  if (left.length && process.argv.includes('--stop')) {
    for (const j of left) sh('systemctl', ['stop', j]);
    left = active();
    console.log('остановлены штатно (systemctl stop)');
  }
  if (left.length) {
    console.log(`ИТОГ: задания ещё работают (${left.join(', ')}) — набор менять нельзя`);
    process.exitCode = 1;
    return;
  }
  console.log(`ИТОГ: заданий, читающих настройки хранилища, нет (${JOBS.join(', ')})`);
}

const commands = { consumers, apply, restore, quiesce };
if (!commands[command]) {
  console.error(
    'команды: consumers | apply <набор> --save <файл> | restore <файл> | quiesce [--wait-min N] [--stop]',
  );
  process.exit(2);
}
try {
  await commands[command]();
} catch (e) {
  console.error(`ОШИБКА: ${e.message}`);
  process.exit(1);
}
