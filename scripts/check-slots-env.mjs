#!/usr/bin/env node
/**
 * Два ядра на настоящей временной среде (блок 09, задание 3; уточнения Тэнка 09.11).
 *
 *   node scripts/check-slots-env.mjs [--keep]
 *
 * Образы из чистого снимка кода (git archive — как CI), метки slot1…slot4 — одни образы,
 * сборка различается FIFTH_BUILD слота. Среда test-78 создаётся и удаляется прогоном.
 *
 *  [1] перевод на слоты; через nginx — slot1/core-a;
 *  [2] выпуск slot2 под потоком запросов с живой сессией: нет неуспешных ответов, сессия
 *      жива, через nginx — slot2/core-b, фон только у core-b, старый остановлен;
 *  [3] перезапуск неактивного слота — фон не стартует;
 *  [4] перезапуск обоих слотов в окне наблюдения — фон только у активного;
 *  [5] отказ перезагрузки nginx после паузы старого фона — прежняя работа восстановлена;
 *  [6] перезапуск старого слота сразу после паузы — пауза сохраняется;
 *  [7] перезапуск кандидата после записи маршрута, до подтверждения — фон не стартует;
 *  [8] фактическое состояние согласовано;
 *  [9] новая статика при прежнем web (та же серверная часть): web и база не пересоздаются;
 *  [10] кандидат без метки серверной части — web пересоздан (Тэнк 13.11).
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { s3Object } from './lib/s3.mjs';
import { webRuntimeSum } from './lib/web-runtime.mjs';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV = 'test-78';
const PORT = 18178;
const BASE = `http://127.0.0.1:${PORT}`;
const dockerEnv = { ...process.env, MSYS_NO_PATHCONV: '1' };
const JOURNAL = join(ROOT, '.local', 'envs', ENV, 'release', 'journal.jsonl');

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.warn(
    `  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`,
  );
};
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...dockerEnv, ...opts.env },
    timeout: opts.timeout ?? 1_800_000,
    cwd: opts.cwd ?? ROOT,
  });
const envTool = (args, extra = {}) => {
  const r = run(process.execPath, [join(ROOT, 'scripts', 'env.mjs'), ...args], { env: extra });
  let json = null;
  try {
    json = JSON.parse(r.stdout.trim().split('\n').pop());
  } catch {
    /* проверка покажет */
  }
  return { code: r.status, json, out: `${r.stdout}${r.stderr}`.trim() };
};
const envToolAsync = (args, extra = {}) =>
  new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts', 'env.mjs'), ...args], {
      env: { ...dockerEnv, ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      let json = null;
      try {
        json = JSON.parse(
          out
            .trim()
            .split('\n')
            .filter((l) => l.startsWith('{'))
            .pop(),
        );
      } catch {
        /* проверка покажет */
      }
      resolveRun({ code, json, out: out.trim() });
    });
  });
/**
 * Контрольный объект среды (M153) — как `monitoring.mjs control-init` на prod: файл в бакете
 * среды и запись с размером и SHA-256. Без него контрольная операция кандидата — 503.
 */
async function controlInit() {
  const keys = JSON.parse(readFileSync(join(ROOT, '.local', 'envs', ENV, 'storage.json'), 'utf8'));
  const body = Buffer.concat([Buffer.from('5E control object v1\n'), randomBytes(4096)]);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const put = await s3Object(
    {
      endpoint: 'http://127.0.0.1:9000',
      bucket: `fifth-${ENV}`,
      region: readFileSync(join(ROOT, '.local', 'envs', ENV, 'settings.env'), 'utf8')
        .match(/^S3_REGION=(.*)$/m)[1]
        .trim(),
      accessKey: keys.app.accessKeyId,
      secretKey: keys.app.secretAccessKey,
    },
    'PUT',
    'control/probe-v1',
    body,
    { 'content-type': 'application/octet-stream' },
  );
  if (put.status !== 200) throw new Error(`контрольный объект: HTTP ${put.status}`);
  const sql = `INSERT INTO audit.control_objects (name, s3_key, size_bytes, sha256) VALUES ('probe', 'control/probe-v1', ${body.length}, '${sha256}') ON CONFLICT DO NOTHING`;
  const r = run('docker', [
    'exec',
    `fifth-${ENV}-postgres`,
    'sh',
    '-c',
    `PGPASSWORD="$(cat /run/secrets/POSTGRES_PASSWORD)" psql -h 127.0.0.1 -U fifth_owner -d fifth_element -v ON_ERROR_STOP=1 -c "$0"`,
    sql,
  ]);
  if (r.status !== 0) throw new Error(`контрольная запись: ${r.stderr.slice(-200)}`);
}
const container = (slot) => (slot === 'core-b' ? `fifth-${ENV}-core-b` : `fifth-${ENV}-core`);
const bg = (slot) => {
  const r = run('docker', [
    'exec',
    container(slot),
    'node',
    '-e',
    "fetch('http://127.0.0.1:4400/background').then((r)=>r.json()).then((b)=>console.log(b.mode),()=>console.log('нет ответа'))",
  ]);
  return r.status === 0 ? r.stdout.trim() : 'не работает';
};
const via = async () => {
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request — локальная среда по http
  const r = await fetch(`${BASE}/v1/features`, { signal: AbortSignal.timeout(10_000) });
  await r.arrayBuffer();
  return {
    status: r.status,
    build: r.headers.get('x-fifth-build'),
    slot: r.headers.get('x-fifth-slot'),
  };
};
const waitMode = async (slot) => {
  for (let i = 0; i < 60; i += 1) {
    const m = bg(slot);
    if (!['нет ответа', 'не работает'].includes(m)) return m;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return 'нет ответа';
};
const journal = () => {
  try {
    return readFileSync(JOURNAL, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

console.warn('\n=== ДВА ЯДРА НА ВРЕМЕННОЙ СРЕДЕ ===\n');

// ------------------------------------------------------------------ образы
console.warn('▸ Образы из чистого снимка');
{
  const snap =
    run('git', ['stash', 'create']).stdout.trim() ||
    run('git', ['rev-parse', 'HEAD']).stdout.trim();
  const src = mkdtempSync(join(tmpdir(), 'fifth-slots-src-'));
  const tar = spawnSync(
    'sh',
    ['-c', `git archive ${snap} | tar -x -C "${src.replace(/\\/g, '/')}"`],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (tar.status !== 0) throw new Error(`снимок: ${tar.stderr}`);
  for (const [file, image] of [
    ['infra/images/core.Dockerfile', 'core'],
    ['infra/images/web.Dockerfile', 'web'],
  ]) {
    const b = run(
      'docker',
      [
        'build',
        '-q',
        '--build-arg',
        `GIT_COMMIT=${snap}`,
        '-f',
        file,
        '-t',
        `fifth/${image}:slot1`,
        // Метка серверной части web — как в CI (Тэнк 13.11).
        ...(image === 'web' ? ['--label', `fifth.web.runtime=${webRuntimeSum(src)}`] : []),
        '.',
      ],
      { cwd: src },
    );
    if (b.status !== 0) throw new Error(`сборка ${image}: ${b.stderr.slice(-300)}`);
  }
  const pg = run('docker', ['build', '-q', '-t', 'fifth/postgres:slot1', 'infra/postgres'], {
    cwd: src,
  });
  if (pg.status !== 0) throw new Error(`сборка postgres: ${pg.stderr.slice(-300)}`);
  rmSync(src, { recursive: true, force: true });
  for (const n of ['slot2', 'slot3', 'slot4']) {
    for (const c of ['core', 'web', 'postgres'])
      run('docker', ['tag', `fifth/${c}:slot1`, `fifth/${c}:${n}`]);
  }
  check('образы собраны', true, snap.slice(0, 12));
}

envTool(['destroy', ENV, '--confirm', ENV]);
try {
  // ---------------------------------------------------------------- [1]
  console.warn('\n[1] Перевод среды на слоты');
  // Адрес загрузки — хранилище стенда, проброшенное на узел (загрузка файла в [2]).
  const created = envTool([
    'create',
    ENV,
    '--kit',
    'slot1',
    '--web-port',
    String(PORT),
    '--files-url',
    'http://localhost:9000',
  ]);
  check('среда создана', created.code === 0, created.out.slice(-200));
  // Режим испытаний ядра: долгий проход фона (8 с) и маршрут долгого запроса.
  appendFileSync(
    join(ROOT, '.local', 'envs', ENV, 'settings.env'),
    'BACKGROUND_TEST_SLOW_MS=8000\n',
  );
  await controlInit();
  check('контрольный объект среды заведён', true);
  const enabled = envTool(['slots-enable', ENV]);
  check('слоты включены', enabled.code === 0, enabled.json?.message ?? enabled.out.slice(-200));
  const v1 = await via();
  check(
    'через nginx — slot1/core-a',
    v1.build === 'slot1' && v1.slot === 'core-a',
    JSON.stringify(v1),
  );
  check('фон у core-a', bg('core-a') === 'running', bg('core-a'));

  // ---------------------------------------------------------------- [2]
  console.warn('\n[2] Выпуск slot2 под потоком запросов');
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request — локальная среда по http
  const cons = await (await fetch(`${BASE}/v1/auth/consents/templates?locale=ru-RU`)).json();
  const email = `slots-${Date.now() % 1e9}@test.local`;
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request — локальная среда по http
  const reg = await fetch(`${BASE}/v1/auth/register`, {
    signal: AbortSignal.timeout(30_000),
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: `Pw-${Date.now()}-slots-check`,
      displayName: 'Слоты',
      role: 'founder',
      locale: 'ru-RU',
      consents: (cons.items ?? []).map((t) => ({
        kind: t.kind,
        version: t.version,
        locale: 'ru-RU',
      })),
    }),
  });
  const cookie = (reg.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  check('сессия открыта', reg.status === 201 && cookie.length > 0, `HTTP ${reg.status}`);
  const stats = { total: 0, bad: [], builds: new Set() };
  let stop = false;
  const load = (async () => {
    while (!stop) {
      stats.total += 1;
      try {
        // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request — локальная среда по http
        const r = await fetch(`${BASE}/v1/me/profile`, {
          headers: { cookie },
          signal: AbortSignal.timeout(15_000),
        });
        await r.arrayBuffer();
        stats.builds.add(r.headers.get('x-fifth-build'));
        if (r.status !== 200) stats.bad.push(r.status);
      } catch (e) {
        stats.bad.push(e.cause?.code ?? 'обрыв');
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  })();
  // Загрузка: билет выдаёт старое ядро до переключения, сборку завершает новое после.
  const csrf = /ul_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
  const png = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 30, g: 90, b: 160 } },
  })
    .png()
    .toBuffer();
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request — локальная среда по http
  const ticketRes = await fetch(`${BASE}/v1/me/avatar/upload`, {
    signal: AbortSignal.timeout(30_000),
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ contentType: 'image/png', sizeBytes: png.byteLength }),
  });
  const ticket = await ticketRes.json().catch(() => null);
  check(
    'загрузка: билет выдан старым ядром',
    Boolean(ticket?.uploadUrl) && ticketRes.headers.get('x-fifth-build') === 'slot1',
    `HTTP ${ticketRes.status}`,
  );
  // Долгий запрос на самом ядре: начат на старом до переключения.
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request — локальная среда по http
  const slow = fetch(`${BASE}/v1/__test/slow?ms=40000`, {
    signal: AbortSignal.timeout(120_000),
  }).then(
    async (r) => ({ status: r.status, body: await r.json().catch(() => null), at: Date.now() }),
    (e) => ({ status: 0, error: e.cause?.code ?? e.message, at: Date.now() }),
  );
  // Занятый фон: в наблюдении сравнить проход старого и первый проход кандидата.
  const jobsOf = (slot) => {
    const r = run('docker', [
      'exec',
      container(slot),
      'node',
      '-e',
      "fetch('http://127.0.0.1:4400/jobs').then((r)=>r.json()).then((b)=>console.log(JSON.stringify(b.jobs.find((j)=>j.name==='test.slow-pass')??null)),()=>console.log('null'))",
    ]);
    try {
      return JSON.parse(r.stdout.trim());
    } catch {
      return null;
    }
  };
  let busy = null;
  const watchBusy = (async () => {
    for (let i = 0; i < 300 && !busy; i += 1) {
      if (
        journal().some(
          (l) => l.stage === 'grant' && l.status === 'ok' && /owner=core-b/.test(l.detail),
        )
      ) {
        await new Promise((r) => setTimeout(r, 3000));
        busy = { old: jobsOf('core-a'), cand: jobsOf('core-b') };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
  // Выпуск — отдельным процессом без блокировки: поток запросов идёт параллельно.
  const up = await envToolAsync([
    'slots-update',
    ENV,
    '--kit',
    'slot2',
    '--observe-ms',
    '20000',
    '--drain-ms',
    '90000',
  ]);
  stop = true;
  await load;
  await watchBusy;
  const slowRes = await slow;
  check(
    'долгий запрос завершён старым ядром, без обрыва',
    slowRes.status === 200 && slowRes.body?.build === 'slot1',
    JSON.stringify(slowRes).slice(0, 120),
  );
  // Итоговая запись этапа (ok или timeout): с задания 4 у этапа есть и запись «start».
  const drain = journal()
    .filter((l) => l.op === up.json?.op && l.stage === 'drain' && l.status !== 'start')
    .at(-1);
  const stopOld = journal().find((l) => l.op === up.json?.op && l.stage === 'stop-old');
  check(
    'старое ядро остановлено после завершения долгого запроса',
    drain?.status === 'ok' && Date.parse(stopOld?.at) >= slowRes.at,
    `${drain?.status} ${drain?.detail ?? ''}`,
  );
  check(
    'занятый фон: первый проход кандидата — после окончания прохода старого',
    busy?.old?.lastFinishedAt &&
      busy?.cand?.lastStartedAt &&
      Date.parse(busy.cand.lastStartedAt) >= Date.parse(busy.old.lastFinishedAt) &&
      !busy.old.running,
    JSON.stringify({
      oldFinished: busy?.old?.lastFinishedAt,
      oldRunning: busy?.old?.running,
      candStarted: busy?.cand?.lastStartedAt,
    }),
  );
  if (ticket?.uploadUrl) {
    const form = new FormData();
    for (const [k, v] of Object.entries(ticket.formFields)) form.append(k, v);
    form.append('file', new Blob([png], { type: 'image/png' }), 'a.png');
    const put = await fetch(ticket.uploadUrl, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request — локальная среда по http
    const fin = await fetch(`${BASE}/v1/me/avatar/finalize`, {
      signal: AbortSignal.timeout(30_000),
      method: 'POST',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request — локальная среда по http
    const profRes = await fetch(`${BASE}/v1/me/profile`, {
      headers: { cookie },
      signal: AbortSignal.timeout(30_000),
    });
    const prof = await profRes.json().catch(() => null);
    check(
      'загрузка: файл принят, сборку завершило новое ядро',
      put.status < 400 &&
        fin.status === 200 &&
        fin.headers.get('x-fifth-build') === 'slot2' &&
        Boolean(prof?.avatar),
      `хранилище ${put.status}, сборка ${fin.status} (${fin.headers.get('x-fifth-build')})`,
    );
  }
  check(
    'выпуск прошёл',
    up.code === 0 && up.json?.active === 'core-b',
    up.json?.message ?? up.out.slice(-300),
  );
  check(
    'неуспешных ответов под потоком нет',
    stats.bad.length === 0,
    `запросов ${stats.total}, неуспешных ${stats.bad.length}: ${[...new Set(stats.bad)].join(',')}`,
  );
  check(
    'поток видел обе сборки',
    stats.builds.has('slot1') && stats.builds.has('slot2'),
    [...stats.builds].join(','),
  );
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request — локальная среда по http
  const me = await fetch(`${BASE}/v1/me/profile`, {
    headers: { cookie },
    signal: AbortSignal.timeout(30_000),
  });
  check('сессия жива после переключения', me.status === 200, `HTTP ${me.status}`);
  const v2 = await via();
  check(
    'через nginx — slot2/core-b',
    v2.build === 'slot2' && v2.slot === 'core-b',
    JSON.stringify(v2),
  );
  check(
    'фон только у core-b, core-a остановлен',
    bg('core-b') === 'running' && bg('core-a') === 'не работает',
    `${bg('core-b')} / ${bg('core-a')}`,
  );
  check(
    'журнал: разрешение снято до паузы, фон кандидату после подтверждения',
    (() => {
      const j = journal()
        .filter((l) => l.op === up.json?.op)
        .map((l) => `${l.stage}:${l.status}`);
      return (
        j.indexOf('grant:ok') < j.indexOf('pause:ok') &&
        j.indexOf('confirm:ok') < j.lastIndexOf('grant:ok')
      );
    })(),
  );

  // ---------------------------------------------------------------- [3]
  console.warn('\n[3] Перезапуск неактивного слота');
  run('docker', ['start', container('core-a')]);
  const inactive = await waitMode('core-a');
  check('неактивный core-a после старта — без фона', inactive === 'paused', inactive);
  run('docker', ['stop', container('core-a')]);

  // ---------------------------------------------------------------- [4]
  console.warn('\n[4] Перезапуск обоих слотов в окне наблюдения');
  const child = spawn(
    process.execPath,
    [
      join(ROOT, 'scripts', 'env.mjs'),
      'slots-update',
      ENV,
      '--kit',
      'slot3',
      '--observe-ms',
      '60000',
      '--drain-ms',
      '30000',
    ],
    { env: dockerEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const done = new Promise((r) => child.on('close', r));
  for (let i = 0; i < 300; i += 1) {
    if (
      journal().some(
        (l) => l.stage === 'grant' && l.status === 'ok' && /owner=core-a/.test(l.detail),
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  run('docker', ['restart', container('core-a')]);
  run('docker', ['restart', container('core-b')]);
  const modesDuring = { a: await waitMode('core-a'), b: await waitMode('core-b') };
  check(
    'в наблюдении после перезапуска обоих: фон только у активного core-a',
    modesDuring.a === 'running' && modesDuring.b === 'paused',
    JSON.stringify(modesDuring),
  );
  await done;
  const r4 = JSON.parse(out.trim().split('\n').pop() || '{}');
  // Перезапуск активного слота — настоящий короткий отказ: наблюдение обязано его поймать и,
  // без разрешённого возврата, остановиться с решением за Томасом, не переключая назад.
  check(
    'наблюдение поймало отказ активного, возврат без разрешения не сделан',
    r4.ok === false && r4.stage === 'observe' && r4.active === 'core-a',
    r4.message,
  );

  // ---------------------------------------------------------------- [5]
  console.warn('\n[5] Отказ перезагрузки nginx после паузы старого фона');
  const f5 = envTool(
    ['slots-update', ENV, '--kit', 'slot4', '--observe-ms', '5000', '--drain-ms', '10000'],
    { FIFTH_TEST_SLOT_HOOK: 'reload-fail' },
  );
  check(
    'отказ на перезагрузке',
    f5.code !== 0 && f5.json?.stage === 'reload',
    f5.json?.message ?? f5.out.slice(-200),
  );
  const v5 = await via();
  check(
    'обслуживает прежний: slot3/core-a',
    v5.build === 'slot3' && v5.slot === 'core-a',
    JSON.stringify(v5),
  );
  check(
    'прежняя работа восстановлена: фон core-a идёт, кандидат остановлен',
    bg('core-a') === 'running' && bg('core-b') === 'не работает',
    `${bg('core-a')} / ${bg('core-b')}`,
  );

  // ---------------------------------------------------------------- [6]
  console.warn('\n[6] Перезапуск старого слота сразу после паузы');
  const f6 = envTool(
    ['slots-update', ENV, '--kit', 'slot4', '--observe-ms', '5000', '--drain-ms', '20000'],
    { FIFTH_TEST_SLOT_HOOK: 'restart-after-pause' },
  );
  const h6 = journal().find((l) => l.op === f6.json?.op && l.stage === 'hook');
  check(
    'после перезапуска старый остался на паузе',
    /: paused$/.test(h6?.detail ?? ''),
    h6?.detail,
  );
  check('выпуск slot4 прошёл', f6.code === 0 && f6.json?.active === 'core-b', f6.json?.message);

  // ---------------------------------------------------------------- [7]
  console.warn('\n[7] Перезапуск кандидата после записи маршрута, до подтверждения');
  const f7 = envTool(
    ['slots-update', ENV, '--kit', 'slot1', '--observe-ms', '5000', '--drain-ms', '20000'],
    { FIFTH_TEST_SLOT_HOOK: 'restart-candidate-after-route' },
  );
  const h7 = journal().find((l) => l.op === f7.json?.op && l.stage === 'hook');
  check('кандидат после перезапуска — без фона', /: paused$/.test(h7?.detail ?? ''), h7?.detail);
  check(
    'выпуск slot1 прошёл, фон у кандидата после подтверждения',
    f7.code === 0 && bg('core-a') === 'running',
    f7.json?.message,
  );
  check(
    'тот же образ web и базы — без пересоздания, план «без простоя»',
    f7.json?.web === 'same' && f7.json?.plan?.zeroDowntime === true && !f7.json?.companions?.length,
    JSON.stringify({ web: f7.json?.web, plan: f7.json?.plan?.summary, c: f7.json?.companions }),
  );

  // ---------------------------------------------------------------- [9]
  // Тэнк 13.11: web с той же серверной частью и новой статикой не пересоздаётся.
  console.warn('\n[9] Новая статика при прежнем web');
  const derive = (tag, from, lines) => {
    const d = mkdtempSync(join(tmpdir(), 'fifth-slots-web-'));
    writeFileSync(join(d, 'Dockerfile'), `FROM fifth/web:${from}\n${lines.join('\n')}\n`);
    const b = run('docker', ['build', '-q', '-t', `fifth/web:${tag}`, d]);
    rmSync(d, { recursive: true, force: true });
    if (b.status !== 0) throw new Error(`образ web ${tag}: ${b.stderr.slice(-300)}`);
    for (const c of ['core', 'postgres'])
      run('docker', ['tag', `fifth/${c}:slot1`, `fifth/${c}:${tag}`]);
  };
  const started = (svc) =>
    run('docker', [
      'inspect',
      `fifth-${ENV}-${svc}`,
      '--format',
      '{{.Id}} {{.State.StartedAt}}',
    ]).stdout.trim();
  derive('slot5', 'slot1', [
    `RUN sed -i 's#</head>#<meta name="fifth-check" content="slot5"></head>#' /srv/lab/index.html`,
  ]);
  const web5 = started('web');
  const pg5 = started('postgres');
  const p5 = envTool(['slots-plan', ENV, '--kit', 'slot5']);
  check(
    'план: прежний web, без простоя',
    p5.json?.zeroDowntime === true,
    p5.json?.summary ?? p5.out.slice(-200),
  );
  const f9 = envTool([
    'slots-update',
    ENV,
    '--kit',
    'slot5',
    '--observe-ms',
    '5000',
    '--drain-ms',
    '20000',
  ]);
  check(
    'выпуск slot5 прошёл',
    f9.code === 0 && f9.json?.active === 'core-b',
    f9.json?.message ?? f9.out.slice(-200),
  );
  check(
    'web не пересоздан, работает прежний образ',
    f9.json?.web === 'equivalent' && started('web') === web5,
    JSON.stringify({ web: f9.json?.web, c: f9.json?.companions, after: f9.json?.after }),
  );
  check('база не перезапущена', started('postgres') === pg5);
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request — локальная среда по http
  const lab5 = await fetch(`${BASE}/lab/`, { signal: AbortSignal.timeout(15_000) }).then(
    (r) => r.text(),
    () => '',
  );
  check('новая статика подключена при прежнем web', /content="slot5"/.test(lab5));
  const inst5 = JSON.parse(readFileSync(join(ROOT, '.local', 'envs', ENV, 'install.json'), 'utf8'));
  check(
    'учёт: прежний образ web и эквивалентность кандидату, а не совпадение',
    inst5.kit?.label === 'slot5' &&
      Boolean(inst5.kit?.webEquivalentTo) &&
      inst5.kit.images?.web !== inst5.kit.webEquivalentTo,
    JSON.stringify(inst5.kit ?? null).slice(0, 200),
  );

  // ---------------------------------------------------------------- [10]
  console.warn('\n[10] Кандидат без метки — обычное сравнение и пересоздание');
  derive('slot6', 'slot5', [
    'LABEL fifth.web.runtime=""',
    `RUN sed -i 's#content="slot5"#content="slot6"#' /srv/lab/index.html`,
  ]);
  const p6 = envTool(['slots-plan', ENV, '--kit', 'slot6']);
  check(
    'план: пересоздание web, НЕ без простоя',
    p6.json?.zeroDowntime === false && /web/.test(p6.json?.summary ?? ''),
    p6.json?.summary ?? p6.out.slice(-200),
  );
  const web6 = started('web');
  const f10 = envTool([
    'slots-update',
    ENV,
    '--kit',
    'slot6',
    '--observe-ms',
    '5000',
    '--drain-ms',
    '20000',
  ]);
  check(
    'выпуск slot6 прошёл',
    f10.code === 0 && f10.json?.active === 'core-a',
    f10.json?.message ?? f10.out.slice(-200),
  );
  check(
    'web пересоздан на образе кандидата',
    f10.json?.web === 'recreated' && started('web') !== web6,
    JSON.stringify({ web: f10.json?.web, c: f10.json?.companions }),
  );
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request — локальная среда по http
  const lab6 = await fetch(`${BASE}/lab/`, { signal: AbortSignal.timeout(15_000) }).then(
    (r) => r.text(),
    () => '',
  );
  check('статика slot6 отдаётся', /content="slot6"/.test(lab6));

  // ---------------------------------------------------------------- [8]
  console.warn('\n[8] Фактическое состояние');
  const st = envTool(['slots-state', ENV]);
  check(
    'согласовано',
    st.code === 0 && st.json?.consistent === true,
    JSON.stringify(st.json?.background ?? st.out.slice(-200)),
  );
} catch (e) {
  check('прогон дошёл до конца', false, e.message);
} finally {
  if (!process.argv.includes('--keep')) envTool(['destroy', ENV, '--confirm', ENV]);
}

console.warn(`\nИТОГО: ${passed} пройдено, ${failed} провалено\n`);
process.exitCode = failed > 0 ? 1 : 0;
