#!/usr/bin/env node
/**
 * Испытания архиватора журналов (блок 8, 8.4; 2.1-W08b) на настоящем
 * journald — локально, без VPS.
 *
 * Поднимает контейнер с systemd (infra/testbed/journald.Dockerfile) в сети
 * стенда, отдельный бакет с версиями в MinIO стенда и учётку архиватора без
 * права удаления; в конце всё удаляет. Сценарии:
 *   1. обычный проход: порции, каталог, чтение каждой порции её VersionId;
 *   2. падение после записи отрезка в состояние, до отправки;
 *   3. падение после «S3 принял», до сохранения курсора — повтор не пишет
 *      порцию заново (исходный хеш совпал), версий у ключа одна;
 *   4. потеря локального состояния и каталога — продолжение с конца
 *      непрерывной цепочки из S3;
 *   5. разрыв в S3 (порция удалена) + потеря состояния — продолжение с конца
 *      непрерывной цепочки, объекты за разрывом сверяются, а не дублируются;
 *   6. оборванная строка каталога;
 *   7. конфликт: под ключом только чужая порция (даже с «верным» хешем в
 *      метаданных) — отказ без перезаписи; после разбора утрата видна;
 *   8. новая версия B под ключом подтверждённой порции A: verify читает A и
 *      называет B посторонней; потеря каталога + rebuild — привязка снова A;
 *   9. ротация journald без потерь;
 *  10. вытеснение неархивированных записей — отметка «вытеснено journald»;
 *  11. утрата первой порции архива + потеря состояния — пропуск у границы
 *      обнаружен и восполнен из journald;
 *  12. утрата нескольких начальных порций при уже вытесненном journald —
 *      отметка «утрачено в архиве», а не «вытеснено journald».
 *  13–15. утрата последней порции, нескольких последних, всех порций при
 *      сохранившихся квитанциях + потеря состояния — обнаруживается; verify
 *      не зелёный, пока утрата не восполнена (journald хранит) или не
 *      отмечена «утрачено в архиве» (journald вытеснен).
 *   P. суточные пакеты и ручная копия под учёткой чтения: добавочно, порча
 *      копии и описи, посторонняя версия пакета, исчезнувшая порция доступна
 *      из пакета; копия проверяется и без доступа к S3 (сеть отключена).
 *  В 12–15 копия скачивается и до восполнения (вердикт «НЕ сошлась», утрата
 *  названа), и после (тот же вердикт, что у verify).
 * Цепочка проверяется от ЗАКРЕПЛЁННОЙ в S3 границы.
 *
 *   node scripts/check-logs-archive.mjs [--keep]
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { loadEnv, ROOT } from './lib/backup.mjs';
import { contiguousChain, parseChunkKey } from './lib/logs-archive.mjs';
import { s3Object } from './lib/s3.mjs';

loadEnv();
const keep = process.argv.includes('--keep');
const tag = randomBytes(3).toString('hex');
const CT = `jtb-${tag}`;
const BUCKET = `tech-logs-test-${tag}`;
const USER = `logs-w-${tag}`;
const USER_SECRET = randomBytes(18).toString('hex');
const IMAGE = 'fifth/journald-testbed:local';
const NETWORK = 'unicorn-launch_default';

const root = {
  endpoint: `http://127.0.0.1:${process.env.S3_PORT || 9000}`,
  bucket: BUCKET,
  region: process.env.S3_REGION || 'us-east-1',
  accessKey: process.env.MINIO_ROOT_USER,
  secretKey: process.env.MINIO_ROOT_PASSWORD,
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
  });
  if (r.status !== 0 && !allowFail) {
    throw new Error(
      `${cmd} ${args.slice(0, 3).join(' ')}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`,
    );
  }
  return r;
}

/** Действия root в MinIO — внутри контейнера MinIO, секреты из его окружения. */
function mcRoot(script) {
  return sh('docker', [
    'exec',
    'unicorn-minio',
    'sh',
    '-c',
    `mc alias set r http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && ${script}; mc alias rm r >/dev/null`,
  ]);
}

const ARCH_ENV = {
  LOGS_S3_ENDPOINT: 'http://unicorn-minio:9000',
  LOGS_S3_BUCKET: BUCKET,
  LOGS_S3_ACCESS_KEY_ID: USER,
  LOGS_S3_SECRET_ACCESS_KEY: USER_SECRET,
  LOGS_ARCHIVE_KEY: randomBytes(32).toString('hex'),
  LOGS_STATE_DIR: '/var/lib/fifth-logs-test',
  LOGS_MAX_CHUNK_BYTES: '6000',
};

function arch(command, extra = {}) {
  const env = { ...ARCH_ENV, ...extra };
  const r = sh(
    'docker',
    [
      'exec',
      ...Object.keys(env).flatMap((k) => ['-e', k]),
      CT,
      'node',
      '/src/scripts/logs-archive.mjs',
      command,
    ],
    { env, allowFail: true },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() };
}

function inCt(script) {
  return sh('docker', ['exec', CT, 'sh', '-c', script]).stdout;
}

function gen(n, label) {
  inCt(
    `for i in $(seq 1 ${n}); do echo "w08b ${label} $i $(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \\n')" | systemd-cat -t w08b-test; done; sleep 1`,
  );
}

async function rootReq(method, key, query = {}, body = null, headers = {}) {
  return s3Object(root, method, key, body, headers, query);
}

async function versionsOf(key) {
  const r = await rootReq('GET', '', { versions: '', prefix: key });
  const xml = await r.text();
  return [...xml.matchAll(/<Version>([\s\S]*?)<\/Version>/g)]
    .map((m) => ({
      key: m[1].match(/<Key>([^<]+)<\/Key>/)?.[1],
      versionId: m[1].match(/<VersionId>([^<]+)<\/VersionId>/)?.[1],
    }))
    .filter((v) => v.key === key);
}

async function allKeysUnder(prefix) {
  const r = await rootReq('GET', '', { 'list-type': '2', prefix });
  const xml = await r.text();
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
}

async function allKeys() {
  const r = await rootReq('GET', '', { 'list-type': '2', prefix: 'j/' });
  const xml = await r.text();
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
}

const catalog = () =>
  inCt(`cat ${ARCH_ENV.LOGS_STATE_DIR}/catalog.jsonl 2>/dev/null || true`)
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });

/** Граница архива из S3 — то, от чего обязана идти цепочка. */
async function anchorStart() {
  const r = await rootReq('GET', '', { 'list-type': '2', prefix: 'anchors/' });
  const key = (await r.text()).match(/<Key>([^<]+)<\/Key>/)?.[1];
  const a = JSON.parse(await (await rootReq('GET', key)).text());
  return BigInt(a.afterSeq) + 1n;
}

/** Цепочка от ЗАКРЕПЛЁННОЙ границы, только по объектам с действующей квитанцией. */
async function chainCheck(name) {
  const items = (await allKeys())
    .map((k) => ({ key: k, ...parseChunkKey(k) }))
    .filter((i) => i.seqId);
  const { chain, beyond, overlaps, gaps } = contiguousChain(items, await anchorStart());
  check(
    `${name}: цепочка непрерывна от границы, перекрытий нет`,
    beyond.length === 0 && overlaps.length === 0 && gaps.length === 0 && chain.length > 0,
    `звеньев ${chain.length}, пропусков ${gaps.length}, перекрытий ${overlaps.length}`,
  );
}

function verifyOk(name) {
  const v = arch('verify');
  check(
    `${name}: каждая порция читается своей версией, хеши сошлись`,
    v.code === 0,
    v.out.split('\n')[0],
  );
  // Вердикт различает «сохранено полностью» и «пройдено с учтёнными потерями».
  const hasLoss = catalog().some((r) => r.kind === 'loss');
  const verdict = v.out.split('\n').find((l) => l.startsWith('ИТОГ:')) ?? '';
  check(
    `${name}: вердикт — ${hasLoss ? 'есть учтённые потери' : 'данные сохранены полностью'}`,
    hasLoss
      ? verdict.includes('есть учтённые потери')
      : verdict.includes('данные сохранены полностью'),
    verdict,
  );
}

let readerCreated = null;

async function cleanup() {
  if (keep) {
    console.log(`\n(--keep: оставлены контейнер ${CT}, бакет ${BUCKET})`);
    return;
  }
  sh('docker', ['rm', '-f', CT], { allowFail: true });
  mcRoot(
    `mc rb --force --dangerous r/${BUCKET} >/dev/null 2>&1 || mc rb --force r/${BUCKET} >/dev/null 2>&1; mc admin user rm r ${USER} >/dev/null 2>&1; mc admin policy rm r ${USER} >/dev/null 2>&1; ${readerCreated ? `mc admin user rm r ${readerCreated} >/dev/null 2>&1; mc admin policy rm r ${readerCreated} >/dev/null 2>&1;` : ''} true`,
  );
}

console.log(`=== АРХИВАТОР ЖУРНАЛОВ: испытания (${tag}) ===`);

// Чистая функция: начало закреплено границей (случай Тэнка — граница 100,
// есть только 110–119; прежняя версия принимала её за непрерывную цепочку).
{
  const r = contiguousChain([{ first: 110n, last: 119n }], 100n);
  check(
    'цепочка от границы 100 при единственной порции 110–119 — пропуск 100–109',
    r.chain.length === 0 &&
      r.gaps.length === 1 &&
      r.gaps[0].first === 100n &&
      r.gaps[0].last === 109n,
  );
  const ok = contiguousChain(
    [
      { first: 100n, last: 109n },
      { first: 110n, last: 119n },
    ],
    100n,
  );
  check('цепочка 100–119 от границы 100 — без пропусков', ok.gaps.length === 0 && ok.end === 119n);
}

try {
  // ---------------------------------------------------------- стенд
  if (sh('docker', ['image', 'inspect', IMAGE], { allowFail: true }).status !== 0) {
    sh(
      'docker',
      ['build', '-q', '-t', IMAGE, '-f', 'infra/testbed/journald.Dockerfile', 'infra/testbed'],
      {},
    );
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
    `${resolve(ROOT, 'scripts')}:/src/scripts:ro`,
    IMAGE,
  ]);
  for (let i = 0; i < 30; i++) {
    const s = sh('docker', ['exec', CT, 'systemctl', 'is-system-running'], {
      allowFail: true,
    }).stdout.trim();
    if (s === 'running' || s === 'degraded') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const policy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: [
          's3:PutObject',
          's3:GetObject',
          's3:GetObjectVersion',
          's3:ListBucket',
          's3:ListBucketVersions',
          's3:GetBucketLocation',
        ],
        Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`],
      },
      {
        Effect: 'Deny',
        Action: [
          's3:DeleteObject',
          's3:DeleteObjectVersion',
          's3:PutBucketVersioning',
          's3:PutLifecycleConfiguration',
          's3:DeleteBucket',
          's3:PutBucketPolicy',
        ],
        Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`],
      },
    ],
  });
  sh('docker', ['exec', '-i', 'unicorn-minio', 'sh', '-c', `cat > /tmp/p-${tag}.json`], {
    input: policy,
  });
  sh(
    'docker',
    [
      'exec',
      '-e',
      'US',
      'unicorn-minio',
      'sh',
      '-c',
      `mc alias set r http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mb -q r/${BUCKET} >/dev/null && mc version enable r/${BUCKET} >/dev/null && mc admin policy create r ${USER} /tmp/p-${tag}.json >/dev/null && mc admin user add r ${USER} "$US" >/dev/null && mc admin policy attach r ${USER} --user ${USER} >/dev/null; rm -f /tmp/p-${tag}.json; mc alias rm r >/dev/null`,
    ],
    { env: { US: USER_SECRET } },
  );
  console.log(`стенд: ${CT}, бакет ${BUCKET} (версии включены), учётка без удаления`);

  // ---------------------------------------------------------- 1
  console.log('\n▸ 1. Обычный проход');
  check('init', arch('init').code === 0);
  gen(40, 's1');
  const r1 = arch('run');
  check('проход', r1.code === 0, r1.out.split('\n').pop());
  const c1 = catalog();
  check(
    'порций несколько, у каждой VersionId',
    c1.length > 1 && c1.every((r) => r.versionId),
    `порций ${c1.length}`,
  );
  verifyOk('1');

  // ---------------------------------------------------------- 2
  console.log('\n▸ 2. Падение до отправки');
  gen(15, 's2');
  check(
    'падение после записи отрезка',
    arch('run', { LOGS_TEST_CRASH: 'after-pending' }).code === 97,
  );
  const r2 = arch('run');
  check('повтор', r2.code === 0, r2.out.split('\n')[0]);
  verifyOk('2');

  // ---------------------------------------------------------- 3
  console.log('\n▸ 3. Падение после «S3 принял»');
  gen(15, 's3');
  check('падение после записи объекта', arch('run', { LOGS_TEST_CRASH: 'after-put' }).code === 98);
  const pendingKey = JSON.parse(inCt(`cat ${ARCH_ENV.LOGS_STATE_DIR}/state.json`)).pending?.key;
  check('отрезок записан в состояние', Boolean(pendingKey), pendingKey ?? '');
  const before = await versionsOf(pendingKey);
  const r3 = arch('run');
  check(
    'повтор узнал порцию по исходному хешу',
    r3.code === 0 && r3.out.includes('уже в архиве'),
    r3.out.split('\n')[0],
  );
  check(
    'версий у ключа по-прежнему одна',
    before.length === 1 && (await versionsOf(pendingKey)).length === 1,
  );
  verifyOk('3');

  // ---------------------------------------------------------- 4
  console.log('\n▸ 4. Потеря локального состояния и каталога');
  inCt(`rm -f ${ARCH_ENV.LOGS_STATE_DIR}/state.json ${ARCH_ENV.LOGS_STATE_DIR}/catalog.jsonl`);
  gen(15, 's4');
  const r4 = arch('run');
  check(
    'восстановление из S3 и продолжение',
    r4.code === 0 && r4.out.includes('восстановлено из S3'),
    r4.out.split('\n')[0],
  );
  await chainCheck('4');
  verifyOk('4');

  // ---------------------------------------------------------- 5
  console.log('\n▸ 5. Разрыв в S3 + потеря состояния');
  const mid = catalog()
    .filter((r) => r.kind === 'chunk')
    .at(Math.floor(catalog().length / 2));
  for (const v of await versionsOf(mid.key)) {
    await rootReq('DELETE', mid.key, { versionId: v.versionId });
  }
  check(
    'порция из середины удалена (root)',
    (await versionsOf(mid.key)).length === 0,
    mid.key.split('/').pop(),
  );
  inCt(`rm -f ${ARCH_ENV.LOGS_STATE_DIR}/state.json ${ARCH_ENV.LOGS_STATE_DIR}/catalog.jsonl`);
  gen(10, 's5');
  const r5 = arch('run');
  check(
    'продолжение с конца непрерывной цепочки',
    r5.code === 0 && /за разрывом \d+/.test(r5.out),
    r5.out.split('\n')[0],
  );
  await chainCheck('5');
  verifyOk('5');

  // ---------------------------------------------------------- 6
  console.log('\n▸ 6. Оборванная строка каталога');
  inCt(`printf '{"kind":"chunk","key":"j/обрыв' >> ${ARCH_ENV.LOGS_STATE_DIR}/catalog.jsonl`);
  gen(10, 's6');
  const r6 = arch('run');
  check('проход после обрыва строки', r6.code === 0, r6.out.split('\n').pop());
  verifyOk('6');

  // ---------------------------------------------------------- 8
  console.log('\n▸ 8. Новая версия под тем же ключом — и потеря каталога');
  gen(10, 's8');
  check('проход', arch('run').code === 0);
  const k = catalog().at(-1);
  const versionA = k.versionId;
  // root кладёт под тот же ключ другую порцию — новая версия B, даже с
  // «правильным» исходным хешем в метаданных.
  const rogue = await rootReq('PUT', k.key, {}, Buffer.from('чужая порция'), {
    'x-amz-meta-plain-sha256': k.plainSha,
  });
  const versionB = rogue.headers.get('x-amz-version-id');
  check('версия B под тем же ключом (root)', rogue.ok && (await versionsOf(k.key)).length === 2);
  const v8 = arch('verify');
  check(
    'verify: подтверждённая порция читается версией A, B — посторонняя',
    v8.out.includes('проблем: 0') && v8.out.includes('посторонних версий: 1'),
    v8.out.split('\n')[0],
  );
  inCt(`rm -f ${ARCH_ENV.LOGS_STATE_DIR}/state.json ${ARCH_ENV.LOGS_STATE_DIR}/catalog.jsonl`);
  const rb8 = arch('rebuild');
  const k8 = catalog().find((r) => r.key === k.key);
  check(
    'rebuild после потери каталога: привязка — снова A, а не последняя B',
    rb8.code === 0 && k8?.versionId === versionA,
    `в каталоге: ${k8?.versionId === versionA ? 'A' : k8?.versionId === versionB ? 'B' : 'нет'}`,
  );
  const v8b = arch('verify');
  check(
    'verify после rebuild: проблем 0, B по-прежнему посторонняя',
    v8b.out.includes('проблем: 0') && v8b.out.includes('посторонних версий: 1'),
    v8b.out.split('\n')[0],
  );
  await rootReq('DELETE', k.key, { versionId: versionB });

  // ---------------------------------------------------------- 7
  console.log('\n▸ 7. Конфликт: под ключом только чужая порция');
  const stateBefore = inCt(`cat ${ARCH_ENV.LOGS_STATE_DIR}/state.json`);
  const catBefore = inCt(`cat ${ARCH_ENV.LOGS_STATE_DIR}/catalog.jsonl`);
  gen(10, 's7');
  check('проход', arch('run').code === 0);
  const c = catalog().at(-1);
  for (const v of await versionsOf(c.key)) {
    await rootReq('DELETE', c.key, { versionId: v.versionId });
  }
  const rogue7 = await rootReq('PUT', c.key, {}, Buffer.from('чужая порция'), {
    'x-amz-meta-plain-sha256': c.plainSha,
  });
  check(
    'под ключом только чужая версия (root)',
    rogue7.ok && (await versionsOf(c.key)).length === 1,
  );
  const st = JSON.parse(stateBefore);
  st.pending = { key: c.key, firstCursor: c.firstCursor, count: c.count, plainSha: c.plainSha };
  sh('docker', ['exec', '-i', CT, 'sh', '-c', `cat > ${ARCH_ENV.LOGS_STATE_DIR}/state.json`], {
    input: JSON.stringify(st),
  });
  sh('docker', ['exec', '-i', CT, 'sh', '-c', `cat > ${ARCH_ENV.LOGS_STATE_DIR}/catalog.jsonl`], {
    input: catBefore,
  });
  const r7 = arch('run');
  check(
    'конфликт: отказ (верный хеш в метаданных чужой версии не помог)',
    r7.code !== 0 && r7.out.includes('КОНФЛИКТ'),
    r7.out.split('\n').pop(),
  );
  check('конфликт: без перезаписи', (await versionsOf(c.key)).length === 1);
  await rootReq('DELETE', c.key, { versionId: rogue7.headers.get('x-amz-version-id') });
  inCt(`rm -f ${ARCH_ENV.LOGS_STATE_DIR}/state.json ${ARCH_ENV.LOGS_STATE_DIR}/catalog.jsonl`);
  const r7b = arch('run');
  check(
    'после разбора: утрата подтверждённой порции видна, отрезок восстановлен из journald',
    r7b.code === 0 && r7b.out.includes('УТРАЧЕНО ПОДТВЕРЖДЁННЫХ'),
    r7b.out.split('\n')[0],
  );
  await chainCheck('7');
  verifyOk('7');

  // ---------------------------------------------------------- 9
  console.log('\n▸ 9. Ротация journald');
  inCt('journalctl --rotate');
  gen(15, 's9');
  const r9 = arch('run');
  check(
    'проход после ротации, без потерь',
    r9.code === 0 && !r9.out.includes('ПОТЕРЯ'),
    r9.out.split('\n').pop(),
  );

  // ---------------------------------------------------------- P
  console.log('\n▸ P. Суточные пакеты и ручная копия (учётка только на чтение)');
  const READER = `logs-r-${tag}`;
  const READER_SECRET = randomBytes(18).toString('hex');
  const readerPolicy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: [
          's3:GetObject',
          's3:GetObjectVersion',
          's3:ListBucket',
          's3:ListBucketVersions',
          's3:GetBucketLocation',
        ],
        Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`],
      },
    ],
  });
  sh('docker', ['exec', '-i', 'unicorn-minio', 'sh', '-c', `cat > /tmp/pr-${tag}.json`], {
    input: readerPolicy,
  });
  sh(
    'docker',
    [
      'exec',
      '-e',
      'RS',
      'unicorn-minio',
      'sh',
      '-c',
      `mc alias set r http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc admin policy create r ${READER} /tmp/pr-${tag}.json >/dev/null && mc admin user add r ${READER} "$RS" >/dev/null && mc admin policy attach r ${READER} --user ${READER} >/dev/null; rm -f /tmp/pr-${tag}.json; mc alias rm r >/dev/null`,
    ],
    { env: { RS: READER_SECRET } },
  );
  readerCreated = READER;
  const asReader = { LOGS_S3_ACCESS_KEY_ID: READER, LOGS_S3_SECRET_ACCESS_KEY: READER_SECRET };
  const PULL = `/tmp/pull-${tag}`;
  const pull = () => arch('pull', { ...asReader, LOGS_PULL_TO: PULL });
  const downloadedOf = (out) => Number(out.match(/скачано объектов: (\d+)/)?.[1] ?? -1);
  const verdictOf = (out) => out.split('\n').find((l) => l.startsWith('ИТОГ:')) ?? '';
  const copyLine = (out) => out.split('\n').find((l) => l.startsWith('копия:')) ?? out;
  /** Проверка копии без S3: сеть контейнера отключена, учётки в окружении нет. */
  const offline = (dir) => {
    sh('docker', ['network', 'disconnect', NETWORK, CT]);
    try {
      return arch('verify-copy', {
        LOGS_PULL_TO: dir,
        LOGS_S3_ACCESS_KEY_ID: '',
        LOGS_S3_SECRET_ACCESS_KEY: '',
      });
    } finally {
      sh('docker', ['network', 'connect', NETWORK, CT]);
    }
  };
  const WANT = {
    full: 'данные сохранены полностью',
    loss: 'есть учтённые потери',
    red: 'копия НЕ сошлась',
  };
  /** Скачивание в новый каталог + та же проверка без S3; ожидаемый вердикт. */
  const pullCase = (name, expect) => {
    const dir = `/tmp/pc-${tag}-${name}`;
    const p = arch('pull', { ...asReader, LOGS_PULL_TO: dir });
    const v = verdictOf(p.out);
    check(
      `${name}: копия — ${WANT[expect]}`,
      v.includes(WANT[expect]) &&
        (expect === 'red' ? p.code !== 0 && p.out.includes('утрата архива') : p.code === 0),
      `${copyLine(p.out)} | ${v}`,
    );
    const o = offline(dir);
    check(
      `${name}: без доступа к S3 копия даёт тот же вердикт`,
      o.code === p.code && verdictOf(o.out) === v,
      verdictOf(o.out) || o.out.split('\n')[0],
    );
    inCt(`rm -rf ${dir}`);
    return p;
  };
  const expectAfterRun = () => (catalog().some((r) => r.kind === 'loss') ? 'loss' : 'full');
  // «Завтра»: архиватор дочитал журнал после конца суток — сутки закрыты.
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
  check('проход «завтра»', arch('run', { LOGS_TEST_NOW: tomorrow }).code === 0);
  const pk = arch('pack', { LOGS_TEST_NOW: tomorrow });
  check(
    'пакет закрытых суток собран',
    pk.code === 0 && /пакет \d{4}-\d{2}-\d{2}: порций \d+/.test(pk.out),
    pk.out.split('\n')[0],
  );
  const pk2 = arch('pack', { LOGS_TEST_NOW: tomorrow });
  check('повторная сборка пакета не дублирует', pk2.out.includes('пакетов собрано: 0'));
  const p1 = pull();
  check(
    'скачивание: копия сошлась',
    p1.code === 0 && p1.out.includes('ИТОГ: данные сохранены полностью'),
    p1.out.split('\n')[0],
  );
  check(
    'скачан один пакет, порции из пакета отдельно не качались',
    downloadedOf(p1.out) === 1,
    `скачано ${downloadedOf(p1.out)}`,
  );
  const p2 = pull();
  check(
    'повтор скачивания — добавочно, ничего',
    p2.code === 0 && downloadedOf(p2.out) === 0,
    `скачано ${downloadedOf(p2.out)}`,
  );
  gen(10, 'sP');
  check('проход', arch('run').code === 0);
  const fresh = catalog().filter((r) => r.kind === 'chunk').length;
  const p3 = pull();
  check(
    'новые порции текущих суток докачаны без пакета',
    p3.code === 0 && downloadedOf(p3.out) >= 1,
    `скачано ${downloadedOf(p3.out)}, порций в каталоге ${fresh}`,
  );
  // Порча копии на ноутбуке.
  inCt(
    `f=$(ls ${PULL}/packs/*.pack | head -1); printf 'X' | dd of="$f" bs=1 seek=40 conv=notrunc 2>/dev/null`,
  );
  const p4 = pull();
  check(
    'порча байта копии пакета обнаружена',
    p4.code !== 0 && p4.out.includes('порча копии'),
    p4.out.split('\n').find((l) => l.includes('пакет')) ?? p4.out.split('\n')[0],
  );
  inCt(`rm -f ${PULL}/packs/*.pack`);
  const p5 = pull();
  check(
    'испорченная копия скачана заново — сошлась',
    p5.code === 0 && downloadedOf(p5.out) === 1,
    p5.out.split('\n').at(-1),
  );
  // Посторонняя версия под ключом пакета не меняет чтение по квитанции.
  const packObj = (await allKeysUnder('p/'))[0];
  await rootReq('PUT', packObj, {}, Buffer.from('чужой пакет'));
  inCt(`rm -f ${PULL}/packs/*.pack`);
  const p6 = pull();
  check(
    'новая версия под ключом пакета: копия по квитанции сошлась',
    p6.code === 0 && p6.out.includes('ИТОГ: данные сохранены полностью'),
    p6.out.split('\n').at(-1),
  );
  // Учётка чтения не пишет.
  const rw = await s3Object(
    { ...root, accessKey: READER, secretKey: READER_SECRET },
    'PUT',
    'p/запрещено',
    Buffer.from('x'),
  );
  check('учётка чтения: запись запрещена', rw.status === 403, `HTTP ${rw.status}`);
  // Опись на ноутбуке: без S3 та же копия даёт тот же вердикт.
  const o7 = offline(PULL);
  check(
    'копия без доступа к S3: состав и вердикт по локальной описи',
    o7.code === 0 && verdictOf(o7.out) === verdictOf(p6.out),
    copyLine(o7.out),
  );
  // Порча описи обнаруживается (она зашифрована ключом архива).
  inCt(`printf 'X' | dd of=${PULL}/MANIFEST.sealed bs=1 seek=30 conv=notrunc 2>/dev/null`);
  const o8 = offline(PULL);
  check('порча описи копии обнаружена', o8.code !== 0 && o8.out.includes('опись копии'), o8.out);
  inCt(`rm -rf ${PULL}`);
  // Исходная порция исчезла, но её точная версия — в исправном пакете.
  const byFirst = (a, b) => (BigInt(a.first) < BigInt(b.first) ? -1 : 1);
  const packedFirst = catalog()
    .filter((r) => r.kind === 'chunk')
    .sort(byFirst)[0];
  for (const v of await versionsOf(packedFirst.key)) {
    await rootReq('DELETE', packedFirst.key, { versionId: v.versionId });
  }
  pullCase('P-пакет', 'full');
  // Обратная проверка: без исправного пакета та же порция — утрата архива.
  const PK = `/tmp/pk-${tag}`;
  arch('pull', { ...asReader, LOGS_PULL_TO: PK });
  inCt(
    `f=$(ls ${PK}/packs/*.pack | head -1); printf 'X' | dd of="$f" bs=1 seek=40 conv=notrunc 2>/dev/null`,
  );
  const oPk = offline(PK);
  check(
    'исчезнувшую порцию покрывал именно пакет: при порче пакета — утрата',
    oPk.code !== 0 &&
      oPk.out.includes(`отрезок ${packedFirst.first}–${packedFirst.last}: квитанция есть`),
    oPk.out.split('\n').find((l) => l.includes(`отрезок ${packedFirst.first}`)) ??
      copyLine(oPk.out),
  );
  inCt(`rm -rf ${PK}`);

  // ---------------------------------------------------------- 11
  console.log('\n▸ 11. Утрата первой порции архива + потеря состояния (journald ещё хранит)');
  const firstChunk = catalog()
    .filter((r) => r.kind === 'chunk')
    .sort(byFirst)[0];
  check(
    'первая порция начинается сразу за границей',
    BigInt(firstChunk.first) === (await anchorStart()),
  );
  for (const v of await versionsOf(firstChunk.key)) {
    await rootReq('DELETE', firstChunk.key, { versionId: v.versionId });
  }
  inCt(`rm -f ${ARCH_ENV.LOGS_STATE_DIR}/state.json ${ARCH_ENV.LOGS_STATE_DIR}/catalog.jsonl`);
  const r11 = arch('run');
  check(
    'пропуск в начале обнаружен',
    r11.out.includes(`ПРОПУСК В АРХИВЕ: записи ${firstChunk.first}`),
    r11.out.split('\n').find((l) => l.includes('ПРОПУСК')) ?? r11.out.split('\n')[0],
  );
  check(
    'и восстановлен из journald, без отметки потери',
    r11.code === 0 && !/ПОТЕРЯ|ПРОПУСК АРХИВА|НЕ ПРОВЕРЯЕМО/.test(r11.out),
    r11.out.split('\n').pop(),
  );
  await chainCheck('11');
  verifyOk('11');

  // ---------------------------------------------------------- 10
  console.log('\n▸ 10. Вытеснение до архивации');
  gen(20, 's10-lost');
  inCt('journalctl --rotate && journalctl --vacuum-files=1 >/dev/null 2>&1; true');
  gen(5, 's10-after');
  const r10 = arch('run');
  check(
    'потеря обнаружена и отмечена как вытеснение journald',
    r10.code === 0 && r10.out.includes('ПОТЕРЯ (вытеснено journald)'),
    r10.out.split('\n').find((l) => l.includes('ПОТЕРЯ')) ?? r10.out,
  );
  check(
    'в каталоге — отметка потери journald-vacuumed',
    catalog().some((r) => r.kind === 'loss' && r.reason === 'journald-vacuumed'),
  );
  await chainCheck('10');
  verifyOk('10');

  // ---------------------------------------------------------- 12
  console.log('\n▸ 12. Утрата нескольких начальных порций, journald уже вытеснен');
  const firstThree = catalog()
    .filter((r) => r.kind === 'chunk')
    .sort(byFirst)
    .slice(0, 3);
  for (const ch of firstThree) {
    for (const v of await versionsOf(ch.key)) {
      await rootReq('DELETE', ch.key, { versionId: v.versionId });
    }
  }
  // Удалённые начальные порции (кроме восполненной в 11) — точными версиями в
  // пакете: на копии данные есть, утраты нет (journald при этом вытеснен).
  const p12 = pullCase('12-до', expectAfterRun());
  check(
    '12: удалённые порции доступны из пакета',
    !p12.out.includes('утрата архива'),
    copyLine(p12.out),
  );
  inCt(`rm -f ${ARCH_ENV.LOGS_STATE_DIR}/state.json ${ARCH_ENV.LOGS_STATE_DIR}/catalog.jsonl`);
  const r12 = arch('run');
  check(
    'пропуск в начале обнаружен при восстановлении',
    r12.out.includes(`ПРОПУСК В АРХИВЕ: записи ${firstThree[0].first}`),
    r12.out.split('\n').find((l) => l.includes('ПРОПУСК В АРХИВЕ')) ?? r12.out.split('\n')[0],
  );
  const lost12 = catalog().filter(
    (r) => r.kind === 'loss' && BigInt(r.first) === BigInt(firstThree[0].first),
  );
  check(
    'отмечен как утрата АРХИВА, а не вытеснение journald',
    r12.code === 0 &&
      lost12.length === 1 &&
      lost12[0].reason === 'archive-missing' &&
      BigInt(lost12[0].last) === BigInt(firstThree[2].last),
    lost12.map((r) => `${r.reason} ${r.first}–${r.last}`).join(', ') ||
      r12.out.split('\n').slice(-2).join(' | '),
  );
  check(
    'подтверждённые порции за разрывом приняты по квитанциям',
    catalog().filter((r) => r.kind === 'chunk').length >= 3,
  );
  await chainCheck('12');
  verifyOk('12');
  pullCase('12-после', expectAfterRun());

  // ---------------------------------------------------- 13–15: утрата конца
  const chunksByFirst = () =>
    catalog()
      .filter((r) => r.kind === 'chunk')
      .sort(byFirst);
  const dropAll = async (rows) => {
    for (const ch of rows) {
      for (const v of await versionsOf(ch.key)) {
        await rootReq('DELETE', ch.key, { versionId: v.versionId });
      }
    }
  };
  const loseState = () =>
    inCt(`rm -f ${ARCH_ENV.LOGS_STATE_DIR}/state.json ${ARCH_ENV.LOGS_STATE_DIR}/catalog.jsonl`);
  /** Каждый удалённый отрезок покрыт отметками «утрачено в архиве». */
  const coveredByArchiveMissing = (rows) => {
    const marks = catalog().filter((r) => r.kind === 'loss' && r.reason === 'archive-missing');
    return rows.every((ch) =>
      marks.some((m) => BigInt(m.first) <= BigInt(ch.first) && BigInt(ch.last) <= BigInt(m.last)),
    );
  };
  const verifyRed = (name) => {
    const v = arch('verify');
    check(
      `${name}: verify не зелёный, пока утрата не восполнена или не учтена`,
      v.code !== 0 && v.out.includes('утрата архива'),
      v.out.split('\n')[0],
    );
  };

  console.log('\n▸ 13. Утрата последней порции + потеря состояния (journald ещё хранит)');
  const last13 = chunksByFirst().at(-1);
  await dropAll([last13]);
  loseState();
  const rb13 = arch('rebuild');
  check(
    'утрата последней порции обнаружена rebuild',
    rb13.out.includes(`ПРОПУСК В АРХИВЕ: записи ${last13.first}`),
    rb13.out.split('\n').find((l) => l.includes('ПРОПУСК')) ?? rb13.out.split('\n')[0],
  );
  verifyRed('13');
  pullCase('13-до', 'red');
  const r13 = arch('run');
  check(
    'восполнена из journald, без отметки потери',
    r13.code === 0 && !/ПОТЕРЯ|ПРОПУСК АРХИВА|НЕ ПРОВЕРЯЕМО/.test(r13.out),
    r13.out.split('\n').pop(),
  );
  await chainCheck('13');
  verifyOk('13');
  pullCase('13-после', expectAfterRun());

  console.log('\n▸ 14. Утрата нескольких последних порций, journald уже вытеснен');
  const last14 = chunksByFirst().slice(-3);
  await dropAll(last14);
  inCt('journalctl --rotate && journalctl --vacuum-files=1 >/dev/null 2>&1; true');
  loseState();
  const rb14 = arch('rebuild');
  check(
    'утрата последних порций обнаружена rebuild',
    rb14.out.includes(`ПРОПУСК В АРХИВЕ: записи ${last14[0].first}`),
    rb14.out.split('\n').find((l) => l.includes('ПРОПУСК')) ?? rb14.out.split('\n')[0],
  );
  verifyRed('14');
  pullCase('14-до', 'red');
  gen(5, 's14-after');
  const r14 = arch('run');
  check(
    'отмечена как утрата АРХИВА, а не вытеснение journald',
    r14.code === 0 && coveredByArchiveMissing(last14),
    r14.out
      .split('\n')
      .filter((l) => /ПОТЕРЯ|ПРОПУСК/.test(l))
      .join(' | ') || r14.out,
  );
  await chainCheck('14');
  verifyOk('14');
  pullCase('14-после', expectAfterRun());

  console.log('\n▸ 15. Утрачены все порции, квитанции сохранились, journald вытеснен');
  const all15 = chunksByFirst();
  await dropAll(all15);
  check(
    'все объекты порций удалены (root)',
    (await allKeys()).every((k) => !k.endsWith('.jx')),
  );
  inCt('journalctl --rotate && journalctl --vacuum-files=1 >/dev/null 2>&1; true');
  loseState();
  const rb15 = arch('rebuild');
  check(
    'утрата всех порций обнаружена rebuild',
    rb15.out.includes('ПРОПУСК В АРХИВЕ') && rb15.out.includes('УТРАЧЕНО ПОДТВЕРЖДЁННЫХ'),
    rb15.out.split('\n')[0],
  );
  verifyRed('15');
  const p15 = pullCase('15-до', 'red');
  check(
    '15: порции из пакета остались доступны, утрата — только за пакетом',
    !/порций из пакетов: 0,/.test(p15.out),
    copyLine(p15.out),
  );
  gen(5, 's15-after');
  const r15 = arch('run');
  check(
    'каждая утраченная порция отмечена как утрата АРХИВА',
    r15.code === 0 && coveredByArchiveMissing(all15),
    `порций ${all15.length}`,
  );
  await chainCheck('15');
  verifyOk('15');
  pullCase('15-после', expectAfterRun());
} catch (error) {
  failed++;
  console.log(`  FAIL  испытание прервано: ${error.message}`);
} finally {
  await cleanup();
}
console.log(`\nИтог: пройдено ${passed}, провалено ${failed}`);
process.exit(failed ? 1 : 0);
