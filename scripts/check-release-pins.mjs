#!/usr/bin/env node
/**
 * Узкая проверка закреплений комплектов (W09c): одна среда, три комплекта.
 *
 *   node scripts/check-release-pins.mjs [--from <метка образов>]
 *
 * Сценарии: сбой сверки после обновления, оборванное обновление, запись закреплений
 * под блокировкой. Очистка идёт с FIFTH_KIT_KEEP=1, чтобы хватало трёх комплектов.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fromArg = process.argv.indexOf('--from');
const FROM = fromArg > 0 ? process.argv[fromArg + 1] : 'dev';
const KITS = join(ROOT, '.local', 'check-release-pins-kits');
const ENVS = join(ROOT, '.local', 'envs');
const E = 'test-75';
const A = '2.1-b9101.1';
const C = '2.1-b9102.1';
const D = '2.1-b9103.1';
const F = '2.1-b9104.1';
const env0 = { ...process.env, MSYS_NO_PATHCONV: '1', FIFTH_KITS_DIR: KITS, FIFTH_KIT_KEEP: '1' };

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
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() };
}
const kit = (...a) => tool('kit.mjs', a);
const env = (...a) => tool('env.mjs', a);
const installArgs = (build, expect) => [
  'install',
  E,
  '--kit',
  build,
  '--expect',
  expect,
  '--actor',
  'прогон',
  '--approved-by',
  'прогон',
];
const install = (build, expect, extra) => tool('release.mjs', installArgs(build, expect), extra);
const pins = () => JSON.parse(readFileSync(join(KITS, 'pins', `${E}.json`), 'utf8'));
const hasKit = (build) => existsSync(join(KITS, build, 'kit.json'));
const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8', env: env0 }).stdout.trim();
const owner = (sql) =>
  docker(
    'exec',
    `fifth-${E}-postgres`,
    'sh',
    '-c',
    `PGPASSWORD="$(cat /run/secrets/POSTGRES_PASSWORD)" psql -h 127.0.0.1 -U fifth_owner -d fifth_element -Atc "${sql}"`,
  );

function cleanup() {
  if (existsSync(join(ENVS, E, 'install.json'))) env('destroy', E, '--confirm', E);
}

console.log('=== ЗАКРЕПЛЕНИЕ КОМПЛЕКТОВ ===');
rmSync(KITS, { recursive: true, force: true });
mkdirSync(KITS, { recursive: true });
cleanup();
try {
  const packed = kit('pack', '--build', A, '--from', FROM);
  if (packed.code !== 0) throw new Error(`комплект ${A}: ${packed.out}`);
  const created = env('create', E, '--kit', FROM, '--web-port', '18175');
  if (created.code !== 0) throw new Error(`среда: ${created.out.slice(0, 200)}`);
  const first = install(A, 'none');
  check('исходный комплект установлен', first.code === 0, first.out.slice(0, 100));

  // Образы в архиве сохранены с метками: без них после загрузки образ не найти.
  for (const c of ['core', 'web', 'postgres']) docker('rmi', `fifth/${c}:${A}`);
  const reload = kit('load', '--build', A);
  check(
    'метки образов восстанавливаются из архива',
    reload.code === 0 &&
      docker('image', 'inspect', `fifth/core:${A}`, '--format', '{{.Id}}') !== '',
    reload.out.slice(0, 90),
  );

  // Подмена: метки на месте, но core указывает на другой образ.
  const idOf = (ref) => docker('image', 'inspect', ref, '--format', '{{.Id}}');
  const realCore = idOf(`fifth/core:${A}`);
  docker('tag', `fifth/web:${A}`, `fifth/core:${A}`);
  check('контроль: метка core указывает на другой образ', idOf(`fifth/core:${A}`) !== realCore);
  const spoofed = kit('load', '--build', A);
  const ids = JSON.parse(readFileSync(join(KITS, A, 'local-images.json'), 'utf8'));
  check(
    'загрузка вернула образ комплекта, подмена не принята как эталон',
    spoofed.code === 0 && idOf(`fifth/core:${A}`) === realCore && ids.core === realCore,
    spoofed.out.slice(0, 90),
  );

  console.log('\n▸ Сбой сверки после обновления');
  check('следующий комплект скачан', kit('pack', '--build', C, '--from', FROM).code === 0);
  const bad = install(C, A, { FIFTH_TEST_VERIFY_FAIL: '1' });
  check('итоговая сверка не прошла, код 1', bad.code === 1, bad.out.slice(0, 100));
  check(
    'комплект из работающей среды закреплён как частичный',
    pins().partial?.includes(C) && pins().current === A && !pins().pending,
    JSON.stringify(pins()),
  );
  const pack = kit('pack', '--build', D, '--from', FROM);
  check('скачан следующий комплект', pack.code === 0);
  check('частичный комплект не удалён очисткой', hasKit(C) && hasKit(A));

  console.log('\n▸ Оборванное обновление');
  // Сбой до обновления не снимает частичное закрепление предыдущей попытки.
  const early = install(D, A, { FIFTH_TEST_CRASH: 'after-load' });
  check('выпуск оборван до обновления', early.code === 97);
  const earlyOp = owner("select id from ops.installations where status = 'running'");
  tool('release.mjs', ['recover', E, '--op', earlyOp, '--note', 'испытание']);
  check(
    'обрыв до обновления не закрепил новую сборку и не снял прежнюю',
    pins().partial?.includes(C) && !pins().partial?.includes(D),
    JSON.stringify(pins()),
  );
  const crash = install(D, A, { FIFTH_TEST_CRASH: 'during-update' });
  check('выпуск оборван на обновлении', crash.code === 96);
  const op = owner("select id from ops.installations where status = 'running'");

  console.log('\n▸ Закрытие операции под блокировкой');
  // Ошибка закрепления: комплекта нет на месте, операция должна остаться в работе.
  renameSync(join(KITS, D), join(KITS, `${D}.away`));
  const noPin = tool('release.mjs', ['recover', E, '--op', op, '--note', 'испытание']);
  renameSync(join(KITS, `${D}.away`), join(KITS, D));
  check(
    'ошибка закрепления оставила операцию заблокированной',
    noPin.code !== 0 &&
      owner(`select status from ops.installations where id = '${op}'`) === 'running',
    noPin.out.slice(0, 110),
  );
  const held = mkdtempSync(join(tmpdir(), 'fifth-hold-'));
  const closing = spawn(
    process.execPath,
    [join(ROOT, 'scripts', 'release.mjs'), 'recover', E, '--op', op, '--note', 'испытание'],
    { env: { ...env0, FIFTH_TEST_HOLD_RECOVER: held }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let closingEnded = false;
  let closingOut = '';
  closing.stdout.on('data', (d) => (closingOut += d));
  const closingDone = new Promise((ok) => closing.on('close', ok));
  closing.on('close', () => (closingEnded = true));
  const closingUntil = Date.now() + 120_000;
  while (!existsSync(join(held, 'reached')) && !closingEnded && Date.now() < closingUntil) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!existsSync(join(held, 'reached'))) {
    closing.kill();
    throw new Error(`recover не дошёл до точки ожидания: ${closingOut.slice(0, 160)}`);
  }
  const during = install(C, A, { FIFTH_TEST_CRASH: 'after-load' });
  check(
    'пока recover идёт, следующий выпуск отказан блокировкой, код 2',
    during.code === 2 && during.out.includes('уже идёт выпуск'),
    during.out.slice(0, 100),
  );
  writeFileSync(join(held, 'go'), '1');
  const closingCode = await closingDone;
  check('операция закрыта', closingCode === 0, closingOut.slice(0, 90));
  rmSync(held, { recursive: true, force: true });
  const afterRecover = install(C, A, { FIFTH_TEST_CRASH: 'after-load' });
  check(
    'после recover следующий выпуск проходит, его pending сохранён',
    afterRecover.code === 97 && pins().pending === C,
    JSON.stringify(pins()),
  );
  const nextOp = owner("select id from ops.installations where status = 'running'");
  tool('release.mjs', ['recover', E, '--op', nextOp, '--note', 'испытание']);
  check(
    'обе сборки закреплены: в среде может быть смесь образов',
    pins().partial?.includes(C) && pins().partial?.includes(D) && !pins().pending,
    JSON.stringify(pins()),
  );

  console.log('\n▸ Закрепления под блокировкой');
  const hold = mkdtempSync(join(tmpdir(), 'fifth-hold-'));
  const child = spawn(
    process.execPath,
    [join(ROOT, 'scripts', 'release.mjs'), ...installArgs(C, A)],
    {
      env: { ...env0, FIFTH_TEST_HOLD_CLOSE: hold },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let closed = false;
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const done = new Promise((ok) => child.on('close', ok));
  child.on('close', () => (closed = true));
  const until = Date.now() + 180_000;
  while (!existsSync(join(hold, 'reached')) && !closed && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!existsSync(join(hold, 'reached'))) {
    child.kill();
    throw new Error(`выпуск не дошёл до точки ожидания: ${out.slice(0, 160)}`);
  }
  check(
    'закрепления записаны, пока блокировка ещё наша',
    pins().current === C &&
      pins().rollback === A &&
      owner("select count(*) from ops.installations where status = 'running'") === '1',
    JSON.stringify(pins()),
  );
  const second = install(D, A);
  check(
    'следующий выпуск отказан блокировкой, код 2',
    second.code === 2 && second.out.includes('уже идёт выпуск'),
    second.out.slice(0, 100),
  );
  writeFileSync(join(hold, 'go'), '1');
  const code = await done;
  check(
    'успех снял частичное закрепление',
    code === 0 && !pins().partial && pins().current === C,
    JSON.stringify(pins()),
  );
  rmSync(hold, { recursive: true, force: true });
  const next = kit('pack', '--build', F, '--from', FROM);
  check('снятый комплект больше не держится очисткой', next.code === 0 && !hasKit(D));
} finally {
  console.log('\n▸ Уборка');
  cleanup();
  for (const t of ['core', 'web', 'postgres']) {
    for (const tag of [A, C, D, F]) docker('rmi', `fifth/${t}:${tag}`);
  }
  rmSync(KITS, { recursive: true, force: true });
}

console.log(`\nИТОГО: ${passed} пройдено, ${failed} провалено`);
process.exit(failed ? 1 : 0);
