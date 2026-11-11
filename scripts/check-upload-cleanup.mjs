#!/usr/bin/env node
/**
 * Испытание очистки служебных копий завершённых загрузок (работа № 8 раздела 01, 3.3;
 * CHK-UPLOAD-CLEANUP). На серверных средах задача выключена до общей приёмки.
 *
 *   стенд:   node scripts/check-upload-cleanup.mjs --target local
 *            (UPLOAD_COPY_CLEANUP_ENABLED=true и BACKGROUND_CONTROL_TOKEN в .env)
 *   test-1:  только при общей приёмке, между `fifth-test op prod-cleanup-trial on` и `off`:
 *            FIFTH_LOAD_BASE=https://test-1.5espace.com … node scripts/check-upload-cleanup.mjs --target test-1
 *
 * Проход — служебная команда фона `/background/run/uploads.copy-cleanup` (тот же механизм и
 * ограничения). Шаги с базой и хранилищем — `scripts/file-restore.mjs --trial`.
 * Сценарии:
 *   1. до срока копии остаются;
 *   2. после срока каждое условие запрещает удаление: запрет на материал, на проект и на всю
 *      среду, активная попытка, неистёкшее разрешение передачи, открытая утрата;
 *   3. ссылка на ключ из другой записи сохраняет этот ключ, остальные служебные копии
 *      удаляются; снятие ссылки — удаляется и он;
 *   4. файл материала и опубликованная копия целы, владелец читает файл; отклонённая загрузка
 *      (брошенная, не завершённая) не тронута;
 *   5. повторный проход ничего не ломает; ошибок очистки нет;
 *   6. протокол запрета (M180): запрет, поставленный во время идущей очистки, подтверждается
 *      только после её окончания, а следующее взятие видит его; не дождавшийся запрет не
 *      устанавливается вовсе.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { BASE, client, isLocalBase, parseArgs, runDir } from './load/lib.mjs';

const TARGET = String(parseArgs(process.argv.slice(2)).target ?? 'local');
if (!['test-1', 'local'].includes(TARGET) || (TARGET === 'local') !== isLocalBase()) {
  console.error(`нужен --target test-1 | local, согласованный с адресом ${BASE}`);
  process.exit(2);
}
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
const out = join('out', 'suites', `upload-cleanup-${TARGET}-${stamp}`);
mkdirSync(out, { recursive: true });

let passed = 0;
let failed = 0;
const log = [];
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  const line = `  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`;
  log.push(line);
  console.log(line);
}
const say = (s) => {
  log.push(`\n== ${s}`);
  console.log(`\n== ${s}`);
};
const SSH = [
  '-i',
  join(homedir(), '.ssh', 'maus_5e'),
  '-o',
  'IdentitiesOnly=yes',
  '-o',
  'BatchMode=yes',
  'maus@193.233.217.210',
];
const shellQuote = (x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replace(/'/g, "'\\''")}'`);
function op(cmd, ...a) {
  const [bin, argv] =
    TARGET === 'local'
      ? [process.execPath, ['scripts/file-restore.mjs', cmd, '--env', 'local', ...a, '--json']]
      : [
          'ssh',
          [
            ...SSH,
            ['sudo -n /usr/local/sbin/fifth-test op prod-file-restore', cmd, ...a, '--json']
              .map(shellQuote)
              .join(' '),
          ],
        ];
  const r = spawnSync(bin, argv, {
    encoding: 'utf8',
    env: { ...process.env, FIFTH_FILE_RESTORE_LOCAL: TARGET === 'local' ? '1' : '' },
    timeout: 600_000,
  });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  log.push(text);
  for (const l of text.split('\n')) if (l && !l.startsWith('RESULT ')) console.log(`    ${l}`);
  const line = (r.stdout ?? '')
    .split('\n')
    .reverse()
    .find((l) => l.startsWith('RESULT '));
  return { code: r.status, result: line ? JSON.parse(line.slice(7)) : null };
}
const trial = (cmd, ...a) => op(cmd, '--trial', ...a).result;

const runId = `uc-${stamp.slice(2).replace('-', '')}`.toLowerCase();
function seed(cmd, extra = []) {
  const r = spawnSync(
    process.execPath,
    ['scripts/load/seed.mjs', cmd, '--run-id', runId, ...extra],
    { encoding: 'utf8', timeout: 600_000 },
  );
  if (r.status !== 0)
    throw new Error(`seed ${cmd}: ${(r.stderr || r.stdout).trim().split('\n').at(-1)}`);
}
async function upload(c, projectId, body, finalize = true) {
  const t = await c.call(`/v1/projects/${projectId}/materials/upload`, {
    method: 'POST',
    key: true,
    body: {
      type: 'deck',
      fileName: 'cleanup.pdf',
      contentType: 'application/pdf',
      sizeBytes: body.length,
    },
  });
  if (!t.json?.materialId) throw new Error(`билет: ${t.status}`);
  if (!finalize) return t.json.materialId;
  const form = new FormData();
  for (const [k, v] of Object.entries(t.json.formFields ?? {})) form.append(k, v);
  form.append('file', new Blob([body], { type: 'application/pdf' }), 'cleanup.pdf');
  const put = await fetch(t.json.uploadUrl, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (put.status >= 400) throw new Error(`форма: ${put.status}`);
  let state = null;
  for (let i = 0; i < 20; i += 1) {
    const f = await c.call(`/v1/projects/${projectId}/materials/${t.json.materialId}/finalize`, {
      method: 'POST',
    });
    state = f.json?.uploadState;
    if (state === 'ready' || state === 'rejected') break;
    await sleep(1500);
  }
  return { id: t.json.materialId, state };
}

let seeded = false;
try {
  say('стенд');
  check('назначения сверены', op('targets').code === 0);
  const probe = trial('cleanup-run');
  check(
    'служебный проход доступен (задача включена на стенде)',
    probe?.ran === true,
    probe?.reason,
  );

  say('материал и служебные копии');
  seed('seed', ['--users', '1', '--projects', '2']);
  seeded = true;
  const u = JSON.parse(readFileSync(join(runDir(runId), 'users.json'), 'utf8')).users[0];
  const owner = client();
  await owner.call('/v1/auth/login', {
    method: 'POST',
    body: { email: u.email, password: u.password },
  });
  const projectId = u.projects[0].id;
  const ready = await upload(
    owner,
    projectId,
    Buffer.from(`%PDF-1.4\n% cleanup ${runId}\n%%EOF\n`),
  );
  const rejected = await upload(owner, projectId, Buffer.from(`not a pdf ${runId}`));
  const pending = await upload(owner, projectId, Buffer.alloc(16), false);
  check(
    'готовый и отклонённый материалы',
    ready.state === 'ready' && rejected.state === 'rejected',
    `${ready.state}/${rejected.state}`,
  );
  const m = ready.id;
  const fx = trial('cleanup-fixture', '--material', m);
  const service = [fx.upload, fx.failed.key, fx.abandoned.key, fx.copied.key].filter(Boolean);
  const keep = [fx.final, ...fx.published];
  const exists = (keys) => trial('exists', '--keys', keys.join(',')).exists;
  const all = (keys, want) => {
    const e = exists(keys);
    return keys.every((k) => e[k] === want);
  };
  check(
    'служебные копии и файл на месте',
    all([...service, ...keep], true),
    `${service.length} служебных`,
  );

  say('до срока');
  trial('cleanup-run');
  check('до срока копии остаются', all(service, true));

  say('после срока: запреты');
  trial('cleanup-set', '--material', m, '--what', 'age', '--days', '8');
  const blocked = async (label, on, off) => {
    const h = on();
    trial('cleanup-run');
    check(`${label} — ничего не удалено`, all(service, true));
    off(h);
  };
  await blocked(
    'запрет на материал',
    () =>
      op('cleanup-hold', '--material', m, '--reason', 'испытание 8', '--incident', `TRIAL-${runId}`)
        .result.hold,
    (h) => op('cleanup-release', '--hold', h),
  );
  await blocked(
    'запрет на проект',
    () => op('cleanup-hold', '--project', projectId, '--reason', 'испытание 8').result.hold,
    (h) => op('cleanup-release', '--hold', h),
  );
  await blocked(
    'запрет на всю среду',
    () => op('cleanup-hold', '--all', '--reason', 'испытание 8').result.hold,
    (h) => op('cleanup-release', '--hold', h),
  );
  await blocked(
    'активная попытка (результат копирования неизвестен)',
    () =>
      trial(
        'cleanup-set',
        '--material',
        m,
        '--what',
        'attempt-copying',
        '--attempt',
        fx.failed.attempt,
      ),
    () =>
      trial(
        'cleanup-set',
        '--material',
        m,
        '--what',
        'attempt-failed',
        '--attempt',
        fx.failed.attempt,
      ),
  );
  await blocked(
    'неистёкшее разрешение передачи',
    () => trial('cleanup-set', '--material', m, '--what', 'permit-open'),
    () => trial('cleanup-set', '--material', m, '--what', 'permit-closed'),
  );
  await blocked(
    'открытая утрата файла',
    () => trial('cleanup-set', '--material', m, '--what', 'lost-open'),
    () => trial('cleanup-set', '--material', m, '--what', 'lost-close'),
  );

  say('ссылка на ключ из другой записи');
  trial('cleanup-set', '--what', 'ref-on', '--other', pending, '--key', fx.copied.key);
  trial('cleanup-run');
  const e1 = exists(service);
  check(
    'ключ со ссылкой сохранён, остальные служебные копии удалены',
    e1[fx.copied.key] === true &&
      service.filter((k) => k !== fx.copied.key).every((k) => e1[k] === false),
    JSON.stringify(e1),
  );
  check('файл материала и опубликованная копия целы', all(keep, true));
  const read = await owner.call(`/v1/projects/${projectId}/materials/${m}/content`);
  check('владелец читает файл', read.status === 200, `HTTP ${read.status}`);
  trial(
    'cleanup-set',
    '--what',
    'ref-off',
    '--other',
    pending,
    '--key',
    `${fx.copied.key}-released`,
  );
  trial('cleanup-run');
  check('ссылка снята — удалён и этот ключ', exists([fx.copied.key])[fx.copied.key] === false);

  say('итог');
  const st = trial('cleanup-state', '--material', m);
  check(
    'отметки: исходник и три попытки очищены, опубликованная — нет, ошибок нет',
    st.upload === true &&
      [fx.failed, fx.abandoned, fx.copied].every((a) => st.attempts[a.attempt]?.cleaned) &&
      Object.values(st.attempts)
        .filter((a) => a.state === 'published')
        .every((a) => !a.cleaned) &&
      st.queues.cleanupFailed === 0,
    JSON.stringify(st.queues),
  );
  trial('cleanup-set', '--material', rejected.id, '--what', 'age', '--days', '30');
  const again = trial('cleanup-run');
  check('повторный проход без ошибок', again.ran && !again.error, again.status);
  const rs = trial('cleanup-state', '--material', rejected.id);
  check(
    'отклонённая загрузка не тронута',
    rs.upload === false && Boolean(rs.uploadKey) && exists([rs.uploadKey])[rs.uploadKey] === true,
    JSON.stringify({ upload: rs.upload }),
  );
  check('открытых запретов не осталось', st.queues.cleanupHolds === 0);

  say('протокол запрета (M180)');
  const race = trial(
    'hold-race',
    '--material',
    m,
    '--reason',
    'испытание протокола',
    '--busy-sec',
    '5',
    '--wait-sec',
    '30',
  );
  check(
    'запрет во время очистки подтверждён только после её окончания',
    Boolean(race.hold) && race.confirmedAfterCleanup === true && race.waitedMs >= 2500,
    JSON.stringify(race),
  );
  const c = trial('claim-now', '--material', m);
  check('следующее взятие видит запрет', c.claim === 'запрет очистки', c.claim);
  op('cleanup-release', '--hold', race.hold);
  const late = trial(
    'hold-race',
    '--material',
    m,
    '--reason',
    'испытание протокола',
    '--busy-sec',
    '6',
    '--wait-sec',
    '1',
  );
  check(
    'не дождался очистки — запрет не установлен и об этом сказано',
    !late.hold && /НЕ установлен/.test(late.refused ?? '') && late.holdsAdded === 0,
    JSON.stringify(late),
  );
} catch (error) {
  check('испытание завершилось', false, error.message);
} finally {
  if (seeded) {
    try {
      seed('clean');
    } catch (error) {
      console.log(`  уборка участников: ${error.message}`);
    }
  }
  const summary = `CHK-UPLOAD-CLEANUP (${TARGET}): ${passed}/${passed + failed}`;
  log.push(`\n${summary}`);
  writeFileSync(join(out, 'report.txt'), `${log.join('\n')}\n`);
  console.log(`\n${summary}\nотчёт: ${out}/report.txt`);
  process.exit(failed ? 1 : 0);
}
