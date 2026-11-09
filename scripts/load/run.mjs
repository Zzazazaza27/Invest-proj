#!/usr/bin/env node
/**
 * Запуск нагрузочного профиля p1 в k6 (W32, docs/architecture/w32-load-failures-plan.md).
 *
 *   node scripts/load/run.mjs --run-id <id> --mode base  [--rate 2] [--duration 15m]
 *   node scripts/load/run.mjs --run-id <id> --mode steps [--steps 2,4,8,16] [--step-duration 10m]
 *   node scripts/load/run.mjs --run-id <id> --mode soak  [--duration 60m]
 *   общие: [--burst 20] [--max-upload 1|0] [--max-vus N] [--samples]
 *
 * Цель — FIFTH_LOAD_BASE (по умолчанию http://127.0.0.1); закрытая паролем —
 * FIFTH_LOAD_BASIC_AUTH_FILE (строка `user:password`). Данные — от seed.mjs:
 * `.local/load/<run_id>/users.json`.
 *
 * k6 работает в Docker образом с закреплённым digest (образ должен быть уже
 * скачан: `--pull never`). Для локального стенда контейнер подключается к сети
 * стенда (fifth_default) и ходит к nginx и Garage по именам контейнеров; адрес
 * хранилища из билета переписывается (FIFTH_LOAD_STORAGE_REWRITE).
 * Значение basic-auth передаётся через окружение процесса (`-e ИМЯ` без
 * значения), в командной строке и выводе его нет.
 *
 * Отчёт — `out/suites/load-<run_id>/<режим>-<время>/`: summary.json (сводка),
 * k6-metrics.json (метрики k6), meta.json (версии и параметры), k6.log.
 * Прежние запуски не затираются.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { cpus, hostname, release, totalmem, platform } from 'node:os';
import { join } from 'node:path';
import { BASE, ROOT, basicAuthHeader, isLocalBase, parseArgs, runDir } from './lib.mjs';

const K6_IMAGE =
  'grafana/k6:1.3.0@sha256:3ddc8b1a33a2c3d8edc6e99b6a762ae36cba08788463458f5e6a7703e14eb77d';
/*
 * Локальный стенд публикует порты только на 127.0.0.1 хоста, и из контейнера
 * через host.docker.internal они недоступны (проверено: connection refused).
 * Поэтому k6 подключается к сети стенда и ходит к nginx и Garage по именам
 * контейнеров. Значения можно переопределить окружением.
 */
const LOCAL_NETWORK = process.env.FIFTH_LOAD_DOCKER_NETWORK ?? 'fifth_default';
const LOCAL_TARGET = process.env.FIFTH_LOAD_DOCKER_TARGET ?? 'http://fifth-web';
const LOCAL_STORAGE_REWRITE =
  process.env.FIFTH_LOAD_STORAGE_REWRITE ??
  'http://localhost:9000=>http://fifth-garage-1:3900,http://127.0.0.1:9000=>http://fifth-garage-1:3900';

const args = parseArgs(process.argv.slice(2));
const runId = String(args['run-id'] ?? '');
const mode = String(args.mode ?? 'base');
if (!['base', 'steps', 'soak'].includes(mode)) {
  console.error('режим: --mode base | steps | soak');
  process.exit(2);
}
const dataDir = runDir(runId);
if (!existsSync(join(dataDir, 'users.json'))) {
  console.error(`нет данных прогона: ${join(dataDir, 'users.json')} — сначала seed.mjs seed`);
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
const outDir = join(ROOT, 'out', 'suites', `load-${runId}`, `${mode}-${stamp}`);
if (existsSync(outDir)) {
  console.error(`каталог отчёта уже есть: ${outDir}`);
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

// Адрес цели изнутри контейнера.
const local = isLocalBase();
const target = local ? LOCAL_TARGET : BASE;

const k6Env = {
  FIFTH_LOAD_BASE: target,
  FIFTH_LOAD_USERS: '/load-data/users.json',
  FIFTH_LOAD_OUT: '/out',
  FIFTH_LOAD_RUN_ID: runId,
  FIFTH_LOAD_MODE: mode,
};
const passthrough = {
  rate: 'FIFTH_LOAD_RATE',
  duration: mode === 'soak' ? 'FIFTH_LOAD_SOAK_DURATION' : 'FIFTH_LOAD_DURATION',
  steps: 'FIFTH_LOAD_STEPS',
  'step-duration': 'FIFTH_LOAD_STEP_DURATION',
  'return-rate': 'FIFTH_LOAD_RETURN_RATE',
  'return-duration': 'FIFTH_LOAD_RETURN_DURATION',
  'soak-rate': 'FIFTH_LOAD_SOAK_RATE',
  burst: 'FIFTH_LOAD_BURST',
  'max-upload': 'FIFTH_LOAD_MAX_UPLOAD',
  'max-vus': 'FIFTH_LOAD_MAX_VUS',
};
for (const [arg, name] of Object.entries(passthrough)) {
  if (args[arg] !== undefined && args[arg] !== true) k6Env[name] = String(args[arg]);
}
if (local) k6Env.FIFTH_LOAD_STORAGE_REWRITE = LOCAL_STORAGE_REWRITE;
else if (process.env.FIFTH_LOAD_STORAGE_REWRITE) {
  k6Env.FIFTH_LOAD_STORAGE_REWRITE = process.env.FIFTH_LOAD_STORAGE_REWRITE;
}

// Секрет — только в окружении дочернего процесса; docker берёт его по имени.
const childEnv = { ...process.env, K6_NO_USAGE_REPORT: 'true' };
const basic = basicAuthHeader();
if (basic) childEnv.FIFTH_LOAD_BASIC_AUTH = basic;

function git(...a) {
  const r = spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Имя контейнера — чтобы остановить его и при обрыве обёртки (Ctrl+C на Windows не доходит до k6).
const containerName = `fifth-load-${runId}-${stamp}`.toLowerCase();
const dockerArgs = [
  'run',
  '--rm',
  '--name',
  containerName,
  '--pull',
  'never',
  ...(local ? ['--network', LOCAL_NETWORK] : []),
  '-v',
  `${join(ROOT, 'scripts', 'load')}:/scripts:ro`,
  '-v',
  `${dataDir}:/load-data:ro`,
  '-v',
  `${outDir}:/out`,
  '-e',
  'K6_NO_USAGE_REPORT',
  ...(basic ? ['-e', 'FIFTH_LOAD_BASIC_AUTH'] : []),
  ...Object.entries(k6Env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
  K6_IMAGE,
  'run',
  '--no-usage-report',
  // Параметры и basic-auth приходят окружением контейнера — явно, не по умолчанию k6.
  '--include-system-env-vars',
  ...(args.samples ? ['--out', 'csv=/out/samples.csv.gz'] : []),
  '/scripts/p1.js',
];

const meta = {
  profile: 'p1',
  runId,
  mode,
  target: BASE,
  targetInContainer: target,
  basicAuth: Boolean(basic),
  params: Object.fromEntries(Object.entries(k6Env).filter(([k]) => !/BASIC/.test(k))),
  k6Image: K6_IMAGE,
  k6Version: null,
  commit: git('rev-parse', 'HEAD'),
  dirty: (git('status', '--porcelain') ?? '').length > 0,
  generator: {
    host: hostname(),
    platform: `${platform()} ${release()}`,
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model ?? null,
    memoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
  },
  startedAt: new Date().toISOString(),
  finishedAt: null,
  exitCode: null,
};
const version = spawnSync('docker', ['run', '--rm', '--pull', 'never', K6_IMAGE, 'version'], {
  encoding: 'utf8',
  timeout: 60_000,
});
meta.k6Version = version.status === 0 ? version.stdout.trim() : null;
writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

console.log(`\n=== НАГРУЗКА p1: ${mode}, прогон ${runId} → ${BASE} ===`);
console.log(`  отчёт: ${outDir}\n`);

const log = createWriteStream(join(outDir, 'k6.log'));
const child = spawn('docker', dockerArgs, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => {
  process.stdout.write(d);
  log.write(d);
});
child.stderr.on('data', (d) => {
  process.stderr.write(d);
  log.write(d);
});
const stop = () => {
  spawnSync('docker', ['stop', '--time', '30', containerName], { stdio: 'ignore' });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('close', (code) => {
  log.end();
  meta.finishedAt = new Date().toISOString();
  meta.exitCode = code;
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  const hasSummary = existsSync(join(outDir, 'summary.json'));
  console.log(
    `\n  k6 завершился с кодом ${code}; сводка ${hasSummary ? 'записана' : 'НЕ записана'}`,
  );
  process.exit(hasSummary ? (code ?? 1) : 1);
});
