#!/usr/bin/env node
/**
 * Испытание восстановления одного файла (работа № 6 раздела 01; CHK-FILE-RESTORE).
 *
 *   test-1:  FIFTH_LOAD_BASE=https://test-1.5espace.com FIFTH_LOAD_BASIC_AUTH_FILE=… \
 *            FIFTH_LOAD_ADMIN_EMAIL=… FIFTH_LOAD_ADMIN_PASSWORD_FILE=… \
 *            node scripts/check-file-restore.mjs --target test-1
 *   стенд:   node scripts/check-file-restore.mjs --target local
 *
 * Серверные шаги — `scripts/file-restore.mjs` (на test-1 — через `fifth-test op
 * prod-file-restore`, конфигурация test-1 закреплена обёрткой). Участники — свой набор
 * `seed.mjs` (убирается в конце). Сценарии:
 *   1. назначения сверены до работы; защита готового материала (обычное изменение
 *      запрещено, роли приложения не обходят её ни отметкой, ни вызовом функции);
 *   2. файловая копия снята; она не выбирается как комплект восстановления;
 *   3. файл цел — восстанавливать нечего, ничего не меняется;
 *   4. файл утрачен → повреждённая копия отвергается, материал не изменён;
 *   5. восстановление с конкурентной сменой видимости: видимость не затёрта, владелец
 *      получает файл с прежней суммой, посторонний — 404, второй материал не тронут,
 *      событие журнала с оператором, основанием, операцией и инцидентом;
 *   6. повтор — ни нового объекта, ни события;
 *   7. конкурентное восстановление: запись изменилась — связь не переключена, лишний
 *      объект убран, успех не объявлен;
 *   8. записи нет / материал не готов — отказ, запись не создаётся;
 *   9. цепочка журнала цела.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { BASE, adminLogin, client, isLocalBase, parseArgs, runDir } from './load/lib.mjs';

const args = parseArgs(process.argv.slice(2));
const TARGET = String(args.target ?? '');
if (!['test-1', 'local'].includes(TARGET)) {
  console.error('нужен --target test-1 | local');
  process.exit(2);
}
if ((TARGET === 'local') !== isLocalBase()) {
  console.error(`адрес ${BASE} не соответствует цели ${TARGET}`);
  process.exit(2);
}
const startedAt = new Date().toISOString();
const stamp = startedAt.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
const out = join('out', 'suites', `file-restore-${TARGET}-${stamp}`);
mkdirSync(out, { recursive: true });
const sha = (b) => createHash('sha256').update(b).digest('hex');

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

// ---------------------------------------------------------------- серверные шаги

const SSH = [
  '-i',
  join(homedir(), '.ssh', 'maus_5e'),
  '-o',
  'IdentitiesOnly=yes',
  '-o',
  'BatchMode=yes',
  '-o',
  'ServerAliveInterval=15',
  'maus@193.233.217.210',
];
function opArgs(cmd, a) {
  return TARGET === 'local'
    ? [process.execPath, ['scripts/file-restore.mjs', cmd, '--env', 'local', ...a, '--json']]
    : [
        'ssh',
        [
          ...SSH,
          ['sudo -n /usr/local/sbin/fifth-test op prod-file-restore', cmd, ...a, '--json']
            .map((x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replace(/'/g, "'\\''")}'`))
            .join(' '),
        ],
      ];
}
const opEnv = { ...process.env, FIFTH_FILE_RESTORE_LOCAL: TARGET === 'local' ? '1' : '' };
function parse(stdout, code) {
  const line = stdout
    .split('\n')
    .reverse()
    .find((l) => l.startsWith('RESULT '));
  return { code, result: line ? JSON.parse(line.slice(7)) : null, text: stdout };
}
function op(cmd, ...a) {
  const [bin, argv] = opArgs(cmd, a);
  const r = spawnSync(bin, argv, { encoding: 'utf8', env: opEnv, timeout: 900_000 });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  log.push(text.trim());
  for (const l of text.trim().split('\n')) if (!l.startsWith('RESULT ')) console.log(`    ${l}`);
  return parse(r.stdout ?? '', r.status);
}
function opBackground(cmd, ...a) {
  const [bin, argv] = opArgs(cmd, a);
  const child = spawn(bin, argv, { env: opEnv });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stdout += d));
  return new Promise((res) => child.on('close', (code) => res(parse(stdout, code))));
}
/** Окно перед переключением: файл ожидания и снятие паузы. */
const pauseDir = TARGET === 'local' ? join(out, 'pause') : '/run/fifth-file-restore';
async function waitPaused(token) {
  for (let i = 0; i < 240; i += 1) {
    if (TARGET === 'local') {
      try {
        readFileSync(join(pauseDir, `${token}.waiting`));
        return true;
      } catch {
        /* ещё нет */
      }
    } else if (op('paused', token).code === 0) return true;
    await sleep(2500);
  }
  return false;
}
function release(token) {
  if (TARGET === 'local') writeFileSync(join(pauseDir, token), 'go');
  else op('release', token);
}
const pausePath = (token) => (TARGET === 'local' ? join(pauseDir, token) : `${pauseDir}/${token}`);
if (TARGET === 'local') mkdirSync(pauseDir, { recursive: true });

// ---------------------------------------------------------------- участники

const runId = `fr-${stamp.slice(2, 13).replace('-', '')}`.toLowerCase();
const seedEnv = { ...process.env };
function seed(cmd, extra = []) {
  const r = spawnSync(
    process.execPath,
    ['scripts/load/seed.mjs', cmd, '--run-id', runId, ...extra],
    { encoding: 'utf8', env: seedEnv, timeout: 600_000 },
  );
  if (r.status !== 0)
    throw new Error(`seed ${cmd}: ${(r.stderr || r.stdout).trim().split('\n').at(-1)}`);
}
async function login(u) {
  const c = client();
  const r = await c.call('/v1/auth/login', { method: 'POST', body: u });
  if (r.status !== 200 && r.status !== 201) throw new Error(`вход ${u.email}: ${r.status}`);
  return c;
}
async function uploadFile(c, projectId, body, finalize = true) {
  const t = await c.call(`/v1/projects/${projectId}/materials/upload`, {
    method: 'POST',
    key: true,
    body: {
      type: 'deck',
      fileName: 'restore.pdf',
      contentType: 'application/pdf',
      sizeBytes: body.length,
    },
  });
  const id = t.json?.materialId;
  if (!id) throw new Error(`билет загрузки: ${t.status}`);
  // Только билет, файла нет: материал остаётся неготовым (сверка его не опубликует).
  if (!finalize) return id;
  const form = new FormData();
  for (const [k, v] of Object.entries(t.json.formFields ?? {})) form.append(k, v);
  form.append('file', new Blob([body], { type: 'application/pdf' }), 'restore.pdf');
  const put = await fetch(t.json.uploadUrl, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (put.status >= 400) throw new Error(`форма хранилища: ${put.status}`);
  for (let i = 0; i < 20; i += 1) {
    const f = await c.call(`/v1/projects/${projectId}/materials/${id}/finalize`, {
      method: 'POST',
    });
    if (f.json?.uploadState === 'ready') return id;
    await sleep(1500);
  }
  throw new Error('материал не стал готовым');
}

// ---------------------------------------------------------------- испытание

let dataSeeded = false;
try {
  say(`назначения (${TARGET})`);
  const targets = op('targets');
  check('назначения сверены до работы', targets.code === 0);
  if (targets.code !== 0) throw new Error('назначения не подтверждены');

  say('участники и материалы');
  seed('seed', ['--users', '2', '--projects', '2']);
  dataSeeded = true;
  const users = JSON.parse(readFileSync(join(runDir(runId), 'users.json'), 'utf8')).users;
  const ownerUser = users.find((u) => u.projects.length) ?? users[0];
  const stranger = users.find((u) => u !== ownerUser);
  const projectId = ownerUser.projects[0].id;
  const owner = await login({ email: ownerUser.email, password: ownerUser.password });
  const other = await login({ email: stranger.email, password: stranger.password });
  const admin = await adminLogin();
  const me = await admin.call('/v1/auth/me');
  const operator = me.json?.id ?? me.json?.user?.id;
  check('оператор — администратор цели', Boolean(operator));
  const bodyA = Buffer.from(`%PDF-1.4\n% работа 6 ${runId} ${randomUUID()}\n%%EOF\n`);
  const bodyB = Buffer.from(`%PDF-1.4\n% контроль ${runId} ${randomUUID()}\n%%EOF\n`);
  const m1 = await uploadFile(owner, projectId, bodyA);
  const m2 = await uploadFile(owner, projectId, bodyB);
  const pending = await uploadFile(owner, projectId, bodyB, false);
  console.log(`    материалы: ${m1} (восстанавливаемый), ${m2} (контроль), ${pending} (не готов)`);
  const read = async (c, id) => {
    const r = await c.call(`/v1/projects/${projectId}/materials/${id}/content`);
    return { status: r.status, sha: r.status === 200 ? sha(Buffer.from(r.text, 'latin1')) : null };
  };
  // Ответ читается текстом (клиент lib.mjs): суммы сравниваются по одинаково переведённым байтам.
  const shaText = (b) => sha(Buffer.from(b.toString('utf8'), 'latin1'));
  check('владелец читает файл до испытания', (await read(owner, m1)).sha === shaText(bodyA));
  const before2 = op('state', '--trial', '--material', m2).result;

  say('защита готового материала');
  const g = op('guards', '--trial', '--material', m1);
  check(
    'обычное изменение запрещено, приложение не обходит защиту',
    g.code === 0 && g.result?.pass,
  );

  say('файловая копия');
  const setOk = op('files-set', '--materials', `${m1},${m2}`);
  const setBad = op('files-set', '--materials', `${m1},${m2}`);
  check('файловые копии сняты', setOk.code === 0 && setBad.code === 0);
  const rs = op('ready-sets', '--trial');
  check(
    'файловая копия не выбирается как комплект восстановления',
    rs.code === 0 && rs.result?.filesSets >= 2 && rs.result.readySets.length === 0,
    `readySets: ${JSON.stringify(rs.result?.readySets)}`,
  );

  const restoreArgs = (extra = []) => [
    '--material',
    m1,
    '--operator',
    operator,
    '--reason',
    'испытание работы 6',
    '--incident',
    `TRIAL-${runId}`,
    ...extra,
  ];

  say('файл цел');
  let s0 = op('state', '--trial', '--material', m1).result;
  const intact = op('restore', ...restoreArgs());
  let s1 = op('state', '--trial', '--material', m1).result;
  check(
    'цел — восстанавливать нечего, ничего не меняется',
    intact.code === 0 &&
      intact.result?.outcome === 'intact' &&
      s1.key === s0.key &&
      s1.events === 0,
  );

  say('утрата и повреждённая копия');
  op('drop-object', '--trial', '--material', m1);
  const lost = await read(owner, m1);
  check('файл утрачен (владелец его не получает)', lost.status !== 200, `HTTP ${lost.status}`);
  op('corrupt-set', '--trial', '--set', setBad.result.id);
  const bad = op('restore', ...restoreArgs(['--set', setBad.result.id]));
  s1 = op('state', '--trial', '--material', m1).result;
  check(
    'повреждённая копия отвергается, материал не изменён',
    bad.code === 2 && s1.key === s0.key && s1.events === 0 && s1.objects === 0,
    bad.result?.refused,
  );

  say('восстановление с конкурентной сменой видимости');
  const t1 = randomUUID();
  const run1 = opBackground(
    'restore',
    ...restoreArgs(['--set', setOk.result.id, '--pause-before-link', pausePath(t1)]),
  );
  const paused1 = await waitPaused(t1);
  const vis = await owner.call(`/v1/projects/${projectId}/materials/${m1}/visibility`, {
    method: 'PUT',
    body: { visibility: s0.visibility === 'private' ? 'investors' : 'private' },
  });
  release(t1);
  const r1 = await run1;
  log.push(r1.text);
  const s2 = op('state', '--trial', '--material', m1).result;
  check('пауза перед переключением наступила', paused1);
  check('видимость сменена во время восстановления', vis.status === 200, `HTTP ${vis.status}`);
  check('восстановлено', r1.code === 0 && r1.result?.outcome === 'restored', r1.result?.refused);
  check('конкурентная смена видимости не затёрта', s2.visibility !== s0.visibility, s2.visibility);
  check(
    'ключ новый, объект один, событие одно',
    s2.key !== s0.key && s2.objects === 1 && s2.events === 1,
  );
  check('владелец получает файл с прежней суммой', (await read(owner, m1)).sha === shaText(bodyA));
  const strangerRead = await read(other, m1);
  check('посторонний — 404', strangerRead.status === 404, `HTTP ${strangerRead.status}`);
  const after2 = op('state', '--trial', '--material', m2).result;
  check(
    'второй материал не тронут',
    after2.key === before2.key && (await read(owner, m2)).sha === shaText(bodyB),
  );
  const ev = s2.lastEvent ?? {};
  check(
    'событие: оператор, основание, операция, инцидент; владельцу не приписано',
    ev.actor?.kind === 'system' &&
      ev.actor?.userId === null &&
      ev.actor?.initiator?.userId === operator &&
      ev.actor?.basis?.[0]?.name === 'ops.file-restore' &&
      Boolean(ev.actor?.operationId) &&
      ev.incident?.ref === `TRIAL-${runId}` &&
      ev.operator?.userId === operator &&
      Boolean(ev.operator?.hostAccount) &&
      ev.actor?.initiator?.userId !== ownerUser.id,
    JSON.stringify({
      initiator: ev.actor?.initiator,
      operator: ev.operator,
      incident: ev.incident,
    }),
  );

  say('повтор');
  const again = op('restore', ...restoreArgs());
  const s3 = op('state', '--trial', '--material', m1).result;
  check(
    'повтор — ни нового объекта, ни события',
    again.code === 0 &&
      again.result?.outcome === 'intact' &&
      s3.objects === 1 &&
      s3.events === 1 &&
      s3.key === s2.key,
  );

  say('конкурентное восстановление');
  op('drop-object', '--trial', '--material', m1);
  const t2 = randomUUID();
  const slow = opBackground('restore', ...restoreArgs(['--pause-before-link', pausePath(t2)]));
  const paused2 = await waitPaused(t2);
  const fast = op('restore', ...restoreArgs());
  release(t2);
  const late = await slow;
  log.push(late.text);
  const s4 = op('state', '--trial', '--material', m1).result;
  check('пауза перед переключением наступила', paused2);
  check(
    'параллельное восстановление прошло',
    fast.code === 0 && fast.result?.outcome === 'restored',
  );
  check(
    'запись изменилась — связь не переключена, успех не объявлен',
    late.code === 2 && /изменилась/.test(late.result?.refused ?? ''),
    late.result?.refused,
  );
  check(
    'ключ — от прошедшего, лишний объект убран, событий два',
    s4.key === fast.result?.newKey && s4.objects === 1 && s4.events === 2,
    `объектов ${s4.objects}, событий ${s4.events}`,
  );
  check('владелец получает файл с прежней суммой', (await read(owner, m1)).sha === shaText(bodyA));

  say('записи нет / не готов');
  const ghost = randomUUID();
  const noRec = op(
    'restore',
    '--material',
    ghost,
    '--operator',
    operator,
    '--reason',
    'x',
    '--incident',
    'x',
  );
  const gs = op('state', '--trial', '--material', ghost).result;
  check(
    'записи нет — отказ, запись не создана',
    noRec.code === 2 && gs.exists === false,
    noRec.result?.refused,
  );
  const np = op(
    'restore',
    '--material',
    pending,
    '--operator',
    operator,
    '--reason',
    'x',
    '--incident',
    'x',
  );
  check(
    'материал не готов — отказ',
    np.code === 2 && /не готов/.test(np.result?.refused ?? ''),
    np.result?.refused,
  );

  say('журнал');
  const ch = op('chain', '--trial', '--since', startedAt);
  check('цепочка журнала цела', ch.code === 0 && ch.result?.broken === 0);
} catch (error) {
  check('испытание завершилось', false, error.message);
} finally {
  if (dataSeeded) {
    try {
      seed('clean');
    } catch (error) {
      console.log(`  уборка участников: ${error.message}`);
    }
  }
  const summary = `CHK-FILE-RESTORE (${TARGET}): ${passed}/${passed + failed}`;
  log.push(`\n${summary}`);
  writeFileSync(join(out, 'report.txt'), `${log.join('\n')}\n`);
  console.log(`\n${summary}\nотчёт: ${out}/report.txt`);
  process.exit(failed ? 1 : 0);
}
