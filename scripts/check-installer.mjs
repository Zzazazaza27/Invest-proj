#!/usr/bin/env node
/**
 * Границы защищённого установщика на искусственной среде test-76.
 *
 *   node scripts/check-installer.mjs [--from <метка образов>]
 *
 * Настоящие `install-ci.mjs`, `release.mjs` и Docker, ключ подписи создаётся прогоном. Проверяет:
 * каждый отказ случается до изменений, удачный выпуск меняет только core и web, сбой приводит к
 * одному возврату, отказ возврата останавливает работу. Обёртку и SSH здесь не проверить: они
 * живут на узле. Комплекты и среда создаются и удаляются прогоном.
 */
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
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
import { classProblems, compareBuilds } from './lib/install-policy.mjs';
import { signKit } from './lib/kit-sign.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fromArg = process.argv.indexOf('--from');
const FROM = fromArg > 0 ? process.argv[fromArg + 1] : 'dev';
const WORK = join(ROOT, '.local', 'check-installer');
const KITS = join(WORK, 'kits');
const ETC = join(WORK, 'etc');
const PROBE = join(WORK, 'probe.json');
const ENV = 'test-76';
const K0 = '2.1-b9100.1';
const K1 = '2.1-b9101.1';
const K2 = '2.1-b9102.1';
const K3 = '2.1-b9103.1';
const TOKEN = 'check-installer-token-value';
const env0 = {
  ...process.env,
  MSYS_NO_PATHCONV: '1',
  FIFTH_KITS_DIR: KITS,
  FIFTH_INSTALL_ETC: ETC,
  FIFTH_INSTALL_TMP: WORK,
};

let passed = 0;
let failed = 0;
const check = (name, ok, details = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(
    `  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details ? ` — ${String(details).slice(0, 220)}` : ''}`,
  );
};

function tool(script, args, extra = {}, input) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
    encoding: 'utf8',
    env: { ...env0, ...extra },
    input,
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout.trim().split('\n').pop());
  } catch {
    /* проверка покажет */
  }
  return { code: r.status, json, out: `${r.stdout}${r.stderr}`.trim() };
}
const docker = (...a) => {
  const r = spawnSync('docker', a, { encoding: 'utf8', env: env0 });
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() };
};
const owner = (sql) =>
  docker(
    'exec',
    `fifth-${ENV}-postgres`,
    'sh',
    '-c',
    `PGPASSWORD="$(cat /run/secrets/POSTGRES_PASSWORD)" psql -h 127.0.0.1 -U fifth_owner -d fifth_element -Atc "${sql}"`,
  ).out;
const imageOf = (c) => docker('inspect', `fifth-${ENV}-${c}`, '--format', '{{.Image}}').out;
const startedOf = (c) =>
  docker('inspect', `fifth-${ENV}-${c}`, '--format', '{{.State.StartedAt}}').out;

const pair = () => generateKeyPairSync('ed25519');
const pem = (key) => key.export({ type: key.type === 'public' ? 'spki' : 'pkcs8', format: 'pem' });
const trusted = pair();
const stranger = pair();

const kitDir = (build) => join(KITS, build);
const readKit = (build) => JSON.parse(readFileSync(join(kitDir(build), 'kit.json'), 'utf8'));

function request(build, expect, { key = trusted.privateKey, change, tamper, asBuild } = {}) {
  const kit = readKit(build);
  if (change) change(kit);
  const bytes = Buffer.from(JSON.stringify(kit));
  const signature = signKit(bytes, pem(key));
  const b64 = (path) => readFileSync(path).toString('base64');
  const files = {
    'kit.json': (tamper ? Buffer.from(`${bytes} `) : bytes).toString('base64'),
    'compose.yml': b64(join(kitDir(build), 'compose.yml')),
  };
  for (const name of readdirSync(join(kitDir(build), 'prod-compose'))) {
    files[`prod-compose/${name}`] = b64(join(kitDir(build), 'prod-compose', name));
  }
  return JSON.stringify({ build: asBuild ?? build, expect, token: TOKEN, signature, files });
}
const installer = (input, extra) => tool('install-ci.mjs', [], extra, input);

function setPolicy(change = {}) {
  writeFileSync(
    join(ETC, 'policy.json'),
    JSON.stringify({
      env: ENV,
      approvedBy: 'прогон',
      rollbackFloor: K0,
      postgresSource: readKit(K0).postgresSource,
      launchFiles: {},
      watchSeconds: 6,
      probeFile: PROBE,
      siteUrl: null,
      ...change,
    }),
  );
}
/** Свежая отметка контрольного входа: время в будущем, файл считается новым весь прогон. */
function setProbe(ok) {
  writeFileSync(PROBE, JSON.stringify({ ok }));
  const future = new Date(Date.now() + 3_600_000);
  utimesSync(PROBE, future, future);
}
function refusal(name, input, word, extra) {
  const core = imageOf('core');
  const r = installer(input, extra);
  check(
    name,
    r.code === 2 && r.json?.error?.includes(word) && imageOf('core') === core,
    r.json?.error ?? r.out,
  );
  return r;
}
function packFrom(build, label, previous) {
  const dockerfile = join(WORK, 'Dockerfile');
  writeFileSync(dockerfile, `FROM fifth/core:${FROM}\nLABEL fifth.check=${label}\n`);
  docker('build', '-q', '-t', `fifth/core:${label}`, '-f', dockerfile, WORK);
  docker('tag', `fifth/web:${FROM}`, `fifth/web:${label}`);
  docker('tag', `fifth/postgres:${FROM}`, `fifth/postgres:${label}`);
  return tool('kit.mjs', ['pack', '--build', build, '--from', label, '--previous', previous]);
}
function cleanup() {
  if (existsSync(join(ROOT, '.local', 'envs', ENV, 'install.json'))) {
    tool('env.mjs', ['destroy', ENV, '--confirm', ENV]);
  }
  // Образы прогона весят гигабайты, на машине их не оставляем.
  for (const label of ['inst1', 'inst2', 'inst3', K0, K1, K2, K3]) {
    docker('rmi', '-f', `fifth/core:${label}`, `fifth/web:${label}`, `fifth/postgres:${label}`);
  }
}

console.log('=== ЗАЩИЩЁННЫЙ УСТАНОВЩИК ===');
/*
 * Ранний отказ на неподходящих образах (W31, Тэнк 10.11): до уборки и создания среды.
 * Комплект собирается из миграций репозитория, а схему ставит образ ядра --from. Если в
 * образе другой набор миграций (обычно — старый `dev`), прогон раньше доходил до сверки и
 * падал 18 пунктами. Теперь — сразу, с несовпадением. Другая сборка сама не подтягивается.
 */
{
  const inRepo = readdirSync(join(ROOT, 'database', 'migrations'))
    .filter((f) => /^M\d+_.*\.sql$/.test(f))
    .sort();
  const ls = docker(
    'run',
    '--rm',
    '--pull',
    'never',
    '--entrypoint',
    'sh',
    `fifth/core:${FROM}`,
    '-c',
    'ls /app/database/migrations',
  );
  if (ls.code !== 0) {
    console.error(`образ fifth/core:${FROM} недоступен: ${ls.out.split('\n').pop()}`);
    console.error('Укажи существующие образы: --from <метка>. Прогон сам их не скачивает.');
    process.exit(2);
  }
  const inImage = ls.out
    .split('\n')
    .map((s) => s.trim())
    .filter((f) => /^M\d+_.*\.sql$/.test(f))
    .sort();
  const missing = inRepo.filter((f) => !inImage.includes(f));
  const extra = inImage.filter((f) => !inRepo.includes(f));
  if (missing.length || extra.length) {
    const span = (a) => (a.length > 3 ? `${a[0]} … ${a.at(-1)} (${a.length})` : a.join(', '));
    console.error(`\nобраз fifth/core:${FROM} не подходит к репозиторию — среда не тронута:`);
    if (missing.length) console.error(`  нет в образе: ${span(missing)}`);
    if (extra.length) console.error(`  лишние в образе: ${span(extra)}`);
    console.error(
      `  в образе до ${inImage.at(-1) ?? '—'}, в репозитории до ${inRepo.at(-1)}. ` +
        'Собери образы текущего кода и укажи их метку: --from <метка>. ' +
        'Другая сборка автоматически не подтягивается.',
    );
    process.exit(2);
  }
  console.log(`  образы fifth/*:${FROM}: миграции совпадают с репозиторием (${inRepo.length})`);
}

cleanup();
rmSync(WORK, { recursive: true, force: true });
mkdirSync(KITS, { recursive: true });
mkdirSync(ETC, { recursive: true });
writeFileSync(join(ETC, 'kit-signing.pub'), pem(trusted.publicKey));
try {
  console.log('\n▸ Порядок сборок');
  check('новая старше прежней', compareBuilds('2.1-b10.1', '2.1-b9.1') > 0);
  check('неверный номер не сравнивается', compareBuilds('2.1', '2.1-b9.1') === null);
  const base = { build: '2.1-b2.1', migrations: [], settingsVersion: 1, postgresSource: 'p' };
  const clean = classProblems({
    kit: base,
    installed: { ...base, build: '2.1-b1.1' },
    applied: [],
    policy: { rollbackFloor: '2.1-b1.1', postgresSource: 'p', launchFiles: {} },
    launch: {},
  });
  check('совпадающая сборка в классе', clean.length === 0, clean.join('; '));

  console.log('\n▸ Среда и прежняя сборка');
  const p0 = tool('kit.mjs', ['pack', '--build', K0, '--from', FROM]);
  check('комплект 0', p0.code === 0, p0.out.slice(0, 120));
  check('в манифесте хеш исходников базы', /^[0-9a-f]{64}$/.test(readKit(K0).postgresSource ?? ''));
  const created = tool('env.mjs', ['create', ENV, '--kit', FROM, '--web-port', '18176']);
  check('среда создана', created.code === 0, created.out.slice(0, 120));
  const i0 = tool('release.mjs', [
    'install',
    ENV,
    '--kit',
    K0,
    '--expect',
    'none',
    '--actor',
    'прогон',
    '--approved-by',
    'прогон',
  ]);
  check('прежняя сборка установлена обычным выпуском', i0.code === 0, i0.out.slice(0, 160));
  const p1 = packFrom(K1, 'inst1', K0);
  check('комплект 1', p1.code === 0, p1.out.slice(0, 120));
  setPolicy();
  setProbe(true);

  console.log('\n▸ Отказы до изменений');
  refusal('чужая подпись', request(K1, K0, { key: stranger.privateKey }), 'подпись');
  refusal('манифест изменён после подписи', request(K1, K0, { tamper: true }), 'подпись');
  refusal('разбитый запрос', '{', 'не разобран');
  refusal('сборка запроса не из манифеста', request(K1, K0, { asBuild: K2 }), 'не совпала');
  refusal('устаревшее задание: другая ожидаемая сборка', request(K1, K1), 'ожидалась');
  refusal('та же сборка', request(K0, K0), 'не новее');
  refusal(
    'новая миграция',
    request(K1, K0, {
      change: (k) => k.migrations.push({ id: 'M999_probe', sha256: '0'.repeat(64) }),
    }),
    'неприменённые миграции',
  );
  refusal(
    'изменённая миграция',
    request(K1, K0, {
      change: (k) => {
        k.migrations[0].sha256 = '0'.repeat(64);
      },
    }),
    'изменённые миграции',
  );
  refusal(
    'схема новее комплекта',
    request(K1, K0, { change: (k) => k.migrations.pop() }),
    'схема новее',
  );
  refusal(
    'другой файл запуска',
    request(K1, K0, {
      change: (k) => {
        k.compose.sha256 = '0'.repeat(64);
      },
    }),
    'другой файл запуска',
  );
  refusal(
    'другие файлы рабочей среды',
    request(K1, K0, {
      change: (k) => {
        k.prodCompose['infra/docker-compose.yml'] = '0'.repeat(64);
      },
    }),
    'файлы рабочей среды',
  );
  refusal(
    'другой образ базы',
    request(K1, K0, {
      change: (k) => {
        k.postgresSource = '0'.repeat(64);
      },
    }),
    'образ базы',
  );
  refusal(
    'другая версия настроек',
    request(K1, K0, {
      change: (k) => {
        k.settingsVersion = 2;
      },
    }),
    'версия настроек',
  );
  setPolicy({ rollbackFloor: K1 });
  refusal('текущая сборка ниже порога возврата', request(K1, K0), 'порога возврата');
  setPolicy();
  owner(
    `INSERT INTO ops.installations (id, env, build, commit_sha, kit_sha256, expected_build, actor, approved_by, kind) VALUES ('00000000-0000-4000-8000-000000000076', '${ENV}', '${K1}', 'x', 'x', '${K0}', 'x', 'x', 'install')`,
  );
  refusal('параллельный выпуск', request(K1, K0), 'идёт выпуск');
  owner(`DELETE FROM ops.installations WHERE id = '00000000-0000-4000-8000-000000000076'`);

  console.log('\n▸ Удачный выпуск');
  const before = {
    core: imageOf('core'),
    postgres: imageOf('postgres'),
    started: startedOf('postgres'),
    migrations: owner('select count(*) from public.schema_migrations'),
  };
  const good = installer(request(K1, K0));
  check('выпуск прошёл', good.code === 0 && good.json?.ok === true, good.out.slice(-200));
  check('токен не попал в вывод', !good.out.includes(TOKEN));
  check('ядро на новом образе', imageOf('core') !== before.core);
  check(
    'база не перезапускалась, образ прежний',
    imageOf('postgres') === before.postgres && startedOf('postgres') === before.started,
  );
  check(
    'миграции не менялись',
    owner('select count(*) from public.schema_migrations') === before.migrations,
  );
  const v = tool('release.mjs', ['verify', ENV]);
  check('сверка после выпуска', v.code === 0, v.out.slice(0, 160));
  const moved = imageOf('core');

  console.log('\n▸ Сбой после выпуска и один возврат');
  const p2 = packFrom(K2, 'inst2', K1);
  check('комплект 2', p2.code === 0, p2.out.slice(0, 120));
  setProbe(false);
  const running = spawn(process.execPath, [join(ROOT, 'scripts', 'install-ci.mjs')], {
    env: env0,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let output = '';
  running.stdout.on('data', (chunk) => (output += chunk));
  running.stdin.end(request(K2, K1));
  const exited = new Promise((done) => running.on('exit', done));
  // Контрольный вход чинится, как только начался возврат.
  let returning = false;
  const healer = setInterval(() => {
    if (returning) return;
    if (owner(`select count(*) from ops.installations where kind = 'rollback'`) !== '0') {
      returning = true;
      setProbe(true);
    }
  }, 2000);
  const code = await exited;
  clearInterval(healer);
  const result = JSON.parse(output.trim().split('\n').pop());
  check(
    'выпуск не удался, возврат прошёл',
    code === 1 && result.returned === true,
    output.slice(-200),
  );
  check('ядро вернулось на прежнюю сборку', imageOf('core') === moved);
  check(
    'в реестре один возврат',
    owner(`select count(*) from ops.installations where kind = 'rollback'`) === '1',
  );
  const v2 = tool('release.mjs', ['verify', ENV]);
  check('сверка после возврата', v2.code === 0 && v2.json?.build === K1, v2.out.slice(0, 160));

  console.log('\n▸ Сбой самого возврата');
  const p3 = packFrom(K3, 'inst3', K1);
  check('комплект 3', p3.code === 0, p3.out.slice(0, 120));
  const stop = installer(request(K3, K1), { FIFTH_TEST_VERIFY_FAIL: '1' });
  check(
    'остановка, нужен человек',
    stop.code === 3 && stop.json?.stopped === true,
    stop.out.slice(-200),
  );
  check(
    'повторных возвратов нет',
    owner(`select count(*) from ops.installations where kind = 'rollback'`) === '2',
  );
} catch (error) {
  check('прогон оборван', false, error.stack);
} finally {
  cleanup();
  rmSync(WORK, { recursive: true, force: true });
}
console.log(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===`);
process.exit(failed ? 1 : 0);
