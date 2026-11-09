#!/usr/bin/env node
/**
 * Защищённый установщик выпуска. Запускается обёрткой `fifth-install` из закреплённой копии вне
 * git. На вход — один JSON в stdin (`install-request.mjs`). Среда, порог возврата и открытый ключ
 * берутся только из настроек установщика, а не из запроса.
 *
 * Порядок: подпись → класс операций → получение комплекта → выпуск образов core и web → окно
 * наблюдения. Возврат — только если образы уже менялись, один раз, на сборку, работавшую до
 * выпуска. Блокировка и журнал — в `release.mjs`, второй реализации нет.
 *
 * Код завершения: 0 готово, 2 отказ до изменений, 1 выпуск не удался и возврат прошёл,
 * 3 остановка, нужен человек. Результат — строка JSON. Токен не печатается и не сохраняется
 * дольше работы процесса.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classProblems,
  compareBuilds,
  launchProblems,
  observeWindow,
  sameKit,
} from './lib/install-policy.mjs';
import { kitSignatureValid } from './lib/kit-sign.mjs';

const TOOLS = resolve(dirname(fileURLToPath(import.meta.url)));
const ETC = process.env.FIFTH_INSTALL_ETC || '/etc/fifth-install';
const KITS = process.env.FIFTH_KITS_DIR;
const MAX_REQUEST = 8 * 1024 * 1024;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const done = (result, code) => {
  console.log(JSON.stringify(result));
  process.exit(code);
};
const refuse = (error) => done({ ok: false, refused: true, error }, 2);

function tool(script, args, env = process.env) {
  const r = spawnSync(process.execPath, [join(TOOLS, script), ...args], {
    encoding: 'utf8',
    env,
    timeout: 1_800_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout.trim().split('\n').pop());
  } catch {
    /* итог по коду завершения */
  }
  // Без итоговой строки причину даёт хвост ошибки: процесс мог быть убит или упасть раньше.
  const detail = r.error?.message ?? r.signal ?? r.stderr?.trim().split('\n').pop()?.slice(0, 200);
  return { code: r.status, json: json ?? { error: detail } };
}

function readRequest() {
  const data = readFileSync(0);
  if (data.length > MAX_REQUEST) refuse('запрос больше предела');
  try {
    return JSON.parse(data.toString('utf8'));
  } catch {
    return refuse('запрос не разобран');
  }
}

/** Только файлы, названные подписанным манифестом, с его хешами. */
function stageFiles(request, kit) {
  const dir = mkdtempSync(join(process.env.FIFTH_INSTALL_TMP || tmpdir(), 'fifth-kit-'));
  const take = (name, sum) => {
    const value = request.files?.[name];
    if (typeof value !== 'string') refuse(`в запросе нет ${name}`);
    const bytes = Buffer.from(value, 'base64');
    if (sha256(bytes) !== sum) refuse(`${name}: хеш не совпал с манифестом`);
    return bytes;
  };
  writeFileSync(join(dir, 'kit.json'), Buffer.from(request.files['kit.json'], 'base64'));
  writeFileSync(join(dir, 'compose.yml'), take('compose.yml', kit.compose?.sha256));
  mkdirSync(join(dir, 'prod-compose'));
  for (const [file, sum] of Object.entries(kit.prodCompose ?? {})) {
    const name = basename(file);
    writeFileSync(join(dir, 'prod-compose', name), take(`prod-compose/${name}`, sum));
  }
  if (kit.sbom) {
    // Опись — только файлы, названные подписанным манифестом, с его суммами.
    mkdirSync(join(dir, 'sbom'));
    for (const [name, sum] of Object.entries(kit.sbom.files ?? {})) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) refuse(`опись: недопустимое имя ${name}`);
      writeFileSync(join(dir, 'sbom', name), take(`sbom/${name}`, sum));
    }
  }
  return dir;
}

/** Токен живёт в каталоге настроек Docker этого запуска. */
function fetchKit(kit, request, staged) {
  const stored = join(KITS, kit.build, 'kit.json');
  if (existsSync(stored)) {
    if (!sameKit(kit, JSON.parse(readFileSync(stored, 'utf8')))) {
      refuse(`комплект ${kit.build} на узле не совпал с подписанным`);
    }
    return;
  }
  const config = mkdtempSync(join(process.env.FIFTH_INSTALL_TMP || tmpdir(), 'fifth-docker-'));
  try {
    const auth = Buffer.from(`token:${request.token}`).toString('base64');
    writeFileSync(join(config, 'config.json'), JSON.stringify({ auths: { 'ghcr.io': { auth } } }), {
      mode: 0o600,
    });
    const r = tool('kit.mjs', ['fetch', '--build', kit.build, '--dir', staged], {
      ...process.env,
      DOCKER_CONFIG: config,
    });
    if (r.code !== 0) refuse(`комплект не получен: ${r.json?.error ?? r.code}`);
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
}

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** Сайт за паролем на входе проверяется учёткой наблюдения. */
async function siteOk(url, credentialsFile) {
  if (!url) return true;
  const headers = credentialsFile
    ? {
        authorization: `Basic ${Buffer.from(readFileSync(credentialsFile, 'utf8').trim()).toString('base64')}`,
      }
    : {};
  try {
    return (await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })).ok;
  } catch {
    return false;
  }
}

function probeState(file, since) {
  if (!file) return 'ok';
  if (!existsSync(file) || statSync(file).mtimeMs <= since) return 'old';
  return JSON.parse(readFileSync(file, 'utf8')).ok === true ? 'ok' : 'failed';
}

/** Окно наблюдения за конкретной сборкой. Нечитаемая отметка — сбой наблюдения. */
function watch(env, build, policy) {
  const started = Date.now();
  return observeWindow({
    seconds: policy.watchSeconds,
    pause: () => wait(Math.min(5000, policy.watchSeconds * 250)),
    step: async () => ({
      probe: probeState(policy.probeFile, started),
      good:
        tool('release.mjs', ['verify', env, '--build', build]).code === 0 &&
        (await siteOk(policy.siteUrl, policy.siteCredentials)),
    }),
  });
}

/** Файлы запуска рабочей среды. У тестовой среды Compose свой, он в манифесте. */
function launchFiles(env) {
  if (env !== 'prod') return {};
  const r = spawnSync(process.execPath, [join(TOOLS, 'infra.mjs'), 'files'], {
    encoding: 'utf8',
    env: process.env,
  });
  if (r.status !== 0) return { 'файлы запуска': 'не прочитаны' };
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const pinsOf = (env) => {
  const file = join(KITS, 'pins', `${env}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
};

const installArgs = (env, kit, expect, actor, approved, extra = []) => [
  'install',
  env,
  '--kit',
  kit,
  '--expect',
  expect,
  '--actor',
  actor,
  '--approved-by',
  approved,
  '--images-only',
  ...extra,
];

const stopped = (build, previous, reason, returnError) =>
  done({ ok: false, stopped: true, build, previous, reason, returnError }, 3);

/** Блокировка не прерывается: возврат принимает операцию. При остановке она остаётся за человеком. */
async function returnTo(env, op, previous, rollbackPin, reason, policy, build) {
  if (launchProblems(launchFiles(env), policy).length) {
    stopped(build, previous, reason, 'файлы запуска изменились, возврат не начат');
  }
  const back = tool(
    'release.mjs',
    installArgs(env, previous, previous, 'fifth-install', 'policy', [
      '--rollback',
      '--hold',
      '--takeover',
      op,
    ]),
  );
  if (back.code !== 0) stopped(build, previous, reason, `возврат: код ${back.code}`);
  const problem = await watch(env, previous, policy);
  if (problem) stopped(build, previous, reason, problem);
  tool('release.mjs', [
    'close',
    env,
    '--op',
    back.json.op,
    '--status',
    'succeeded',
    '--detail',
    reason,
  ]);
  if (rollbackPin) tool('kit.mjs', ['pin', '--env', env, '--rollback', rollbackPin]);
  done({ ok: false, returned: true, build, previous, reason }, 1);
}

const policy = JSON.parse(readFileSync(join(ETC, 'policy.json'), 'utf8'));
const request = readRequest();
const env = policy.env;
const kitValue = request.files?.['kit.json'];
if (typeof kitValue !== 'string') refuse('в запросе нет манифеста');
const kitBytes = Buffer.from(kitValue, 'base64');
const publicKey = readFileSync(join(ETC, 'kit-signing.pub'), 'utf8');
if (!kitSignatureValid(kitBytes, request.signature, publicKey)) refuse('подпись не подтверждена');
const kit = JSON.parse(kitBytes.toString('utf8'));
if (compareBuilds(kit.build, kit.build) === null || kit.build !== request.build) {
  refuse('сборка запроса не совпала с манифестом');
}

const state = tool('release.mjs', ['state', env]);
if (state.code !== 0) refuse(`состояние среды не прочитано: ${state.json?.error ?? state.code}`);
const { build: current, migrations: applied, running } = state.json;
if (running) refuse('в среде идёт выпуск');
if (!current || current !== request.expect) {
  refuse(`среда на сборке ${current ?? 'none'}, ожидалась ${request.expect}`);
}
const installedFile = join(KITS, current, 'kit.json');
if (!existsSync(installedFile)) refuse(`на узле нет комплекта возврата ${current}`);
const installed = JSON.parse(readFileSync(installedFile, 'utf8'));
const launch = launchFiles(env);
const problems = classProblems({ kit, installed, applied, policy, launch });
if (problems.length) refuse(`вне класса операций: ${problems.join('; ')}`);
const ready = tool('kit.mjs', ['check', '--build', current]);
if (ready.code !== 0)
  refuse(`комплект возврата ${current} не годен: ${ready.json?.error ?? ready.code}`);

const staged = stageFiles(request, kit);
try {
  fetchKit(kit, request, staged);
} finally {
  rmSync(staged, { recursive: true, force: true });
}

const rollbackPin = pinsOf(env).rollback ?? null;
const forward = tool(
  'release.mjs',
  installArgs(env, kit.build, current, 'fifth-install', policy.approvedBy, ['--hold']),
);
if (forward.code === 2) refuse(forward.json?.error ?? 'выпуск отклонён');
if (forward.code !== 0) {
  if (!forward.json?.held) done({ ok: false, build: kit.build, error: forward.json?.error }, 3);
  await returnTo(env, forward.json.op, current, rollbackPin, forward.json.error, policy, kit.build);
}
const problem = await watch(env, kit.build, policy);
if (problem) await returnTo(env, forward.json.op, current, rollbackPin, problem, policy, kit.build);
tool('release.mjs', [
  'close',
  env,
  '--op',
  forward.json.op,
  '--status',
  'succeeded',
  '--detail',
  'наблюдение прошло',
]);
done({ ok: true, build: kit.build, previous: current }, 0);
