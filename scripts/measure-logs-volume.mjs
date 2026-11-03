#!/usr/bin/env node
/**
 * Замер места под архив журналов (блок 8, 8.4; 2.1-W08b, раздел 4 плана).
 *
 *  1. Журнал запросов ядра в journald: служба на node — как unicorn-core на
 *     VPS — пишет N строк в формате журнала запросов (apps/core/src/main.ts,
 *     onResponse). Итог — байт на запрос в формате export и после gzip.
 *  2. Место маленького объекта в MinIO стенда (бакет с версиями): K объектов
 *     размера минутной порции и квитанции. Итог — байт на диске на объект
 *     (блок файловой системы, метаданные MinIO).
 *  3. Расчёт на сутки и год: фон — по замеру VPS (аргументы, по умолчанию
 *     чтение 03.11.2026), запросы ядра — при нескольких постоянных
 *     нагрузках и всплеске; число объектов в год.
 *
 * Ничего не меняет вне временного контейнера и временного бакета.
 *
 *   node scripts/measure-logs-volume.mjs [--base-bytes-day N] [--base-gzip-day N]
 *        [--burst-rps R] [--burst-hours H] [--requests N] [--objects K]
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { loadEnv } from './lib/backup.mjs';

loadEnv();
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
// Чтение VPS 03.11.2026 за сутки: 71 462 записи, export 71 123 880 байт,
// gzip 6 455 381 байт (без журнала запросов ядра — его ещё нет).
const BASE_DAY = arg('--base-bytes-day', 71_123_880);
const BASE_GZIP_DAY = arg('--base-gzip-day', 6_455_381);
const BURST_RPS = arg('--burst-rps', 50);
const BURST_HOURS = arg('--burst-hours', 1);
const N = arg('--requests', 3000);
const K = arg('--objects', 300);
const tag = randomBytes(3).toString('hex');
const CT = `jtb-measure-${tag}`;
const BUCKET = `tech-logs-measure-${tag}`;

function sh(cmd, args, { allowFail = false, input } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.slice(0, 3).join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout;
}
const inCt = (script) => sh('docker', ['exec', CT, 'sh', '-c', script]);
const inMinio = (script) =>
  sh('docker', [
    'exec',
    'unicorn-minio',
    'sh',
    '-c',
    `mc alias set r http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && ${script}; mc alias rm r >/dev/null`,
  ]);
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const fmt = (b) => (b >= GiB ? `${(b / GiB).toFixed(2)} ГиБ` : `${(b / MiB).toFixed(1)} МиБ`);

// Строка журнала запросов — как пишет ядро (поля и порядок — json-logger.ts).
const EMIT = `
const r = () => Math.random().toString(16).slice(2, 10);
for (let i = 0; i < ${N}; i++) {
  console.log(JSON.stringify({
    t: new Date().toISOString(), level: 'log', component: 'core', version: '7071471',
    ctx: 'http', msg: 'запрос', method: i % 5 ? 'GET' : 'POST',
    route: ['/v1/projects/:id', '/v1/projects', '/v1/me', '/v1/health'][i % 4],
    status: 200, durationMs: 5 + (i % 40), result: 'ok', requestId: r() + r() + r() + r(),
  }));
}`;

try {
  // ---------------------------------------------------------- 1. journald
  sh('docker', [
    'run',
    '-d',
    '--name',
    CT,
    '--privileged',
    '--cgroupns=host',
    '-v',
    '/sys/fs/cgroup:/sys/fs/cgroup:rw',
    '--tmpfs',
    '/run',
    '--tmpfs',
    '/run/lock',
    'fifth/journald-testbed:local',
  ]);
  for (let i = 0; i < 30; i++) {
    const s = sh('docker', ['exec', CT, 'systemctl', 'is-system-running'], { allowFail: true });
    if (/running|degraded/.test(s)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  sh(
    'docker',
    [
      'exec',
      '-i',
      CT,
      'sh',
      '-c',
      'mkdir -p /opt/unicorn-launch/apps/core/dist && cat > /opt/unicorn-launch/apps/core/dist/main.js',
    ],
    {
      input: EMIT,
    },
  );
  inCt(
    `printf '[Unit]\\nDescription=UNICORN LAUNCH — ядро (core)\\n[Service]\\nType=oneshot\\nWorkingDirectory=/opt/unicorn-launch\\nExecStart=/usr/local/bin/node /opt/unicorn-launch/apps/core/dist/main.js\\n' > /etc/systemd/system/unicorn-core.service && systemctl daemon-reload && systemctl start unicorn-core && sleep 2`,
  );
  const count = Number(
    inCt('journalctl -u unicorn-core -o export --no-pager | grep -ac "^__CURSOR="'),
  );
  const exportBytes = Number(
    inCt(
      `journalctl -u unicorn-core -o export --no-pager | grep -a -v '^$' >/dev/null; journalctl -u unicorn-core -o export --no-pager | wc -c`,
    ),
  );
  const gzipBytes = Number(
    inCt('journalctl -u unicorn-core -o export --no-pager | gzip -c | wc -c'),
  );
  // Записи службы помимо строк запроса (запуск, завершение) — несколько штук.
  const perReq = exportBytes / count;
  const perReqGzip = gzipBytes / count;

  // ---------------------------------------------------------- 2. MinIO
  const chunkObj = Math.round(BASE_GZIP_DAY / 1440); // минутная порция фона, сжатая
  const receiptObj = 900; // квитанция: JSON с хешами и курсорами
  inMinio(`mc mb -q r/${BUCKET} >/dev/null && mc version enable r/${BUCKET} >/dev/null`);
  const before = Number(inMinio(`du -sk /data/${BUCKET} | cut -f1`).trim());
  inMinio(
    `head -c ${chunkObj} /dev/urandom > /tmp/m-c && head -c ${receiptObj} /dev/urandom > /tmp/m-r && i=0; while [ $i -lt ${K} ]; do mc cp -q /tmp/m-c r/${BUCKET}/j/$i.jx >/dev/null; mc cp -q /tmp/m-r r/${BUCKET}/r/$i.json >/dev/null; i=$((i+1)); done; rm -f /tmp/m-c /tmp/m-r`,
  );
  const after = Number(inMinio(`du -sk /data/${BUCKET} | cut -f1`).trim());
  const perPair = ((after - before) * 1024) / K; // порция + квитанция на диске
  const payload = chunkObj + receiptObj;

  // ---------------------------------------------------------- 3. расчёт
  const perMinutePairs = 1440;
  const objectsYear = perMinutePairs * 365 * 2 + 365 * 3; // порции, квитанции; пакеты, их квитанции, снимки
  const diskPairDay = perPair * perMinutePairs;
  const overheadDay = diskPairDay - payload * perMinutePairs; // сверх полезных байт
  const rowsReq = (rps) => {
    const day = rps * 86_400;
    return { day, exp: day * perReq, gz: day * perReqGzip };
  };
  console.log(`=== ЗАМЕР МЕСТА ПОД АРХИВ ЖУРНАЛОВ (${tag}) ===`);
  console.log(
    `запись журнала запросов ядра: ${perReq.toFixed(0)} байт в export, ${perReqGzip.toFixed(0)} после gzip (сжатие ×${(perReq / perReqGzip).toFixed(1)}; ${count} записей)`,
  );
  console.log(
    `MinIO: порция ${chunkObj} + квитанция ${receiptObj} байт занимают на диске ${perPair.toFixed(0)} байт (${K} пар)`,
  );
  console.log(`фон VPS: ${fmt(BASE_DAY)}/сутки export, ${fmt(BASE_GZIP_DAY)}/сутки в архиве`);
  console.log('');
  console.log(
    'запросов ядра | в архиве в сутки | journald в сутки | архив в год (данные) | ×2 с пакетами',
  );
  for (const rps of [0, 1, 10, 50]) {
    const q = rowsReq(rps);
    const archDay = BASE_GZIP_DAY + q.gz;
    console.log(
      `${String(rps).padStart(4)} в сек. | ${fmt(archDay).padStart(12)} | ${fmt(BASE_DAY + q.exp).padStart(12)} | ${fmt(archDay * 365).padStart(12)} | ${fmt(archDay * 365 * 2).padStart(12)}`,
    );
  }
  const burst = BURST_RPS * 3600 * BURST_HOURS;
  console.log('');
  console.log(
    `всплеск ${BURST_RPS} запросов/с в течение ${BURST_HOURS} ч: +${fmt(burst * perReq)} в journald, +${fmt(burst * perReqGzip)} в архиве; приток за час ${fmt((burst * perReq) / BURST_HOURS)} против фона ${fmt(BASE_DAY / 24)}`,
  );
  console.log(
    `объектов в год: ~${objectsYear.toLocaleString('ru-RU')} (минутные порции и квитанции + пакеты); накладные расходы MinIO сверх данных: ~${fmt(overheadDay)}/сутки, ~${fmt(overheadDay * 365)}/год`,
  );
} finally {
  sh('docker', ['rm', '-f', CT], { allowFail: true });
  inMinio(`mc rb --force --dangerous r/${BUCKET} >/dev/null 2>&1; true`);
}
