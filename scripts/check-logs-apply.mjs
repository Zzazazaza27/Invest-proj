#!/usr/bin/env node
/**
 * Испытания применения W08b (блок 8, 8.4) — то, что ляжет на VPS, на
 * локальном стенде, без VPS.
 *
 * Контейнер с systemd, journald и своим Docker Engine
 * (infra/testbed/journald-docker.Dockerfile) в сети стенда; каталог
 * `/opt/fifth-element` как на VPS (scripts и infra из репозитория, свой
 * `.env` с LOGS_*); бакеты и ключи заводит настоящий шаг garage-init (Garage, D-001).
 *   U. юниты fifth-logs-* из infra/systemd: окружение из .env, проход,
 *      файлы почты, пакеты, таймеры; занятая блокировка — пропуск, не отказ;
 *   J. лимиты journald (infra/journald): действуют, штатный перезапуск
 *      нумерацию не меняет;
 *   D. драйвер journald: записи контейнера в архиве и в поиске по имени
 *      контейнера; дополнение compose подключается только переменной;
 *   H. история журнала Docker: работающий молчащий контейнер — снимок
 *      стабилен, но не «покрыт целиком»; остановленный — покрыт;
 *   M. порядок для MinIO: остановка → локальный снимок без S3 → отправка и
 *      сверка после возврата S3; снимок не удаляется; порча снимка видна;
 *   G. известный пробел (журнал postgres до 02.11) в итоговом покрытии;
 *   C. журнал запросов Caddy без query, cookie, авторизации и заголовков;
 *   K. ключ архива из комплекта ключей W07: копия открывается ключом из
 *      комплекта, чужой комплект — нет.
 *
 *   node scripts/check-logs-apply.mjs [--keep]
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { docker as dockerTool, loadEnv, ROOT, TOOL_IMAGE } from './lib/backup.mjs';
import { garageApi } from './lib/garage-admin.mjs';
import { PORTS } from './lib/ports.mjs';
import { s3Object } from './lib/s3.mjs';

loadEnv();
const keep = process.argv.includes('--keep');
const tag = randomBytes(3).toString('hex');
const CT = `jap-${tag}`;
const BASE_IMAGE = 'fifth/journald-testbed:local';
const IMAGE = 'fifth/journald-docker-testbed:local';
const NETWORK = 'fifth_default';
const APP = '/opt/fifth-element';
const STATE = '/var/lib/fifth-logs';
const ALPINE = 'alpine:3.20';
const CADDY = 'caddy:2.11.4';

// Ключи Garage (D-001): GK + 24 hex и секрет 64 hex.
const secret = () => randomBytes(32).toString('hex');
const gk = () => `GK${randomBytes(12).toString('hex')}`;
const ROOT_KEY = gk();
const ROOT_SECRET = secret();
const E = {
  LOGS_S3_ENDPOINT: 'http://fifth-garage-1:3900',
  LOGS_S3_REGION: process.env.S3_REGION || 'us-east-1',
  LOGS_S3_BUCKET: `tech-logs-apply-${tag}`,
  LOGS_S3_ACCESS_KEY_ID: gk(),
  LOGS_S3_SECRET_ACCESS_KEY: secret(),
  LOGS_READER_ACCESS_KEY_ID: gk(),
  LOGS_READER_SECRET_ACCESS_KEY: secret(),
  LOGS_ARCHIVE_KEY: randomBytes(32).toString('hex'),
  LOGS_LEGACY_S3_BUCKET: `tech-logs-legacy-apply-${tag}`,
  LOGS_LEGACY_WRITER_ACCESS_KEY_ID: gk(),
  LOGS_LEGACY_WRITER_SECRET_ACCESS_KEY: secret(),
  LOGS_LEGACY_READER_ACCESS_KEY_ID: gk(),
  LOGS_LEGACY_READER_SECRET_ACCESS_KEY: secret(),
  LOGS_LEGACY_ARCHIVE_KEY: randomBytes(32).toString('hex'),
  LOGS_FILES: '/var/log/tmail/mainlog',
  LOGS_FILES_MIN_AGE_SEC: '0',
};

const root = {
  endpoint: `http://127.0.0.1:${PORTS.garageS3}`,
  bucket: E.LOGS_S3_BUCKET,
  region: process.env.S3_REGION || 'us-east-1',
  accessKey: ROOT_KEY,
  secretKey: ROOT_SECRET,
};

let passed = 0;
let failed = 0;
const check = (name, ok, details = '') => {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details ? ` — ${details}` : ''}`);
};

function sh(cmd, args, { env = {}, allowFail = false, input } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env, MSYS_NO_PATHCONV: '1' },
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 && !allowFail) {
    throw new Error(
      `${cmd} ${args.slice(0, 3).join(' ')}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`,
    );
  }
  return r;
}
const inCt = (script, opts = {}) => sh('docker', ['exec', CT, 'sh', '-c', script], opts).stdout;
const last = (out) => out.trim().split('\n').at(-1);
const line = (out, re) => out.split('\n').find((l) => re.test(l)) ?? last(out);

/** Архиватор как на VPS: из /opt/fifth-element, окружение из .env. */
function arch(command, extra = {}, args = []) {
  const env = { LOGS_DOTENV: '1', ...extra };
  const r = sh(
    'docker',
    [
      'exec',
      '-w',
      APP,
      ...Object.keys(env).flatMap((k) => ['-e', k]),
      CT,
      'node',
      'scripts/logs-archive.mjs',
      command,
      ...args,
    ],
    { env, allowFail: true },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() };
}

/** Запуск юнита и его итог (Result) — как таймер на VPS. */
function startUnit(unit) {
  sh('docker', ['exec', CT, 'systemctl', 'start', unit], { allowFail: true });
  return inCt(`systemctl show -p Result --value ${unit}`).trim();
}

const containerLog = (name) => inCt(`docker inspect -f '{{.LogPath}}' ${name}`).trim();
const offline = (fn) => {
  sh('docker', ['network', 'disconnect', NETWORK, CT]);
  try {
    return fn();
  } finally {
    sh('docker', ['network', 'connect', NETWORK, CT]);
  }
};

const tmpDirs = [];
async function cleanup() {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  sh('docker', ['rm', '-f', `caddy-apply-${tag}`], { allowFail: true });
  if (keep) {
    console.log(
      `\n(--keep: оставлены контейнер ${CT}, бакеты ${E.LOGS_S3_BUCKET}, ${E.LOGS_LEGACY_S3_BUCKET})`,
    );
    return;
  }
  sh('docker', ['rm', '-f', CT], { allowFail: true });
  // Бакеты опустошаются ключом владельца и удаляются, ключи — admin API Garage.
  for (const b of [E.LOGS_S3_BUCKET, E.LOGS_LEGACY_S3_BUCKET]) {
    try {
      const store = { ...root, bucket: b };
      let token = null;
      do {
        const r = await s3Object(
          store,
          'GET',
          '',
          null,
          {},
          {
            'list-type': '2',
            ...(token ? { 'continuation-token': token } : {}),
          },
        );
        const xml = await r.text();
        for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
          await s3Object(store, 'DELETE', m[1].replace(/&amp;/g, '&'));
        }
        token = /<IsTruncated>true/.test(xml)
          ? xml.match(/<NextContinuationToken>([^<]+)</)?.[1]
          : null;
      } while (token);
      const info = await garageApi('GetBucketInfo', undefined, `?globalAlias=${b}`);
      await garageApi('DeleteBucket', {}, `?id=${info.id}`);
    } catch {
      /* бакета нет — уже убран */
    }
  }
  for (const k of [
    E.LOGS_S3_ACCESS_KEY_ID,
    E.LOGS_READER_ACCESS_KEY_ID,
    E.LOGS_LEGACY_WRITER_ACCESS_KEY_ID,
    E.LOGS_LEGACY_READER_ACCESS_KEY_ID,
    ROOT_KEY,
  ]) {
    await garageApi('DeleteKey', {}, `?id=${k}`).catch(() => undefined);
  }
}

console.log(`=== ПРИМЕНЕНИЕ W08b: испытания (${tag}) ===`);
try {
  // ---------------------------------------------------------- стенд
  for (const [image, file] of [
    [BASE_IMAGE, 'journald.Dockerfile'],
    [IMAGE, 'journald-docker.Dockerfile'],
  ]) {
    if (sh('docker', ['image', 'inspect', image], { allowFail: true }).status !== 0) {
      sh('docker', ['build', '-q', '-t', image, '-f', `infra/testbed/${file}`, 'infra/testbed']);
    }
  }
  sh('docker', [
    'run',
    '-d',
    '--name',
    CT,
    '--network',
    NETWORK,
    '--privileged',
    '--cgroupns=host',
    '-v',
    '/sys/fs/cgroup:/sys/fs/cgroup:rw',
    '--tmpfs',
    '/run',
    '--tmpfs',
    '/run/lock',
    '-v',
    `${resolve(ROOT, 'scripts')}:${APP}/scripts:ro`,
    '-v',
    `${resolve(ROOT, 'infra')}:${APP}/infra:ro`,
    IMAGE,
  ]);
  for (let i = 0; i < 40; i++) {
    const s = sh('docker', ['exec', CT, 'systemctl', 'is-system-running'], { allowFail: true });
    if (/running|degraded/.test(s.stdout)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  // .env стенда: переменные архива + окружение ядра из .env машины с
  // адресами сети стенда (ядро в контейнере ходит к базе, Valkey, NATS и
  // MinIO по именам). Значения не печатаются, передаются через stdin.
  const standEnv = readFileSync(resolve(ROOT, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => !/^\s*(LOGS_|DOCKER_LOG_DRIVER)/.test(l))
    .join('\n')
    .replace(/(localhost|127\.0\.0\.1):5433/g, 'fifth-postgres:5432')
    .replace(/(localhost|127\.0\.0\.1):6380/g, 'fifth-valkey:6379')
    .replace(/(localhost|127\.0\.0\.1):4222/g, 'fifth-nats:4222')
    .replace(/(localhost|127\.0\.0\.1):9000/g, 'fifth-garage-1:3900');
  sh('docker', ['exec', '-i', CT, 'sh', '-c', `cat > ${APP}/.env && chmod 600 ${APP}/.env`], {
    input: `${Object.entries(E)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')}\n${standEnv}\n`,
  });
  inCt('ln -sf /usr/local/bin/node /usr/bin/node');
  if (sh('docker', ['image', 'inspect', ALPINE], { allowFail: true }).status !== 0) {
    sh('docker', ['pull', '-q', ALPINE]);
  }
  const saved = spawnSync('docker', ['save', ALPINE], { maxBuffer: 256 * 1024 * 1024 });
  sh('docker', ['exec', '-i', CT, 'docker', 'load'], { input: saved.stdout });
  // Бакеты и ключи журналов — шаг стенда garage-init, как на VPS.
  const init = sh(process.execPath, ['scripts/garage-init.mjs'], { env: E, allowFail: true });
  check(
    'garage-init: бакеты архива и истории с ключами',
    init.status === 0 &&
      init.stdout.includes(`бакет ${E.LOGS_S3_BUCKET}: создан`) &&
      init.stdout.includes(`бакет ${E.LOGS_LEGACY_S3_BUCKET}: создан`),
  );
  // Ключ владельца — только для чтения границы и уборки испытанием.
  await garageApi('ImportKey', {
    accessKeyId: ROOT_KEY,
    secretAccessKey: ROOT_SECRET,
    name: `logs-apply-root-${tag}`,
  });
  for (const b of [E.LOGS_S3_BUCKET, E.LOGS_LEGACY_S3_BUCKET]) {
    const info = await garageApi('GetBucketInfo', undefined, `?globalAlias=${b}`);
    await garageApi('AllowBucketKey', {
      bucketId: info.id,
      accessKeyId: ROOT_KEY,
      permissions: { read: true, write: true, owner: true },
    });
  }

  // ---------------------------------------------------------- U
  console.log('\n▸ U. Юниты systemd из infra/systemd, окружение из .env');
  inCt(
    `cp ${APP}/infra/systemd/fifth-logs-* /etc/systemd/system/ && systemctl daemon-reload && mkdir -p /var/log/tmail && printf 'живой\\n' > /var/log/tmail/mainlog && printf 'поколение ${tag}\\n' > /var/log/tmail/mainlog.1`,
  );
  const vr = sh(
    'docker',
    ['exec', CT, 'sh', '-c', 'systemd-analyze verify /etc/systemd/system/fifth-logs-*'],
    { allowFail: true },
  );
  check(
    'systemd-analyze verify: юниты без ошибок',
    vr.status === 0,
    (vr.stdout + vr.stderr).trim().split('\n')[0],
  );
  check('init архива окружением из .env', arch('init').code === 0);
  inCt('for i in $(seq 1 20); do echo "apply u $i" | systemd-cat -t w08b-apply; done; sleep 1');
  check(
    'fifth-logs-run.service: проход успешен',
    startUnit('fifth-logs-run.service') === 'success',
  );
  const m1 = JSON.parse(inCt(`cat ${STATE}/metrics.json`));
  check(
    'состояние для Zabbix — по пути агента VPS; файлы почты до первого прохода — «не было»',
    m1.run?.ok === true && m1.files?.sources?.[0]?.state === 'never',
    JSON.stringify(m1.run),
  );
  check(
    'fifth-logs-files.service: поколение почты в архиве',
    startUnit('fifth-logs-files.service') === 'success' &&
      JSON.parse(inCt(`cat ${STATE}/files.json`)).stored === 1,
  );
  check('fifth-logs-pack.service: успешен', startUnit('fifth-logs-pack.service') === 'success');
  inCt('systemctl enable --now fifth-logs-run.timer fifth-logs-files.timer fifth-logs-pack.timer');
  const timers = inCt(
    'systemctl list-timers --all --no-legend | grep -c fifth-logs || true',
  ).trim();
  check('таймеры включены (3)', timers === '3', `таймеров ${timers}`);
  // Блокировку держит «другой проход» (живой процесс) — минута пропускается.
  inCt(`sleep 30 >/dev/null 2>&1 & echo $! > ${STATE}/lock`);
  const busy = arch('run');
  check(
    'занятая блокировка — проход пропущен с кодом 0, не отказ',
    busy.code === 0 && busy.out.includes('проход пропущен'),
    last(busy.out),
  );
  inCt(`kill $(cat ${STATE}/lock) 2>/dev/null; rm -f ${STATE}/lock`);

  // ---------------------------------------------------------- J
  console.log('\n▸ J. Лимиты journald');
  // ID нумерации — из курсора (s=…); поля __SEQNUM_ID в journald 252 нет.
  const sid = () =>
    inCt(
      "journalctl -n 1 -o export --no-pager | grep -a '^__CURSOR=' | sed 's/^__CURSOR=s=\\([0-9a-f]*\\);.*/\\1/'",
    ).trim();
  const sidBefore = sid();
  check('ID нумерации прочитан', /^[0-9a-f]{32}$/.test(sidBefore), sidBefore);
  inCt(
    `mkdir -p /etc/systemd/journald.conf.d && cp ${APP}/infra/journald/50-fifth.conf /etc/systemd/journald.conf.d/ && systemctl restart systemd-journald && sleep 1 && echo after-restart | systemd-cat -t w08b-apply && sleep 1`,
  );
  const cfg = inCt('systemd-analyze cat-config systemd/journald.conf');
  check(
    'настройки действуют: SystemMaxUse=4G, SystemKeepFree=15G',
    /SystemMaxUse=4G/.test(cfg) && /SystemKeepFree=15G/.test(cfg),
  );
  check(
    'штатный перезапуск journald — нумерация прежняя',
    sid() === sidBefore,
    `${sidBefore} → ${sid()}`,
  );
  check('проход после перезапуска', startUnit('fifth-logs-run.service') === 'success');

  // ---------------------------------------------------------- D
  console.log('\n▸ D. Драйвер journald для контейнеров');
  const probe = `probe-${tag}`;
  inCt(
    `docker run --rm --name ${probe} --log-driver journald ${ALPINE} echo marker-${tag} && sleep 1`,
  );
  check(
    'запись контейнера в journald с CONTAINER_NAME',
    inCt(`journalctl CONTAINER_NAME=${probe} -o cat --no-pager`).includes(`marker-${tag}`),
  );
  startUnit('fifth-logs-run.service');
  const fD = arch('find', { LOGS_PROFILE: 'reader' }, [
    '--from',
    new Date(Date.now() - 3600_000).toISOString(),
    '--source',
    probe,
  ]);
  check(
    'поиск по имени контейнера учёткой чтения — из архива',
    fD.code === 0 && /найдено: 1/.test(fD.out) && !/порций архива: 0/.test(fD.out),
    last(fD.out),
  );
  // Те же файлы, что у команд стенда: scripts/infra.mjs подключает
  // дополнение journald только при DOCKER_LOG_DRIVER=journald.
  const services = (driver) => {
    const r = sh(
      process.execPath,
      [
        'scripts/infra.mjs',
        'compose',
        '--profile',
        'web',
        '--profile',
        'monitoring',
        '--profile',
        'monitoring-host',
        'config',
        '--format',
        'json',
      ],
      { env: { DOCKER_LOG_DRIVER: driver } },
    );
    return Object.entries(JSON.parse(r.stdout).services).filter(
      ([, s]) => s.restart === 'unless-stopped',
    );
  };
  const vps = services('journald');
  const local = services('');
  check(
    'DOCKER_LOG_DRIVER=journald — у всех постоянных сервисов VPS journald',
    vps.length >= 8 && vps.every(([, s]) => s.logging?.driver === 'journald'),
    vps.map(([n, s]) => `${n}:${s.logging?.driver}`).join(' '),
  );
  // Без переменной определение сервисов прежнее: выкладка (web:up) не
  // пересоздаёт контейнер и не удаляет его журнал до выгрузки.
  check(
    'без переменной — основной compose без logging, пересоздания нет',
    local.length === vps.length && local.every(([, s]) => s.logging === undefined),
  );
  const bad = sh(process.execPath, ['scripts/infra.mjs', 'compose', 'config'], {
    env: { DOCKER_LOG_DRIVER: 'syslog' },
    allowFail: true,
  });
  check('другое значение DOCKER_LOG_DRIVER — отказ', bad.status === 2);

  // ---------------------------------------------------------- Я
  console.log('\n▸ Я. Журнал ядра: настоящий запрос → journald → архив → поиск');
  // Ядро из закоммиченного кода (git archive HEAD), собранное в контейнере:
  // argon2 и sharp — родные модули Linux. scripts и infra — смонтированные.
  const archive = spawnSync('git', ['archive', 'HEAD'], {
    cwd: ROOT,
    maxBuffer: 512 * 1024 * 1024,
  });
  sh('docker', ['exec', '-i', CT, 'tar', '-x', '-C', APP, '--exclude=scripts', '--exclude=infra'], {
    input: archive.stdout,
  });
  const build = sh(
    'docker',
    [
      'exec',
      '-w',
      APP,
      CT,
      'sh',
      '-c',
      'npm ci --no-audit --no-fund --ignore-scripts --workspace apps/core --workspace packages/contracts --include-workspace-root >/tmp/npm.log 2>&1 && npm rebuild argon2 sharp >>/tmp/npm.log 2>&1 && npm run build -w packages/contracts -w apps/core >>/tmp/npm.log 2>&1',
    ],
    { allowFail: true },
  );
  check(
    'ядро собрано в контейнере',
    build.status === 0,
    build.status ? inCt('tail -3 /tmp/npm.log') : '',
  );
  // Юнит — ровно тот, что ляжет на VPS.
  inCt(
    `cp ${APP}/infra/systemd/unicorn-core.service /etc/systemd/system/ && systemctl daemon-reload && systemctl start unicorn-core`,
  );
  let health = '';
  for (let i = 0; i < 60 && health !== '200'; i++) {
    health = inCt(
      "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4300/v1/health || true",
    ).trim();
    if (health !== '200') await new Promise((r) => setTimeout(r, 1000));
  }
  check('ядро под юнитом infra/systemd/unicorn-core.service отвечает', health === '200', health);
  const reqId = `w08b-core-${tag}-0001`;
  inCt(
    `curl -s -o /dev/null -H 'X-Request-Id: ${reqId}' 'http://127.0.0.1:4300/v1/health?token=CORE_SECRET_${tag}' && sleep 1`,
  );
  const coreJournal = inCt('journalctl -u unicorn-core -o export --no-pager');
  check(
    'запрос в journald от юнита ядра: шаблон маршрута, ID запроса, без query',
    coreJournal.includes(`"requestId":"${reqId}"`) &&
      coreJournal.includes('"route":"/v1/health"') &&
      coreJournal.includes('SYSLOG_IDENTIFIER=unicorn-core') &&
      !coreJournal.includes(`CORE_SECRET_${tag}`),
  );
  check('файла core.log нет — вывод только в journald', !inCt(`ls ${APP}`).includes('core.log'));
  check('проход архива', startUnit('fifth-logs-run.service') === 'success');
  // Поиск по копии без S3: запись именно в архиве, а не в свежем journald.
  const cpull = arch('pull', { LOGS_PROFILE: 'reader', LOGS_PULL_TO: '/tmp/corecopy' });
  const fCore = offline(() =>
    arch(
      'find',
      { LOGS_PULL_TO: '/tmp/corecopy', LOGS_S3_ACCESS_KEY_ID: '', LOGS_S3_SECRET_ACCESS_KEY: '' },
      [
        '--copy',
        '/tmp/corecopy',
        '--from',
        new Date(Date.now() - 3600_000).toISOString(),
        '--request-id',
        reqId,
      ],
    ),
  );
  check(
    'поиск по ID запроса в копии архива без S3 — найден ровно один',
    cpull.code === 0 && fCore.code === 0 && /найдено: 1/.test(fCore.out),
    last(fCore.out),
  );
  check(
    'счётчик запросов часа учёл запрос ядра',
    JSON.parse(inCt(`cat ${STATE}/metrics.json`)).lastHour?.requests >= 1,
  );
  inCt('systemctl stop unicorn-core');

  // ---------------------------------------------------------- H
  console.log('\n▸ H. История журнала Docker: остановка подтверждается источником');
  const anchorKey = (
    await (
      await s3Object(root, 'GET', '', null, {}, { 'list-type': '2', prefix: 'anchors/' })
    ).text()
  ).match(/<Key>([^<]+)<\/Key>/)?.[1];
  const anchor = JSON.parse(await (await s3Object(root, 'GET', anchorKey)).text());
  const LEG = { LOGS_PROFILE: 'legacy', LOGS_UNTIL_CURSOR: anchor.afterCursor };
  const quiet = `quiet-${tag}`;
  inCt(
    `docker run -d --name ${quiet} ${ALPINE} sh -c 'echo q1; echo q2; sleep 600' >/dev/null && sleep 2`,
  );
  const qLog = containerLog(quiet);
  const h1 = arch('legacy-export', { ...LEG, LOGS_LEGACY_FILES: qLog });
  check(
    'работающий молчащий контейнер: снимок стабилен, но НЕПОЛНА (код 2)',
    h1.code === 2 &&
      /стабильный снимок до границы, НЕПОЛНО: источник работает/.test(h1.out) &&
      h1.out.includes('локальную историю не очищать'),
    line(h1.out, /^история: \//),
  );
  inCt(`docker stop -t 1 ${quiet} >/dev/null`);
  const h2 = arch('legacy-export', { ...LEG, LOGS_LEGACY_FILES: qLog });
  check(
    'остановленный контейнер (docker inspect): покрыт целиком',
    h2.code === 0 &&
      /источник остановлен — покрыт целиком/.test(h2.out) &&
      h2.out.includes('ИТОГ: история файлов покрыта полностью'),
    line(h2.out, /^история: \//),
  );

  // ---------------------------------------------------------- M
  console.log('\n▸ M. Порядок для MinIO: локальный снимок без S3, отправка после возврата');
  const SNAP = '/var/lib/fifth-logs-snapshot';
  const mc = `minio-like-${tag}`;
  inCt(
    `docker run -d --name ${mc} ${ALPINE} sh -c 'echo m1; echo m2; echo m3; sleep 600' >/dev/null && sleep 2`,
  );
  const mLog = containerLog(mc);
  const mRun = arch('legacy-snapshot', {
    ...LEG,
    LOGS_LEGACY_FILES: mLog,
    LOGS_LEGACY_SNAPSHOT_DIR: `${SNAP}-run`,
  });
  check(
    'снимок работающего контейнера — НЕПОЛОН, «пересоздавать нельзя»',
    mRun.code === 2 && mRun.out.includes('пересоздавать нельзя'),
    last(mRun.out),
  );
  inCt(`docker stop -t 1 ${mc} >/dev/null`);
  // S3 недоступен — как при остановленном MinIO.
  const [mOff, mOffExport] = offline(() => [
    arch('legacy-snapshot', { ...LEG, LOGS_LEGACY_FILES: mLog, LOGS_LEGACY_SNAPSHOT_DIR: SNAP }),
    arch('legacy-export', { ...LEG, LOGS_LEGACY_FILES: mLog }),
  ]);
  check(
    'без S3: локальный снимок проверен, источник остановлен',
    mOff.code === 0 && mOff.out.includes('ИТОГ: локальный снимок проверен'),
    last(mOff.out),
  );
  check(
    'без S3 выгрузка в архив невозможна — отказ, не успех',
    mOffExport.code !== 0,
    last(mOffExport.out),
  );
  check(
    'снимок: данные и покрытие, каталог только для root',
    inCt(`stat -c %a ${SNAP}; ls ${SNAP}`).includes('700') &&
      /\.data/.test(inCt(`ls ${SNAP}`)) &&
      /\.cover\.json/.test(inCt(`ls ${SNAP}`)),
  );
  inCt(`docker start ${mc} >/dev/null`); // прежний контейнер снова работает
  const mSend = arch('legacy-export', { ...LEG, LOGS_LEGACY_SNAPSHOT_DIR: SNAP });
  check(
    'после возврата: снимок отправлен, хеш сверен, покрытие — с остановки',
    mSend.code === 0 &&
      /в архиве, хеш сверен .*источник остановлен — покрыт целиком/.test(mSend.out) &&
      mSend.out.includes('ИТОГ: история файлов покрыта полностью'),
    line(mSend.out, /^снимок /),
  );
  check(
    'локальный снимок не удалён до подтверждения архива',
    /\.data/.test(inCt(`ls ${SNAP}`)) && mSend.out.includes('локальный снимок сохранён'),
  );
  const lver = arch('verify', { LOGS_PROFILE: 'legacy' });
  check('verify истории после отправки снимка', lver.code === 0, line(lver.out, /^ИТОГ/));
  inCt(`f=$(ls ${SNAP}/*.data); node ${APP}/scripts/lib/flip-byte.mjs "$f" 3`);
  const mBad = arch('legacy-export', { ...LEG, LOGS_LEGACY_SNAPSHOT_DIR: SNAP });
  check(
    'испорченный снимок не отправляется, итог НЕПОЛНА',
    mBad.code === 2 && mBad.out.includes('ХЕШ НЕ СОВПАЛ'),
    line(mBad.out, /ХЕШ|ИТОГ/),
  );

  // ---------------------------------------------------------- G
  console.log('\n▸ G. Известный пробел в итоговом покрытии');
  const GAP = {
    LOGS_GAP_SOURCE: 'docker:fifth-postgres',
    LOGS_GAP_UNTIL: '2026-11-02T20:07:17Z',
    LOGS_GAP_REASON: 'журнал json-file удалён пересозданием контейнера 02.11 (правка секретов)',
  };
  const g1 = arch('legacy-gap', { LOGS_PROFILE: 'legacy', ...GAP });
  const g2 = arch('legacy-gap', { LOGS_PROFILE: 'legacy', ...GAP });
  const g3 = arch('legacy-gap', { LOGS_PROFILE: 'legacy', ...GAP, LOGS_GAP_REASON: 'другое' });
  check(
    'пробел записан; повтор — без изменений; другое описание — КОНФЛИКТ',
    g1.code === 0 && g2.out.includes('уже записан') && g3.code !== 0 && g3.out.includes('КОНФЛИКТ'),
  );
  const gr = arch('legacy-export', LEG);
  check(
    'итоговое покрытие называет пробел, восстановления не обещает',
    gr.out.includes('известный пробел: docker:fifth-postgres до 2026-11-02T20:07:17Z') &&
      gr.out.includes('восстановление не обещается') &&
      /ИТОГ: .*известных пробелов до выгрузки: 1/.test(gr.out),
    line(gr.out, /^ИТОГ/),
  );

  // ---------------------------------------------------------- C
  console.log('\n▸ C. Журнал запросов Caddy');
  const cdir = mkdtempSync(join(tmpdir(), 'caddy-apply-'));
  tmpDirs.push(cdir);
  sh('docker', ['pull', '-q', CADDY], { allowFail: true });
  writeFileSync(
    join(cdir, 'Caddyfile'),
    [
      '{',
      '\tauto_https off',
      '}',
      'import /etc/caddy/repo/access-log.caddy',
      ':8080 {',
      '\timport fifth_access_log',
      '\theader Set-Cookie "sid=CADDY_SECRET_5"',
      '\trespond "ok"',
      '}',
      '',
    ].join('\n'),
  );
  sh('docker', [
    'run',
    '-d',
    '--name',
    `caddy-apply-${tag}`,
    '-v',
    `${cdir}:/etc/caddy/t:ro`,
    '-v',
    `${resolve(ROOT, 'infra', 'caddy')}:/etc/caddy/repo:ro`,
    CADDY,
    'caddy',
    'run',
    '--config',
    '/etc/caddy/t/Caddyfile',
  ]);
  await new Promise((r) => setTimeout(r, 2000));
  sh('docker', [
    'exec',
    `caddy-apply-${tag}`,
    'wget',
    '-q',
    '-O',
    '/dev/null',
    '--header',
    'Cookie: s=CADDY_SECRET_2',
    '--header',
    'Authorization: Bearer CADDY_SECRET_3',
    '--header',
    'Referer: https://x/?t=CADDY_SECRET_4',
    'http://127.0.0.1:8080/reset?token=CADDY_SECRET_1&x=1',
  ]);
  const clog = sh('docker', ['logs', `caddy-apply-${tag}`]).stderr;
  const access = clog.split('\n').filter((l) => l.includes('"handled request"'));
  check(
    'запрос в журнале: метод, путь, статус; query удалён',
    access.length === 1 &&
      /"method":"GET"/.test(access[0]) &&
      /"uri":"\/reset\?\[query-removed\]"/.test(access[0]) &&
      /"status":200/.test(access[0]),
    access[0]?.slice(0, 160),
  );
  check(
    'секретов (query, cookie, авторизация, referer, set-cookie) в журнале нет',
    !/CADDY_SECRET/.test(clog),
  );
  const cval = sh(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${resolve(ROOT, 'infra', 'caddy')}:/etc/caddy/repo:ro`,
      '--entrypoint',
      'sh',
      CADDY,
      '-c',
      "printf 'import /etc/caddy/repo/files.caddy\\n' > /tmp/C && caddy validate --config /tmp/C --adapter caddyfile 2>&1 | tail -1",
    ],
    { allowFail: true },
  );
  check(
    'files.caddy сам по себе (без сниппета) — конфигурация верна',
    /Valid configuration/.test(cval.stdout),
    last(cval.stdout),
  );
  // Блок журнала в files.caddy — тот же, что в сниппете (там он вписан, а не
  // импортирован: файл приезжает выкладкой раньше правки Caddyfile).
  const logBlock = (file) =>
    readFileSync(resolve(ROOT, 'infra', 'caddy', file), 'utf8')
      .match(/\tlog \{[\s\S]*?\n\t*\}\n\t*\}/)?.[0]
      ?.replace(/^\t+/gm, '');
  check(
    'фильтр журнала в files.caddy совпадает со сниппетом',
    Boolean(logBlock('files.caddy')) && logBlock('files.caddy') === logBlock('access-log.caddy'),
  );

  // ---------------------------------------------------------- K
  console.log('\n▸ K. Ключ архива из комплекта ключей W07');
  const kdir = mkdtempSync(join(tmpdir(), 'logs-keys-'));
  tmpDirs.push(kdir);
  const pull = arch('pull', { LOGS_PROFILE: 'reader', LOGS_PULL_TO: '/tmp/kcopy' });
  check('копия архива учёткой чтения', pull.code === 0, last(pull.out));
  sh('docker', ['cp', `${CT}:/tmp/kcopy`, join(kdir, 'copy')]);
  const keysDir = join(ROOT, '.local', 'backup-keys-local-stand');
  if (!existsSync(join(keysDir, 'recipient.asc'))) {
    check(
      'пара ключей стенда .local/backup-keys-local-stand есть',
      false,
      'нет — K не проверяется',
    );
  } else {
    // Комплект ключей так же, как его шифрует backup.mjs: весь .env, gpg.
    const bundle = (name, archiveKey) => {
      const r = dockerTool(
        [
          'run',
          '--rm',
          '-i',
          '--entrypoint',
          'sh',
          '-v',
          `${join(keysDir, 'recipient.asc')}:/in/recipient.asc:ro`,
          TOOL_IMAGE,
          '-c',
          'export GNUPGHOME=$(mktemp -d) && gpg -q --batch --import /in/recipient.asc 2>/dev/null && ' +
            'gpg -q --batch --trust-model always --encrypt --armor ' +
            '--recipient "$(gpg --batch --list-keys --with-colons | awk -F: \'/^fpr/{print $10; exit}\')" --output -',
        ],
        { input: `DATABASE_URL=postgres://x\nLOGS_ARCHIVE_KEY=${archiveKey}\n` },
      );
      writeFileSync(join(kdir, name), r.stdout);
      return join(kdir, name);
    };
    const hostCopy = (bundleFile) => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith('LOGS_')),
      );
      const r = spawnSync(
        process.execPath,
        [
          join(ROOT, 'scripts', 'logs-archive.mjs'),
          'verify-copy',
          '--to',
          join(kdir, 'copy'),
          '--bundle',
          bundleFile,
          '--secret-key',
          join(keysDir, 'secret-key.asc'),
          '--passphrase-file',
          join(keysDir, 'passphrase.txt'),
        ],
        { encoding: 'utf8', env },
      );
      return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() };
    };
    const kOk = hostCopy(bundle('keys-ok.env.gpg', E.LOGS_ARCHIVE_KEY));
    check(
      'комплект открыт закрытым ключом, ключ из него открывает копию',
      kOk.code === 0 &&
        kOk.out.includes('комплект ключей открыт') &&
        /ИТОГ: данные сохранены полностью/.test(kOk.out),
      line(kOk.out, /^ИТОГ|ОШИБКА/),
    );
    const kBad = hostCopy(bundle('keys-bad.env.gpg', randomBytes(32).toString('hex')));
    check(
      'комплект с другим ключом копию не открывает',
      kBad.code !== 0,
      line(kBad.out, /^ИТОГ|ОШИБКА/),
    );
    check('значения ключей в выводе не печатаются', !kOk.out.includes(E.LOGS_ARCHIVE_KEY));
  }
} catch (error) {
  failed++;
  console.log(`  FAIL  испытание прервано: ${error.message}`);
} finally {
  await cleanup();
}
console.log(`\nИтог: пройдено ${passed}, провалено ${failed}`);
process.exit(failed ? 1 : 0);
