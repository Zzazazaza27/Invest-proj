#!/usr/bin/env node
/**
 * Рабочая ветка установщика на изолированной площадке.
 *
 *   node scripts/check-installer-site.mjs
 *
 * Снаружи: окно наблюдения как чистая функция, затем контейнер с собственным Docker. Внутри
 * (`--inside`) настоящие `prod-install-setup.sh`, обёртка, sudo, SSH с принудительной командой,
 * закреплённая копия, `release.mjs` по ветке `prod` и файлы Compose рабочей среды. Отличия
 * площадки: образы core и web — заглушки, база пустая со схемой реестра, журналы json-file.
 * Настоящие GHCR и GitHub здесь не участвуют. Контейнер и его данные удаляются прогоном.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeWindow } from './lib/install-policy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'fifth-install-site';
const IMAGE = 'fifth/install-site:check';
const STUBS = ['node:22-bookworm-slim', 'nginx:1.27-alpine', 'postgres:16-alpine'];

let passed = 0;
let failed = 0;
const check = (name, ok, details = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(
    `  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details ? ` — ${String(details).slice(0, 260)}` : ''}`,
  );
};
const summary = () => {
  console.log(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===`);
  process.exit(failed ? 1 : 0);
};

async function windowCases() {
  console.log('\n▸ Окно наблюдения');
  const run = async (steps) => {
    let tick = 0;
    let i = 0;
    return observeWindow({
      seconds: (steps.length - 1) / 1000,
      now: () => tick,
      pause: async () => {
        tick += 1;
      },
      step: async () => {
        const s = steps[i];
        i += 1;
        if (s instanceof Error) throw s;
        return s;
      },
    });
  };
  const ok = { good: true, probe: 'ok' };
  const bad = { good: false, probe: 'ok' };
  check('всё держится — успех', (await run([ok, ok, ok])) === null);
  check('сбой на последней проверке — отказ', (await run([ok, ok, bad])) !== null);
  check('сбой посреди окна и успех в конце — успех', (await run([ok, bad, ok])) === null);
  check('две неудачи подряд — отказ', (await run([bad, bad, ok])) !== null);
  check(
    'контрольный вход не обновился — отказ',
    (await run([{ good: true, probe: 'old' }])) !== null,
  );
  check(
    'контрольный вход провалился — отказ',
    (await run([{ good: true, probe: 'failed' }])) !== null,
  );
  check('ошибка чтения отметки — отказ', (await run([ok, new Error('разбор')])) !== null);
}

// ------------------------------------------------------------------ снаружи

function outside() {
  const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8' });
  const must = (...a) => {
    const r = docker(...a);
    if (r.status !== 0) throw new Error(`docker ${a[0]}: ${r.stderr.trim().slice(-300)}`);
    return r.stdout;
  };
  const clean = () => {
    docker('rm', '-f', '-v', SITE);
  };
  clean();
  try {
    console.log('\n▸ Площадка');
    const context = join(ROOT, '.local', 'install-site');
    mkdirSync(context, { recursive: true });
    writeFileSync(
      join(context, 'Dockerfile'),
      'FROM docker:29-dind\nRUN apk add --no-cache bash nodejs openssh sudo shadow git openssl curl\n',
    );
    must('build', '-q', '-t', IMAGE, context);
    rmSync(context, { recursive: true, force: true });
    must('run', '-d', '--privileged', '--name', SITE, IMAGE);
    for (let i = 0; i < 60; i += 1) {
      if (docker('exec', SITE, 'docker', 'info').status === 0) break;
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
    }
    const repo = spawnSync(
      'git',
      ['archive', 'HEAD', 'scripts', 'infra', 'database', 'package.json'],
      {
        cwd: ROOT,
        maxBuffer: 1 << 28,
      },
    );
    must('exec', SITE, 'mkdir', '-p', '/opt/fifth-element');
    const unpack = spawnSync(
      'docker',
      ['exec', '-i', SITE, 'tar', '-xf', '-', '-C', '/opt/fifth-element'],
      {
        input: repo.stdout,
      },
    );
    if (unpack.status !== 0) throw new Error('код не доставлен');
    const load = spawnSync('sh', [
      '-c',
      `docker save ${STUBS.join(' ')} | docker exec -i ${SITE} docker load`,
    ]);
    if (load.status !== 0) throw new Error('образы не доставлены');
    const inside = spawnSync(
      'docker',
      [
        'exec',
        '-w',
        '/opt/fifth-element',
        SITE,
        'node',
        'scripts/check-installer-site.mjs',
        '--inside',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 26 },
    );
    process.stdout.write(inside.stdout);
    const m = /ИТОГ: (\d+) OK, (\d+) FAIL/.exec(inside.stdout);
    passed += Number(m?.[1] ?? 0);
    failed += m ? Number(m[2]) : 1;
  } finally {
    clean();
    docker('rmi', '-f', IMAGE);
  }
}

// ------------------------------------------------------------------- внутри

const HOME = '/opt/fifth-element';
const KITS = `${HOME}/.local/kits`;
const WORK = '/root/site';
const PROBE = `${WORK}/probe.json`;
const K0 = '2.1-b9200.1';
const K1 = '2.1-b9201.1';
const K2 = '2.1-b9202.1';
const K3 = '2.1-b9203.1';

const sh = (command, input) => {
  const r = spawnSync('bash', ['-c', command], { encoding: 'utf8', input, maxBuffer: 1 << 26 });
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() };
};
const must = (command, input) => {
  const r = sh(command, input);
  if (r.code !== 0) throw new Error(`${command.slice(0, 70)}: ${r.out.slice(-400)}`);
  return r.out;
};
const sql = (text) =>
  must(
    `docker exec -i fifth-postgres psql -U unicorn_owner -d fifth_element -v ON_ERROR_STOP=1 -At`,
    text,
  );
const started = (name) => must(`docker inspect ${name} --format '{{.State.StartedAt}}'`);
const imageOf = (name) => must(`docker inspect ${name} --format '{{.Image}}'`);
const running = () => sql(`SELECT count(*) FROM ops.installations WHERE status = 'running';`);

function setProbe(text) {
  writeFileSync(PROBE, text);
  const future = new Date(Date.now() + 3_600_000);
  utimesSync(PROBE, future, future);
}
function patchPolicy(change) {
  const file = '/etc/fifth-install/policy.json';
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...change }));
}
function stub(label, ready) {
  const dir = `${WORK}/stub-${label}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    `${dir}/main.js`,
    `require('http').createServer((q,s)=>{s.statusCode=${ready};s.end('x')}).listen(4400,'0.0.0.0')`,
  );
  writeFileSync(
    `${dir}/Dockerfile`,
    `FROM node:22-bookworm-slim\nLABEL fifth.site=${label}\nWORKDIR /app\nCOPY main.js apps/core/dist/main.js\nCMD ["node","apps/core/dist/main.js"]\n`,
  );
  must(`docker build -q -t fifth/core:${label} ${dir}`);
  must(`docker tag nginx:1.27-alpine fifth/web:${label}`);
  must(`docker tag postgres:16-alpine fifth/postgres:${label}`);
}
function pack(build, label) {
  stub(label, label === 'bad' ? 503 : 200);
  must(`node scripts/kit.mjs pack --build ${build} --from ${label}`);
  const file = `${KITS}/${build}/kit.json`;
  return JSON.parse(readFileSync(file, 'utf8'));
}
function request(build, expect) {
  const dir = `${WORK}/req-${build}`;
  must(
    `rm -rf ${dir} && mkdir -p ${dir} && cp -r ${KITS}/${build}/. ${dir}/ && rm -f ${dir}/images.tar`,
  );
  return must(
    `node scripts/install-request.mjs --dir ${dir} --expect ${expect} --sign-key-file ${WORK}/sign.pem --token-file ${WORK}/token`,
  );
}
const SSH = `ssh -i ${WORK}/ci -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR fifth-ci@127.0.0.1`;
function viaSsh(input) {
  const r = sh(SSH, input);
  let json = null;
  try {
    json = JSON.parse(r.out.split('\n').pop());
  } catch {
    /* проверка покажет */
  }
  return { ...r, json };
}
function viaSshAsync(input) {
  const child = spawn('bash', ['-c', SSH], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  child.stdin.end(input);
  return new Promise((done) =>
    child.on('exit', (code) => {
      let json = null;
      try {
        json = JSON.parse(out.trim().split('\n').pop());
      } catch {
        /* проверка покажет */
      }
      done({ code, out: out.trim(), json });
    }),
  );
}
const until = async (test, seconds = 240) => {
  for (let i = 0; i < seconds; i += 1) {
    if (test()) return true;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  return false;
};

function prepare() {
  mkdirSync(WORK, { recursive: true });
  writeFileSync(`${WORK}/token`, 'site-token');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(`${WORK}/sign.pem`, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  writeFileSync(`${WORK}/sign.pub`, publicKey.export({ type: 'spki', format: 'pem' }));
  must(`ssh-keygen -q -t ed25519 -N '' -f ${WORK}/ci`);
  must(`ssh-keygen -A && mkdir -p /run/sshd && /usr/sbin/sshd`);
  // На площадке нет journald: драйвер меняется до сборки комплектов, для всех одинаково.
  for (const file of readdirSync('infra').filter((f) => f.endsWith('.yml'))) {
    const path = `infra/${file}`;
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replaceAll('driver: journald', 'driver: json-file'),
    );
  }
  must(
    `git init -q && git config user.email s@s && git config user.name s && printf '.local\\n.env\\n' > .gitignore && git add -A && git commit -qm site`,
  );
  const names = new Set();
  for (const file of readdirSync('infra').filter((f) => f.endsWith('.yml'))) {
    for (const m of readFileSync(`infra/${file}`, 'utf8').matchAll(/\$\{([A-Z0-9_]+):\?/g))
      names.add(m[1]);
  }
  const tls = '/etc/fifth-tls/services';
  must(
    `mkdir -p ${tls} .local/core-none /run/fifth-secrets /var/lib/fifth-monitor .local/kits/pins .local/envs/prod/compose`,
  );
  must(
    `openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=site -keyout ${tls}/server.key -out ${tls}/server.crt 2>/dev/null && cp ${tls}/server.crt ${tls}/ca.crt`,
  );
  const env = Object.fromEntries([...names].map((n) => [n, 'site']));
  Object.assign(env, {
    FIFTH_CORE_IMAGE: `fifth/core:${K0}`,
    FIFTH_WEB_IMAGE: `fifth/web:${K0}`,
    FIFTH_POSTGRES_IMAGE: `fifth/postgres:${K0}`,
    FIFTH_SECRETS_DIR: `${HOME}/.local/core-none`,
    FIFTH_TLS_DIR: tls,
    POSTGRES_PASSWORD: 'site-pg',
    DB_ROLE_PASSWORD_APP_RELEASE: 'site-release',
  });
  writeFileSync(
    '.env',
    `${Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')}\n`,
  );
}

async function bootstrap() {
  const kit = pack(K0, 'base');
  must(`node scripts/kit.mjs load --build ${K0}`);
  must(`cp ${KITS}/${K0}/prod-compose/* .local/envs/prod/compose/`);
  must(`node scripts/infra.mjs compose up -d --no-deps postgres core web`);
  check(
    'площадка поднялась файлами рабочей среды',
    await until(
      () =>
        sh(`docker exec fifth-postgres pg_isready -U unicorn_owner -d fifth_element`).code === 0,
      60,
    ),
  );
  const rows = kit.migrations
    .map(
      (m) =>
        `INSERT INTO public.schema_migrations VALUES ('${m.id}', decode('${m.sha256}', 'hex'));`,
    )
    .join('\n');
  const registry = readdirSync('database/migrations').find((f) => f.startsWith('M157'));
  sql(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_readonly') THEN CREATE ROLE app_readonly NOLOGIN; END IF; END $$;
    ${readFileSync(`database/migrations/${registry}`, 'utf8')}
    CREATE ROLE app_release_user LOGIN PASSWORD 'site-release' IN ROLE app_release;
    CREATE TABLE public.schema_migrations (id text PRIMARY KEY, checksum bytea NOT NULL);
    GRANT SELECT ON public.schema_migrations TO app_release;
    ${rows}
    INSERT INTO ops.installations (id, env, build, commit_sha, kit_sha256, actor, approved_by, status, finished_at)
    VALUES (gen_random_uuid(), 'prod', '${K0}', 'site', 'site', 'site', 'site', 'succeeded', now());`);
  must(`node scripts/kit.mjs pin --env prod --current ${K0}`);
  const v = sh(`node scripts/release.mjs verify prod`);
  check('прежняя сборка сверяется по ветке prod', v.code === 0, v.out.slice(-200));
}

async function insideRun() {
  console.log('\n▸ Установка на узел');
  prepare();
  await bootstrap();
  const b64 = (file) => Buffer.from(readFileSync(file)).toString('base64');
  const setup = sh(
    `bash infra/host/prod-install-setup.sh ${b64(`${WORK}/sign.pub`)} ${b64(`${WORK}/ci.pub`)}`,
  );
  check('установка прошла', setup.code === 0, setup.out.slice(-200));
  // В образе площадки нет PAM: заблокированная учётка не вошла бы даже по ключу.
  must(`usermod -p '*' fifth-ci`);
  const policy = JSON.parse(readFileSync('/etc/fifth-install/policy.json', 'utf8'));
  check(
    'закреплены все файлы запуска',
    [
      'docker-compose.yml',
      'docker-compose.prod.yml',
      'docker-compose.secrets.yml',
      'docker-compose.tls.yml',
    ].every((f) => Object.keys(policy.launchFiles).some((k) => k.endsWith(`/${f}`))),
    Object.keys(policy.launchFiles).length,
  );
  check(
    'копия инструментов принадлежит root',
    must(`stat -c %U /opt/fifth-install/tools/scripts/install-ci.mjs`) === 'root',
  );
  check(
    'учётка CI не пишет в копию',
    sh(`sudo -u fifth-ci touch /opt/fifth-install/tools/x`).code !== 0,
  );
  patchPolicy({ rollbackFloor: K0, watchSeconds: 15, siteUrl: null, probeFile: PROBE });
  setProbe('{"ok":true}');

  console.log('\n▸ Цепочка SSH');
  const escape = sh(`${SSH} 'id; cat /etc/shadow' </dev/null`);
  check(
    'своя команда не выполняется, принудительная отказывает',
    !escape.out.includes('uid=') && escape.out.includes('не разобран'),
    escape.out.slice(-160),
  );
  const forward = sh(
    `${SSH.replace('ssh ', 'ssh -L 19999:127.0.0.1:22 -N -o ExitOnForwardFailure=yes ')}`,
    '',
  );
  check('проброс порта закрыт', forward.code !== 0, forward.out.slice(-120));
  const sudoOther = sh(`sudo -u fifth-ci sudo -n /bin/sh -c id`);
  check('sudo разрешён только на обёртку', sudoOther.code !== 0);

  pack(K1, 'one');
  const reqK1 = request(K1, K0);

  console.log('\n▸ Файлы запуска');
  for (const file of [
    'infra/docker-compose.secrets.yml',
    'infra/docker-compose.tls.yml',
    '.local/envs/prod/compose/docker-compose.prod.yml',
  ]) {
    const text = readFileSync(file);
    appendFileSync(file, '# подмена\n');
    const r = viaSsh(reqK1);
    writeFileSync(file, text);
    check(
      `подмена ${file.split('/').pop()} — отказ до изменений`,
      r.code === 2 && r.json?.error?.includes('файлы запуска'),
      r.out.slice(-160),
    );
  }

  console.log('\n▸ Выпуск и блокировка на всё наблюдение');
  const pgStarted = started('fifth-postgres');
  const before = imageOf('fifth-core');
  pack(K2, 'two');
  const reqK2 = request(K2, K0);
  const first = viaSshAsync(reqK1);
  check('ядро заменено, наблюдение идёт', await until(() => imageOf('fifth-core') !== before));
  const during = viaSsh(reqK2);
  check(
    'второй выпуск во время наблюдения — отказ',
    during.code === 2 && during.json?.error?.includes('идёт выпуск'),
    during.out.slice(-160),
  );
  check('блокировка держится', running() === '1');
  const done = await first;
  check(
    'выпуск прошёл через обёртку',
    done.code === 0 && done.json?.ok === true,
    done.out.slice(-200),
  );
  check('блокировка снята после наблюдения', running() === '0');
  check('база не перезапускалась', started('fifth-postgres') === pgStarted);
  check(
    'зависимости не тронуты',
    sh(`docker ps -a --format '{{.Names}}' | grep -E 'valkey|nats|garage|zabbix'`).code !== 0,
  );
  check(
    'миграций не прибавилось',
    sql('SELECT count(*) FROM public.schema_migrations') ===
      String(readdirSync('database/migrations').filter((f) => f.endsWith('.sql')).length),
  );
  const v1 = sh(`node scripts/release.mjs verify prod --build ${K1}`);
  check('сверка своей сборки', v1.code === 0, v1.out.slice(-160));
  check(
    'сверка чужой сборки отказывает',
    sh(`node scripts/release.mjs verify prod --build ${K0}`).code !== 0,
  );

  console.log('\n▸ Нечитаемая отметка и возврат без разрыва блокировки');
  const one = imageOf('fifth-core');
  setProbe('не json');
  const reqK2b = request(K2, K1);
  const second = viaSshAsync(reqK2b);
  const healed = await until(() => {
    if (sql(`SELECT count(*) FROM ops.installations WHERE kind = 'rollback'`) === '0') return false;
    setProbe('{"ok":true}');
    return true;
  });
  check('возврат начался', healed);
  const back = await second;
  check('возврат прошёл', back.code === 1 && back.json?.returned === true, back.out.slice(-200));
  check('ядро на прежней сборке', imageOf('fifth-core') === one);
  check(
    'разрыва блокировки нет',
    sql(`SELECT f.finished_at = r.started_at FROM ops.installations f, ops.installations r
          WHERE f.build = '${K2}' AND r.kind = 'rollback' ORDER BY r.started_at DESC LIMIT 1`) ===
      't',
  );
  check('блокировка снята', running() === '0');

  console.log('\n▸ Ядро не поднялось');
  pack(K3, 'bad');
  const third = viaSsh(request(K3, K1));
  check(
    'выпуск не удался, возврат прошёл',
    third.code === 1 && third.json?.returned === true,
    third.out.slice(-200),
  );
  check('ядро на прежней сборке', imageOf('fifth-core') === one);
  const v2 = sh(`node scripts/release.mjs verify prod`);
  check('сверка после возврата', v2.code === 0 && v2.out.includes(K1), v2.out.slice(-160));
}

if (process.argv.includes('--inside')) {
  try {
    await insideRun();
  } catch (error) {
    check('прогон оборван', false, error.message);
  }
  summary();
}
console.log('=== РАБОЧАЯ ВЕТКА УСТАНОВЩИКА ===');
await windowCases();
if (!existsSync(join(ROOT, '.git'))) throw new Error('нужен git');
outside();
summary();
