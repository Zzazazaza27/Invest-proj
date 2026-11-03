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
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { loadEnv, ROOT } from './lib/backup.mjs';
import { garageApi } from './lib/garage-admin.mjs';
import { PORTS } from './lib/ports.mjs';
import { contiguousChain, parseChunkKey, receiptKey } from './lib/logs-archive.mjs';
import { LOGS_ITEMS, logsTriggers } from './lib/logs-metrics-zabbix.mjs';
import { s3Object } from './lib/s3.mjs';

loadEnv();
const keep = process.argv.includes('--keep');
const tag = randomBytes(3).toString('hex');
const CT = `jtb-${tag}`;
const BUCKET = `tech-logs-test-${tag}`;
// Ключи Garage (D-001): GK + 24 hex и секрет 64 hex.
const gk = () => `GK${randomBytes(12).toString('hex')}`;
const gsec = () => randomBytes(32).toString('hex');
const USER = gk();
const USER_SECRET = gsec();
const READER = gk();
const READER_SECRET = gsec();
// Бакет накопленной истории — свои учётки и ключ.
const LBUCKET = `tech-logs-legacy-test-${tag}`;
const LWRITER = gk();
const LWRITER_SECRET = gsec();
const LREADER = gk();
const LREADER_SECRET = gsec();
// Ключ владельца обоих бакетов — только для порчи данных испытаниями.
const ROOT_KEY = gk();
const ROOT_SECRET = gsec();
const LKEY = randomBytes(32).toString('hex');
const IMAGE = 'fifth/journald-testbed:local';
const NETWORK = 'unicorn-launch_default';

const root = {
  endpoint: `http://127.0.0.1:${PORTS.garageS3}`,
  bucket: BUCKET,
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
  });
  if (r.status !== 0 && !allowFail) {
    throw new Error(
      `${cmd} ${args.slice(0, 3).join(' ')}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`,
    );
  }
  return r;
}

const ARCH_ENV = {
  LOGS_S3_ENDPOINT: 'http://unicorn-garage-1:3900',
  LOGS_S3_REGION: process.env.S3_REGION || 'us-east-1',
  LOGS_S3_BUCKET: BUCKET,
  LOGS_S3_ACCESS_KEY_ID: USER,
  LOGS_S3_SECRET_ACCESS_KEY: USER_SECRET,
  LOGS_ARCHIVE_KEY: randomBytes(32).toString('hex'),
  LOGS_STATE_DIR: '/var/lib/fifth-logs-test',
  LOGS_MAX_CHUNK_BYTES: '6000',
};

function arch(command, extra = {}, args = []) {
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
      ...args,
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

/**
 * Объект под ключом: [] или [{key, versionId, body}] — версий у Garage нет,
 * «версия» — SHA-256 байтов (как у архиватора).
 */
async function versionsOf(key, store = root) {
  const r = await s3Object(store, 'GET', key);
  if (r.status !== 200) return [];
  const body = Buffer.from(await r.arrayBuffer());
  return [{ key, versionId: createHash('sha256').update(body).digest('hex'), body }];
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

async function cleanup() {
  if (keep) {
    console.log(`\n(--keep: оставлены контейнер ${CT}, бакет ${BUCKET})`);
    return;
  }
  sh('docker', ['rm', '-f', CT], { allowFail: true });
  // Бакеты опустошаются ключом владельца и удаляются, ключи — через admin API.
  for (const b of [BUCKET, LBUCKET]) {
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
  for (const k of [USER, READER, LWRITER, LREADER, ROOT_KEY]) {
    await garageApi('DeleteKey', {}, `?id=${k}`).catch(() => undefined);
  }
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
  // Бакеты и ключи заводит НАСТОЯЩИЙ шаг стенда garage-init (Garage, D-001) —
  // испытывается то, что применится на VPS.
  const init = sh(process.execPath, ['scripts/garage-init.mjs'], {
    env: {
      LOGS_S3_BUCKET: BUCKET,
      LOGS_S3_ACCESS_KEY_ID: USER,
      LOGS_S3_SECRET_ACCESS_KEY: USER_SECRET,
      LOGS_READER_ACCESS_KEY_ID: READER,
      LOGS_READER_SECRET_ACCESS_KEY: READER_SECRET,
      LOGS_LEGACY_S3_BUCKET: LBUCKET,
      LOGS_LEGACY_WRITER_ACCESS_KEY_ID: LWRITER,
      LOGS_LEGACY_WRITER_SECRET_ACCESS_KEY: LWRITER_SECRET,
      LOGS_LEGACY_READER_ACCESS_KEY_ID: LREADER,
      LOGS_LEGACY_READER_SECRET_ACCESS_KEY: LREADER_SECRET,
    },
    allowFail: true,
  });
  check(
    'garage-init: бакеты журналов и истории, ключи записи и чтения',
    init.status === 0 &&
      init.stdout.includes(`бакет ${BUCKET}: создан`) &&
      init.stdout.includes(`бакет ${LBUCKET}: создан`) &&
      init.stdout.includes(`права записи журналов на ${BUCKET}: read+write`) &&
      init.stdout.includes(`права чтения журналов на ${BUCKET}: read`),
    (init.stdout + init.stderr)
      .trim()
      .split('\n')
      .filter((l) => /журнал|бакет|ОШИБ|Error/i.test(l))
      .join(' | '),
  );
  // Ключ владельца обоих бакетов — для порчи данных испытаниями.
  await garageApi('ImportKey', {
    accessKeyId: ROOT_KEY,
    secretAccessKey: ROOT_SECRET,
    name: `logs-test-root-${tag}`,
  });
  for (const b of [BUCKET, LBUCKET]) {
    const info = await garageApi('GetBucketInfo', undefined, `?globalAlias=${b}`);
    await garageApi('AllowBucketKey', {
      bucketId: info.id,
      accessKeyId: ROOT_KEY,
      permissions: { read: true, write: true, owner: true },
    });
  }
  // Права по фактам Garage: ключ записи пишет и читает свой бакет, а право
  // записи включает удаление — подмену и удаление архив обнаруживает, а не
  // запрещает; ключ чтения только читает; чужой бакет не виден.
  const asUser = (who, secret) => ({ ...root, accessKey: who, secretKey: secret });
  const wr = asUser(USER, USER_SECRET);
  const rd = asUser(READER, READER_SECRET);
  const put = await s3Object(wr, 'PUT', 'probe/права', Buffer.from('x'));
  const denied = async (who, method, key, body = null, query = {}) =>
    (await s3Object(who, method, key, body, {}, query)).status === 403;
  check(
    'ключ чтения: читает; писать и удалять — нельзя',
    put.status === 200 &&
      (await s3Object(rd, 'GET', 'probe/права')).status === 200 &&
      (await denied(rd, 'PUT', 'probe/чтение', Buffer.from('x'))) &&
      (await denied(rd, 'DELETE', 'probe/права')),
  );
  const del = await s3Object(wr, 'DELETE', 'probe/права');
  check(
    'ключ записи: удаление разрешено (Garage) — защита архива обнаружением',
    del.status === 204,
    `HTTP ${del.status}`,
  );
  console.log(`стенд: ${CT}, бакет ${BUCKET} (Garage, без версий)`);

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

  // ---------------------------------------------------------- L
  console.log('\n▸ L. Накопленная история: свой бакет и ключ, до границы основного архива');
  const anchorKey = (await allKeysUnder('anchors/'))[0];
  const mainAnchor = JSON.parse(await (await rootReq('GET', anchorKey)).text());
  const LSTATE = '/var/lib/fifth-logs-legacy-test';
  const LEG = {
    LOGS_S3_BUCKET: LBUCKET,
    LOGS_S3_ACCESS_KEY_ID: LWRITER,
    LOGS_S3_SECRET_ACCESS_KEY: LWRITER_SECRET,
    LOGS_ARCHIVE_KEY: LKEY,
    LOGS_STATE_DIR: LSTATE,
    LOGS_UNTIL_CURSOR: mainAnchor.afterCursor,
  };
  const lroot = { ...root, bucket: LBUCKET };
  const lkeys = async (prefix) => {
    const r = await s3Object(lroot, 'GET', '', null, {}, { 'list-type': '2', prefix });
    return [...(await r.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
  };
  // «Журнал Docker json-file» с секретом, ещё пишущийся (свежий).
  const DOCKER_LOG = '/var/lib/docker-test/c1/c1-json.log';
  inCt(
    `mkdir -p /var/lib/docker-test/c1 && printf '%s\\n' '{"log":"password=${tag}"}' > ${DOCKER_LOG}`,
  );
  const l1 = arch('legacy-export', { ...LEG, LOGS_LEGACY_FILES: DOCKER_LOG });
  const lcat = () =>
    inCt(`cat ${LSTATE}/catalog.jsonl 2>/dev/null || true`)
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const lastL = lcat().reduce((m, r) => (BigInt(r.last) > m ? BigInt(r.last) : m), 0n);
  check(
    'история выгружена ровно до границы основного архива включительно',
    // Код 2: файл — не журнал Docker и не поколение, остановка источника не
    // подтверждена; journald выгружен полностью.
    l1.code === 2 && lastL === BigInt(mainAnchor.afterSeq) && /журнал \w+: записи 1–/.test(l1.out),
    `${l1.out.split('\n').find((l) => l.startsWith('журнал')) ?? l1.out.split('\n').at(-1)}; граница ${mainAnchor.afterSeq}`,
  );
  // Журнал контейнера без дыр в нумерации: пробелов быть не должно (первая
  // версия теряла запись 1 — --after-cursor с курсором «ID + номер»).
  check(
    'с первой записи журнала, без ложных пробелов',
    /пробелов 0 \(записей 0\)/.test(l1.out) && !lcat().some((r) => r.kind === 'loss'),
    l1.out.split('\n').find((l) => l.startsWith('журнал')),
  );
  const lf = (await lkeys('f/')).filter((k) => k.includes('docker-test'));
  const mf = (await allKeysUnder('f/')).filter((k) => k.includes('docker-test'));
  check(
    'журнал Docker (ещё пишущийся) — только в бакете истории',
    lf.length === 1 && mf.length === 0,
    `история ${lf.length}, основной ${mf.length}`,
  );
  const l2 = arch('legacy-export', { ...LEG, LOGS_LEGACY_FILES: DOCKER_LOG });
  check(
    'повтор выгрузки — ничего нового',
    l2.code === 2 &&
      /проход: порций 0/.test(l2.out) &&
      /файлы истории: записано 0, уже в архиве 1/.test(l2.out),
    l2.out
      .split('\n')
      .filter((l) => /проход|файлы истории/.test(l))
      .join(' | '),
  );
  const lv = arch('verify', LEG);
  check(
    'verify истории своим ключом',
    lv.code === 0 && /ИТОГ: (данные сохранены полностью|проверка пройдена)/.test(lv.out),
    lv.out.split('\n').find((l) => l.startsWith('ИТОГ')) ?? lv.out.split('\n')[0],
  );
  const LPULL = `/tmp/lpull-${tag}`;
  const lp = arch('pull', {
    ...LEG,
    LOGS_S3_ACCESS_KEY_ID: LREADER,
    LOGS_S3_SECRET_ACCESS_KEY: LREADER_SECRET,
    LOGS_PULL_TO: LPULL,
  });
  check(
    'ручная копия истории учёткой чтения истории, сходится',
    lp.code === 0 &&
      /файлов: 1/.test(lp.out) &&
      /ИТОГ: (данные сохранены полностью|копия сошлась)/.test(lp.out),
    lp.out.split('\n').at(-1),
  );
  const lwrong = arch('verify-copy', { LOGS_PULL_TO: LPULL });
  check('копия истории не открывается ключом основного архива', lwrong.code !== 0, lwrong.out);
  inCt(`rm -rf ${LPULL}`);
  // Живой журнал Docker: снимок до границы, проверка покрытия (замечание
  // Тэнка: readFileSync изменяемого файла не доказывает полноту).
  const coverOf = (out) =>
    out.split('\n').find((l) => l.startsWith(`история: ${DOCKER_LOG}`)) ?? '';
  const dockerLog = (name) =>
    inCt(
      `printf '%s\\n' '{"log":"${name} 1","time":"2026-11-01T10:00:00Z"}' '{"log":"${name} 2","time":"2026-11-01T10:05:00Z"}' > ${DOCKER_LOG}`,
    );
  dockerLog(`quiet-${tag}`);
  const lq = arch('legacy-export', { ...LEG, LOGS_LEGACY_FILES: DOCKER_LOG });
  check(
    'стабильный файл без подтверждённой остановки — не «покрыт целиком» (код 2)',
    lq.code === 2 &&
      /строк 2, время 2026-11-01T10:00:00Z–2026-11-01T10:05:00Z; стабильный снимок до границы, НЕПОЛНО: остановка источника не подтверждена/.test(
        coverOf(lq.out),
      ),
    coverOf(lq.out),
  );
  // Поколение после ротации закрыто по имени — покрыто целиком.
  inCt(
    `cp ${DOCKER_LOG} ${DOCKER_LOG}.1 && printf '%s\\n' '{"log":"gen-${tag}"}' >> ${DOCKER_LOG}.1`,
  );
  const lc = arch('legacy-export', { ...LEG, LOGS_LEGACY_FILES: `${DOCKER_LOG}.1` });
  check(
    'закрытое поколение: граница, строки и время записаны, покрыто целиком',
    lc.code === 0 &&
      /стабильный снимок, источник остановлен — покрыт целиком/.test(lc.out) &&
      lc.out.includes('ИТОГ: история файлов покрыта полностью'),
    lc.out.split('\n').find((l) => l.startsWith('история: /')),
  );
  inCt(`rm -f ${DOCKER_LOG}.1`);
  dockerLog(`cut-${tag}`);
  inCt(`printf '%s' '{"log":"оборвано' >> ${DOCKER_LOG}`);
  const lcut = arch('legacy-export', { ...LEG, LOGS_LEGACY_FILES: DOCKER_LOG });
  check(
    'оборванная последняя запись — вне границы, история НЕПОЛНА (код 2)',
    lcut.code === 2 &&
      /строк 2,.*НЕПОЛНО: после границы \d+ байт/.test(coverOf(lcut.out)) &&
      lcut.out.includes('локальную историю не очищать'),
    coverOf(lcut.out),
  );
  dockerLog(`append-${tag}`);
  const lapp = arch('legacy-export', {
    ...LEG,
    LOGS_LEGACY_FILES: DOCKER_LOG,
    LOGS_TEST_LEGACY_MUTATE: 'append',
  });
  check(
    'дописывание во время копирования: снимок до границы, хвост учтён, НЕПОЛНА',
    lapp.code === 2 &&
      /строк 2,.*НЕПОЛНО: после границы \d+ байт/.test(coverOf(lapp.out)) &&
      /файлы истории: записано 1/.test(lapp.out),
    coverOf(lapp.out),
  );
  dockerLog(`rotate-${tag}`);
  const lrot = arch('legacy-export', {
    ...LEG,
    LOGS_LEGACY_FILES: DOCKER_LOG,
    LOGS_TEST_LEGACY_MUTATE: 'rotate',
  });
  check(
    'ротация во время копирования: обнаружена, НЕПОЛНА',
    lrot.code === 2 && /ротация во время копирования/.test(coverOf(lrot.out)),
    coverOf(lrot.out),
  );
  inCt(`rm -f ${DOCKER_LOG}.1`);
  dockerLog(`trunc-${tag}`);
  const ltr = arch('legacy-export', {
    ...LEG,
    LOGS_LEGACY_FILES: DOCKER_LOG,
    LOGS_TEST_LEGACY_MUTATE: 'truncate',
  });
  check(
    'усечение во время копирования: снимок не принят и не записан',
    ltr.code === 2 &&
      /снимок не принят/.test(coverOf(ltr.out)) &&
      /файлы истории: записано 0/.test(ltr.out),
    coverOf(ltr.out),
  );
  // Покрытие записано в квитанцию: источник, граница, файл (inode).
  const rcKey = (await lkeys('rf/')).at(-1);
  const rc = JSON.parse(await (await s3Object(lroot, 'GET', rcKey, null, {})).text());
  check(
    'покрытие в квитанции: путь, граница, inode, полнота',
    rc.snapshot?.path === DOCKER_LOG &&
      Number.isInteger(rc.snapshot?.boundary) &&
      Number.isInteger(rc.snapshot?.ino) &&
      typeof rc.snapshot?.complete === 'boolean',
    JSON.stringify(rc.snapshot ?? null),
  );
  const deny = async (who, secret, bucket) =>
    (
      await s3Object(
        { ...root, bucket, accessKey: who, secretKey: secret },
        'GET',
        '',
        null,
        {},
        { 'list-type': '2' },
      )
    ).status === 403;
  check(
    'учётки разделены: основной архив не видит историю, история — основной архив',
    (await deny(READER, READER_SECRET, LBUCKET)) &&
      (await deny(USER, USER_SECRET, LBUCKET)) &&
      (await deny(LREADER, LREADER_SECRET, BUCKET)) &&
      (await deny(LWRITER, LWRITER_SECRET, BUCKET)),
  );

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
    'объект под ключом — прежнее содержимое (повтор не перезаписал)',
    before.length === 1 && (await versionsOf(pendingKey))[0]?.versionId === before[0].versionId,
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
  await rootReq('DELETE', mid.key);
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
  console.log('\n▸ 8. Перезапись объекта под ключом (Garage: запретить нельзя — обнаружить)');
  gen(10, 's8');
  check('проход', arch('run').code === 0);
  const k = catalog().at(-1);
  const [original8] = await versionsOf(k.key);
  // Ключ записи может перезаписать порцию — даже с «правильным» исходным
  // хешем в метаданных.
  const rogue = await rootReq('PUT', k.key, {}, Buffer.from('чужая порция'), {
    'x-amz-meta-plain-sha256': k.plainSha,
    'x-amz-meta-object-sha256': k.objSha,
  });
  check('порция перезаписана (ключ владельца)', rogue.ok);
  const v8 = arch('verify');
  check(
    'verify: перезапись обнаружена — порция не та, что в квитанции',
    v8.code !== 0 && v8.out.includes(`${k.key}@${k.versionId}: нет или не расшифровано`),
    v8.out.split('\n').find((l) => l.includes(k.key)) ?? v8.out.split('\n')[0],
  );
  await rootReq('PUT', k.key, {}, original8.body, { 'x-amz-meta-object-sha256': k.objSha });
  verifyOk('8 — исходная порция возвращена');

  // ---------------------------------------------------------- 7
  console.log('\n▸ 7. Конфликт: под ключом только чужая порция');
  const stateBefore = inCt(`cat ${ARCH_ENV.LOGS_STATE_DIR}/state.json`);
  const catBefore = inCt(`cat ${ARCH_ENV.LOGS_STATE_DIR}/catalog.jsonl`);
  gen(10, 's7');
  check('проход', arch('run').code === 0);
  const c = catalog().at(-1);
  await rootReq('DELETE', c.key);
  const rogue7 = await rootReq('PUT', c.key, {}, Buffer.from('чужая порция'), {
    'x-amz-meta-plain-sha256': c.plainSha,
  });
  const rogueSha7 = createHash('sha256').update(Buffer.from('чужая порция')).digest('hex');
  check(
    'под ключом чужая порция (ключ владельца)',
    rogue7.ok && (await versionsOf(c.key))[0]?.versionId === rogueSha7,
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
  check('конфликт: без перезаписи', (await versionsOf(c.key))[0]?.versionId === rogueSha7);
  await rootReq('DELETE', c.key);
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
  inCt(`f=$(ls ${PULL}/packs/*.pack | head -1); node /src/scripts/lib/flip-byte.mjs "$f" 40`);
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
  // Перезапись пакета (Garage: запретить нельзя) обнаруживается: пакет не
  // тот, что в квитанции; после возврата исходного — копия снова сходится.
  const packObj = (await allKeysUnder('p/'))[0];
  const [packOrig] = await versionsOf(packObj);
  await rootReq('PUT', packObj, {}, Buffer.from('чужой пакет'));
  inCt(`rm -f ${PULL}/packs/*.pack`);
  const p6bad = pull();
  check(
    'перезапись пакета обнаружена — копия НЕ сошлась, пакет назван',
    p6bad.code !== 0 && p6bad.out.includes('пакет'),
    p6bad.out.split('\n').find((l) => l.includes('пакет ')) ?? p6bad.out.split('\n').at(-1),
  );
  await rootReq('PUT', packObj, {}, packOrig.body, {
    'x-amz-meta-object-sha256': packOrig.versionId,
  });
  inCt(`rm -f ${PULL}/packs/*.pack`);
  const p6 = pull();
  check(
    'исходный пакет возвращён — копия сошлась',
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
  inCt(`node /src/scripts/lib/flip-byte.mjs ${PULL}/MANIFEST.sealed 30`);
  const o8 = offline(PULL);
  check('порча описи копии обнаружена', o8.code !== 0 && o8.out.includes('опись копии'), o8.out);
  inCt(`rm -rf ${PULL}`);
  // Исходная порция исчезла, но её точная версия — в исправном пакете.
  const byFirst = (a, b) => (BigInt(a.first) < BigInt(b.first) ? -1 : 1);
  const packedFirst = catalog()
    .filter((r) => r.kind === 'chunk')
    .sort(byFirst)[0];
  await rootReq('DELETE', packedFirst.key);
  pullCase('P-пакет', 'full');
  // Обратная проверка: без исправного пакета та же порция — утрата архива.
  const PK = `/tmp/pk-${tag}`;
  arch('pull', { ...asReader, LOGS_PULL_TO: PK });
  inCt(`f=$(ls ${PK}/packs/*.pack | head -1); node /src/scripts/lib/flip-byte.mjs "$f" 40`);
  const oPk = offline(PK);
  check(
    'исчезнувшую порцию покрывал именно пакет: при порче пакета — утрата',
    oPk.code !== 0 &&
      oPk.out.includes(`отрезок ${packedFirst.first}–${packedFirst.last}: квитанция есть`),
    oPk.out.split('\n').find((l) => l.includes(`отрезок ${packedFirst.first}`)) ??
      copyLine(oPk.out),
  );
  inCt(`rm -rf ${PK}`);

  // ---------------------------------------------------------- E
  console.log('\n▸ E. Файлы почты: закрытые поколения, без повторов по содержимому');
  const MAIL = '/var/log/tmail';
  const FENV = { LOGS_FILES: `${MAIL}/mainlog` };
  const SRC = 'var_log_tmail_mainlog';
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  const filesRun = (extra = {}) => arch('files', { ...FENV, ...extra });
  const storedOf = (out) => Number(out.match(/записано (\d+)/)?.[1] ?? -1);
  const fileKeys = async () => (await allKeysUnder('f/')).filter((k) => k.endsWith('.fx'));
  const old = (p) => `touch -d '-1 hour' ${p}`;
  const T = {
    live: `живой ${tag}\n`,
    g1: `поколение 1 ${tag}\n`.repeat(50),
    g2: `поколение 2 ${tag}\n`.repeat(50),
    fresh: `свежее ${tag}\n`,
    g4: `поколение 4 ${tag}\n`.repeat(20),
  };
  inCt(
    `mkdir -p ${MAIL} && cd ${MAIL} && printf '%s' '${T.live}' > mainlog && printf '%s' '${T.g1}' > mainlog.1 && printf '%s' '${T.g2}' | gzip -c > mainlog.2.gz && printf '%s' '${T.fresh}' > mainlog.5 && printf 'x' > mainlog.bak && : > mainlog.6 && ${old('mainlog.1')} && ${old('mainlog.2.gz')} && ${old('mainlog.6')}`,
  );
  const e1 = filesRun();
  const k1 = await fileKeys();
  check(
    'закрытые поколения (.1, .2.gz) записаны; живой, свежий, пустой и посторонний — нет',
    e1.code === 0 &&
      storedOf(e1.out) === 2 &&
      k1.length === 2 &&
      k1.includes(`f/${SRC}/${sha(T.g1)}.fx`) &&
      k1.includes(`f/${SRC}/${sha(T.g2)}.fx`),
    `${e1.out.split('\n').at(-1)}; ${k1.length} объектов`,
  );
  const e2 = filesRun();
  check(
    'повтор — ничего нового',
    e2.code === 0 && storedOf(e2.out) === 0,
    e2.out.split('\n').at(-1),
  );
  // Ротация: .2.gz → .3.gz, .1 → .2.gz (сжатие), живой → .1, новый живой.
  inCt(
    `cd ${MAIL} && mv mainlog.2.gz mainlog.3.gz && gzip -c mainlog.1 > mainlog.2.gz && rm mainlog.1 && mv mainlog mainlog.1 && printf 'новый' > mainlog && ${old('mainlog.1')} && ${old('mainlog.2.gz')} && ${old('mainlog.3.gz')}`,
  );
  const e3 = filesRun();
  check(
    'после ротации записан только бывший живой; переименованные и сжатые узнаны по содержимому',
    e3.code === 0 && storedOf(e3.out) === 1 && (await fileKeys()).length === 3,
    e3.out.split('\n').at(-1),
  );
  // Конфликт: под ключом будущего поколения — чужое содержимое.
  const k4 = `f/${SRC}/${sha(T.g4)}.fx`;
  await rootReq('PUT', k4, {}, Buffer.from('чужое'));
  inCt(`cd ${MAIL} && printf '%s' '${T.g4}' > mainlog.4 && ${old('mainlog.4')}`);
  const e4 = filesRun();
  check(
    'чужое содержимое под ключом — КОНФЛИКТ без перезаписи',
    e4.code !== 0 && e4.out.includes('КОНФЛИКТ') && (await versionsOf(k4)).length === 1,
    e4.out.split('\n').find((l) => l.includes('КОНФЛИКТ')) ?? e4.out,
  );
  await rootReq('DELETE', k4);
  // Падение после записи, до квитанции: повтор подтверждает по содержимому.
  const e5 = filesRun({ LOGS_TEST_CRASH: 'file-after-put' });
  const e6 = filesRun();
  check(
    'падение после записи, до квитанции — повтор без второй версии',
    e5.code === 96 &&
      e6.code === 0 &&
      storedOf(e6.out) === 1 &&
      (await versionsOf(k4)).length === 1,
    `код ${e5.code}; ${e6.out.split('\n').at(-1)}; версий ${(await versionsOf(k4)).length}`,
  );
  // verify здесь красный из-за порции, удалённой в P (восполняется в 11), —
  // проверяются только файлы: все 4 прочитаны, проблем по ним нет.
  const vE = arch('verify');
  check(
    'verify проверяет и файлы',
    /файлов: 4/.test(vE.out) && !/^\s+файл /m.test(vE.out),
    vE.out.split('\n')[0],
  );
  const FE = `/tmp/fe-${tag}`;
  const pE = arch('pull', { ...asReader, LOGS_PULL_TO: FE });
  const oE = offline(FE);
  check(
    'файлы в ручной копии; проверка копии без S3 их сверяет',
    pE.code === 0 && /файлов: 4/.test(pE.out) && oE.code === 0 && /файлов: 4/.test(oE.out),
    copyLine(oE.out),
  );
  inCt(`node /src/scripts/lib/flip-byte.mjs $(ls ${FE}/files/* | head -1) 40`);
  const oE2 = offline(FE);
  check(
    'порча файла в копии обнаружена',
    oE2.code !== 0 && oE2.out.includes('копия не сошлась с квитанцией'),
    oE2.out.split('\n').find((l) => l.includes('файл ')) ?? copyLine(oE2.out),
  );
  inCt(`rm -rf ${FE}`);
  // Источник отсутствует или недоступен — ошибка по этому источнику, его
  // время успеха не обновляется; исправный источник рядом не скрывает её
  // (замечание Тэнка: files с несуществующим каталогом давал код 0).
  const okAt = (base) =>
    JSON.parse(inCt(`cat ${ARCH_ENV.LOGS_STATE_DIR}/files.json`)).sources?.[base] ?? {};
  const GONE = '/var/log/tmail-gone/mainlog';
  const eM = filesRun({ LOGS_FILES: `${MAIL}/mainlog,${GONE}` });
  check(
    'несуществующий каталог источника: ошибка, у исправного — успех',
    eM.code !== 0 &&
      eM.out.includes(`источник ${GONE}: ОТСУТСТВУЕТ`) &&
      okAt(GONE).state === 'missing' &&
      okAt(GONE).lastOkAt === null &&
      okAt(`${MAIL}/mainlog`).state === 'ok',
    eM.out.split('\n').at(-1),
  );
  // Каталог есть, а файла журнала и поколений нет — ошибка пути.
  const NOFILE = `${MAIL}/nosuchlog`;
  const eN = filesRun({ LOGS_FILES: NOFILE });
  check(
    'каталог есть, журнала нет — ОТСУТСТВУЕТ',
    eN.code !== 0 && okAt(NOFILE).state === 'missing',
    eN.out.split('\n').at(-1),
  );
  // Недоступен: время успеха прежнее, не текущее. На месте каталога — файл
  // (под root права не мешают чтению, ENOTDIR — тот же класс ошибки).
  const prevOk = okAt(`${MAIL}/mainlog`).lastOkAt;
  inCt(`mv ${MAIL} ${MAIL}.bak && printf x > ${MAIL}`);
  const eU = filesRun();
  check(
    'источник недоступен: ошибка, время успеха не обновлено',
    eU.code !== 0 &&
      eU.out.includes('НЕДОСТУПЕН') &&
      okAt(`${MAIL}/mainlog`).state === 'unavailable' &&
      okAt(`${MAIL}/mainlog`).lastOkAt === prevOk,
    eU.out.split('\n').at(-1),
  );
  inCt(`rm -f ${MAIL} && mv ${MAIL}.bak ${MAIL}`);
  check(
    'источник вернулся — успех',
    filesRun().code === 0 && okAt(`${MAIL}/mainlog`).state === 'ok',
  );

  // ---------------------------------------------------------- F
  console.log('\n▸ F. Поиск: архив по каталогу, свежее из journald, копия без S3');
  const emit = (n, obj) =>
    inCt(
      `for i in $(seq 1 ${n}); do echo '${JSON.stringify(obj)}' | systemd-cat -t w08b-json; done; sleep 1`,
    );
  const findOut = (args, extra = {}) => arch('find', { ...asReader, ...extra }, args.split(' '));
  const foundOf = (out) => Number(out.match(/найдено: (\d+)/)?.[1] ?? -1);
  const tF = new Date().toISOString();
  emit(3, { requestId: `A-${tag}`, code: 'ok' });
  emit(2, { requestId: `B-${tag}`, code: `conflict-${tag}`, status: 409 });
  check('проход', arch('run').code === 0);
  emit(2, { requestId: `C-${tag}`, code: 'ok' });
  const fA = findOut(`--from ${tF} --request-id A-${tag}`);
  check(
    'по ID запроса — из архива, ровно свои записи',
    fA.code === 0 && foundOf(fA.out) === 3 && !/порций архива: 0/.test(fA.out),
    fA.out.split('\n').at(-1),
  );
  const fC = findOut(`--from ${tF} --request-id C-${tag}`);
  check(
    'свежие, ещё не в архиве — из journald',
    fC.code === 0 && foundOf(fC.out) === 2 && !/свежих записей journald: 0/.test(fC.out),
    fC.out.split('\n').at(-1),
  );
  const fB = findOut(`--from ${tF} --code conflict-${tag}`);
  const f409 = findOut(`--from ${tF} --code 409 --source w08b-json`);
  check(
    'по коду результата и по HTTP-статусу',
    foundOf(fB.out) === 2 && foundOf(f409.out) === 2,
    `${foundOf(fB.out)} / ${foundOf(f409.out)}`,
  );
  const fS = findOut(`--from ${tF} --source w08b-json`);
  check('по источнику — все 7', foundOf(fS.out) === 7, fS.out.split('\n').at(-1));
  const fW = findOut(
    `--from ${new Date(Date.now() + 3_600_000).toISOString()} --to ${new Date(Date.now() + 7_200_000).toISOString()} --request-id A-${tag}`,
  );
  check(
    'вне интервала — ничего',
    fW.code === 0 && foundOf(fW.out) === 0,
    fW.out.split('\n').at(-1),
  );
  // Порция, удалённая из архива в P (её точная версия — только в пакете),
  // задевает интервал раньше tF: поиск на сервере неполон и называет её.
  const fLost = findOut(`--from ${new Date(Date.parse(tF) - 3_600_000).toISOString()} --to ${tF}`);
  check(
    'утраченная в архиве порция в интервале — поиск НЕПОЛОН, порция названа',
    fLost.code !== 0 &&
      fLost.out.includes(`порция ${packedFirst.first}–${packedFirst.last}: не прочитана`),
    fLost.out
      .split('\n')
      .filter((l) => l.includes('порция') || l.startsWith('ИТОГ'))
      .join(' | '),
  );
  const fBad = findOut('--from вчера');
  check('неверное время — отказ, а не поиск по всему', fBad.code !== 0, fBad.out);
  // По копии на ноутбуке, без S3 и journald.
  check('проход', arch('run').code === 0);
  const FC = `/tmp/fc-${tag}`;
  arch('pull', { ...asReader, LOGS_PULL_TO: FC });
  sh('docker', ['network', 'disconnect', NETWORK, CT]);
  let fCopy;
  try {
    fCopy = findOut(`--copy ${FC} --from ${tF} --source w08b-json`, {
      LOGS_S3_ACCESS_KEY_ID: '',
      LOGS_S3_SECRET_ACCESS_KEY: '',
    });
  } finally {
    sh('docker', ['network', 'connect', NETWORK, CT]);
  }
  check(
    'по копии без S3 — те же 7',
    fCopy.code === 0 && foundOf(fCopy.out) === 7 && fCopy.out.includes('(копия)'),
    fCopy.out.split('\n').at(-1),
  );
  inCt(`for f in ${FC}/chunks/*; do node /src/scripts/lib/flip-byte.mjs "$f" 40; done`);
  const fBroken = findOut(`--copy ${FC} --from ${tF} --source w08b-json`);
  check(
    'испорченная порция копии — поиск НЕПОЛОН, а не «ничего не найдено»',
    fBroken.code !== 0 && fBroken.out.includes('ИТОГ: поиск НЕПОЛОН'),
    fBroken.out.split('\n').at(-1),
  );
  inCt(`rm -rf ${FC}`);

  // ---------------------------------------------------------- 11
  console.log('\n▸ 11. Утрата первой порции архива + потеря состояния (journald ещё хранит)');
  const firstChunk = catalog()
    .filter((r) => r.kind === 'chunk')
    .sort(byFirst)[0];
  check(
    'первая порция начинается сразу за границей',
    BigInt(firstChunk.first) === (await anchorStart()),
  );
  await rootReq('DELETE', firstChunk.key);
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
  const t10 = new Date().toISOString();
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
  const f10 = findOut(`--from ${t10} --source w08b-test`);
  check(
    'поиск по интервалу с вытесненными записями называет потерю',
    f10.code === 0 &&
      /учтённых потерь в интервале: [1-9]/.test(f10.out) &&
      f10.out.includes('journald-vacuumed'),
    f10.out
      .split('\n')
      .filter((l) => /найдено|потеря/.test(l))
      .join(' | '),
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
    await rootReq('DELETE', ch.key);
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
      await rootReq('DELETE', ch.key);
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

  // ---------------------------------------------------------- M
  console.log('\n▸ M. Файл состояния для Zabbix: счётчики, очередь, подавление, без текстов');
  const metrics = () => JSON.parse(inCt(`cat ${ARCH_ENV.LOGS_STATE_DIR}/metrics.json`));
  const LIMIT = { LOGS_JOURNAL_MAX_BYTES: String(4 * 1024 ** 3) };
  const emitRaw = (n, text, ident) =>
    inCt(`for i in $(seq 1 ${n}); do echo '${text}' | systemd-cat -t ${ident}; done; sleep 1`);
  const http = (o) =>
    JSON.stringify({ level: 'log', component: 'core', ctx: 'http', result: 'ok', ...o });
  emitRaw(3, http({ status: 200 }), 'm-core');
  emitRaw(2, http({ level: 'error', status: 503, code: 'internal', result: 'error' }), 'm-core');
  emitRaw(1, http({ status: 200, code: `refused-${tag}` }), 'm-core');
  emitRaw(1, `Out of memory: Killed process 4242 (node-${tag})`, 'kernel');
  emitRaw(1, `fifth-${tag}.service: Main process exited, code=dumped, status=6/ABRT`, 'systemd');
  check('проход', arch('run', LIMIT).code === 0);
  const m1 = metrics();
  const h = m1.lastHour;
  check(
    'счётчики часа — ровно по записям: запросы, 5xx, отказ внутри 2xx, ошибки по компонентам и кодам',
    h.requests === 6 &&
      h.s5xx === 2 &&
      h.fail2xx === 1 &&
      h.errors.core === 2 &&
      h.codes.internal === 2,
    JSON.stringify({ r: h.requests, s5xx: h.s5xx, f2xx: h.fail2xx, e: h.errors, c: h.codes }),
  );
  check('OOM и аварийное завершение', h.oom === 1 && h.crashes === 1, `${h.oom} / ${h.crashes}`);
  // Предобработка Zabbix на этом файле: свежий — значения, устаревший —
  // ошибка («неизвестно»), а не нули. Код — ES5 (Duktape).
  // Выполняется код предобработки из scripts/lib/logs-metrics-zabbix.mjs
  // (константы репозитория), а не данные извне — так его выполнит Zabbix.
  // Отдельный контекст без доступа к модулям — как песочница Zabbix.
  const zbx = (x, s) => runInNewContext(`(function (value) { ${x.js} })`, {})(JSON.stringify(s));
  const byKey = Object.fromEntries(LOGS_ITEMS.map((x) => [x.key, x]));
  const UNKNOWN = Symbol('неизвестно');
  /** Значение проверки или UNKNOWN (ошибка предобработки → «не поддерживается»). */
  const val = (key, s) => {
    try {
      return zbx(byKey[key], s);
    } catch {
      return UNKNOWN;
    }
  };
  const show = (v) => (v === UNKNOWN ? 'неизвестно' : JSON.stringify(v));
  // Счёт только что начат: час не полон, база не накоплена — это не нули.
  check(
    'счёт начат меньше часа назад: приток часа и база — «не измерено», запас — без скорости',
    m1.run.ok &&
      m1.queue.entries === 0 &&
      m1.journald.usageBytes > 0 &&
      m1.inflow.lastHourBytes === null &&
      m1.inflow.baselineReady === false &&
      m1.journald.fillState === 'no-rate' &&
      m1.journald.fillHours === null,
    JSON.stringify({ q: m1.queue, i: m1.inflow, j: m1.journald }),
  );
  const fresh1 = {
    'logs.file.problem': '',
    'logs.run.failure': '',
    'logs.queue.lag': 0,
    'logs.http.requests': 6,
    'logs.http.5xx_share': 33.3,
    'logs.errors.total': 2,
    'logs.oom': 1,
    'logs.crashes': 1,
    'logs.inflow.hour': UNKNOWN,
    'logs.inflow.avg7d': UNKNOWN,
    'logs.journald.fill_state': 'no-rate',
    'logs.journald.fill_hours': UNKNOWN,
  };
  const bad1 = Object.entries(fresh1).filter(([k, v]) => val(k, m1) !== v);
  check(
    'Zabbix: свежий файл — значения; неполный час и ненакопленная база — «неизвестно»',
    bad1.length === 0 && val('logs.snapshot.age', m1) < 3600,
    bad1.map(([k, v]) => `${k}: ${show(val(k, m1))} вместо ${show(v)}`).join('; ') || 'сошлось',
  );
  // Испорченное время файла — каждая проверка «неизвестно», и файл назван
  // ошибочным отдельной проверкой (случаи Тэнка + нецелое и старое время).
  const now = Math.floor(Date.now() / 1000);
  const { atEpoch: _drop, ...noTime } = m1;
  const badFiles = {
    'без времени': noTime,
    'время текстом': { ...m1, atEpoch: 'not-a-time' },
    'время на сутки вперёд': { ...m1, atEpoch: now + 86400 },
    'время нецелое': { ...m1, atEpoch: now + 0.5 },
    'время null': { ...m1, atEpoch: null },
    устаревший: { ...m1, atEpoch: now - 600 },
    'другой формат': { ...m1, format: 'logs-metrics/v0' },
  };
  for (const [name, s] of Object.entries(badFiles)) {
    const leaked = LOGS_ITEMS.filter(
      (x) => x.key !== 'logs.file.problem' && val(x.key, s) !== UNKNOWN,
    );
    const problem = val('logs.file.problem', s);
    check(
      `Zabbix: ${name} — все проверки «неизвестно», ошибка файла названа`,
      leaked.length === 0 && typeof problem === 'string' && problem.length > 0,
      leaked.map((x) => `${x.key}=${show(val(x.key, s))}`).join(', ') || problem,
    );
  }
  const skew = { ...m1, atEpoch: now + 60 };
  check(
    'Zabbix: расхождение часов в пределах допуска — файл принят',
    val('logs.file.problem', skew) === '' && val('logs.http.requests', skew) === 6,
  );
  // Неизвестное не подменяется числами; ноль измеренного притока — число.
  const j = (o) => ({ ...m1, journald: { ...m1.journald, ...o } });
  const inf = (o) => ({ ...m1, inflow: { ...m1.inflow, ...o } });
  const cases = [
    [
      'нет лимита journald',
      j({ fillState: 'no-limit', fillHours: null }),
      'logs.journald.fill_hours',
      UNKNOWN,
    ],
    [
      'нет лимита journald — состояние',
      j({ fillState: 'no-limit', fillHours: null }),
      'logs.journald.fill_state',
      'no-limit',
    ],
    [
      'притока нет при исправном измерении',
      j({ fillState: 'no-inflow', fillHours: null }),
      'logs.journald.fill_state',
      'no-inflow',
    ],
    [
      'притока нет — запас не число',
      j({ fillState: 'no-inflow', fillHours: null }),
      'logs.journald.fill_hours',
      UNKNOWN,
    ],
    [
      'занятость не прочитана',
      j({ usageBytes: null, fillState: 'no-usage', fillHours: null }),
      'logs.journald.usage',
      UNKNOWN,
    ],
    ['запас вычислен', j({ fillState: 'ok', fillHours: 30 }), 'logs.journald.fill_hours', 30],
    [
      'запас «ok», но числа нет',
      j({ fillState: 'ok', fillHours: null }),
      'logs.journald.fill_hours',
      UNKNOWN,
    ],
    [
      'база не накоплена',
      inf({ avg7dHourBytes: null, baselineReady: false, baselineHours: 5 }),
      'logs.inflow.avg7d',
      UNKNOWN,
    ],
    [
      'база не накоплена — часов',
      inf({ avg7dHourBytes: null, baselineReady: false, baselineHours: 5 }),
      'logs.inflow.baseline_hours',
      5,
    ],
    [
      'база готова',
      inf({ avg7dHourBytes: 900, baselineReady: true, baselineHours: 96 }),
      'logs.inflow.avg7d',
      900,
    ],
    ['измеренный ноль притока за полный час', inf({ lastHourBytes: 0 }), 'logs.inflow.hour', 0],
    [
      'запросов нет — доля 5xx не определена',
      { ...m1, lastHour: { ...m1.lastHour, requests: 0, s5xx: 0 } },
      'logs.http.5xx_share',
      UNKNOWN,
    ],
    [
      'запросов нет — их число ноль',
      { ...m1, lastHour: { ...m1.lastHour, requests: 0, s5xx: 0 } },
      'logs.http.requests',
      0,
    ],
    ['очередь не прочитана', { ...m1, queue: null }, 'logs.queue.lag', UNKNOWN],
    ['счётчик текстом', { ...m1, lastHour: { ...m1.lastHour, oom: '1' } }, 'logs.oom', UNKNOWN],
    [
      'снимка нет — время от начала архива',
      { ...m1, snapshot: null, archiveStartEpoch: now - 7200 },
      'logs.snapshot.age',
      7200,
    ],
    [
      'снимка нет и начало неизвестно',
      { ...m1, snapshot: null, archiveStartEpoch: null },
      'logs.snapshot.age',
      UNKNOWN,
    ],
  ];
  const badCases = cases.filter(([, s, k, want]) => {
    const got = val(k, s);
    return want === 7200 ? !(got >= 7200 && got <= 7205) : got !== want;
  });
  check(
    `Zabbix: неизвестное не подменяется числами (${cases.length} случаев)`,
    badCases.length === 0,
    badCases.map(([n, s, k]) => `${n}: ${k}=${show(val(k, s))}`).join('; ') || 'сошлось',
  );
  check(
    'Zabbix: тревога роста требует готовой базы',
    /logs\.inflow\.baseline_hours\)>=72/.test(
      logsTriggers('h', 'f').find(([n]) => n.includes('втрое'))[1],
    ),
  );
  check(
    'Zabbix: код предобработки без синтаксиса новее ES5',
    LOGS_ITEMS.every((x) => !/=>|`|\blet\b|\bconst\b/.test(x.js)),
  );
  // Полный час счёта и накопленная база (начало счёта сдвинуто на 96 ч назад).
  inCt(
    `node -e "const f='${ARCH_ENV.LOGS_STATE_DIR}/state.json';const fs=require('fs');const s=JSON.parse(fs.readFileSync(f));s.countingSince=new Date(Date.now()-96*3600e3).toISOString();fs.writeFileSync(f,JSON.stringify(s))"`,
  );
  check('проход', arch('run', LIMIT).code === 0);
  const m3 = metrics();
  check(
    'полный час и база 96 ч: приток и среднее — числа, запас вычислен',
    Number.isInteger(m3.inflow.lastHourBytes) &&
      m3.inflow.baselineReady === true &&
      m3.inflow.baselineHours >= 95 &&
      Number.isInteger(m3.inflow.avg7dHourBytes) &&
      m3.journald.fillState === 'ok' &&
      m3.journald.fillHours > 0 &&
      val('logs.inflow.avg7d', m3) === m3.inflow.avg7dHourBytes,
    JSON.stringify({ i: m3.inflow, j: m3.journald }),
  );
  check(
    'без лимита journald — «запас не вычисляется», а не огромное число',
    arch('run').code === 0 &&
      metrics().journald.fillState === 'no-limit' &&
      val('logs.journald.fill_hours', metrics()) === UNKNOWN,
  );
  check(
    'потери и пропуски архива — числами',
    m1.losses.segments > 0 && m1.archiveGaps === 0 && m1.losses.byReason['archive-missing'] > 0,
    JSON.stringify(m1.losses),
  );
  const vol = await allKeysUnder('volume/');
  const volBody = vol.length ? JSON.parse(await (await rootReq('GET', vol[0])).text()) : null;
  check(
    'суточный снимок объёма по источникам — объектом в архиве, его время в состоянии',
    volBody?.bySource?.['w08b-test'] > 0 && m1.snapshot?.lastDayBytes === volBody.total,
    `${vol.join(', ')}; ${JSON.stringify(m1.snapshot)}`,
  );
  // Недоступный S3: проход не удался, очередь растёт, текста ошибки нет.
  gen(10, 'mS3');
  const down = arch('run', { ...LIMIT, LOGS_S3_ENDPOINT: 'http://127.0.0.1:1' });
  const m2 = metrics();
  check(
    'S3 недоступен: сбой с кодом s3, очередь и её возраст видны',
    down.code !== 0 &&
      !m2.run.ok &&
      m2.run.failure === 's3' &&
      m2.queue.entries >= 10 &&
      m2.queue.lagSec >= 0,
    JSON.stringify({ run: m2.run, q: m2.queue }),
  );
  const raw2 = JSON.stringify(m2);
  check(
    'в файле нет текстов ошибок и сообщений журнала',
    !/fetch failed|127\.0\.0\.1|ECONN|Killed process|Main process|ABRT|refused-/.test(raw2),
    raw2.length > 0 ? 'проверены fetch failed, адрес, ECONN, тексты записей' : '',
  );
  check(
    'S3 вернулся — проход догоняет',
    arch('run', LIMIT).code === 0 && metrics().queue.entries === 0,
  );
  // Подавление частоты journald.
  inCt(
    `mkdir -p /etc/systemd/journald.conf.d && printf '[Journal]\\nRateLimitIntervalSec=1s\\nRateLimitBurst=5\\n' > /etc/systemd/journald.conf.d/rl.conf && systemctl restart systemd-journald && printf '[Service]\\nType=oneshot\\nExecStart=/bin/sh -c "for i in $$(seq 1 100); do echo spam $$i; done; sleep 2; echo after"\\n' > /etc/systemd/system/m-spam.service && systemctl daemon-reload && systemctl start m-spam; sleep 1; rm -f /etc/systemd/journald.conf.d/rl.conf`,
  );
  check('проход', arch('run', LIMIT).code === 0);
  check(
    'подавление journald посчитано',
    metrics().lastHour.suppressed > 0,
    `подавлено ${metrics().lastHour.suppressed}`,
  );
  // Свежесть файлов почты в файле состояния и в Zabbix.
  check('проход с настроенными файлами', arch('run', { ...LIMIT, ...FENV }).code === 0);
  const mF = metrics();
  check(
    'файлы почты: время последнего успешного прохода в состоянии, Zabbix — возраст',
    Number.isInteger(mF.files?.lastOkEpoch) && val('logs.files.age', mF) < 3600,
    JSON.stringify(mF.files),
  );
  check(
    'все источники исправны — logs.files.bad = 0',
    val('logs.files.bad', mF) === 0 && mF.files.sources?.every((s) => s.state === 'ok'),
  );
  const BOTH = { LOGS_FILES: `${MAIL}/mainlog,/var/log/tmail-gone/mainlog` };
  arch('files', BOTH);
  check('проход с недоступным источником', arch('run', { ...LIMIT, ...BOTH }).code === 0);
  const mB = metrics();
  check(
    'недоступный источник: logs.files.bad = 1, возраст — по худшему источнику',
    val('logs.files.bad', mB) === 1 &&
      mB.files.lastOkEpoch === null &&
      mB.files.sources.find((s) => s.source.includes('gone'))?.state === 'missing',
    JSON.stringify(mB.files),
  );
  check('проход без него', arch('run', { ...LIMIT, ...FENV }).code === 0);
  check(
    'файлы не настроены — «неизвестно», а не возраст',
    metrics().files !== undefined && val('logs.files.age', { ...mF, files: null }) === UNKNOWN,
  );

  // ---------------------------------------------------- S: новая нумерация
  console.log('\n▸ S. Новая нумерация journald (аварийная остановка journald)');
  const sidNow = () => JSON.parse(inCt(`cat ${ARCH_ENV.LOGS_STATE_DIR}/state.json`)).seqId;
  const anchorsAll = async () => {
    const out = [];
    for (const k of await allKeysUnder('anchors/')) {
      out.push(JSON.parse(await (await rootReq('GET', k)).text()));
    }
    return out;
  };
  check('проход', arch('run').code === 0);
  const oldSid = sidNow();
  inCt(
    'd=$(ls -d /var/log/journal/*); systemctl kill -s KILL systemd-journald; sleep 1; mv $d/system.journal $d/system.journal~; systemctl restart systemd-journald; sleep 1',
  );
  const tS = new Date().toISOString();
  gen(10, 'sS');
  const rS = arch('run');
  const newSid = sidNow();
  const aS = await anchorsAll();
  const newAnchor = aS.find((a) => a.seqId === newSid);
  check(
    'новая нумерация: своя граница «после записи 0» в S3, прежняя указана',
    rS.code === 0 &&
      newSid !== oldSid &&
      rS.out.includes('новая нумерация журнала') &&
      aS.length === 2 &&
      newAnchor?.afterSeq === '0' &&
      newAnchor?.after?.seqId === oldSid,
    `${rS.out.split('\n').find((l) => l.includes('нумерация')) ?? rS.out.split('\n').at(-1)}; границ ${aS.length}`,
  );
  const ofSid = (sid) => catalog().filter((r) => r.key.includes(`/${sid}/`));
  check(
    'порции новой нумерации с записи 1, без ложной потери в начале',
    ofSid(newSid).some((r) => r.kind === 'chunk' && r.first === '1') &&
      !ofSid(newSid).some((r) => r.kind === 'loss'),
    ofSid(newSid)
      .map((r) => `${r.kind} ${r.first}–${r.last}`)
      .join(', '),
  );
  verifyOk('S');
  pullCase('S', expectAfterRun());
  const fS2 = findOut(`--from ${tS} --source w08b-test`);
  check(
    'поиск через смену нумерации',
    fS2.code === 0 && foundOf(fS2.out) === 10,
    fS2.out.split('\n').at(-1),
  );
  // Потеря состояния: rebuild собирает обе нумерации.
  loseState();
  const rbS = arch('rebuild');
  check(
    'rebuild: каталог по обеим нумерациям',
    rbS.code === 0 && ofSid(oldSid).length > 0 && ofSid(newSid).length > 0 && sidNow() === newSid,
    rbS.out.split('\n')[0],
  );
  verifyOk('S-rebuild');
  // Утрата порции прежней нумерации, journald её ещё хранит: дочитывается
  // по курсору из ID нумерации и номера, без отметки потери.
  const oldLast = ofSid(oldSid)
    .filter((r) => r.kind === 'chunk')
    .sort(byFirst)
    .at(-1);
  await dropAll([oldLast]);
  loseState();
  const rbS2 = arch('rebuild');
  check(
    'утраченная порция прежней нумерации восполнена из journald',
    rbS2.code === 0 &&
      rbS2.out.includes(`восполнено из journald: записи ${oldLast.first}`) &&
      !ofSid(oldSid).some(
        (r) =>
          r.kind === 'loss' &&
          BigInt(r.first) <= BigInt(oldLast.last) &&
          BigInt(oldLast.first) <= BigInt(r.last),
      ),
    rbS2.out
      .split('\n')
      .filter((l) => /восполнено|ПОТЕРЯ|ПРОПУСК/.test(l))
      .join(' | ') || rbS2.out,
  );
  check('проход', arch('run').code === 0);
  verifyOk('S-восполнение');
  pullCase('S-восполнение', expectAfterRun());

  // ------------------------------------- Ц: цепочка квитанций и эталон
  // Garage не запрещает перезапись и удаление (D-001) — архив их обнаруживает:
  // квитанции подписаны ключом архива и связаны в цепочку, её голова —
  // эталон в состоянии архиватора и в описи копии (замечания Тэнка 03.11).
  console.log('\n▸ Ц. Цепочка квитанций: подмена с квитанцией, утрата хвоста, утрата эталона');
  const hex = (b) => createHash('sha256').update(b).digest('hex');
  const rk = (r) => {
    const p = parseChunkKey(r.key);
    return receiptKey(p.seqId, p.first, p.last, p.kind, r.versionId);
  };
  const lineOf = (out, re) => out.split('\n').find((l) => re.test(l)) ?? out.split('\n').at(-1);
  gen(20, 'tc');
  check('проход', arch('run').code === 0);

  // Ц1. Порция и её квитанция заменены согласованно — без ключа архива.
  const t1 = catalog()
    .filter((r) => r.kind === 'chunk')
    .at(-1);
  const [o1] = await versionsOf(t1.key);
  const [q1] = await versionsOf(rk(t1));
  const forged = Buffer.from('подложная порция');
  await rootReq('PUT', t1.key, {}, forged, { 'x-amz-meta-object-sha256': hex(forged) });
  await rootReq(
    'PUT',
    rk(t1),
    {},
    Buffer.from(JSON.stringify({ ...JSON.parse(q1.body.toString('utf8')), objSha: hex(forged) })),
  );
  const vT1 = arch('verify');
  check(
    'подмена порции вместе с квитанцией обнаружена — подпись не сошлась',
    vT1.code !== 0 && vT1.out.includes('без подписи ключом архива'),
    lineOf(vT1.out, /подписи/),
  );
  await rootReq('PUT', t1.key, {}, o1.body, { 'x-amz-meta-object-sha256': o1.versionId });
  await rootReq('PUT', rk(t1), {}, q1.body);
  verifyOk('Ц1 — подлинные порция и квитанция возвращены');

  // Ц2. Удаление хвоста вместе с квитанциями: VPS видит по эталону, копия —
  // по эталону прежней копии (голову в хранилище тоже можно удалить).
  const REFCOPY = `/tmp/refcopy-${tag}`;
  const asReaderT = { LOGS_S3_ACCESS_KEY_ID: READER, LOGS_S3_SECRET_ACCESS_KEY: READER_SECRET };
  arch('pull', { ...asReaderT, LOGS_PULL_TO: REFCOPY });
  check('копия с эталоном цепочки', inCt(`ls ${REFCOPY}`).includes('MANIFEST.sealed'));
  const tail = catalog()
    .filter((r) => r.kind === 'chunk')
    .slice(-2);
  const savedTail = [];
  for (const r of tail) {
    for (const key of [r.key, rk(r)]) {
      const [o] = await versionsOf(key);
      savedTail.push({ key, body: o.body, sha: o.versionId });
      await rootReq('DELETE', key);
    }
  }
  const [refObj] = await versionsOf('ref/head.json');
  await rootReq('DELETE', 'ref/head.json');
  const vT2 = arch('verify');
  check(
    'удаление хвоста с квитанциями обнаружено — цепочка короче эталона',
    vT2.code !== 0 && vT2.out.includes('цепочка короче эталона'),
    lineOf(vT2.out, /цепочка/),
  );
  // Регрессия (Тэнк к 065cba0): два запуска подряд — оба красные, а
  // подтверждённая опись (эталон копии) не меняется; иначе второй сверялся бы
  // с укороченным эталоном и давал ложный успех.
  const manifestSha = () => inCt(`sha256sum ${REFCOPY}/MANIFEST.sealed | cut -c1-64`).trim();
  const refSha = manifestSha();
  const pT2 = arch('pull', { ...asReaderT, LOGS_PULL_TO: REFCOPY });
  check(
    'копия: хранилище расходится с эталоном прежней копии (голова в хранилище тоже удалена)',
    pT2.code !== 0 && pT2.out.includes('расходится с эталоном прежней копии'),
    lineOf(pT2.out, /расходится|ИТОГ/),
  );
  const pT2b = arch('pull', { ...asReaderT, LOGS_PULL_TO: REFCOPY });
  check(
    'второй запуск подряд — тоже НЕ сошлась, подтверждённая опись прежняя',
    pT2b.code !== 0 &&
      pT2b.out.includes('расходится с эталоном прежней копии') &&
      manifestSha() === refSha &&
      inCt(`ls ${REFCOPY}`).includes('MANIFEST.sealed.rejected'),
    lineOf(pT2b.out, /^ИТОГ/),
  );
  for (const s of savedTail) {
    await rootReq('PUT', s.key, {}, s.body, { 'x-amz-meta-object-sha256': s.sha });
  }
  await rootReq('PUT', 'ref/head.json', {}, refObj.body);
  verifyOk('Ц2 — хвост возвращён');
  const pT2c = arch('pull', { ...asReaderT, LOGS_PULL_TO: REFCOPY });
  check(
    'после возврата хвоста — копия сошлась, опись заменена допустимым продолжением',
    pT2c.code === 0 && !pT2c.out.includes('НЕ сошлась'),
    lineOf(pT2c.out, /^ИТОГ/),
  );

  // Ц3. Утрата эталона: без него — «НЕПРОВЕРЯЕМО», голова из хранилища не
  // подтверждена; подтверждение — опись копии на ноутбуке.
  arch('pull', { ...asReaderT, LOGS_PULL_TO: REFCOPY });
  inCt(`rm -f ${ARCH_ENV.LOGS_STATE_DIR}/chain.json`);
  const vT3 = arch('verify');
  check(
    'эталона нет — НЕПРОВЕРЯЕМО, а не зелёный',
    vT3.code !== 0 && vT3.out.includes('ИТОГ: НЕПРОВЕРЯЕМО — эталона состава нет'),
    lineOf(vT3.out, /^ИТОГ/),
  );
  const rbT3 = arch('rebuild');
  const vT3b = arch('verify');
  check(
    'rebuild без эталона: голова из хранилища не подтверждена — НЕПРОВЕРЯЕМО',
    rbT3.out.includes('ЭТАЛОН УТРАЧЕН') && vT3b.out.includes('ИТОГ: НЕПРОВЕРЯЕМО'),
    lineOf(vT3b.out, /^ИТОГ/),
  );
  const rbT3c = arch('rebuild', {}, ['--reference', REFCOPY]);
  check(
    'rebuild --reference: эталон — из описи копии, цепочка сошлась',
    rbT3c.code === 0 && rbT3c.out.includes('эталон цепочки — из описи копии'),
    lineOf(rbT3c.out, /эталон/),
  );
  verifyOk('Ц3 — эталон из копии');
  inCt(`rm -rf ${REFCOPY}`);

  // ---------------------------------------------------- E2: утрата файла
  console.log('\n▸ E2. Утрата файла почты в архиве');
  const lostFile = (await fileKeys())[0];
  await rootReq('DELETE', lostFile);
  const vE2 = arch('verify');
  check(
    'verify: утрата файла — НЕ пройдена',
    vE2.code !== 0 &&
      vE2.out.includes('утрата архива') &&
      vE2.out.includes('ИТОГ: проверка НЕ пройдена'),
    vE2.out.split('\n').find((l) => l.includes('файл ')) ?? vE2.out.split('\n')[0],
  );
  pullCase('E2', 'red');
} catch (error) {
  failed++;
  console.log(`  FAIL  испытание прервано: ${error.message}`);
} finally {
  await cleanup();
}
console.log(`\nИтог: пройдено ${passed}, провалено ${failed}`);
process.exit(failed ? 1 : 0);
