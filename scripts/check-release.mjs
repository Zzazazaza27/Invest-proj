#!/usr/bin/env node
/**
 * Комплект, блокировка выпуска, реестр установок и сверка версий (W09c).
 *
 *   node scripts/check-release.mjs [--from <метка образов>]
 *
 * Два комплекта из локальных образов (второй отличается меткой), среды test-73 и
 * test-74. Комплекты и среды создаются и удаляются прогоном.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fromArg = process.argv.indexOf('--from');
const FROM = fromArg > 0 ? process.argv[fromArg + 1] : 'dev';
const KITS = mkdtempSync(join(tmpdir(), 'fifth-kits-'));
const ENVS = join(ROOT, '.local', 'envs');
const A = 'test-73';
const B = 'test-74';
const K1 = '2.1-b9001.1';
const K2 = '2.1-b9002.1';
const K3 = '2.1-b9002.2';
const env0 = { ...process.env, MSYS_NO_PATHCONV: '1', FIFTH_KITS_DIR: KITS };

let passed = 0;
let failed = 0;
const check = (name, ok, details = '') => {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details ? ` — ${details}` : ''}`);
};

function tool(script, args, extra = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
    encoding: 'utf8',
    env: { ...env0, ...extra },
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout.trim().split('\n').pop());
  } catch {
    /* вывод не разобран — проверка покажет */
  }
  return { code: r.status, json, out: `${r.stdout}${r.stderr}`.trim() };
}
const kit = (...a) => tool('kit.mjs', a);
const env = (...a) => tool('env.mjs', a);
const release = (a, extra) => tool('release.mjs', a, extra);
const docker = (...a) => {
  const r = spawnSync('docker', a, { encoding: 'utf8', env: env0 });
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() };
};
const install = (id, build, expect, ...rest) =>
  release([
    'install',
    id,
    '--kit',
    build,
    '--expect',
    expect,
    '--actor',
    'прогон',
    '--approved-by',
    'прогон',
    ...rest,
  ]);
const owner = (id, sql) =>
  docker(
    'exec',
    `fifth-${id}-postgres`,
    'sh',
    '-c',
    `PGPASSWORD="$(cat /run/secrets/POSTGRES_PASSWORD)" psql -h 127.0.0.1 -U fifth_owner -d fifth_element -Atc "${sql}"`,
  ).out;

function cleanup() {
  for (const id of [A, B]) {
    if (existsSync(join(ENVS, id, 'install.json'))) env('destroy', id, '--confirm', id);
  }
}

console.log('=== КОМПЛЕКТ, БЛОКИРОВКА, РЕЕСТР ===');
cleanup();
try {
  console.log('\n▸ Комплект');
  docker('tag', `fifth/web:${FROM}`, 'fifth/web:rel2');
  docker('tag', `fifth/postgres:${FROM}`, 'fifth/postgres:rel2');
  const dockerfile = join(KITS, 'Dockerfile');
  writeFileSync(dockerfile, `FROM fifth/core:${FROM}\nLABEL fifth.check=rel2\n`);
  docker('build', '-q', '-t', 'fifth/core:rel2', '-f', dockerfile, KITS);
  const p1 = kit('pack', '--build', K1, '--from', FROM);
  check('комплект 1 собран из образов без пересборки', p1.code === 0, p1.out.slice(0, 120));
  const p2 = kit('pack', '--build', K2, '--from', 'rel2', '--previous', K1);
  check('комплект 2 собран', p2.code === 0);
  const again = kit('pack', '--build', K2, '--from', FROM);
  check('занятый номер не заменяется, код 2', again.code === 2, again.json?.error);
  const k = JSON.parse(readFileSync(join(KITS, K2, 'kit.json'), 'utf8'));
  check(
    'манифест: коммит, образы, миграции, Compose, прежняя версия',
    Boolean(k.commit && k.images.core.imageId && k.migrations.length && k.compose.sha256) &&
      k.previous === K1,
    `миграций ${k.migrations.length}`,
  );
  check('в манифесте нет секретов', !/PASSWORD|SECRET/.test(JSON.stringify(k)));
  const retry = kit('pack', '--build', K3, '--from', FROM);
  check('повторная попытка сборки — новый номер', retry.code === 0);
  check(
    'хранятся текущий и предыдущий комплекты',
    !existsSync(join(KITS, K1)) && existsSync(join(KITS, K2)) && existsSync(join(KITS, K3)),
  );
  // Возвращаем в хранилище нужные для испытаний комплекты.
  rmSync(join(KITS, K3), { recursive: true, force: true });
  const p1b = kit('pack', '--build', K1, '--from', FROM);
  check('комплект 1 снова в хранилище', p1b.code === 0, p1b.out.slice(0, 100));
  const tarFile = join(KITS, K1, 'images.tar');
  const tar = readFileSync(tarFile);
  writeFileSync(
    tarFile,
    Buffer.concat([tar.subarray(0, 4096), Buffer.from('x'), tar.subarray(4097)]),
  );
  const bad = kit('check', '--build', K1);
  check('порча копии образов обнаружена', bad.code === 1, bad.json?.error);
  writeFileSync(tarFile, tar);
  check('целая копия проходит проверку', kit('check', '--build', K1).code === 0);

  console.log('\n▸ Установка и реестр');
  const ca = env('create', A, '--kit', FROM, '--web-port', '18173');
  check('среда A создана', ca.code === 0, ca.out.slice(0, 120));
  const cb = env('create', B, '--kit', FROM, '--web-port', '18174');
  check('среда B создана', cb.code === 0, cb.out.slice(0, 120));
  const i1 = install(A, K1, 'none');
  check(
    'выпуск 1 подтверждён фактической сверкой',
    i1.code === 0 && i1.json?.confirmed === 3 && i1.json?.total === 3,
    i1.out.slice(0, 160),
  );
  const i1b = install(B, K1, 'none');
  check('тот же комплект в другую среду без пересборки', i1b.code === 0, i1b.out.slice(0, 120));
  check(
    'образ ядра в средах один',
    docker('inspect', `fifth-${A}-core`, '--format', '{{.Image}}').out ===
      docker('inspect', `fifth-${B}-core`, '--format', '{{.Image}}').out,
  );
  check(
    'реестр: установка, цели, этапы',
    owner(A, 'select status, build from ops.installations') === `succeeded|${K1}` &&
      owner(A, 'select count(*) from ops.installation_targets') === '3' &&
      Number(owner(A, 'select count(*) from ops.installation_events')) >= 4,
  );
  const v1 = release(['verify', A]);
  check(
    'сверка: 3 из 3, готовность и миграции',
    v1.code === 0 && v1.json?.confirmed === 3,
    v1.out.slice(0, 160),
  );

  console.log('\n▸ Привязка к текущей версии');
  const wrong = install(A, K2, 'none');
  check('неверная ожидаемая сборка — отказ, код 2', wrong.code === 2, wrong.json?.error);
  const i2 = install(A, K2, K1);
  check('выпуск 2 от ожидаемой сборки', i2.code === 0, i2.out.slice(0, 120));
  const stale = install(A, K1, K2);
  check('устаревшая сборка без --rollback отказана', stale.code === 2, stale.json?.error);

  console.log('\n▸ Подмена версии видна в сверке');
  const core = docker('inspect', `fifth-${A}-core`, '--format', '{{.Image}}').out;
  const composeEnv = join(ENVS, A, 'compose.env');
  const envText = readFileSync(composeEnv, 'utf8');
  writeFileSync(
    composeEnv,
    envText.replace(/^FIFTH_CORE_IMAGE=.*$/m, `FIFTH_CORE_IMAGE=fifth/core:${FROM}`),
  );
  docker(
    'compose',
    '--env-file',
    composeEnv,
    '-f',
    join(ROOT, 'infra', 'docker-compose.env.yml'),
    'up',
    '-d',
    'core',
  );
  const v2 = release(['verify', A]);
  check(
    'посторонний образ — сверка красная, экземпляр назван',
    v2.code === 1 && v2.json?.differ?.includes(`${A}/local/core`),
    `${v2.json?.confirmed} из ${v2.json?.total}, было ${core.slice(7, 19)}`,
  );
  writeFileSync(composeEnv, envText);
  docker(
    'compose',
    '--env-file',
    composeEnv,
    '-f',
    join(ROOT, 'infra', 'docker-compose.env.yml'),
    'up',
    '-d',
    'core',
  );

  console.log('\n▸ Блокировка');
  const crash = install.call(null, B, K2, K1);
  check('контроль: среда B переведена', crash.code === 0, crash.out.slice(0, 100));
  const broken = release(
    [
      'install',
      B,
      '--kit',
      K1,
      '--expect',
      K2,
      '--actor',
      'прогон',
      '--approved-by',
      'прогон',
      '--rollback',
    ],
    { FIFTH_TEST_CRASH: 'after-load' },
  );
  check('выпуск оборван после загрузки', broken.code === 97);
  const running = owner(B, "select id from ops.installations where status = 'running'");
  check('блокировка осталась за оборванной операцией', /^[0-9a-f-]{36}$/.test(running), running);
  const second = install(B, K1, K2, '--rollback');
  check('второй выпуск отказан, код 2', second.code === 2, second.json?.error);
  const journal = readFileSync(join(ENVS, B, 'release-journal.jsonl'), 'utf8');
  check(
    'журнал хранит этапы оборванной операции',
    journal.includes(running) && journal.includes('"load"'),
  );
  const noNote = release(['recover', B, '--op', running]);
  check('закрытие без причины отказано', noNote.code === 2);
  const rec = release(['recover', B, '--op', running, '--note', 'испытание обрыва']);
  check(
    'операция закрыта явно, этап назван',
    rec.code === 0 && rec.json?.lastStage === 'load',
    rec.out.slice(0, 120),
  );
  const back = install(B, K1, K2, '--rollback');
  check('после закрытия откат проходит', back.code === 0, back.out.slice(0, 120));
  check(
    'откат записан отдельным видом',
    owner(
      B,
      "select count(*) from ops.installations where kind = 'rollback' and status = 'succeeded'",
    ) === '1',
  );

  console.log('\n▸ Недоступная база');
  docker('stop', `fifth-${A}-postgres`);
  const noDb = install(A, K1, K2, '--rollback');
  check(
    'без подтверждённой блокировки выпуск не начат, код 2',
    noDb.code === 2 && /блокировка не подтверждена/.test(noDb.json?.error ?? ''),
    noDb.json?.error?.slice(0, 90),
  );
  check(
    'образ ядра не менялся',
    docker('inspect', `fifth-${A}-core`, '--format', '{{.Image}}').out === core,
  );
  docker('start', `fifth-${A}-postgres`);
  await new Promise((r) => setTimeout(r, 6000));

  console.log('\n▸ Доставка записей из журнала');
  const op = owner(A, 'select id from ops.installations order by started_at desc limit 1');
  const eventId = '00000000-0000-4000-8000-000000000001';
  const line = JSON.stringify({
    id: eventId,
    op,
    at: new Date().toISOString(),
    stage: 'late',
    result: 'ok',
    detail: 'записано при недоступной базе',
  });
  writeFileSync(
    join(ENVS, A, 'release-journal.jsonl'),
    `${readFileSync(join(ENVS, A, 'release-journal.jsonl'), 'utf8')}${line}\n`,
  );
  const r1 = release(['replay', A]);
  check('запись из журнала доставлена', r1.code === 0 && r1.json?.sent === 1, r1.out.slice(0, 120));
  const r2 = release(['replay', A]);
  check(
    'повторная доставка без дублей',
    r2.code === 0 && r2.json?.sent === 0,
    r2.out.slice(0, 120),
  );

  console.log('\n▸ Права');
  const asRelease = (sql) =>
    docker(
      'exec',
      `fifth-${A}-postgres`,
      'sh',
      '-c',
      `psql "$(cat /run/secrets/DATABASE_URL_APP_RELEASE)" -Atc "${sql}"`,
    );
  check(
    'роль выпуска читает реестр',
    asRelease('select count(*) from ops.installations').code === 0,
  );
  check(
    'роль выпуска не видит прикладные данные',
    asRelease('select count(*) from identity.users').code !== 0,
  );
  check(
    'этапы не правятся',
    asRelease("update ops.installation_events set result = 'x'").code !== 0,
  );
  const asCore = docker(
    'exec',
    `fifth-${A}-postgres`,
    'sh',
    '-c',
    `psql "$(cat /run/secrets/DATABASE_URL)" -Atc "insert into ops.instances values ('x','x','x',null,'x',null,now(),'x')"`,
  );
  check('ядро реестр не пишет', asCore.code !== 0);
} finally {
  console.log('\n▸ Уборка');
  cleanup();
  for (const t of ['core', 'web', 'postgres']) {
    for (const tag of ['rel2', K1, K2, K3]) docker('rmi', `fifth/${t}:${tag}`);
  }
  rmSync(KITS, { recursive: true, force: true });
  check('среды прогона удалены', ![A, B].some((id) => existsSync(join(ENVS, id))));
}

console.log(`\nИТОГО: ${passed} пройдено, ${failed} провалено`);
process.exit(failed ? 1 : 0);
