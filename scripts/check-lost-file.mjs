#!/usr/bin/env node
/**
 * Испытание обнаружения утраты готового файла (работа № 7 раздела 01, 3.2; CHK-LOST-FILE).
 *
 *   стенд:   node scripts/check-lost-file.mjs --target local
 *   test-1:  FIFTH_LOAD_BASE=https://test-1.5espace.com … node scripts/check-lost-file.mjs --target test-1
 *
 * Серверные шаги — `scripts/file-restore.mjs` (на test-1 — `fifth-test op prod-file-restore`).
 * Сценарии:
 *   1. материал: объект удалён → владелец получает 500 `stored_file_missing`, утрата открыта,
 *      /queues files.lost растёт; повтор — та же строка, счётчик; посторонний и
 *      несуществующая запись — 404, учёта нет;
 *   2. гонка: учёт утраты старого ключа приходит, пока смена ключа держит запись, — ждёт и
 *      ничего не открывает (stale);
 *   3. восстановление № 6 закрывает утрату как restored; запоздавший учёт старого ключа её не
 *      открывает заново; владелец снова получает файл;
 *   4. изображение проекта и аватар: утрата → 500 и учёт; замена закрывает её как replaced,
 *      запоздавший учёт старого ключа — stale; удаление — removed (не «восстановлено»);
 *   5. закрытые строки сохраняются (история), открытых утрат испытания не остаётся.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import sharp from 'sharp';
import { BASE, adminLogin, client, isLocalBase, parseArgs, runDir } from './load/lib.mjs';

const args = parseArgs(process.argv.slice(2));
const TARGET = String(args.target ?? '');
if (!['test-1', 'local'].includes(TARGET) || (TARGET === 'local') !== isLocalBase()) {
  console.error(`нужен --target test-1 | local, согласованный с адресом ${BASE}`);
  process.exit(2);
}
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
const out = join('out', 'suites', `lost-file-${TARGET}-${stamp}`);
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
function op(cmd, ...a) {
  const [bin, argv] =
    TARGET === 'local'
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
  const r = spawnSync(bin, argv, {
    encoding: 'utf8',
    env: { ...process.env, FIFTH_FILE_RESTORE_LOCAL: TARGET === 'local' ? '1' : '' },
    timeout: 900_000,
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

const runId = `lf-${stamp.slice(2, 13).replace('-', '')}`.toLowerCase();
function seed(cmd, extra = []) {
  const r = spawnSync(
    process.execPath,
    ['scripts/load/seed.mjs', cmd, '--run-id', runId, ...extra],
    {
      encoding: 'utf8',
      timeout: 600_000,
    },
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
async function postForm(ticket, body, type, name) {
  const form = new FormData();
  for (const [k, v] of Object.entries(ticket.formFields ?? {})) form.append(k, v);
  form.append('file', new Blob([body], { type }), name);
  const put = await fetch(ticket.uploadUrl, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (put.status >= 400) throw new Error(`форма хранилища: ${put.status}`);
}
async function uploadMaterial(c, projectId, body) {
  const t = await c.call(`/v1/projects/${projectId}/materials/upload`, {
    method: 'POST',
    key: true,
    body: {
      type: 'deck',
      fileName: 'lost.pdf',
      contentType: 'application/pdf',
      sizeBytes: body.length,
    },
  });
  if (!t.json?.materialId) throw new Error(`билет материала: ${t.status}`);
  await postForm(t.json, body, 'application/pdf', 'lost.pdf');
  for (let i = 0; i < 20; i += 1) {
    const f = await c.call(`/v1/projects/${projectId}/materials/${t.json.materialId}/finalize`, {
      method: 'POST',
    });
    if (f.json?.uploadState === 'ready') return t.json.materialId;
    await sleep(1500);
  }
  throw new Error('материал не стал готовым');
}
const image = (r, g, b) =>
  sharp({ create: { width: 400, height: 400, channels: 3, background: { r, g, b } } })
    .jpeg()
    .toBuffer();
async function uploadLogo(c, projectId, body) {
  const t = await c.call(`/v1/projects/${projectId}/media/upload`, {
    method: 'POST',
    body: { kind: 'logo', contentType: 'image/jpeg', sizeBytes: body.byteLength },
  });
  if (!t.json?.uploadId) throw new Error(`билет изображения: ${t.status}`);
  await postForm(t.json, body, 'image/jpeg', 'logo.jpg');
  const f = await c.call(`/v1/projects/${projectId}/media/logo/finalize`, {
    method: 'POST',
    key: true,
    body: { uploadId: t.json.uploadId, focusX: 0.5, focusY: 0.5 },
  });
  if (f.status !== 200 && f.status !== 201) throw new Error(`изображение: ${f.status}`);
}
async function uploadAvatar(c, body) {
  const t = await c.call('/v1/me/avatar/upload', {
    method: 'POST',
    body: { contentType: 'image/jpeg', sizeBytes: body.byteLength },
  });
  if (!t.json?.uploadUrl) throw new Error(`билет аватара: ${t.status}`);
  await postForm(t.json, body, 'image/jpeg', 'avatar.jpg');
  const f = await c.call('/v1/me/avatar/finalize', { method: 'POST' });
  if (f.status !== 200) throw new Error(`аватар: ${f.status}`);
}
/** Вариант по ключу: путь чтения и размер. */
const sizeOf = (key) =>
  key
    .split('/')
    .at(-1)
    .replace(/\.webp$/, '');
const openLost = () => trial('lost', '--key', 'none').files.lost;

let seeded = false;
try {
  say(`назначения (${TARGET})`);
  check('назначения сверены до работы', op('targets').code === 0);

  say('участники');
  seed('seed', ['--users', '2', '--projects', '2']);
  seeded = true;
  const users = JSON.parse(readFileSync(join(runDir(runId), 'users.json'), 'utf8')).users;
  const ownerUser = users.find((u) => u.projects.length) ?? users[0];
  const strangerUser = users.find((u) => u !== ownerUser);
  const projectId = ownerUser.projects[0].id;
  const owner = await login({ email: ownerUser.email, password: ownerUser.password });
  const stranger = await login({ email: strangerUser.email, password: strangerUser.password });
  const admin = await adminLogin();
  const operator = (await admin.call('/v1/auth/me')).json?.id;
  const base = openLost();

  say('материал: утрата');
  const m1 = await uploadMaterial(
    owner,
    projectId,
    Buffer.from(`%PDF-1.4\n% lost ${runId}\n%%EOF\n`),
  );
  const m2 = await uploadMaterial(
    owner,
    projectId,
    Buffer.from(`%PDF-1.4\n% race ${runId}\n%%EOF\n`),
  );
  op('files-set', '--materials', `${m1},${m2}`);
  const k1 = trial('keys', '--kind', 'material', '--record', m1).keys[0];
  trial('drop-key', '--key', k1);
  const read1 = await owner.call(`/v1/projects/${projectId}/materials/${m1}/content`);
  check(
    'владелец: 500 stored_file_missing, не 404',
    read1.status === 500 && read1.json?.code === 'stored_file_missing',
    `HTTP ${read1.status} ${read1.json?.code ?? ''}`,
  );
  let l = trial('lost', '--key', k1);
  check(
    'утрата открыта, /queues files.lost +1',
    l.rows.length === 1 &&
      l.rows[0].open &&
      l.rows[0].kind === 'material' &&
      l.files.lost === base + 1,
    JSON.stringify(l),
  );
  await owner.call(`/v1/projects/${projectId}/materials/${m1}/content`);
  l = trial('lost', '--key', k1);
  check('повтор — та же строка, счётчик 2', l.rows.length === 1 && l.rows[0].hits === 2);
  const strangerRead = await stranger.call(`/v1/projects/${projectId}/materials/${m1}/content`);
  const ghost = await owner.call(`/v1/projects/${projectId}/materials/${randomUUID()}/content`);
  l = trial('lost', '--key', k1);
  check(
    'посторонний и несуществующая запись — 404, учёта нет',
    strangerRead.status === 404 &&
      ghost.status === 404 &&
      l.rows[0].hits === 2 &&
      l.files.lost === base + 1,
    `${strangerRead.status}/${ghost.status}`,
  );

  say('гонка учёта со сменой ключа');
  const k2 = trial('keys', '--kind', 'material', '--record', m2).keys[0];
  const race = trial('race-report', '--material', m2);
  const l2 = trial('lost', '--key', k2);
  check(
    'учёт старого ключа ждал смену и ничего не открыл',
    race.late === 'stale' && race.waitedMs >= 1500 && l2.rows.length === 0,
    JSON.stringify(race),
  );

  say('восстановление № 6 закрывает утрату');
  const rs = op(
    'restore',
    '--material',
    m1,
    '--operator',
    operator,
    '--reason',
    'испытание работы 7',
    '--incident',
    `TRIAL-${runId}`,
  );
  l = trial('lost', '--key', k1);
  check(
    'утрата закрыта как restored, строка сохранена',
    rs.code === 0 &&
      l.rows.length === 1 &&
      !l.rows[0].open &&
      l.rows[0].resolution === 'restored' &&
      l.files.lost === base,
    JSON.stringify(l.rows),
  );
  const late = trial('report-late', '--kind', 'material', '--record', m1, '--key', k1);
  l = trial('lost', '--key', k1);
  check(
    'запоздавший учёт старого ключа не открывает утрату заново',
    late.result === 'stale' && l.rows.length === 1 && l.files.lost === base,
  );
  const back = await owner.call(`/v1/projects/${projectId}/materials/${m1}/content`);
  check('владелец снова получает файл', back.status === 200);

  for (const kind of ['project_media', 'avatar']) {
    const label = kind === 'avatar' ? 'аватар' : 'изображение проекта';
    say(`${label}: утрата, замена, удаление`);
    const record = kind === 'avatar' ? ownerUser.id : projectId;
    const upload = (b) =>
      kind === 'avatar' ? uploadAvatar(owner, b) : uploadLogo(owner, projectId, b);
    const path = (key) =>
      kind === 'avatar'
        ? `/v1/users/${record}/avatar/${sizeOf(key)}`
        : `/v1/projects/${projectId}/media/logo/${sizeOf(key)}`;
    const remove = () =>
      owner.call(kind === 'avatar' ? '/v1/me/avatar' : `/v1/projects/${projectId}/media/logo`, {
        method: 'DELETE',
      });
    const keysNow = () =>
      trial('keys', '--kind', kind, '--record', record, '--media-kind', 'logo').keys;

    await upload(await image(200, 40, 40));
    const [oldKey] = keysNow();
    trial('drop-key', '--key', oldKey);
    const r = await owner.call(path(oldKey));
    l = trial('lost', '--key', oldKey);
    check(
      `${label}: 500 stored_file_missing и утрата открыта`,
      r.status === 500 && r.json?.code === 'stored_file_missing' && l.rows[0]?.open === true,
      `HTTP ${r.status}`,
    );
    await upload(await image(40, 200, 40));
    l = trial('lost', '--key', oldKey);
    check(
      `${label}: замена закрыла утрату как replaced`,
      l.rows.length === 1 && !l.rows[0].open && l.rows[0].resolution === 'replaced',
      JSON.stringify(l.rows),
    );
    const lateR = trial('report-late', '--kind', kind, '--record', record, '--key', oldKey);
    l = trial('lost', '--key', oldKey);
    check(
      `${label}: запоздавший учёт старого ключа — stale, не открыт заново`,
      lateR.result === 'stale' && l.rows.length === 1,
    );
    const [newKey] = keysNow();
    trial('drop-key', '--key', newKey);
    await owner.call(path(newKey));
    const del = await remove();
    l = trial('lost', '--key', newKey);
    check(
      `${label}: удаление закрыло утрату как removed`,
      del.status < 300 && l.rows.length === 1 && l.rows[0].resolution === 'removed',
      `HTTP ${del.status} ${JSON.stringify(l.rows)}`,
    );
  }

  say('итог учёта');
  check(
    'открытых утрат испытания не осталось',
    openLost() === base,
    `files.lost ${openLost()}, было ${base}`,
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
  const summary = `CHK-LOST-FILE (${TARGET}): ${passed}/${passed + failed}`;
  log.push(`\n${summary}`);
  writeFileSync(join(out, 'report.txt'), `${log.join('\n')}\n`);
  console.log(`\n${summary}\nотчёт: ${out}/report.txt`);
  process.exit(failed ? 1 : 0);
}
