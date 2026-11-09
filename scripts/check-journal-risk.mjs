#!/usr/bin/env node
/**
 * Риск потери невыгруженных записей journald на НАСТОЯЩЕМ journald
 * (CHK-JOURNAL-RISK; решение Тэнка и Томаса 09.11.2026). Испытательный
 * контейнер с systemd (infra/testbed/journald.Dockerfile), без S3: граница
 * архива подставляется в state.json, расчёт — командой архиватора `risk`.
 *
 * Случаи: заголовки и занятость читаются; приток ещё не измерен — unknown с
 * отсрочкой, после 10 минут — без неё, ошибка отсрочку не возобновляет; всё
 * выгружено — clear; невыгруженное — ok, объём не меньше активного файла;
 * C удалён ротацией, C+1 сохранён — потери нет; после C удалены записи —
 * lost с номерами; корректный переход нумерации; переход с недоказанной
 * непрерывностью — unknown.
 *
 *   node scripts/check-journal-risk.mjs [--keep]
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { ROOT } from './lib/backup.mjs';
import { parseHeaders } from './lib/journal-risk.mjs';

const keep = process.argv.includes('--keep');
const CT = `jrisk-${randomBytes(3).toString('hex')}`;
const IMAGE = 'fifth/journald-testbed:local';
const STATE_DIR = '/var/lib/fifth-logs-risk';

let passed = 0;
let failed = 0;
const check = (name, ok, details = '') => {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details ? ` — ${details}` : ''}`);
};

function sh(cmd, args, { input, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    input,
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 && !allowFail) {
    throw new Error(
      `${cmd} ${args.slice(0, 4).join(' ')}: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`,
    );
  }
  return r;
}
const inCt = (script) => sh('docker', ['exec', CT, 'sh', '-c', script]).stdout;
const writeCt = (path, text) =>
  sh('docker', ['exec', '-i', CT, 'sh', '-c', `cat > ${path}`], { input: text });
const readCtJson = (path) => JSON.parse(inCt(`cat ${path}`));

function gen(n, label) {
  inCt(
    `for i in $(seq 1 ${n}); do echo "risk ${label} $i $(head -c 300 /dev/urandom | base64 -w0)" | systemd-cat -t risk-test; done; sleep 1`,
  );
}

/** Все записи: курсор, нумерация, номер (из курсора — так в любой версии systemd). */
function entries() {
  return inCt('journalctl -o json --no-pager --output-fields=__CURSOR')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const c = JSON.parse(l).__CURSOR;
      const m = Object.fromEntries(c.split(';').map((p) => p.split('=')));
      return { cursor: c, seqId: m.s, seq: BigInt(`0x${m.i}`) };
    });
}
const headers = () => parseHeaders(inCt('journalctl --header --no-pager'));

function setBoundary(e) {
  writeCt(
    `${STATE_DIR}/state.json`,
    JSON.stringify({ seqId: e.seqId, lastSeq: String(e.seq), lastCursor: e.cursor }),
  );
}
function risk() {
  const r = sh(
    'docker',
    [
      'exec',
      '-e',
      `LOGS_STATE_DIR=${STATE_DIR}`,
      CT,
      'node',
      '/src/scripts/logs-archive.mjs',
      'risk',
    ],
    {
      allowFail: true,
    },
  );
  try {
    return JSON.parse(r.stdout.trim().split('\n').pop());
  } catch {
    return { state: 'не разобран', out: `${r.stdout}${r.stderr}`.slice(0, 300) };
  }
}
const show = (r) => JSON.stringify(r).slice(0, 400);
const editRisk = (fn) => {
  const s = readCtJson(`${STATE_DIR}/risk.json`);
  fn(s);
  writeCt(`${STATE_DIR}/risk.json`, JSON.stringify(s));
};

console.log(`=== РИСК ПОТЕРИ НЕВЫГРУЖЕННОГО: настоящий journald (${CT}) ===`);
try {
  if (sh('docker', ['image', 'inspect', IMAGE], { allowFail: true }).status !== 0) {
    sh('docker', [
      'build',
      '-q',
      '-t',
      IMAGE,
      '-f',
      'infra/testbed/journald.Dockerfile',
      'infra/testbed',
    ]);
  }
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
  inCt(`mkdir -p ${STATE_DIR}; journalctl --flush; systemctl --version | head -1`);
  console.log(`  ·     ${inCt('systemctl --version | head -1').trim()}`);

  // ---------------------------------------------------------------- 1
  console.log('\n▸ 1. Заголовки, отсрочка «неизвестно»');
  gen(50, 'a');
  setBoundary(entries().at(-1));
  // Отсутствие невыгруженного подтверждено без притока: clear, прогноза нет.
  const r0 = risk();
  check(
    'всё выгружено, приток не измерен — clear без прогноза',
    r0.state === 'clear' && r0.ifStoppedHours === null && r0.forecastProblem === 'no-rate',
    show(r0),
  );
  gen(10, 'a2');
  const r1 = risk();
  check(
    'есть невыгруженное, приток не измерен — unknown, отсрочка идёт',
    r1.state === 'unknown' && r1.reason === 'no-rate' && r1.grace === true,
    show(r1),
  );
  editRisk((s) => {
    s.since = Date.now() - 11 * 60_000;
  });
  const r1b = risk();
  check(
    'через 10 минут — unknown без отсрочки',
    r1b.state === 'unknown' && r1b.grace === false,
    show(r1b),
  );
  const r1c = risk();
  check('повторная ошибка отсрочку не возобновляет', r1c.grace === false, show(r1c));

  // ---------------------------------------------------------------- 2
  console.log('\n▸ 2. Всё выгружено, затем невыгруженное');
  const nowH = Math.floor(Date.now() / 3_600_000);
  editRisk((s) => {
    s.since = Date.now() - 3 * 3_600_000;
    s.track = {
      ...s.track,
      since: Date.now() - 3 * 3_600_000,
      hours: { [nowH - 2]: 5e6, [nowH - 1]: 5e6 },
    };
  });
  setBoundary(entries().at(-1));
  const r2 = risk();
  const blocks = Number(
    inCt(
      `find /var/log/journal -name '*.journal*' -type f -exec stat -c '%b %B' {} + | awk '{s+=$1*$2} END {print s}'`,
    ).trim(),
  );
  check(
    'всё выгружено — clear, невыгруженного 0, запас при остановке — число',
    r2.state === 'clear' && r2.backlogBytes === 0 && r2.ifStoppedHours > 0,
    show(r2),
  );
  check(
    'занятость — блоки на диске, как у journald',
    r2.usageBytes === blocks,
    `${r2.usageBytes} / ${blocks}`,
  );
  gen(40, 'b');
  const r3 = risk();
  const activeSize = Number(
    inCt(`stat -c '%b %B' /var/log/journal/*/system.journal | awk '{print $1*$2}'`).trim(),
  );
  check(
    'есть невыгруженное — ok, объём не меньше активного файла, оценка при текущем притоке',
    r3.state === 'ok' && r3.backlogBytes >= activeSize && r3.hours > 0 && r3.rateBytesHour >= 5e6,
    show(r3),
  );

  // ---------------------------------------------------------------- 3
  console.log('\n▸ 3. Ротация удалила C, следующая запись сохранена');
  inCt('journalctl --rotate; sleep 1');
  const archived = headers().filter((f) => f.path.includes('@') && f.entries > 0);
  const lastClosed = archived.reduce((m, f) => (f.tail > m.tail ? f : m));
  gen(20, 'c');
  const C3 = entries().find((e) => e.seqId === lastClosed.seqId && e.seq === lastClosed.tail);
  setBoundary(C3);
  inCt('journalctl --vacuum-size=1 >/dev/null 2>&1; sleep 1');
  const still = entries().some((e) => e.seq === C3.seq && e.seqId === C3.seqId);
  const r4 = risk();
  check(
    'C удалён, C+1 на месте — ok, потери нет',
    !still && r4.state === 'ok',
    `C=${C3.seq}; ${show(r4)}`,
  );

  // ---------------------------------------------------------------- 4
  console.log('\n▸ 4. После C удалены невыгруженные записи');
  inCt('journalctl --rotate; sleep 1');
  const closed4 = headers().filter((f) => f.path.includes('@') && f.entries > 0);
  const f4 = closed4.reduce((m, f) => (f.tail > m.tail ? f : m));
  const C4 = entries().find((e) => e.seqId === f4.seqId && e.seq === f4.tail - 5n);
  setBoundary(C4);
  gen(5, 'd');
  inCt('journalctl --vacuum-size=1 >/dev/null 2>&1; sleep 1');
  const r5 = risk();
  check(
    'lost — с номерами пропуска',
    r5.state === 'lost' &&
      r5.lost?.first === String(C4.seq + 1n) &&
      BigInt(r5.lost?.last ?? 0) >= f4.tail,
    `C=${C4.seq}, хвост файла ${f4.tail}; ${show(r5)}`,
  );

  // ---------------------------------------------------------------- 5
  console.log('\n▸ 5. Переход нумерации');
  const T5 = entries().at(-1);
  setBoundary(T5);
  inCt(
    'd=$(ls -d /var/log/journal/*); systemctl kill -s KILL systemd-journald; sleep 1; mv $d/system.journal $d/system.journal~; systemctl restart systemd-journald; sleep 1',
  );
  gen(10, 'e');
  const after = entries();
  const newSid = after.at(-1).seqId;
  const r6 = risk();
  check(
    'прежняя закрыта и дочитана до C, новая с 1 — ok, не потеря',
    newSid !== T5.seqId && after.at(-1).seq < 100n && r6.state === 'ok',
    `${T5.seqId.slice(0, 8)}→${newSid.slice(0, 8)}; ${show(r6)}`,
  );
  // Файлы прежней нумерации — по заголовку: повреждённый файл journald
  // переименовывает в system@<время>-<случайное>.journal~, нумерации в имени нет.
  const oldFiles = headers()
    .filter((f) => f.seqId === T5.seqId)
    .map((f) => f.path);
  inCt(`rm -f ${oldFiles.map((p) => `'${p}'`).join(' ')}`);
  const r7 = risk();
  check(
    'файлов прежней нумерации нет, новая с 1 — непрерывность не доказана: unknown',
    r7.state === 'unknown' && r7.reason === 'transition-unproven' && r7.grace === false,
    show(r7),
  );
} catch (error) {
  failed++;
  console.log(`  FAIL  испытание прервано: ${error.message}`);
} finally {
  if (keep) console.log(`\n(--keep: оставлен контейнер ${CT})`);
  else sh('docker', ['rm', '-f', CT], { allowFail: true });
}
console.log(`\nИТОГ: ${passed} OK, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
