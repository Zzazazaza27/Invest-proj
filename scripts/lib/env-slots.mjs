/**
 * Слоты ядра тестовой или временной среды (блок 09, задание 3) — настоящие действия для
 * scripts/lib/slot-switch.mjs. Вызывается из scripts/env.mjs (`slots-enable`, `slots-update`),
 * помощники среды приходят параметром `env`: compose, каталог, порт web.
 *
 * Каталог среды:
 *   release/grant/background-grant.json  разрешение фона (пишет только установщик)
 *   release/token/token                  токен служебных команд (читают только контейнеры)
 *   release/nginx/route.conf             маршрут nginx: ядро, служебный, статика
 *   release/core-route.json              тот же маршрут для скриптов
 *   release/static/<сборка>/…             статика сборки из образа web
 *   release/journal.jsonl                журнал шагов переключения
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { get as httpGet } from 'node:http';
import { join } from 'node:path';

const dockerEnv = { ...process.env, MSYS_NO_PATHCONV: '1' };
const SERVICE = { 'core-a': 'core', 'core-b': 'core-b' };
const INTERNAL = 4400;

export function slotDirs(dir) {
  const r = join(dir, 'release');
  return {
    root: r,
    grant: join(r, 'grant', 'background-grant.json'),
    token: join(r, 'token', 'token'),
    route: join(r, 'nginx', 'route.conf'),
    routeJson: join(r, 'core-route.json'),
    static: join(r, 'static'),
    journal: join(r, 'journal.jsonl'),
  };
}

/** Запись через временный файл: читатель видит старое или новое, не половину. */
function atomicWrite(file, text) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Статика сборки из образа web — один раз на сборку. */
export function extractStatic(dir, label) {
  const dest = join(slotDirs(dir).static, label);
  if (existsSync(join(dest, 'lab', 'index.html'))) return dest;
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const create = spawnSync('docker', ['create', `fifth/web:${label}`], {
    encoding: 'utf8',
    env: dockerEnv,
  });
  if (create.status !== 0) throw new Error(`образ web ${label}: ${create.stderr.trim()}`);
  const cid = create.stdout.trim();
  try {
    const cp = spawnSync('docker', ['cp', `${cid}:/srv/.`, dest], {
      encoding: 'utf8',
      env: dockerEnv,
    });
    if (cp.status !== 0) throw new Error(`статика ${label}: ${cp.stderr.trim()}`);
  } finally {
    spawnSync('docker', ['rm', cid], { env: dockerEnv });
  }
  if (!existsSync(join(dest, 'lab', 'index.html')))
    throw new Error(`статика ${label}: нет lab/index.html`);
  return dest;
}

/**
 * Раскладка слотов: имена контейнеров и адреса. Временная среда — ядро в своей сети Docker,
 * слоты различаются именем, порты одинаковые. Рабочая — ядро в сети узла, у слотов свои
 * порты, nginx ходит на шлюз Docker (infra/docker-compose.slots.yml, infra/host/core-slot.sh).
 */
export function envLayout(project) {
  const name = (slot) => (slot === 'core-b' ? `${project}-core-b` : `${project}-core`);
  return {
    container: name,
    web: `${project}-web`,
    service: (slot) => SERVICE[slot],
    apiPort: () => 4300,
    internalPort: () => INTERNAL,
    routeApi: (slot) => `${SERVICE[slot]}:4300`,
    routeInternal: (slot) => `${SERVICE[slot]}:${INTERNAL}`,
  };
}

export function prodLayout(coreHost) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(coreHost ?? ''))
    throw new Error('адрес шлюза Docker (CORE_HOST) не задан');
  const ports = { 'core-a': [4300, 4401], 'core-b': [4310, 4411] };
  return {
    container: (slot) => (slot === 'core-b' ? 'fifth-core-b' : 'fifth-core'),
    web: 'fifth-web',
    service: (slot) => SERVICE[slot],
    apiPort: (slot) => ports[slot][0],
    internalPort: (slot) => ports[slot][1],
    routeApi: (slot) => `${coreHost}:${ports[slot][0]}`,
    routeInternal: (slot) => `${coreHost}:${ports[slot][1]}`,
  };
}

export function writeRoute(dir, { slot, build, prevBuild }, layout = envLayout('')) {
  const d = slotDirs(dir);
  atomicWrite(
    d.route,
    [
      `# Маршрут ${slot}, сборка ${build} — пишет установщик (блок 09, задание 3).`,
      `set $core_api "${layout.routeApi(slot)}";`,
      `set $core_internal "${layout.routeInternal(slot)}";`,
      `set $static_root /srv/static/${build};`,
      `set $static_prev /srv/static/${prevBuild ?? build};`,
      '',
    ].join('\n'),
  );
  atomicWrite(
    d.routeJson,
    `${JSON.stringify({ format: 1, slot, build, prevBuild: prevBuild ?? build, at: new Date().toISOString() })}\n`,
  );
}

export function writeGrant(dir, owner, op) {
  atomicWrite(
    slotDirs(dir).grant,
    `${JSON.stringify({ format: 1, owner, op, at: new Date().toISOString() })}\n`,
  );
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** Подготовка каталога и файлов режима слотов: токен, разрешение, маршрут, статика. */
export function prepareSlots(dir, label, layout = envLayout('')) {
  const d = slotDirs(dir);
  for (const sub of ['grant', 'token', 'nginx', 'static'])
    mkdirSync(join(d.root, sub), { recursive: true });
  if (!existsSync(d.token)) {
    writeFileSync(d.token, randomBytes(32).toString('hex'));
    chmodSync(d.token, 0o644); // каталог среды — 0700; внутри контейнера читает пользователь ядра
  }
  extractStatic(dir, label);
  writeGrant(dir, 'core-a', 'slots-enable');
  writeRoute(dir, { slot: 'core-a', build: label, prevBuild: label }, layout);
}

/** Порт действий для switchSlots в тестовой среде. */
export function envSlotOps(env, op) {
  return slotOps(
    {
      dir: env.dir,
      layout: envLayout(env.project),
      webPort: env.webPort,
      compose: env.compose,
      setImage: (slot, build) => {
        const key = slot === 'core-b' ? 'B' : 'A';
        env.setComposeEnv(`FIFTH_CORE_${key}_IMAGE`, `fifth/core:${build}`);
        env.setComposeEnv(`FIFTH_CORE_${key}_BUILD`, build);
      },
    },
    op,
  );
}

/**
 * Порт действий для switchSlots — общий для тестовых и рабочей сред.
 * @param ctx { dir, layout, webPort, compose(args, opts), setImage(slot, build) }
 */
export function slotOps(ctx, op) {
  const env = ctx;
  const L = ctx.layout;
  const d = slotDirs(ctx.dir);
  const container = (slot) => L.container(slot);
  const execNode = (slot, code, timeout = 90_000) => {
    const r = spawnSync('docker', ['exec', container(slot), 'node', '-e', code], {
      encoding: 'utf8',
      env: dockerEnv,
      timeout,
    });
    try {
      return JSON.parse(r.stdout.trim().split('\n').pop());
    } catch {
      return { status: 0, error: (r.stderr || r.stdout || 'нет ответа').trim().slice(0, 200) };
    }
  };
  // Служебный порт слота изнутри контейнера; токен читается там же и наружу не выходит.
  const internal = (slot, method, path) =>
    execNode(
      slot,
      `const fs=require('fs');const t=${method === 'POST' ? "fs.readFileSync('/run/fifth-release-token/token','utf8').trim()" : "''"};` +
        `fetch('http://127.0.0.1:${L.internalPort(slot)}${path}',{method:'${method}',headers:t?{authorization:'Bearer '+t}:{},signal:AbortSignal.timeout(80000)})` +
        `.then(async(r)=>console.log(JSON.stringify({status:r.status,body:await r.json().catch(()=>null)})),(e)=>console.log(JSON.stringify({status:0,error:String(e)})))`,
    );
  const webExec = (cmd) =>
    spawnSync('docker', ['exec', L.web, 'sh', '-c', cmd], {
      encoding: 'utf8',
      env: dockerEnv,
      timeout: 30_000,
    });
  // Каждый раз новое соединение (agent: false): как новый посетитель. Переиспользованное
  // keep-alive могло бы попасть в старый обработчик nginx и показать старое ядро.
  const via = () =>
    new Promise((resolveVia, rejectVia) => {
      const req = httpGet(
        {
          host: '127.0.0.1',
          port: env.webPort,
          path: '/v1/features',
          agent: false,
          timeout: 10_000,
        },
        (res) => {
          res.resume();
          res.on('end', () =>
            resolveVia({
              status: res.statusCode,
              build: res.headers['x-fifth-build'] ?? null,
              slot: res.headers['x-fifth-slot'] ?? null,
            }),
          );
        },
      );
      req.on('timeout', () => req.destroy(new Error('нет ответа')));
      req.on('error', rejectVia);
    });

  const record = (stage, status, detail = '') => {
    const line = { at: new Date().toISOString(), op, stage, status, detail };
    appendFileSync(d.journal, `${JSON.stringify(line)}\n`);
    console.error(`  · ${stage}: ${status}${detail ? ` — ${detail}` : ''}`);
  };
  // Точки вмешательства испытаний (scripts/check-slots-env.mjs) — только по переменной.
  const HOOK = process.env.FIFTH_TEST_SLOT_HOOK ?? '';
  const hookPrev = readJson(d.routeJson)?.build;
  const restart = (slot) =>
    spawnSync('docker', ['restart', container(slot)], { env: dockerEnv, timeout: 120_000 });
  const waitMode = async (slot) => {
    for (let i = 0; i < 60; i += 1) {
      const m = internal(slot, 'GET', '/background');
      if (m.status === 200) return m.body?.mode;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return 'нет ответа';
  };

  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    record,
    startCandidate: async (slot, build) => {
      ctx.setImage(slot, build);
      env.compose([
        '--profile',
        'slot-b',
        'up',
        '-d',
        '--no-deps',
        '--force-recreate',
        L.service(slot),
      ]);
    },
    ready: async (slot) => internal(slot, 'GET', '/ready').status === 200,
    candidateChecks: async (slot) => {
      const control = internal(slot, 'GET', '/control');
      if (control.status !== 200)
        return { ok: false, detail: `контрольная операция: ${control.status}` };
      const login = execNode(
        slot,
        `fetch('http://127.0.0.1:${L.apiPort(slot)}/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'nobody-slot@check.invalid',password:'slot-check-'+Date.now()})}).then((r)=>console.log(JSON.stringify({status:r.status})),(e)=>console.log(JSON.stringify({status:0,error:String(e)})))`,
      );
      return login.status === 401
        ? { ok: true }
        : { ok: false, detail: `вход несуществующей учёткой: ${login.status}` };
    },
    writeGrant: (owner) => writeGrant(ctx.dir, owner, op),
    readGrant: () => readJson(d.grant),
    pause: async (slot) => {
      const r = internal(slot, 'POST', '/background/pause');
      const mode = r.body?.mode ?? `нет ответа (${r.status}${r.error ? `: ${r.error}` : ''})`;
      // Испытание: старый слот перезапущен сразу после паузы — пауза обязана сохраниться.
      if (HOOK === 'restart-after-pause' && mode === 'paused') {
        restart(slot);
        const after = await waitMode(slot);
        record('hook', 'restart-after-pause', `${slot} после перезапуска: ${after}`);
        return after;
      }
      return mode;
    },
    resume: async (slot) => {
      const r = internal(slot, 'POST', '/background/resume');
      return r.body?.mode ?? `нет ответа (${r.status})`;
    },
    writeRoute: (route) => writeRoute(ctx.dir, route, L),
    readRoute: () => readJson(d.routeJson),
    reloadNginx: async () => {
      const route = readJson(d.routeJson);
      // Испытание: кандидат перезапущен после записи маршрута, до подтверждения reload.
      if (HOOK === 'restart-candidate-after-route' && route?.slot && route.build !== hookPrev) {
        restart(route.slot);
        record(
          'hook',
          'restart-candidate-after-route',
          `${route.slot}: ${await waitMode(route.slot)}`,
        );
      }
      // Испытание: отказ перезагрузки после паузы старого фона.
      if (HOOK === 'reload-fail' && route?.build !== hookPrev) {
        return { ok: false, detail: 'испытание: nginx -t отказал' };
      }
      const r = webExec('nginx -t 2>&1 && nginx -s reload 2>&1');
      return r.status === 0
        ? { ok: true }
        : { ok: false, detail: `${r.stdout}${r.stderr}`.trim().slice(-200) };
    },
    viaNginx: via,
    observe: async (ms) => {
      const end = Date.now() + ms;
      let bad = 0;
      let total = 0;
      while (Date.now() < end) {
        total += 1;
        const r = await via().catch(() => ({ status: 0 }));
        if (r.status !== 200) bad += 1;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      return bad === 0
        ? { ok: true }
        : { ok: false, detail: `неуспешных ответов через nginx ${bad} из ${total}` };
    },
    nginxOldWorkers: async () => {
      const r = webExec("ps -o args | grep -c '[s]hutting down' || true");
      return Number(r.stdout.trim()) || 0;
    },
    activeRequests: async (slot) => {
      const r = internal(slot, 'GET', '/state');
      return r.status === 200 ? (r.body?.activeRequests ?? 0) : 0;
    },
    stopSlot: async (slot) => {
      env.compose(['--profile', 'slot-b', 'stop', L.service(slot)], { allowFail: true });
    },
    backgroundMode: async (slot) => internal(slot, 'GET', '/background').body?.mode ?? 'нет ответа',
  };
}
