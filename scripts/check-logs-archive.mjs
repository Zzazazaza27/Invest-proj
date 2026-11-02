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
 *   7. конфликт: под ключом порции другая порция — без перезаписи, отказ;
 *   8. новая версия под тем же ключом не меняет чтение подтверждённой
 *      порции (каталог хранит VersionId);
 *   9. ротация journald без потерь;
 *  10. вытеснение неархивированных записей — отметка потери, а не успех.
 * Итог: цепочка непрерывна от начала, перекрытий нет.
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

async function chainCheck(name) {
  const items = (await allKeys())
    .map((k) => ({ key: k, ...parseChunkKey(k) }))
    .filter((i) => i.seqId);
  const { chain, beyond, overlaps } = contiguousChain(items);
  check(
    `${name}: цепочка непрерывна, перекрытий нет`,
    beyond.length === 0 && overlaps.length === 0,
    `звеньев ${chain.length}, за разрывом ${beyond.length}, перекрытий ${overlaps.length}`,
  );
}

function verifyOk(name) {
  const v = arch('verify');
  check(
    `${name}: каждая порция читается своей версией, хеши сошлись`,
    v.code === 0,
    v.out.split('\n')[0],
  );
}

async function cleanup() {
  if (keep) {
    console.log(`\n(--keep: оставлены контейнер ${CT}, бакет ${BUCKET})`);
    return;
  }
  sh('docker', ['rm', '-f', CT], { allowFail: true });
  mcRoot(
    `mc rb --force --dangerous r/${BUCKET} >/dev/null 2>&1 || mc rb --force r/${BUCKET} >/dev/null 2>&1; mc admin user rm r ${USER} >/dev/null 2>&1; mc admin policy rm r ${USER} >/dev/null 2>&1; true`,
  );
}

console.log(`=== АРХИВАТОР ЖУРНАЛОВ: испытания (${tag}) ===`);
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

  // ---------------------------------------------------------- 7–8
  console.log('\n▸ 7–8. Конфликт и новая версия под тем же ключом');
  const stateBefore = inCt(`cat ${ARCH_ENV.LOGS_STATE_DIR}/state.json`);
  const catBefore = inCt(`cat ${ARCH_ENV.LOGS_STATE_DIR}/catalog.jsonl`);
  gen(10, 's7');
  check('проход', arch('run').code === 0);
  const k = catalog().at(-1);
  const kHead = await rootReq('HEAD', k.key);
  const firstCursor = kHead.headers.get('x-amz-meta-first-cursor');
  // root кладёт под тот же ключ другую порцию — новая версия.
  const rogue = await rootReq('PUT', k.key, {}, Buffer.from('чужая порция'), {
    'x-amz-meta-plain-sha256': '0'.repeat(64),
  });
  check(
    'новая версия под тем же ключом (root)',
    rogue.ok && (await versionsOf(k.key)).length === 2,
  );
  verifyOk('8: подтверждённая порция читается прежней версией');
  // Состояние «до этой порции» с незавершённым отрезком — повтор должен
  // встретить чужой объект и отказать без перезаписи.
  const st = JSON.parse(stateBefore);
  st.pending = { key: k.key, firstCursor, count: k.count, plainSha: k.plainSha };
  sh('docker', ['exec', '-i', CT, 'sh', '-c', `cat > ${ARCH_ENV.LOGS_STATE_DIR}/state.json`], {
    input: JSON.stringify(st),
  });
  sh('docker', ['exec', '-i', CT, 'sh', '-c', `cat > ${ARCH_ENV.LOGS_STATE_DIR}/catalog.jsonl`], {
    input: catBefore,
  });
  const r7 = arch('run');
  check('конфликт: отказ', r7.code !== 0 && r7.out.includes('КОНФЛИКТ'), r7.out.split('\n').pop());
  check('конфликт: без перезаписи', (await versionsOf(k.key)).length === 2);
  // Вернуть рабочее состояние: каталог и курсор после порции k.
  inCt(`rm -f ${ARCH_ENV.LOGS_STATE_DIR}/state.json ${ARCH_ENV.LOGS_STATE_DIR}/catalog.jsonl`);
  // Чужая версия последняя — восстановление по метаданным увидело бы её;
  // root возвращает порядок, удалив чужую версию (испытание, не работа).
  const vs = await versionsOf(k.key);
  const rogueId = rogue.headers.get('x-amz-version-id');
  await rootReq('DELETE', k.key, { versionId: rogueId });
  check('чужая версия убрана (root)', vs.length === 2 && (await versionsOf(k.key)).length === 1);
  check('восстановление после конфликта', arch('rebuild').code === 0);

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

  // ---------------------------------------------------------- 10
  console.log('\n▸ 10. Вытеснение до архивации');
  gen(20, 's10-lost');
  inCt('journalctl --rotate && journalctl --vacuum-files=1 >/dev/null 2>&1; true');
  gen(5, 's10-after');
  const r10 = arch('run');
  check(
    'потеря обнаружена и отмечена',
    r10.code === 0 && r10.out.includes('ПОТЕРЯ'),
    r10.out.split('\n').find((l) => l.includes('ПОТЕРЯ')) ?? r10.out,
  );
  check(
    'в каталоге — отметка потери',
    catalog().some((r) => r.kind === 'loss'),
  );
  await chainCheck('10');
  verifyOk('10');
} catch (error) {
  failed++;
  console.log(`  FAIL  испытание прервано: ${error.message}`);
} finally {
  await cleanup();
}
console.log(`\nИтог: пройдено ${passed}, провалено ${failed}`);
process.exit(failed ? 1 : 0);
