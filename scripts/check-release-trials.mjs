#!/usr/bin/env node
/**
 * Сквозные испытания выпуска (блок 09, задание 4; уточнения Тэнка 09.11) — через настоящий
 * `release.mjs install` на временной среде test-79 со слотами.
 *
 *   node scripts/check-release-trials.mjs [--keep]
 *
 * Комплекты — из снимка кода (git archive) с пробными миграциями, только для испытания:
 *   2.1-b9201.1  исходный;
 *   2.1-b9202.1  + M900 — расширение: таблица public.compat_probe (note, legacy);
 *   2.1-b9203.1  + M901 — contract: DROP COLUMN legacy;
 *   2.1-b9204.1  + M902 — обычная миграция (исправление вперёд).
 *
 *  [1] успешный выпуск 9201 → 9202 через слоты: протокол, вывод наблюдения ok;
 *  [2] возврат с новыми данными: кандидат пишет запись в новую таблицу; возврат 9202 → 9201
 *      по подписанному отчёту; прежний код работает, запись цела; снова 9202 — кандидат
 *      читает её. Отчёт совместимости подписан тестовым ключом в самом испытании (прогон
 *      совместимости испытан отдельно — check-migration-compat), здесь — механика установщика;
 *  [3] contract: 9203 без --allow-contract — отказ; с ним — порядок с остановкой; возврат на
 *      9202 запрещён; исправление вперёд 9204 проходит.
 */
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  appendFileSync,
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
import { signCompat } from './lib/kit-sign.mjs';
import { s3Object } from './lib/s3.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV = 'test-79';
const PORT = 18179;
const BASE = `http://127.0.0.1:${PORT}`;
const KITS = join(ROOT, '.local', 'check-trials-kits');
const ETC = join(ROOT, '.local', 'check-trials-etc');
const B = (n) => `2.1-b92${String(n).padStart(2, '0')}.1`;
const dockerEnv = {
  ...process.env,
  MSYS_NO_PATHCONV: '1',
  FIFTH_KITS_DIR: KITS,
  FIFTH_INSTALL_ETC: ETC,
};

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.warn(
    `  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ''}`,
  );
};
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...dockerEnv, ...opts.env },
    cwd: opts.cwd ?? ROOT,
    timeout: 3_600_000,
  });
const tool = (script, args, opts = {}) => {
  const r = run(process.execPath, [join(opts.root ?? ROOT, 'scripts', script), ...args], opts);
  let json = null;
  try {
    json = JSON.parse(
      r.stdout
        .trim()
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .pop(),
    );
  } catch {
    /* проверка покажет */
  }
  return { code: r.status, json, out: `${r.stdout}${r.stderr}`.trim() };
};
const install = (build, expect, ...rest) =>
  tool('release.mjs', [
    'install',
    ENV,
    '--kit',
    build,
    '--expect',
    expect,
    '--actor',
    'испытание',
    '--approved-by',
    'испытание',
    '--observe-ms',
    '15000',
    '--drain-ms',
    '30000',
    ...rest,
  ]);
const psql = (sql) =>
  run('docker', [
    'exec',
    `fifth-${ENV}-postgres`,
    'sh',
    '-c',
    `PGPASSWORD="$(cat /run/secrets/POSTGRES_PASSWORD)" psql -h 127.0.0.1 -U fifth_owner -d fifth_element -Atc "$0"`,
    sql,
  ]).stdout.trim();
const via = async (path = '/v1/features', init = {}) => {
  const r = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(20_000) }).catch(
    () => null,
  );
  if (!r) return { status: 0 };
  const body = await r.json().catch(() => null);
  return { status: r.status, build: r.headers.get('x-fifth-build'), body };
};

/** Снимок кода с пробными миграциями; образ ядра; комплект из этого снимка. */
const MIGRATIONS = {
  M900_compat_probe:
    '-- Только испытание выпуска (check-release-trials).\nCREATE TABLE public.compat_probe (id serial PRIMARY KEY, note text NOT NULL, legacy text);\nGRANT SELECT, INSERT ON public.compat_probe TO app_backend;\nGRANT USAGE ON SEQUENCE public.compat_probe_id_seq TO app_backend;\n',
  M901_compat_contract:
    '-- migrate:contract\n-- Только испытание выпуска: несовместимое удаление колонки.\nALTER TABLE public.compat_probe DROP COLUMN legacy;\n',
  M902_compat_forward:
    '-- Только испытание выпуска: исправление вперёд.\nCREATE INDEX IF NOT EXISTS compat_probe_note_ix ON public.compat_probe (note);\n',
};
let base;
function snapshot(n, extra) {
  const dir = mkdtempSync(join(tmpdir(), `fifth-trials-${n}-`));
  cpSync(base, dir, { recursive: true });
  for (const name of extra)
    writeFileSync(join(dir, 'database', 'migrations', `${name}.sql`), MIGRATIONS[name]);
  const core = run(
    'docker',
    ['build', '-q', '-f', 'infra/images/core.Dockerfile', '-t', `fifth/core:t${n}`, '.'],
    { cwd: dir },
  );
  if (core.status !== 0) throw new Error(`образ ядра t${n}: ${core.stderr.slice(-300)}`);
  for (const c of ['web', 'postgres']) run('docker', ['tag', `fifth/${c}:t1`, `fifth/${c}:t${n}`]);
  return dir;
}
function pack(n, dir, previous) {
  const r = tool(
    'kit.mjs',
    ['pack', '--build', B(n), '--from', `t${n}`, ...(previous ? ['--previous', previous] : [])],
    { root: dir },
  );
  if (r.code !== 0) throw new Error(`комплект ${B(n)}: ${r.out.slice(-300)}`);
}

console.warn('\n=== СКВОЗНЫЕ ИСПЫТАНИЯ ВЫПУСКА ===\n');
rmSync(KITS, { recursive: true, force: true });
mkdirSync(KITS, { recursive: true });
mkdirSync(ETC, { recursive: true });
const signing = generateKeyPairSync('ed25519');
writeFileSync(
  join(ETC, 'kit-signing.pub'),
  signing.publicKey.export({ type: 'spki', format: 'pem' }),
);
const SIGN = signing.privateKey.export({ type: 'pkcs8', format: 'pem' });
tool('env.mjs', ['destroy', ENV, '--confirm', ENV]);
const dirs = [];
try {
  console.warn('▸ Образы и исходный комплект');
  // Только зафиксированный код: незакоммиченная работа рядом (новые файлы в снимок
  // stash не попадают) давала бы образ, который не собирается.
  const snap = run('git', ['rev-parse', 'HEAD']).stdout.trim();
  base = mkdtempSync(join(tmpdir(), 'fifth-trials-base-'));
  dirs.push(base);
  const tar = spawnSync(
    'sh',
    ['-c', `git archive ${snap} | tar -x -C "${base.replace(/\\/g, '/')}"`],
    { cwd: ROOT },
  );
  if (tar.status !== 0) throw new Error('снимок кода');
  for (const [file, image] of [
    ['infra/images/core.Dockerfile', 'core'],
    ['infra/images/web.Dockerfile', 'web'],
  ]) {
    const b = run('docker', ['build', '-q', '-f', file, '-t', `fifth/${image}:t1`, '.'], {
      cwd: base,
    });
    if (b.status !== 0) throw new Error(`образ ${image}: ${b.stderr.slice(-300)}`);
  }
  run('docker', ['build', '-q', '-t', 'fifth/postgres:t1', 'infra/postgres'], { cwd: base });
  pack(1, base);
  check('исходный комплект собран', true, B(1));

  const created = tool('env.mjs', [
    'create',
    ENV,
    '--kit',
    B(1),
    '--web-port',
    String(PORT),
    '--files-url',
    'http://localhost:9000',
  ]);
  check('среда создана', created.code === 0, created.out.slice(-160));
  appendFileSync(
    join(ROOT, '.local', 'envs', ENV, 'settings.env'),
    'BACKGROUND_TEST_SLOW_MS=2000\n',
  );
  // Контрольный объект среды (как control-init на prod).
  const keys = JSON.parse(readFileSync(join(ROOT, '.local', 'envs', ENV, 'storage.json'), 'utf8'));
  const region = readFileSync(join(ROOT, '.local', 'envs', ENV, 'settings.env'), 'utf8')
    .match(/^S3_REGION=(.*)$/m)[1]
    .trim();
  const body = Buffer.concat([Buffer.from('5E control object v1\n'), randomBytes(4096)]);
  await s3Object(
    {
      endpoint: 'http://127.0.0.1:9000',
      bucket: `fifth-${ENV}`,
      region,
      accessKey: keys.app.accessKeyId,
      secretKey: keys.app.secretAccessKey,
    },
    'PUT',
    'control/probe-v1',
    body,
    { 'content-type': 'application/octet-stream' },
  );
  psql(
    `INSERT INTO audit.control_objects (name, s3_key, size_bytes, sha256) VALUES ('probe', 'control/probe-v1', ${body.length}, '${createHash('sha256').update(body).digest('hex')}')`,
  );
  const first = install(B(1), 'none');
  check('первая установка через установщик', first.code === 0, first.json?.error ?? '');
  const enabled = tool('env.mjs', ['slots-enable', ENV]);
  check('среда на слотах', enabled.code === 0, enabled.json?.message ?? enabled.out.slice(-160));

  // ------------------------------------------------------------------ [1]
  console.warn('\n[1] Успешный выпуск с миграцией-расширением');
  const d2 = snapshot(2, ['M900_compat_probe']);
  dirs.push(d2);
  pack(2, d2, B(1));
  const s1 = install(B(2), B(1));
  check('выпуск 9202 прошёл через слоты', s1.code === 0, s1.json?.error ?? s1.json?.op);
  const v1 = await via();
  check('через nginx отвечает 9202', v1.build === B(2), JSON.stringify(v1).slice(0, 100));
  const rep1 = tool('release.mjs', ['report', ENV, '--op', s1.json?.op ?? '', '--text']);
  check(
    'протокол: миграция и переключение слотов',
    /M900_compat_probe/.test(rep1.out) && /Переключение слотов/.test(rep1.out),
    rep1.out.slice(0, 120),
  );
  const w1 = tool('release.mjs', ['watch', ENV]);
  check(
    'наблюдение после выпуска — ok',
    w1.json?.verdict === 'ok',
    JSON.stringify(w1.json?.problems ?? w1.json?.unknown ?? w1.out).slice(0, 160),
  );

  // ------------------------------------------------------------------ [2]
  console.warn('\n[2] Возврат с новыми данными');
  const wrote = await via('/v1/__test/compat-probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note: 'от кандидата' }),
  });
  check(
    'кандидат записал в новую таблицу',
    wrote.status === 200 && wrote.body?.build === B(2),
    JSON.stringify(wrote).slice(0, 120),
  );
  const unsigned = install(B(1), B(2), '--rollback');
  check(
    'возврат без отчёта совместимости — отказ',
    unsigned.code === 2 && /не проверен/.test(unsigned.json?.error ?? ''),
    unsigned.json?.error,
  );
  const kitSha = (b) => JSON.parse(readFileSync(join(KITS, b, 'kit.json'), 'utf8')).tar.sha256;
  const report = Buffer.from(
    JSON.stringify({
      result: 'ok',
      previous: { build: B(1), kitSha256: kitSha(B(1)) },
      candidate: { build: B(2), kitSha256: kitSha(B(2)) },
      newMigrations: ['M900_compat_probe'],
    }),
  );
  writeFileSync(join(KITS, B(2), `compat-${B(1)}.json`), report);
  writeFileSync(join(KITS, B(2), `compat-${B(1)}.json.sig`), signCompat(report, SIGN));
  const back = install(B(1), B(2), '--rollback');
  check('возврат 9202 → 9201 по подписанному отчёту', back.code === 0, back.json?.error ?? '');
  const v2 = await via();
  check(
    'прежний код обслуживает',
    v2.status === 200 && v2.build === B(1),
    JSON.stringify(v2).slice(0, 100),
  );
  check(
    'запись кандидата цела в базе, база не заменена',
    psql("SELECT count(*) FROM public.compat_probe WHERE note = 'от кандидата'") === '1',
  );
  const fwd = install(B(2), B(1));
  check('снова выпуск 9202', fwd.code === 0, fwd.json?.error ?? '');
  const read = await via('/v1/__test/compat-probe');
  check(
    'кандидат снова читает запись',
    read.status === 200 && (read.body?.notes ?? []).includes('от кандидата'),
    JSON.stringify(read.body).slice(0, 120),
  );

  // ------------------------------------------------------------------ [3]
  console.warn('\n[3] Contract-миграция: отдельный порядок и исправление вперёд');
  const d3 = snapshot(3, ['M900_compat_probe', 'M901_compat_contract']);
  dirs.push(d3);
  pack(3, d3, B(2));
  const refused = install(B(3), B(2));
  check(
    'без --allow-contract бесшовный выпуск отказан',
    refused.code !== 0 && /contract/.test(refused.out),
    refused.json?.error ?? refused.out.slice(-160),
  );
  check(
    'схема не тронута отказом',
    psql(
      "SELECT count(*) FROM information_schema.columns WHERE table_name = 'compat_probe' AND column_name = 'legacy'",
    ) === '1',
  );
  const contract = install(B(3), B(2), '--allow-contract');
  check(
    'с --allow-contract — порядок с остановкой прошёл',
    contract.code === 0,
    contract.json?.error ?? '',
  );
  const j3 = readFileSync(join(ROOT, '.local', 'envs', ENV, 'release', 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.op === contract.json?.op);
  const at = (stage, status) => j3.findIndex((l) => l.stage === stage && l.status === status);
  check(
    'старое ядро остановлено до миграции',
    at('stop-old', 'ok') >= 0 && at('stop-old', 'ok') < at('migrate', 'ok'),
    j3.map((l) => `${l.stage}:${l.status}`).join(' '),
  );
  check('через nginx отвечает 9203', (await via()).build === B(3));
  const noBack = install(B(2), B(3), '--rollback');
  check(
    'возврат за contract-миграцию запрещён',
    noBack.code === 2 && /contract-миграции/.test(noBack.json?.error ?? ''),
    noBack.json?.error,
  );
  const d4 = snapshot(4, ['M900_compat_probe', 'M901_compat_contract', 'M902_compat_forward']);
  dirs.push(d4);
  pack(4, d4, B(3));
  const forward = install(B(4), B(3));
  check('исправление вперёд 9204 проходит бесшовно', forward.code === 0, forward.json?.error ?? '');
  check('через nginx отвечает 9204', (await via()).build === B(4));
  const w3 = tool('release.mjs', ['watch', ENV]);
  check(
    'наблюдение после исправления — ok',
    w3.json?.verdict === 'ok',
    JSON.stringify(w3.json?.problems ?? w3.out).slice(0, 160),
  );
} catch (e) {
  check('испытания дошли до конца', false, e.message);
} finally {
  if (!process.argv.includes('--keep')) {
    tool('env.mjs', ['destroy', ENV, '--confirm', ENV]);
    rmSync(KITS, { recursive: true, force: true });
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

console.warn(`\nИТОГО: ${passed} пройдено, ${failed} провалено\n`);
process.exitCode = failed > 0 ? 1 : 0;
