#!/usr/bin/env node
/**
 * Запуск нагрузочного профиля p1 в k6 (W32, docs/architecture/w32-load-failures-plan.md).
 *
 *   node scripts/load/run.mjs --run-id <id> --mode base  [--rate 2] [--duration 15m]
 *   node scripts/load/run.mjs --run-id <id> --mode steps [--steps 2,4,8,16] [--step-duration 10m]
 *   node scripts/load/run.mjs --run-id <id> --mode soak  [--duration 60m]
 *   общие: [--burst 20] [--max-upload 1|0] [--max-vus N] [--samples]
 *          [--profile p1|p1-api|p1-files] [--native]
 *
 * --profile: p1 — полная смесь; p1-api — без загрузок (само API); p1-files — только
 * загрузки (W32: API и большие файлы мерить раздельно).
 * --native: k6 без Docker — бинарь `.local/load/k6/k6.exe` версии 1.3.0, сверяется по
 * SHA-256 (K6_NATIVE_SHA256); для удалённой цели. Снимает из тракта сеть Docker Desktop.
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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { cpus, homedir, hostname, release, totalmem, platform } from 'node:os';
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
// k6 без Docker: тот же выпуск, что образ; бинарь сверяется по SHA-256 перед запуском.
const K6_NATIVE = join(ROOT, '.local', 'load', 'k6', 'k6.exe');
// k6-v1.3.0-windows-amd64.zip — SHA-256 06a15d69…17686d совпал с k6-v1.3.0-checksums.txt выпуска.
const K6_NATIVE_SHA256 =
  process.env.FIFTH_K6_NATIVE_SHA256 ??
  'dad93bac6508f29b7355a9ec747f1c07484b396ded3e17b5553d788718bdb931';
const LOCAL_NETWORK = process.env.FIFTH_LOAD_DOCKER_NETWORK ?? 'fifth_default';
const LOCAL_TARGET = process.env.FIFTH_LOAD_DOCKER_TARGET ?? 'http://fifth-web';
const LOCAL_STORAGE_REWRITE =
  process.env.FIFTH_LOAD_STORAGE_REWRITE ??
  'http://localhost:9000=>http://fifth-garage-1:3900,http://127.0.0.1:9000=>http://fifth-garage-1:3900';

const args = parseArgs(process.argv.slice(2));
const runId = String(args['run-id'] ?? '');
const mode = String(args.mode ?? 'base');
if (!['base', 'steps', 'soak', 'selftest-relogin'].includes(mode)) {
  console.error('режим: --mode base | steps | soak | selftest-relogin');
  process.exit(2);
}
const profile = String(args.profile ?? 'p1');
if (!['p1', 'p1-api', 'p1-files'].includes(profile)) {
  console.error('профиль: --profile p1 | p1-api | p1-files');
  process.exit(2);
}
const native = Boolean(args.native);
const dataDir = runDir(runId);
if (!existsSync(join(dataDir, 'users.json'))) {
  console.error(`нет данных прогона: ${join(dataDir, 'users.json')} — сначала seed.mjs seed`);
  process.exit(2);
}

/*
 * Набор данных — на один прогон (Тэнк 10.11): материалы прошлых прогонов копятся в проектах
 * участников и упираются в предел 50 на проект (422 limit_exceeded в часовом прогоне).
 * 1. Повторный запуск на использованном наборе — отказ (`--reuse-data` — только осознанно).
 * 2. Расчёт: сколько материалов прогон создаст на проект за всю длительность; с запасом на
 *    разброс случайного выбора проекта должно остаться ниже предела.
 */
const MATERIALS_LIMIT = 50;
const MATERIALS_HEADROOM = 5;
const usedMark = join(dataDir, 'used.json');
// Узкая проверка повторного входа набор не расходует: одна ссылка, без нагрузки.
const selftest = mode === 'selftest-relogin';
if (!selftest && existsSync(usedMark) && !args['reuse-data']) {
  const prev = JSON.parse(readFileSync(usedMark, 'utf8'));
  console.error(
    `набор ${runId} уже использован прогоном ${prev.outDir ?? '?'} (${prev.at ?? '?'}): ` +
      'нужен свежий набор (seed.mjs seed --run-id <новый>) или явно --reuse-data',
  );
  process.exit(2);
}
if (!selftest) {
  const users = JSON.parse(readFileSync(join(dataDir, 'users.json'), 'utf8'));
  const nProjects = users.users.reduce((s, u) => s + u.projects.length, 0);
  const seededPerProject = 2; // seed.mjs: две ссылки на проект
  const dur = (raw, def) => {
    const m = String(raw ?? def).match(/^(\d+(?:\.\d+)?)(h|m|s)?$/);
    if (!m) throw new Error(`не длительность: ${raw}`);
    return Number(m[1]) * { h: 3600, m: 60, s: 1 }[m[2] ?? 's'];
  };
  const stages =
    mode === 'base'
      ? [[Number(args.rate ?? 2), dur(args.duration, '15m')]]
      : mode === 'soak'
        ? [[Number(args['soak-rate'] ?? 2), dur(args.duration, '60m')]]
        : [
            ...String(args.steps ?? '2,4,8,16')
              .split(',')
              .map((r) => [Number(r), dur(args['step-duration'], '10m')]),
            [Number(args['return-rate'] ?? 2), dur(args['return-duration'], '10m')],
          ];
  // Доля действий, создающих материал: ссылка 5 %, загрузки 10 % (p1); 50 МиБ — раз в ступень.
  const share = { p1: 0.15, 'p1-api': 0.05, 'p1-files': 1 }[profile];
  const maxUploads = profile === 'p1-api' || args['max-upload'] === '0' ? 0 : stages.length;
  const created = stages.reduce((s, [rate, sec]) => s + rate * sec * share, 0) + maxUploads;
  const mean = created / nProjects;
  // Выбор проекта случаен: вероятностный запас — среднее + 4σ (приближение Пуассона).
  // Это не гарантия: переполнение отдельного проекта маловероятно, но возможно.
  const worst = seededPerProject + mean + 4 * Math.sqrt(mean);
  const allowed = MATERIALS_LIMIT - MATERIALS_HEADROOM;
  console.log(
    `  материалы: прогон создаст ~${Math.round(created)} на ${nProjects} проектов — ` +
      `в среднем ${mean.toFixed(1)}, вероятностный запас (среднее + 4σ) — ${worst.toFixed(1)} на проект ` +
      `(предел ${MATERIALS_LIMIT}, запас ${MATERIALS_HEADROOM}); это оценка, не гарантия: ` +
      'переполнение отдельного проекта маловероятно, но не исключено',
  );
  if (worst > allowed) {
    const need = Math.ceil(created / (Math.sqrt(4 + allowed - seededPerProject) - 2) ** 2);
    console.error(`  мало проектов: нужно не меньше ${need} (seed.mjs seed --projects ${need})`);
    process.exit(2);
  }
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
const outDir = join(
  ROOT,
  'out',
  'suites',
  `load-${runId}`,
  `${profile === 'p1' ? '' : `${profile}-`}${mode}-${stamp}${native ? '-native' : ''}`,
);
if (existsSync(outDir)) {
  console.error(`каталог отчёта уже есть: ${outDir}`);
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
if (!selftest) {
  writeFileSync(usedMark, JSON.stringify({ outDir, at: new Date().toISOString() }, null, 2));
}

// Адрес цели изнутри контейнера.
const local = isLocalBase();
if (native && local) {
  console.error('--native — только для удалённой цели (стенд виден k6 лишь из сети Docker)');
  process.exit(2);
}
if (native) {
  if (!existsSync(K6_NATIVE)) {
    console.error(`нет бинаря k6: ${K6_NATIVE}`);
    process.exit(2);
  }
  const sum = createHash('sha256').update(readFileSync(K6_NATIVE)).digest('hex');
  if (!K6_NATIVE_SHA256 || sum !== K6_NATIVE_SHA256) {
    console.error(
      `k6.exe: SHA-256 ${sum} не совпадает с закреплённым (${K6_NATIVE_SHA256 || 'не задан'})`,
    );
    process.exit(2);
  }
}
const slash = (p) => p.split('\\').join('/');
const target = local ? LOCAL_TARGET : BASE;

const k6Env = {
  FIFTH_LOAD_BASE: target,
  FIFTH_LOAD_USERS: native ? slash(join(dataDir, 'users.json')) : '/load-data/users.json',
  FIFTH_LOAD_OUT: native ? slash(outDir) : '/out',
  FIFTH_LOAD_RUN_ID: runId,
  FIFTH_LOAD_MODE: mode,
  FIFTH_LOAD_PROFILE: profile,
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

// k6 без Docker: параметры — окружением процесса, как и basic-auth.
// Управляющий адрес k6 (REST, только 127.0.0.1): мягкая остановка по порогу сервера — k6
// завершает итерации и пишет сводку. Убийство процесса на Windows сводку теряло (11.11).
const K6_API = `127.0.0.1:${process.env.FIFTH_K6_API_PORT ?? 6565}`;
const nativeArgs = [
  'run',
  '--no-usage-report',
  '--address',
  K6_API,
  '--include-system-env-vars',
  ...(args.samples ? ['--out', `csv=${slash(join(outDir, 'samples.csv.gz'))}`] : []),
  join(ROOT, 'scripts', 'load', 'p1.js'),
];
if (native) Object.assign(childEnv, k6Env);

const meta = {
  profile,
  generatorKind: native ? 'k6 без Docker (Windows)' : 'k6 в Docker',
  runId,
  mode,
  target: BASE,
  targetInContainer: target,
  basicAuth: Boolean(basic),
  params: Object.fromEntries(Object.entries(k6Env).filter(([k]) => !/BASIC/.test(k))),
  k6Image: native ? null : K6_IMAGE,
  k6Binary: native ? { path: K6_NATIVE, sha256: K6_NATIVE_SHA256 } : null,
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
const version = spawnSync(
  native ? K6_NATIVE : 'docker',
  native ? ['version'] : ['run', '--rm', '--pull', 'never', K6_IMAGE, 'version'],
  {
    encoding: 'utf8',
    timeout: 60_000,
  },
);
meta.k6Version = version.status === 0 ? version.stdout.trim() : null;
writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

console.log(
  `\n=== НАГРУЗКА ${profile}${native ? ' (k6 без Docker)' : ''}: ${mode}, прогон ${runId} → ${BASE} ===`,
);
console.log(`  отчёт: ${outDir}\n`);

// Сборщик на сервере (infra/host/prod-load-collect.sh): ресурсы, пороги прекращения, журнал ядра.
// --server-collect <секунд> — предел сбора; без флага (локальная цель) не запускается.
const SSH = [
  '-i',
  join(homedir(), '.ssh', 'maus_5e'),
  '-o',
  'IdentitiesOnly=yes',
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=20',
  process.env.FIFTH_VPS ?? 'maus@193.233.217.210',
];
const collectId = `${runId}-${stamp}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
const collectSecs = Number(args['server-collect'] ?? 0);
const onServer = (...a) =>
  spawnSync(
    'ssh',
    [...SSH, ['sudo -n /usr/local/sbin/fifth-test op prod-load-collect', ...a].join(' ')],
    {
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
let watch = null;
if (collectSecs > 0) {
  const started = onServer('start', collectId, String(Math.min(collectSecs, 14_400)));
  if (started.status !== 0) {
    console.error(`сборщик на сервере не запущен: ${(started.stderr || started.stdout).trim()}`);
    process.exit(2);
  }
  meta.serverCollect = { id: collectId, limitSec: collectSecs };
  console.log(`  сборщик на сервере: ${collectId}`);
}

const log = createWriteStream(join(outDir, 'k6.log'));
const child = native
  ? spawn(K6_NATIVE, nativeArgs, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn('docker', dockerArgs, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
const stop = () => {
  if (native) {
    // Мягко: k6 останавливает тест и пишет сводку; если за 60 с не завершился — убить.
    fetch(`http://${K6_API}/v1/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        data: { type: 'status', id: 'default', attributes: { stopped: true } },
      }),
    }).catch(() => child.kill());
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 60_000).unref();
    return;
  }
  spawnSync('docker', ['stop', '--time', '30', containerName], { stdio: 'ignore' });
};

// Здоровье генератора (W32): отказ тракта генератора — не отказ платформы. Признаки:
//  - сетевые ошибки уровня соединения (dial, no route, i/o timeout) — сервер их не порождает,
//    пока жив его вход; ≥ GEN_NET_ERRORS за 30 с;
//  - k6 перестал продвигаться: число завершённых итераций не растёт GEN_STALL_SEC;
//  - часы k6 отстали от настенных больше GEN_DRIFT_SEC (машина или VM генератора спала).
// Сработал признак — прогон прекращается, причина в meta.generatorFailed, код выхода 3:
// такой прогон не засчитывается ни как нагрузка, ни как проверка отказоустойчивости.
const GEN_NET_ERRORS = Number(process.env.GEN_NET_ERRORS ?? 5);
const GEN_STALL_SEC = Number(process.env.GEN_STALL_SEC ?? 60);
const GEN_DRIFT_SEC = Number(process.env.GEN_DRIFT_SEC ?? 30);
const NET_ERR =
  /dial: i\/o timeout|dial tcp[^"]*: connect:|no route to host|network is unreachable/;
const gen = { netErrors: [], lastDone: -1, lastDoneAt: Date.now(), startedAt: Date.now() };
const generatorFail = (reason) => {
  if (meta.generatorFailed) return;
  meta.generatorFailed = { reason, at: new Date().toISOString() };
  console.error(`\n  ОТКАЗ ГЕНЕРАТОРА: ${reason} — прогон прекращается и не засчитывается`);
  stop();
};
const watchGenerator = (text) => {
  const now = Date.now();
  for (const line of text.split('\n')) {
    if (NET_ERR.test(line)) gen.netErrors.push(now);
    const m = /running \((?:(\d+)h)?(\d+)m([\d.]+)s\), [^,]+, (\d+) complete/.exec(line);
    if (m) {
      const k6Sec = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      const done = Number(m[4]);
      if (done !== gen.lastDone) {
        gen.lastDone = done;
        gen.lastDoneAt = now;
      }
      gen.k6Sec = k6Sec;
      gen.k6At = now;
      if (gen.k6Origin === undefined) gen.k6Origin = now - k6Sec * 1000;
      const drift = (now - gen.k6Origin) / 1000 - k6Sec;
      if (drift > GEN_DRIFT_SEC) generatorFail(`часы k6 отстали на ${Math.round(drift)} с`);
    }
  }
  gen.netErrors = gen.netErrors.filter((t) => now - t < 30_000);
  if (gen.netErrors.length >= GEN_NET_ERRORS)
    generatorFail(`${gen.netErrors.length} сетевых ошибок соединения за 30 с`);
};
const genTimer = setInterval(() => {
  const now = Date.now();
  if (gen.lastDone >= 0 && now - gen.lastDoneAt > GEN_STALL_SEC * 1000)
    generatorFail(`итерации не продвигаются ${Math.round((now - gen.lastDoneAt) / 1000)} с`);
  // Вывод k6 пропал совсем (контейнер или Docker завис): строки хода идут раз в секунду.
  if (gen.k6At && now - gen.k6At > GEN_STALL_SEC * 1000)
    generatorFail(`k6 молчит ${Math.round((now - gen.k6At) / 1000)} с`);
}, 5_000);
child.stdout.on('data', (d) => {
  process.stdout.write(d);
  log.write(d);
  watchGenerator(d.toString());
});
child.stderr.on('data', (d) => {
  process.stderr.write(d);
  log.write(d);
  watchGenerator(d.toString());
});
if (collectSecs > 0) {
  // Порог на сервере сработал — прогон прекращается, причина пишется в meta.json.
  watch = setInterval(() => {
    const st = onServer('status', collectId).stdout?.trim() ?? '';
    if (st.startsWith('STOP')) {
      meta.stoppedByServer = st.slice(5);
      console.error(`\n  ПОРОГ НА СЕРВЕРЕ: ${meta.stoppedByServer} — прогон прекращается`);
      clearInterval(watch);
      stop();
    }
  }, 10_000);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('close', (code) => {
  log.end();
  clearInterval(genTimer);
  if (watch) clearInterval(watch);
  if (collectSecs > 0) {
    onServer('stop', collectId);
    const exp = onServer('export', collectId);
    // Разделы выгрузки — отдельными файлами; серверное время API — сводкой по маршрутам.
    const parts = (exp.stdout ?? '').split(/^### /m).filter(Boolean);
    mkdirSync(join(outDir, 'server'), { recursive: true });
    for (const part of parts) {
      const nl = part.indexOf('\n');
      writeFileSync(join(outDir, 'server', part.slice(0, nl).trim()), part.slice(nl + 1));
    }
    meta.serverSummary = serverSummary(join(outDir, 'server', 'core-requests.csv'));
  }
  meta.finishedAt = new Date().toISOString();
  meta.exitCode = code;
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  const hasSummary = existsSync(join(outDir, 'summary.json'));
  console.log(
    `\n  k6 завершился с кодом ${code}; сводка ${hasSummary ? 'записана' : 'НЕ записана'}`,
  );
  if (meta.generatorFailed) process.exit(3);
  process.exit(hasSummary ? (code ?? 1) : 1);
});

/** Серверное время API по шаблону маршрута: p95, p99, максимум, число, 5xx — из общей выборки. */
function serverSummary(file) {
  if (!existsSync(file)) return null;
  const by = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n').slice(1)) {
    const [, method, route, status, ms] = line.split(',');
    if (!route) continue;
    const key = `${method} ${route}`;
    const e = by.get(key) ?? { d: [], s5: 0 };
    e.d.push(Number(ms));
    if (Number(status) >= 500) e.s5 += 1;
    by.set(key, e);
  }
  const q = (a, p) => a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)];
  return Object.fromEntries(
    [...by].map(([k, e]) => {
      const d = e.d.sort((x, y) => x - y);
      return [k, { count: d.length, p95: q(d, 95), p99: q(d, 99), max: d.at(-1), err5xx: e.s5 }];
    }),
  );
}
