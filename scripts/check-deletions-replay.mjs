#!/usr/bin/env node
/**
 * Учёт удалений после восстановления на изолированной копии (CHK-DELETIONS-REPLAY; 2.1.5,
 * согласовано Тэнком 09.11.2026). Стенд: настоящее ядро, база, Garage.
 *
 *   1. До копии: логотип v1, аватары основателя и второго человека, выдача доступа G1,
 *      исключение E1.
 *   2. Копия базы (pg_dump) — восстанавливается в ОТДЕЛЬНУЮ базу того же кластера.
 *   3. После копии: логотип v2 и удаление; аватар основателя заменён (новый файл есть);
 *      аватар второго заменён, а новый файл из хранилища убран (недоступен); G1 отозвана и
 *      выдана снова (G3); исключение E1 снято; выдача второму получателю и её отзыв.
 *   4. Ежечасная выгрузка (подпись Ed25519, тестовый ключ gpg) → вынос в отдельный каталог
 *      с контрольной точкой → применение к восстановленной копии ИЗ ВЫНЕСЕННОЙ ВЫГРУЗКИ.
 *   5. Итог: удалённое не вернулось (v1 логотипа скрыт), новый аватар основателя на месте,
 *      аватар с недоступным файлом скрыт без ссылки, G3 действует, G1 снята, E1 снято;
 *      повтор ничего не меняет; ворота закрыты до итоговой проверки; открытие — только с
 *      подтверждением конца покрытия; источник другой базы и разрыв серии отвергаются.
 *
 *   node scripts/check-deletions-replay.mjs [--keep]
 *
 * Выгрузка и применение — в Linux-контейнере (gpg); на сервере они идут так же.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { CORE_URL } from './lib/ports.mjs';
import {
  CONSENTS,
  blindIndex,
  createProject,
  loadDotEnv,
  makePool,
} from './lib/project-fixture.mjs';
import { s3Object, storageFromEnv } from './lib/s3.mjs';
import { ROOT } from './lib/backup.mjs';

loadDotEnv();
const keep = process.argv.includes('--keep');
const tag = randomBytes(3).toString('hex');
const RESTORED = `fifth_restore_${tag}`;
const WORK = join(tmpdir(), `deletions-replay-${tag}`).replaceAll('\\', '/');
const IMAGE = 'fifth/journald-testbed:local';
const env = { ...process.env, MSYS_NO_PATHCONV: '1' };

let passed = 0;
let failed = 0;
const check = (name, ok, details = '') => {
  if (ok) passed++;
  else failed++;
  console.log(
    `  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details ? ` — ${String(details).slice(0, 300)}` : ''}`,
  );
};

const pool = makePool('check-deletions-replay');
const sql = async (text, params = []) => (await pool.query(text, params)).rows;
const owner = new URL(process.env.DATABASE_URL_OWNER);
const restoredUrl = (host = owner.host) => {
  const u = new URL(owner);
  u.host = host;
  u.pathname = `/${RESTORED}`;
  return u.toString();
};
const inNetwork = (url) => url.replace(/@localhost:5433\//, '@fifth-postgres:5432/');

// ------------------------------------------------------------ API стенда

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'ul_csrf';
function makeClient() {
  const state = { session: null, csrf: null };
  async function call(path, { method = 'GET', body } = {}) {
    const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf)
      headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
    const response = await fetch(`${CORE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* не JSON */
    }
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(';')[0];
      if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
      if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
    }
    if (response.status >= 400) {
      throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
    }
    return json;
  }
  return call;
}

async function register(role, label) {
  const call = makeClient();
  const email = `dr-${label}-${tag}@test.local`;
  const password = `Pw-${randomBytes(12).toString('hex')}`;
  await call('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: `Учёт ${label}`,
      role,
      locale: 'ru-RU',
      consents: CONSENTS,
    },
  });
  const [row] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
    blindIndex(email),
  ]);
  return { call, email, password, userId: row.id };
}

const image = (w, h, color) =>
  sharp({ create: { width: w, height: h, channels: 3, background: color } })
    .png()
    .toBuffer();

async function upload(ticket, buffer) {
  const form = new FormData();
  for (const [k, v] of Object.entries(ticket.formFields)) form.append(k, v);
  form.append('file', new Blob([buffer], { type: 'image/png' }), 'f.png');
  const r = await fetch(ticket.uploadUrl, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (r.status >= 400) throw new Error(`хранилище: ${r.status}`);
}

async function setLogo(call, projectId, color) {
  const png = await image(600, 600, color);
  const t = await call(`/v1/projects/${projectId}/media/upload`, {
    method: 'POST',
    body: { kind: 'logo', contentType: 'image/png', sizeBytes: png.byteLength },
  });
  await upload(t, png);
  await call(`/v1/projects/${projectId}/media/logo/finalize`, {
    method: 'POST',
    body: { uploadId: t.uploadId, focusX: 0.5, focusY: 0.5 },
  });
}

async function setAvatar(call, color) {
  const png = await image(240, 240, color);
  const t = await call('/v1/me/avatar/upload', {
    method: 'POST',
    body: { contentType: 'image/png', sizeBytes: png.byteLength },
  });
  await upload(t, png);
  await call('/v1/me/avatar/finalize', { method: 'POST' });
}

// ------------------------------------------------------------ контейнер и база

function docker(args, { input, allowFail = false } = {}) {
  const r = spawnSync('docker', args, { env, encoding: 'utf8', input, maxBuffer: 1 << 28 });
  if (r.status !== 0 && !allowFail) {
    throw new Error(
      `docker ${args.slice(0, 3).join(' ')}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`,
    );
  }
  return r;
}

function pgExec(cmd) {
  return docker([
    'exec',
    '-e',
    `PGPASSWORD=${decodeURIComponent(owner.password)}`,
    'fifth-postgres',
    'sh',
    '-c',
    cmd,
  ]);
}

/** Сценарий в Linux-контейнере стенда: выгрузка и применение (gpg). */
function inCt(script, extraEnv = {}) {
  const pass = Object.keys(extraEnv).flatMap((k) => ['-e', k]);
  return spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'fifth_default',
      ...pass,
      '-v',
      `${ROOT.replaceAll('\\', '/')}/scripts:/src/scripts:ro`,
      '-v',
      `${ROOT.replaceAll('\\', '/')}/node_modules:/src/node_modules:ro`,
      '-v',
      `${WORK}:/w`,
      IMAGE,
      'sh',
      '-c',
      script,
    ],
    { env: { ...env, ...extraEnv }, encoding: 'utf8', maxBuffer: 1 << 28 },
  );
}

const S3 = {
  S3_ENDPOINT: 'http://fifth-garage-1:3900',
  S3_BUCKET: process.env.S3_BUCKET,
  S3_REGION: process.env.S3_REGION,
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
};
const KEYS = {
  AUDIT_EXPORT_DIR: '/w/server',
  AUDIT_EXPORT_SIGNING_KEY: '/w/key/signing.key',
  AUDIT_EXPORT_PUBLIC_KEY: '/w/key/signing.pub',
  AUDIT_EXPORT_RECIPIENT: '/w/gpg/recipient.asc',
  AUDIT_EXPORT_MONITOR_FILE: '/w/server/monitor.json',
};

function exportRun() {
  const r = inCt('node /src/scripts/audit-export.mjs run', {
    ...KEYS,
    AUDIT_EXPORT_DB_URL: inNetwork(process.env.DATABASE_URL_APP_ARCHIVE),
  });
  return `${r.stdout}${r.stderr}`.trim();
}

function applyCmd(command, extra = '') {
  const r = inCt(
    `node /src/scripts/deletions-apply.mjs ${command} --db "$RESTORED_URL" --restore-id chk-${tag} ` +
      `--source-export /w/offsite/series --secret-key /w/gpg/secret.asc --passphrase-file /w/gpg/pass ${extra}`,
    {
      ...S3,
      AUDIT_EXPORT_PUBLIC_KEY: '/w/key/signing.pub',
      RESTORED_URL: inNetwork(restoredUrl()),
    },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() };
}

async function restored(text, params = []) {
  const c = new pg.Client({ connectionString: restoredUrl() });
  await c.connect();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end();
  }
}

console.log(`=== УЧЁТ УДАЛЕНИЙ ПОСЛЕ ВОССТАНОВЛЕНИЯ (${tag}) ===`);
mkdirSync(WORK, { recursive: true });
try {
  // ---------------------------------------------------------------- 1
  console.log('\n▸ 1. До копии');
  const founder = await register('founder', 'f');
  const second = await register('founder', 's');
  const inv1 = await register('investor', 'i1');
  const inv2 = await register('investor', 'i2');
  const { project } = await createProject({ json: founder.call }, sql, tag);
  await setLogo(founder.call, project.id, { r: 200, g: 40, b: 40 });
  await setAvatar(founder.call, { r: 40, g: 200, b: 40 });
  await setAvatar(second.call, { r: 40, g: 40, b: 200 });
  const g1 = await founder.call(`/v1/projects/${project.id}/access/grants`, {
    method: 'POST',
    body: { email: inv1.email, permissions: ['profile'] },
  });
  const e1 = await founder.call(`/v1/projects/${project.id}/access/exclusions`, {
    method: 'POST',
    body: { email: inv2.email },
  });
  const logoV1 = (
    await sql('SELECT master_key FROM lab.project_media WHERE project_id = $1', [project.id])
  )[0].master_key;
  const avatarSecondV1 = (
    await sql('SELECT master_key FROM identity.user_avatars WHERE user_id = $1', [second.userId])
  )[0].master_key;
  check(
    'логотип v1, два аватара, выдача и исключение',
    Boolean(logoV1 && avatarSecondV1 && g1.id && e1.id),
  );

  // Ключи выгрузки: подпись Ed25519 и тестовый получатель gpg (ключ Томаса здесь не нужен).
  const keys = inCt(
    [
      'set -e',
      'mkdir -p /w/key /w/gpg && chmod 700 /w/gpg',
      'node /src/scripts/audit-export.mjs keygen --out /w/key/signing.key --pub /w/key/signing.pub',
      'head -c 24 /dev/urandom | base64 > /w/gpg/pass',
      'export GNUPGHOME=$(mktemp -d)',
      'gpg --batch -q --pinentry-mode loopback --passphrase-file /w/gpg/pass --quick-gen-key "chk-deletions <chk@test.local>" ed25519 cert,sign 1d',
      "fpr=$(gpg --batch --list-keys --with-colons | awk -F: '/^fpr/{print $10; exit}')",
      'gpg --batch -q --pinentry-mode loopback --passphrase-file /w/gpg/pass --quick-add-key "$fpr" cv25519 encr 1d',
      'gpg --batch -q --armor --export > /w/gpg/recipient.asc',
      'gpg --batch -q --pinentry-mode loopback --passphrase-file /w/gpg/pass --armor --export-secret-keys > /w/gpg/secret.asc',
    ].join('\n'),
  );
  check('ключи выгрузки созданы', keys.status === 0, keys.stderr.trim().split('\n').pop());
  const e0 = exportRun();
  check('выгрузка до копии — порция 1', /порция 000001/.test(e0), e0);

  // ---------------------------------------------------------------- 2
  console.log('\n▸ 2. Копия базы и восстановление в отдельную базу');
  pgExec(`pg_dump -h 127.0.0.1 -U ${owner.username} -d fifth_element -Fc -f /tmp/${RESTORED}.dump`);
  pgExec(`createdb -h 127.0.0.1 -U ${owner.username} ${RESTORED}`);
  const pr = pgExec(
    `pg_restore -h 127.0.0.1 -U ${owner.username} -d ${RESTORED} --no-owner /tmp/${RESTORED}.dump 2>&1 | tail -3; true`,
  );
  const gateRestored = (await restored('SELECT ops.restore_gate_state() AS s'))[0].s;
  check(
    'восстановленная из копии база закрыта сама (другой отпечаток базы)',
    gateRestored === 'closed',
    `${gateRestored}; ${pr.stdout.trim().slice(0, 120)}`,
  );

  // ---------------------------------------------------------------- 3
  console.log('\n▸ 3. После копии');
  await setLogo(founder.call, project.id, { r: 10, g: 10, b: 10 });
  await founder.call(`/v1/projects/${project.id}/media/logo`, { method: 'DELETE' });
  await setAvatar(founder.call, { r: 250, g: 250, b: 0 });
  const avatarFounderV2 = (
    await sql('SELECT master_key FROM identity.user_avatars WHERE user_id = $1', [founder.userId])
  )[0].master_key;
  await setAvatar(second.call, { r: 0, g: 250, b: 250 });
  const secondV2 = (
    await sql('SELECT master_key, variants FROM identity.user_avatars WHERE user_id = $1', [
      second.userId,
    ])
  )[0];
  // Новый файл второго «пропал» из хранилища: замена не должна дать ссылку на него.
  const storage = storageFromEnv();
  for (const key of [secondV2.master_key, ...Object.values(secondV2.variants).map((v) => v.key)]) {
    await s3Object(storage, 'DELETE', key);
  }
  await founder.call(`/v1/projects/${project.id}/access/grants/${g1.id}`, { method: 'DELETE' });
  const g3 = await founder.call(`/v1/projects/${project.id}/access/grants`, {
    method: 'POST',
    body: { email: inv1.email, permissions: ['materials'] },
  });
  await founder.call(`/v1/projects/${project.id}/access/exclusions/${e1.id}`, { method: 'DELETE' });
  const g2 = await founder.call(`/v1/projects/${project.id}/access/grants`, {
    method: 'POST',
    body: { email: inv2.email, permissions: ['profile'] },
  });
  await founder.call(`/v1/projects/${project.id}/access/grants/${g2.id}`, { method: 'DELETE' });
  check(
    'после копии: удаление, замены, повторная выдача',
    g3.id !== g1.id,
    `G1 ${g1.id}, G3 ${g3.id}`,
  );

  // ---------------------------------------------------------------- 4
  console.log('\n▸ 4. Выгрузка, вынос, применение из вынесенной выгрузки');
  const e1out = exportRun();
  check('выгрузка после копии — порция 2', /порция 000002/.test(e1out), e1out);
  const off = spawnSync(
    process.execPath,
    ['scripts/audit-offsite.mjs', 'pull', '--to', `${WORK}/offsite`],
    {
      env: {
        ...env,
        FIFTH_AUDIT_SOURCE_DIR: `${WORK}/server`,
        AUDIT_EXPORT_PUBLIC_KEY: `${WORK}/key/signing.pub`,
      },
      encoding: 'utf8',
    },
  );
  check(
    'вынос: подписи и продолжение проверены, контрольная точка',
    off.status === 0,
    `${off.stdout}${off.stderr}`.trim(),
  );
  const ack = readFileSync(`${WORK}/server/ack.txt`, 'utf8');
  check('отметка выноса на сервере — номер и покрытие', /^2@\d{4}-/.test(ack), ack);

  const a1 = applyCmd('apply');
  check('применение', a1.code === 0, a1.out);

  // ---------------------------------------------------------------- 5
  console.log('\n▸ 5. Итог на восстановленной копии');
  const logo = await restored('SELECT master_key FROM lab.project_media WHERE project_id = $1', [
    project.id,
  ]);
  check(
    'логотип: копия содержала v1, после v2 удалён — v1 не вернулся',
    logo.length === 0,
    JSON.stringify(logo),
  );
  const fa = await restored('SELECT master_key FROM identity.user_avatars WHERE user_id = $1', [
    founder.userId,
  ]);
  check(
    'аватар основателя: замена с доступным файлом — новый на месте',
    fa[0]?.master_key === avatarFounderV2,
    fa[0]?.master_key,
  );
  const sa = await restored('SELECT master_key FROM identity.user_avatars WHERE user_id = $1', [
    second.userId,
  ]);
  check(
    'аватар второго: новый файл недоступен — прежний скрыт, ссылки на отсутствующий нет',
    sa.length === 0 && /закрыто 1/.test(a1.out) && /файл недоступен/.test(a1.out),
    JSON.stringify(sa),
  );
  const grants = await restored(
    `SELECT id::text, revoked_at IS NULL AS active, permissions FROM lab.project_access_grants
      WHERE project_id = $1 ORDER BY granted_at`,
    [project.id],
  );
  const by = Object.fromEntries(grants.map((g) => [g.id, g]));
  check(
    'выдать → отозвать → выдать снова: G1 снята, G3 действует; выдача второму не появилась',
    by[g1.id]?.active === false && by[g3.id]?.active === true && !by[g2.id]?.active,
    JSON.stringify(grants),
  );
  const ex = await restored(
    'SELECT revoked_at IS NULL AS active FROM lab.project_access_exclusions WHERE id = $1',
    [e1.id],
  );
  check(
    'исключение снято после копии — снято и в восстановленной',
    ex[0]?.active === false,
    JSON.stringify(ex),
  );
  const gate = (await restored('SELECT ops.restore_gate_state() AS s'))[0].s;
  check('ворота закрыты до итоговой проверки', gate === 'closed', gate);

  const a2 = applyCmd('apply');
  check(
    'повтор применения ничего не меняет',
    a2.code === 0 && /применено 0, без изменений 0, закрыто 0/.test(a2.out),
    a2.out.split('\n')[1],
  );
  const v = applyCmd('verify');
  check('итоговая проверка', v.code === 0 && v.out.includes('применён полностью'), v.out);

  // Отказы: источник другой базы, разрыв серии.
  const foreign = inCt(
    `node /src/scripts/deletions-apply.mjs apply --db "$RESTORED_URL" --restore-id chk-${tag} --source-db "$OTHER"`,
    {
      RESTORED_URL: inNetwork(restoredUrl()),
      OTHER: inNetwork(process.env.DATABASE_URL_TEST_OWNER ?? process.env.DATABASE_URL_TEST),
    },
  );
  check(
    'источник другой базы отвергнут',
    foreign.status !== 0 && /другой базы|нет общего звена/.test(foreign.stderr),
    foreign.stderr.trim().split('\n').pop(),
  );
  cpSync(`${WORK}/offsite/series`, `${WORK}/gap`, { recursive: true });
  for (const ext of ['jsonl.gpg', 'manifest.json', 'manifest.sig'])
    rmSync(`${WORK}/gap/000001.${ext}`);
  const gap = inCt(
    `node /src/scripts/deletions-apply.mjs apply --db "$RESTORED_URL" --restore-id chk-${tag} ` +
      '--source-export /w/gap --secret-key /w/gpg/secret.asc --passphrase-file /w/gpg/pass',
    { AUDIT_EXPORT_PUBLIC_KEY: '/w/key/signing.pub', RESTORED_URL: inNetwork(restoredUrl()) },
  );
  check(
    'разрыв серии (нет порции 1) отвергнут',
    gap.status !== 0 && /не начинает серию/.test(gap.stderr),
    gap.stderr.trim().split('\n').pop(),
  );

  const noAck = applyCmd('open');
  check(
    'открытие без подтверждения покрытия — отказ',
    noAck.code !== 0 && noAck.out.includes('--coverage-ack'),
    noAck.out.split('\n').pop(),
  );
  const coverage = noAck.out.match(/--coverage-ack (\S+)/)?.[1];
  const before = (await restored('SELECT max(sessions_valid_from) AS t FROM identity.users'))[0].t;
  const opened = applyCmd('open', `--coverage-ack ${coverage}`);
  const after = (
    await restored(
      'SELECT ops.restore_gate_state() AS s, min(sessions_valid_from) AS t FROM identity.users',
    )
  )[0];
  check(
    'открытие после проверки: ворота открыты, прежние сессии недействительны',
    opened.code === 0 && after.s === 'open' && new Date(after.t) > new Date(before),
    opened.out,
  );
} catch (error) {
  failed++;
  console.log(`  FAIL  испытание прервано: ${error.message}`);
} finally {
  await pool.end().catch(() => undefined);
  if (keep) console.log(`\n(--keep: база ${RESTORED}, каталог ${WORK})`);
  else {
    pgExec(
      `dropdb -h 127.0.0.1 -U ${owner.username} --if-exists ${RESTORED}; rm -f /tmp/${RESTORED}.dump`,
    );
    // Каталог создан контейнером от root — убирает его тоже контейнер.
    spawnSync('docker', ['run', '--rm', '-v', `${WORK}:/w`, IMAGE, 'sh', '-c', 'rm -rf /w/*'], {
      env,
    });
    rmSync(WORK, { recursive: true, force: true });
  }
}
console.log(`\nИТОГ: ${passed} OK, ${failed} FAIL`);
writeFileSync(join(tmpdir(), `deletions-replay-${tag}.done`), `${passed}/${failed}\n`);
process.exit(failed ? 1 : 0);
