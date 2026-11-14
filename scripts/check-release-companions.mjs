#!/usr/bin/env node
/**
 * Перезапуски web и базы при выпуске (Тэнк 13.11) — узкие проверки без среды.
 *
 *   node scripts/check-release-companions.mjs
 *
 *  [1] сумма серверной части web: та же при тех же входах и при другой статике; меняется от
 *      каждого значимого входа (базовый образ, конфигурация, скрипты запуска, проверка
 *      здоровья, новая инструкция); незакреплённый базовый образ и чужое копирование — отказ;
 *  [2] сумма входов образа базы: та же при тех же входах; меняется от Dockerfile, файла
 *      контекста, нового файла, исполняемости, платформы и месяца;
 *  [3] эквивалентность образов (Docker): тот же образ; другой с той же меткой и настройками —
 *      эквивалентен; без метки, с другой меткой, с другой проверкой здоровья — нет;
 *  [4] статика подключена: маршрут, каталог и ответ web; чужой маршрут и чужая статика — нет;
 *  [5] журнал core-b в средах на слотах — тем же способом, что у core (docker compose config).
 *  [6] план перезапусков: перезапуск базы и пересоздание web — «НЕ без простоя».
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { postgresInputs } from './image-inputs.mjs';
import {
  companionPlan,
  staticConnected,
  webEquivalence,
  webRuntimeSum,
} from './lib/web-runtime.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dockerEnv = { ...process.env, MSYS_NO_PATHCONV: '1' };
let passed = 0;
let failed = 0;
let skipped = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.warn(
    `  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`,
  );
};
const skip = (name, why) => {
  skipped += 1;
  console.warn(`  SKIP  ${name} — ${why}`);
};
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', env: dockerEnv, timeout: 300_000, ...opts });
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
const tmp = mkdtempSync(join(tmpdir(), 'fifth-companions-'));
const copy = (name, files) => {
  const dir = join(tmp, name);
  for (const f of files) cpSync(join(ROOT, f), join(dir, f), { recursive: true });
  return dir;
};
const edit = (dir, file, fn) =>
  writeFileSync(join(dir, file), fn(readFileSync(join(dir, file), 'utf8')));

const WEB_FILES = [
  'infra/images/web.Dockerfile',
  'infra/nginx/default.conf',
  'infra/images/web-banner.sh',
  'infra/images/web-route.sh',
];
const DF = 'infra/images/web.Dockerfile';

try {
  // ---------------------------------------------------------------- [1]
  console.warn('\n[1] Сумма серверной части web');
  const base = webRuntimeSum(copy('w0', WEB_FILES));
  check('те же входы — та же сумма', webRuntimeSum(copy('w1', WEB_FILES)) === base);
  check('сумма рабочей копии та же, что у копии', webRuntimeSum(ROOT) === base);
  const variants = {
    'другая статика (COPY --from=build в /srv)': [
      (d) =>
        edit(d, DF, (t) =>
          t.replace('/src/apps/lab/dist /srv/lab', '/src/apps/lab/dist /srv/lab2'),
        ),
      false,
    ],
    'другая статика (сборка приложений)': [
      (d) => edit(d, DF, (t) => t.replace('npm run build:packages', 'npm run build:packages ')),
      false,
    ],
    'базовый nginx (дайджест)': [
      (d) => edit(d, DF, (t) => t.replace(/(nginx:[^@\s]+@sha256:)[0-9a-f]{4}/, '$1ffff')),
      true,
    ],
    'конфигурация nginx': [(d) => edit(d, 'infra/nginx/default.conf', (t) => `${t}\n# x\n`), true],
    'скрипт запуска web-route.sh': [
      (d) => edit(d, 'infra/images/web-route.sh', (t) => `${t}\n# x\n`),
      true,
    ],
    'скрипт запуска web-banner.sh': [
      (d) => edit(d, 'infra/images/web-banner.sh', (t) => `${t}\n# x\n`),
      true,
    ],
    'проверка здоровья': [(d) => edit(d, DF, (t) => t.replace('--retries=3', '--retries=4')), true],
    'новая инструкция (ENV)': [(d) => edit(d, DF, (t) => `${t}\nENV X=1\n`), true],
    'права копирования (--chmod)': [
      (d) =>
        edit(d, DF, (t) =>
          t.replace(
            '--chmod=755 infra/images/web-banner.sh',
            '--chmod=750 infra/images/web-banner.sh',
          ),
        ),
      true,
    ],
  };
  let i = 0;
  for (const [name, [mutate, changes]] of Object.entries(variants)) {
    const d = copy(`wv${(i += 1)}`, WEB_FILES);
    const before =
      readFileSync(join(d, DF), 'utf8') + readFileSync(join(d, 'infra/nginx/default.conf'), 'utf8');
    mutate(d);
    const after =
      readFileSync(join(d, DF), 'utf8') + readFileSync(join(d, 'infra/nginx/default.conf'), 'utf8');
    const sum = webRuntimeSum(d);
    check(
      `${name}: ${changes ? 'сумма меняется' : 'сумма та же'}`,
      (changes ? sum !== base : sum === base) && (name.startsWith('скрипт') || before !== after),
    );
  }
  const unpinned = copy('wu', WEB_FILES);
  edit(unpinned, DF, (t) => t.replace(/(FROM nginx:[^@\s]+)@sha256:[0-9a-f]{64}/, '$1'));
  check(
    'базовый образ без дайджеста — отказ',
    throws(() => webRuntimeSum(unpinned)),
  );
  const foreign = copy('wf', WEB_FILES);
  edit(foreign, DF, (t) => `${t}\nCOPY --from=build /src/x /etc/nginx/x\n`);
  check(
    'копирование из другой стадии вне статики — отказ',
    throws(() => webRuntimeSum(foreign)),
  );

  // ---------------------------------------------------------------- [2]
  console.warn('\n[2] Сумма входов образа базы');
  const PG = ['infra/postgres'];
  const p = (root, o = {}) =>
    postgresInputs({ root, period: '2026-11', platform: 'linux/amd64', ...o });
  const pgBase = p(copy('p0', PG));
  check('те же входы — та же сумма', p(copy('p1', PG)) === pgBase);
  const pd = copy('p2', PG);
  edit(pd, 'infra/postgres/Dockerfile', (t) => `${t}\n# x\n`);
  check('Dockerfile — сумма меняется', p(pd) !== pgBase);
  const pf = copy('p3', PG);
  edit(pf, 'infra/postgres/init/00-databases.sh', (t) => `${t}\n# x\n`);
  check('файл контекста — сумма меняется', p(pf) !== pgBase);
  const pn = copy('p4', PG);
  writeFileSync(join(pn, 'infra/postgres/init/10-new.sql'), 'select 1;\n');
  check('новый файл контекста — сумма меняется', p(pn) !== pgBase);
  check('платформа — сумма меняется', p(copy('p5', PG), { platform: 'linux/arm64' }) !== pgBase);
  check('месяц — сумма меняется', p(copy('p6', PG), { period: '2026-12' }) !== pgBase);
  if (process.platform === 'win32')
    skip('исполняемость файла', 'на Windows бита исполнения нет — проверяется в Linux');
  else {
    const px = copy('p7', PG);
    const f = join(px, 'infra/postgres/init/00-databases.sh');
    chmodSync(f, 0o644);
    const a = p(px);
    chmodSync(f, 0o755);
    check('исполняемость файла — сумма меняется', a !== p(px));
  }
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  check(
    'CI: готовый образ базы берётся по сумме, сборка заново по rebuild_postgres',
    /image-inputs\.mjs postgres/.test(ci) && /rebuild_postgres/.test(ci) && /inputs-\$KEY/.test(ci),
  );
  check(
    'CI: метка fifth.web.runtime ставится на образ web',
    /--label "fifth\.web\.runtime=\$WEB_RUNTIME"/.test(ci),
  );

  // ---------------------------------------------------------------- [3]
  console.warn('\n[3] Эквивалентность образов');
  const docker = run('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (docker.status !== 0) {
    skip('[3] и [4]', 'Docker не отвечает');
  } else {
    const NGINX =
      'nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10';
    const build = (tag, lines) => {
      const d = join(tmp, `img-${tag}`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'Dockerfile'), `${lines.join('\n')}\n`);
      const r = run('docker', ['build', '-q', '-t', `fifth-check/web:${tag}`, d]);
      if (r.status !== 0) throw new Error(`образ ${tag}: ${r.stderr.slice(-300)}`);
      return `fifth-check/web:${tag}`;
    };
    const HC = 'HEALTHCHECK --interval=30s CMD wget -q -O- http://127.0.0.1/ >/dev/null || exit 1';
    const a = build('a', [
      `FROM ${NGINX}`,
      'LABEL fifth.web.runtime=r1',
      HC,
      'RUN mkdir -p /srv/lab && echo a > /srv/lab/index.html',
    ]);
    const b = build('b', [`FROM ${a}`, 'RUN echo b > /srv/lab/index.html']);
    const nolabel = build('n', [`FROM ${NGINX}`, HC, 'RUN echo n > /tmp/n']);
    const other = build('o', [`FROM ${a}`, 'LABEL fifth.web.runtime=r2']);
    const hc = build('h', [`FROM ${a}`, 'HEALTHCHECK --interval=31s CMD true']);
    const env = build('e', [`FROM ${a}`, 'ENV X=1']);
    check('тот же образ — same', webEquivalence(a, a).same === true);
    const ab = webEquivalence(a, b);
    check(
      'другой образ, та же метка и настройки — эквивалентен',
      ab.equivalent && !ab.same,
      ab.reason,
    );
    const an = webEquivalence(nolabel, a);
    check('у запущенного нет метки — не эквивалентен', !an.equivalent, an.reason);
    const na = webEquivalence(a, nolabel);
    check('у кандидата нет метки — не эквивалентен', !na.equivalent, na.reason);
    check('другая метка — не эквивалентен', !webEquivalence(a, other).equivalent);
    const ah = webEquivalence(a, hc);
    check(
      'та же метка, другая проверка здоровья — не эквивалентен',
      !ah.equivalent && /healthcheck/.test(ah.reason ?? ''),
      ah.reason,
    );
    const ae = webEquivalence(a, env);
    check(
      'та же метка, другое окружение — не эквивалентен',
      !ae.equivalent && /env/.test(ae.reason ?? ''),
      ae.reason,
    );
    check('образа нет — не эквивалентен', !webEquivalence(a, 'fifth-check/web:absent').equivalent);

    // ---------------------------------------------------------------- [4]
    console.warn('\n[4] Статика подключена');
    const rel = join(tmp, 'release');
    for (const [bld, text] of [
      ['s1', 'static one'],
      ['s2', 'static two'],
    ]) {
      mkdirSync(join(rel, 'static', bld, 'lab'), { recursive: true });
      writeFileSync(join(rel, 'static', bld, 'lab', 'index.html'), `${text}\n`);
    }
    mkdirSync(join(rel, 'nginx'), { recursive: true });
    const routeFile = join(rel, 'nginx', 'route.conf');
    const name = 'fifth-check-web-static';
    run('docker', ['rm', '-f', name]);
    const up = run('docker', [
      'run',
      '-d',
      '--name',
      name,
      '-v',
      `${join(rel, 'static', 's1').replace(/\\/g, '/')}:/usr/share/nginx/html:ro`,
      NGINX,
    ]);
    if (up.status !== 0) throw new Error(`nginx: ${up.stderr.slice(-200)}`);
    try {
      for (let k = 0; k < 20; k += 1) {
        if (
          run('docker', ['exec', name, 'wget', '-q', '-O-', 'http://127.0.0.1/lab/']).status === 0
        )
          break;
        spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},500)']);
      }
      const at = (bld) =>
        staticConnected({
          routeFile,
          staticDir: join(rel, 'static'),
          build: bld,
          webContainer: name,
        });
      writeFileSync(routeFile, 'set $static_root /srv/static/s1;\n');
      const ok = at('s1');
      check('маршрут на сборку, каталог есть, web отдаёт её — подключена', ok.ok, ok.reason);
      const wrongRoute = at('s2');
      check('маршрут на другую сборку — не подключена', !wrongRoute.ok, wrongRoute.reason);
      writeFileSync(routeFile, 'set $static_root /srv/static/s2;\n');
      const wrongServed = at('s2');
      check(
        'web отдаёт другую статику — не подключена',
        !wrongServed.ok && /отдаёт не статику/.test(wrongServed.reason),
        wrongServed.reason,
      );
      const missing = at('s3');
      check('нет каталога сборки — не подключена', !missing.ok, missing.reason);
    } finally {
      run('docker', ['rm', '-f', name]);
      run('docker', [
        'image',
        'rm',
        '-f',
        ...['a', 'b', 'n', 'o', 'h', 'e'].map((t) => `fifth-check/web:${t}`),
      ]);
    }
  }

  // ---------------------------------------------------------------- [5]
  console.warn('\n[5] Журнал core-b тем же способом, что у core');
  const envDir = join(tmp, 'env');
  mkdirSync(envDir, { recursive: true });
  writeFileSync(
    join(envDir, 'compose.env'),
    [
      'FIFTH_PROJECT=fifth-test-check',
      `FIFTH_ENV_DIR=${envDir.replace(/\\/g, '/')}`,
      'FIFTH_CORE_IMAGE=fifth/core:x',
      'FIFTH_CORE_A_IMAGE=fifth/core:x',
      'FIFTH_CORE_A_BUILD=x',
      'FIFTH_WEB_IMAGE=fifth/web:x',
      'FIFTH_POSTGRES_IMAGE=fifth/postgres:x',
      '',
    ].join('\n'),
  );
  writeFileSync(join(envDir, 'settings.env'), '');
  const cfg = run('docker', [
    'compose',
    '--env-file',
    join(envDir, 'compose.env'),
    '-f',
    join(ROOT, 'infra/docker-compose.env.yml'),
    '-f',
    join(ROOT, 'infra/docker-compose.env-slots.yml'),
    '-f',
    join(ROOT, 'infra/docker-compose.env-journald.yml'),
    '-f',
    join(ROOT, 'infra/docker-compose.env-journald-slots.yml'),
    '--profile',
    'slot-b',
    'config',
    '--no-interpolate',
    '--format',
    'json',
  ]);
  if (cfg.error) skip('журнал core-b (docker compose config)', 'нет docker в окружении');
  else if (cfg.status !== 0) check('docker compose config', false, cfg.stderr.slice(-300));
  else {
    const svc = JSON.parse(cfg.stdout).services;
    const pick = (s) => ({
      logging: s?.logging,
      label: s?.labels?.['fifth.env'],
    });
    const a = pick(svc.core);
    const bb = pick(svc['core-b']);
    check('core в journald', a.logging?.driver === 'journald', JSON.stringify(a));
    check(
      'core-b — тот же драйвер, тег и метка среды, что у core',
      JSON.stringify(bb.logging) === JSON.stringify(a.logging) && bb.label === a.label,
      `${JSON.stringify(a)} | ${JSON.stringify(bb)}`,
    );
  }
  // Чувствительность: без дополнения журнал core-b не в journald (так было на test-1).
  const bare = run('docker', [
    'compose',
    '--env-file',
    join(envDir, 'compose.env'),
    '-f',
    join(ROOT, 'infra/docker-compose.env.yml'),
    '-f',
    join(ROOT, 'infra/docker-compose.env-slots.yml'),
    '-f',
    join(ROOT, 'infra/docker-compose.env-journald.yml'),
    '--profile',
    'slot-b',
    'config',
    '--no-interpolate',
    '--format',
    'json',
  ]);
  if (!bare.error)
    check(
      'без дополнения core-b не в journald (проверка различает)',
      bare.status === 0 &&
        JSON.parse(bare.stdout).services['core-b']?.logging?.driver !== 'journald',
    );
  const envSrc = readFileSync(join(ROOT, 'scripts/env.mjs'), 'utf8');
  check(
    'env.mjs подключает журнал core-b при слотах и journald, снимает при выключении слотов',
    /'journald-slots'/.test(envSrc) && /m !== 'journald-slots'/.test(envSrc),
  );

  // ---------------------------------------------------------------- [6]
  console.warn('\n[6] План перезапусков');
  const quiet = companionPlan({ slots: true, web: { same: true }, postgres: { restart: false } });
  check('ничего не перезапускается — без простоя', quiet.zeroDowntime === true, quiet.summary);
  const eqv = companionPlan({
    slots: true,
    web: { recreate: false },
    postgres: { restart: false },
  });
  check('web прежний эквивалентный — без простоя', eqv.zeroDowntime === true, eqv.steps.join('; '));
  const pgPlan = companionPlan({ slots: true, web: { same: true }, postgres: { restart: true } });
  check(
    'новый образ базы — НЕ без простоя',
    !pgPlan.zeroDowntime && /базы/.test(pgPlan.summary),
    pgPlan.summary,
  );
  const webPlan = companionPlan({
    slots: true,
    web: { recreate: true, reason: 'r' },
    postgres: { restart: false },
  });
  check(
    'пересоздание единственного web — НЕ без простоя',
    !webPlan.zeroDowntime && /web/.test(webPlan.summary),
    webPlan.summary,
  );
  const noSlots = companionPlan({
    slots: false,
    web: { recreate: true },
    postgres: { restart: false },
  });
  check('без слотов — не без простоя', !noSlots.zeroDowntime, noSlots.summary);
} catch (e) {
  check('прогон дошёл до конца', false, e.message);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.warn(`\nИТОГО: ${passed} пройдено, ${failed} провалено, ${skipped} пропущено\n`);
process.exitCode = failed > 0 ? 1 : 0;
