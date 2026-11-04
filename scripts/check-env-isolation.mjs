#!/usr/bin/env node
/**
 * Две изолированные среды из одних образов (W09b): команды управления, изоляция
 * данных, бакетов и секретов, /live и /ready, зависшее ядро.
 *
 *   node scripts/check-env-isolation.mjs [--kit <метка>]
 *
 * Нужны локальный Garage и образы `fifth/{core,web,postgres}:<метка>`. Среды
 * `test-71` и `test-72` создаются и удаляются прогоном; чужие среды не трогает.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kitArg = process.argv.indexOf('--kit');
const KIT = kitArg > 0 ? process.argv[kitArg + 1] : 'dev';
const A = 'test-71';
const B = 'test-72';
const ENVS = process.env.FIFTH_ENVS_DIR || join(ROOT, '.local', 'envs');
const SET = join(ROOT, 'fixtures', 'env', 'smoke-v1.sql');
const dockerEnv = { ...process.env, MSYS_NO_PATHCONV: '1' };

let passed = 0;
let failed = 0;
const check = (name, ok, details = '') => {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details ? ` — ${details}` : ''}`);
};

function env(...args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'env.mjs'), ...args], {
    encoding: 'utf8',
    env: dockerEnv,
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout.trim().split('\n').pop());
  } catch {
    /* вывод не разобран — ниже проверка покажет */
  }
  return { code: r.status, json, out: `${r.stdout}${r.stderr}`.trim() };
}

function docker(...args) {
  const r = spawnSync('docker', args, { encoding: 'utf8', env: dockerEnv });
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() };
}

const psql = (id, sql) =>
  docker(
    'exec',
    `fifth-${id}-postgres`,
    'sh',
    '-c',
    `PGPASSWORD="$(cat /run/secrets/POSTGRES_PASSWORD)" psql -h 127.0.0.1 -U fifth_owner -d fifth_element -Atc "${sql}"`,
  ).out;
const flagCount = (id) =>
  psql(id, "select count(*) from audit.feature_flags where key = 'env-smoke-v1'");

/** Запись и чтение клиентом ядра: ключ S3 — из файла секрета. */
const CORE_S3 = `
const { getEnv } = require('/app/apps/core/dist/config/env.js');
const s3 = require('/app/apps/core/dist/storage/s3.service.js');
(async () => {
  const env = getEnv();
  const body = Buffer.from('w09b ' + env.S3_BUCKET);
  await s3.putObject({ key: 'env-check/object', body, contentType: 'text/plain' });
  const got = await new s3.S3Service().getObject('env-check/object');
  console.log(JSON.stringify({
    bucket: env.S3_BUCKET,
    fromFile: require('node:fs').readFileSync(process.env.S3_SECRET_ACCESS_KEY_FILE, 'utf8').trim() === env.S3_SECRET_ACCESS_KEY,
    same: got?.body?.equals(body) ?? false,
  }));
})().catch((e) => { console.log(JSON.stringify({ error: e.message })); process.exit(1); });
`;

/** Чтение бакета соседа ключом своей среды. */
const FOREIGN_S3 = (bucket) => `
const { createHash, createHmac } = require('node:crypto');
const { getEnv } = require('/app/apps/core/dist/config/env.js');
const env = getEnv();
process.env.S3_BUCKET = ${JSON.stringify(bucket)};
const url = new URL(env.S3_ENDPOINT.replace(/\\/+$/, '') + '/' + ${JSON.stringify(bucket)} + '/env-check/object');
const now = new Date().toISOString().replace(/[-:]|\\.\\d{3}/g, '');
const day = now.slice(0, 8);
const hash = createHash('sha256').update('').digest('hex');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const hmac = (k, s) => createHmac('sha256', k).update(s).digest();
const canonical = ['GET', url.pathname, '', 'host:' + url.host, 'x-amz-content-sha256:' + hash, 'x-amz-date:' + now, '', 'host;x-amz-content-sha256;x-amz-date', hash].join('\\n');
const scope = day + '/' + env.S3_REGION + '/s3/aws4_request';
const toSign = ['AWS4-HMAC-SHA256', now, scope, sha(canonical)].join('\\n');
const key = hmac(hmac(hmac(hmac('AWS4' + env.S3_SECRET_ACCESS_KEY, day), env.S3_REGION), 's3'), 'aws4_request');
const signature = createHmac('sha256', key).update(toSign).digest('hex');
fetch(url, { headers: { host: url.host, 'x-amz-content-sha256': hash, 'x-amz-date': now,
  authorization: 'AWS4-HMAC-SHA256 Credential=' + env.S3_ACCESS_KEY_ID + '/' + scope + ', SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=' + signature } })
  .then((r) => console.log(r.status));
`;

const coreNode = (id, code) => docker('exec', `fifth-${id}-core`, 'node', '-e', code);
const restarts = (id) =>
  Number(docker('inspect', `fifth-${id}-core`, '--format', '{{.RestartCount}}').out);

async function waitFor(fn, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

function cleanup() {
  for (const id of [A, B]) {
    if (existsSync(join(ENVS, id, 'install.json'))) env('destroy', id, '--confirm', id);
  }
}

console.log('=== ДВЕ СРЕДЫ ИЗ ОДНИХ ОБРАЗОВ ===');
cleanup();
try {
  console.log('\n▸ Установка');
  const composeBefore = readFileSync(join(ROOT, 'infra', 'docker-compose.env.yml'));
  const ca = env('create', A, '--kit', KIT, '--web-port', '18171');
  check('среда A создана и готова', ca.code === 0 && ca.json?.ready === true, ca.out.slice(0, 160));
  const cb = env('create', B, '--kit', KIT, '--web-port', '18172');
  check('среда B создана и готова', cb.code === 0 && cb.json?.ready === true, cb.out.slice(0, 160));
  check(
    'Compose и скрипты не правились под вторую среду',
    composeBefore.equals(readFileSync(join(ROOT, 'infra', 'docker-compose.env.yml'))),
  );
  const again = env('create', A, '--kit', KIT, '--web-port', '18171');
  check('повторное создание отказано, код 2', again.code === 2, again.json?.error);

  const ia = JSON.parse(readFileSync(join(ENVS, A, 'install.json'), 'utf8'));
  const ib = JSON.parse(readFileSync(join(ENVS, B, 'install.json'), 'utf8'));
  check(
    'образы сред совпадают по дайджесту',
    JSON.stringify(ia.kit.images) === JSON.stringify(ib.kit.images),
  );
  check(
    'у установки записаны комплект и версия схемы',
    Boolean(ia.kit.images.core && ia.schema?.last),
    ia.schema?.last,
  );

  console.log('\n▸ Служебные проверки');
  const sa = env('status', A);
  check(
    '/live и /ready отвечают на служебном порту',
    sa.code === 0 && sa.json?.live === true && sa.json?.ready === true,
  );
  const web = JSON.parse(
    docker('exec', `fifth-${A}-web`, 'wget', '-qO-', 'http://127.0.0.1/v1/health').out,
  );
  check('ядро отвечает через статику своей среды', web.service === 'fifth-core');
  const inspect = docker('inspect', `fifth-${A}-core`, '--format', '{{.Config.Healthcheck.Test}}');
  check('проверка контейнера — /live, а не /v1/health', inspect.out.includes('core-health.mjs'));

  console.log('\n▸ Garage: секрет из файла, изоляция бакетов');
  const wa = JSON.parse(coreNode(A, CORE_S3).out.split('\n').pop());
  check(
    'запись и чтение через Garage клиентом ядра',
    wa.same === true && wa.bucket === `fifth-${A}`,
    JSON.stringify(wa),
  );
  check('ключ S3 пришёл из файла', wa.fromFile === true);
  const wb = JSON.parse(coreNode(B, CORE_S3).out.split('\n').pop());
  check('среда B пишет в свой бакет', wb.same === true && wb.bucket === `fifth-${B}`);
  const foreign = coreNode(B, FOREIGN_S3(`fifth-${A}`))
    .out.trim()
    .split('\n')
    .pop();
  check('ключ среды B не читает бакет среды A', foreign === '403', `HTTP ${foreign}`);
  const own = coreNode(A, FOREIGN_S3(`fifth-${A}`))
    .out.trim()
    .split('\n')
    .pop();
  check('тем же запросом свой бакет читается', own === '200', `HTTP ${own}`);

  console.log('\n▸ Секреты и данные');
  const mounts = docker('inspect', `fifth-${B}-core`, '--format', '{{json .Mounts}}').out;
  check(
    'среда B видит только свой каталог секретов',
    mounts.includes(`envs/${B}/secrets`) && !mounts.includes(`envs/${A}/`),
  );
  const pa = readFileSync(join(ENVS, A, 'secrets', 'POSTGRES_PASSWORD'));
  const pb = readFileSync(join(ENVS, B, 'secrets', 'POSTGRES_PASSWORD'));
  check('пароли сред различаются', !pa.equals(pb));
  const sd = env('seed', A, '--set', SET);
  check('тестовый набор загружен отдельным шагом', sd.code === 0, sd.json?.dataset?.name);
  check('набор есть в A и нет в B', flagCount(A) === '1' && flagCount(B) === '0');
  const ia2 = JSON.parse(readFileSync(join(ENVS, A, 'install.json'), 'utf8'));
  check('версия набора записана', /^[0-9a-f]{64}$/.test(ia2.dataset?.sha256 ?? ''));

  console.log('\n▸ Остановка и запуск');
  check('среда B остановлена', env('stop', B).code === 0);
  check('среда A при этом готова', env('status', A).code === 0);
  const st = env('status', B);
  check('статус остановленной среды — код 1', st.code === 1 && st.json?.ready === false);
  const up = env('start', B);
  check(
    'среда B снова запущена и готова',
    up.code === 0 && up.json?.ready === true,
    up.out.slice(0, 120),
  );

  console.log('\n▸ Готовность и живость');
  const before = restarts(A);
  docker('stop', `fifth-${A}-postgres`);
  const down = await waitFor(() => env('status', A).json?.ready === false, 30_000);
  const sdown = env('status', A);
  check(
    'база остановлена — /ready отказ, /live жив',
    down && sdown.json?.live === true && sdown.code === 1,
    JSON.stringify(sdown.json?.checks?.required ?? null),
  );
  await new Promise((r) => setTimeout(r, 20_000));
  check('исправный процесс не перезапущен', restarts(A) === before, `перезапусков ${restarts(A)}`);
  docker('start', `fifth-${A}-postgres`);
  check(
    'база вернулась — среда снова готова',
    await waitFor(() => env('status', A).code === 0, 60_000),
  );
  const pid = docker(
    'exec',
    `fifth-${A}-core`,
    'node',
    '-e',
    `const fs=require('fs');for(const p of fs.readdirSync('/proc').filter((d)=>/^\\d+$/.test(d)&&d!=='1')){try{if(fs.readFileSync('/proc/'+p+'/cmdline','utf8').startsWith('node\\0apps/core/dist/main.js')){process.kill(Number(p),'SIGSTOP');console.log(p)}}catch{}}`,
  );
  check('ядро заморожено', /^\d+/.test(pid.out), pid.out);
  check(
    'зависшее ядро перезапущено',
    await waitFor(() => restarts(A) > before, 90_000),
    `перезапусков ${restarts(A)}`,
  );
  check('после перезапуска среда готова', await waitFor(() => env('status', A).code === 0, 90_000));

  console.log('\n▸ Удаление и защита');
  const prod = env('destroy', 'prod', '--confirm', 'prod');
  check('удаление рабочей среды отказано, код 2', prod.code === 2, prod.json?.error);
  const noConfirm = env('destroy', B);
  check('удаление без подтверждения отказано, код 2', noConfirm.code === 2, noConfirm.json?.error);
  const wrong = env('destroy', B, '--confirm', A);
  check('чужое подтверждение отказано, код 2', wrong.code === 2);
  const del = env('destroy', B, '--confirm', B);
  check('среда B удалена', del.code === 0, del.out.slice(0, 140));
  check('тома B удалены', !docker('volume', 'ls', '-q').out.includes(`fifth-${B}_`));
  check('каталог B удалён', !existsSync(join(ENVS, B)));
  check('среда A не задета', env('status', A).code === 0 && flagCount(A) === '1');
  const objA = JSON.parse(coreNode(A, CORE_S3).out.split('\n').pop());
  check('файлы A не задеты', objA.same === true);
  const none = env('status', B);
  check('статус удалённой среды — код 2', none.code === 2, none.json?.error);
} finally {
  console.log('\n▸ Уборка');
  cleanup();
  check('среды прогона удалены', ![A, B].some((id) => existsSync(join(ENVS, id))));
}

console.log(`\nИТОГО: ${passed} пройдено, ${failed} провалено`);
process.exit(failed ? 1 : 0);
