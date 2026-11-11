#!/usr/bin/env node
/**
 * Прежний код на новой схеме (блок 09, задание 2; уточнения Тэнка 09.11).
 *
 *   node scripts/check-migration-compat.mjs --previous <сборка> --candidate <сборка>
 *                                           [--env test-77] [--port 18177] [--keep]
 *
 * Готовые образы комплектов по дайджесту (`kit.mjs check` до начала): прежний — фактически
 * установленный, кандидат — новый. Пересборка старого commit прежний комплект не заменяет.
 * Своя временная среда из образов (env.mjs), рабочие среды не затрагиваются.
 *
 *   1. Среда на прежнем комплекте. Прежнее ядро: участник A — вход, зашифрованный контакт,
 *      файл (аватар), проект.
 *   2. Кандидат: миграции и новое ядро. Сессия A жива; кандидат читает записи A; участник B
 *      (записи кандидата: контакт, файл, проект); права — B не видит черновик A.
 *   3. Прежний образ на новой схеме — то, что даёт возврат: схема и данные новые. Прежнее
 *      ядро: вход A и B, права, чтение проекта, контакта и файла обоих (в том числе записей
 *      кандидата), одна запись (проект A2). Проверки затронутых миграцией функций —
 *      database/compat/<миграция>.mjs для каждой новой миграции.
 *   4. Кандидат снова: читает запись прежнего ядра.
 *
 * Отчёт: <комплекты>/<кандидат>/compat-<прежний>.json — его требует `release.mjs install
 * --rollback` (точка возврата) и показывает обычная установка. Отчёт привязан к хешам обоих
 * комплектов. Метки образов вне комплекта (`--previous dev`) годятся для отладки, отчёт
 * тогда не пишется.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { kitId } from './lib/compat-report.mjs';
import { signCompat } from './lib/kit-sign.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KITS = process.env.FIFTH_KITS_DIR || join(ROOT, '.local', 'kits');
const opt = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const PREVIOUS = opt('--previous');
const CANDIDATE = opt('--candidate');
const ENV = opt('--env', 'test-77');
const PORT = opt('--port', '18177');
const BASE = `http://127.0.0.1:${PORT}`;
if (!PREVIOUS || !CANDIDATE) {
  console.error('нужны --previous <сборка> и --candidate <сборка>');
  process.exit(2);
}
const isBuild = (label) => /^\d+\.\d+-b\d+\.\d+$/.test(label);
const dockerEnv = { ...process.env, MSYS_NO_PATHCONV: '1' };

const results = [];
function check(phase, name, ok, detail = '') {
  results.push({ phase, name, ok: Boolean(ok), detail: String(detail).slice(0, 200) });
  console.warn(
    `  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`,
  );
}

function tool(script, args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
    encoding: 'utf8',
    env: dockerEnv,
    timeout: 900_000,
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout.trim().split('\n').pop());
  } catch {
    /* отчёт покажет */
  }
  return { code: r.status, json, out: `${r.stdout}${r.stderr}`.trim() };
}

/** SQL владельцем внутри контейнера базы среды. */
function sql(query) {
  const r = spawnSync(
    'docker',
    [
      'exec',
      `fifth-${ENV}-postgres`,
      'sh',
      '-c',
      `PGPASSWORD="$(cat /run/secrets/POSTGRES_PASSWORD)" psql -h 127.0.0.1 -U fifth_owner -d fifth_element -v ON_ERROR_STOP=1 -Atc "$0"`,
      query,
    ],
    { encoding: 'utf8', env: dockerEnv },
  );
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim().slice(0, 200)}`);
  return r.stdout.trim();
}

/** Клиент с cookie-сессией и CSRF, как браузер. */
function client() {
  const jar = new Map();
  async function call(path, { method = 'GET', body, raw = false, key = false } = {}) {
    const headers = { 'X-Fifth-Origin': 'render_check' };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const csrf = [...jar].find(([k]) => /csrf/i.test(k))?.[1];
    if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
    if (key) headers['Idempotency-Key'] = randomUUID();
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(';');
      const eq = pair.indexOf('=');
      jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    if (raw) return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* не JSON */
    }
    return { status: response.status, json, text };
  }
  return { call };
}

async function consents() {
  const r = await client().call('/v1/auth/consents/templates?locale=ru-RU');
  return (r.json?.items ?? []).map((t) => ({ kind: t.kind, version: t.version, locale: 'ru-RU' }));
}

async function newPerson(label) {
  const c = client();
  const email = `compat-${label}-${Date.now() % 1e9}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const r = await c.call('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: `Совместимость ${label}`,
      role: 'founder',
      locale: 'ru-RU',
      consents: await consents(),
    },
  });
  return { c, email, password, status: r.status };
}

async function login(person) {
  const c = client();
  const r = await c.call('/v1/auth/login', {
    method: 'POST',
    body: { email: person.email, password: person.password },
  });
  return { c, status: r.status };
}

async function uploadAvatar(c) {
  const png = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 20, g: 120, b: 90 } },
  })
    .png()
    .toBuffer();
  const ticket = await c.call('/v1/me/avatar/upload', {
    method: 'POST',
    body: { contentType: 'image/png', sizeBytes: png.byteLength },
  });
  if (!ticket.json?.uploadUrl) return { ok: false, detail: `билет HTTP ${ticket.status}` };
  const form = new FormData();
  for (const [k, v] of Object.entries(ticket.json.formFields)) form.append(k, v);
  form.append('file', new Blob([png], { type: 'image/png' }), 'a.png');
  let put;
  try {
    put = await fetch(ticket.json.uploadUrl, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return {
      ok: false,
      detail: `хранилище ${ticket.json.uploadUrl} недоступно: ${e.cause?.code ?? e.message}`,
    };
  }
  const done = await c.call('/v1/me/avatar/finalize', { method: 'POST' });
  return {
    ok: put.status < 400 && done.status === 200,
    detail: `загрузка ${put.status}, сборка ${done.status}`,
  };
}

async function createProject(c, title) {
  const taxonomy = await c.call('/v1/taxonomy');
  const r = await c.call('/v1/projects', {
    method: 'POST',
    key: true,
    body: {
      title,
      stage: 'mvp',
      taxonomyId: taxonomy.json?.items?.[0]?.id,
      investmentAsk: '1000000',
      askCurrency: 'RUB',
    },
  });
  return { id: r.json?.id ?? null, status: r.status };
}

/**
 * Готовность через web после смены сборки: env.mjs update ждёт только ядро, а web в это время
 * может пересоздаваться (на машине CI — дольше, чем на стенде).
 */
async function webReady(limitMs = 90_000) {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    const ok = await fetch(`${BASE}/v1/ready`, { signal: AbortSignal.timeout(5_000) }).then(
      (r) => r.status === 200,
      () => false,
    );
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

/** Чтение участником: профиль (контакт расшифрован), свой файл, проект. */
async function reads(phase, who, c, projects) {
  const me = await c.call('/v1/auth/me');
  check(phase, `${who}: сессия действует`, me.status === 200, `HTTP ${me.status}`);
  const profile = await c.call('/v1/me/profile');
  check(
    phase,
    `${who}: зашифрованный контакт читается`,
    profile.status === 200 && typeof profile.json?.emailMasked === 'string',
    `HTTP ${profile.status}, ${profile.json?.emailMasked ?? 'нет адреса'}`,
  );
  const avatar = profile.json?.avatar?.urls?.sm;
  const file = avatar ? await c.call(avatar.replace(/^\/v1/, '/v1'), { raw: true }) : null;
  check(
    phase,
    `${who}: файл читается`,
    file?.status === 200 && file.bytes > 0,
    file ? `HTTP ${file.status}, ${file.bytes} байт` : 'аватара нет',
  );
  for (const [label, id] of projects) {
    const p = await c.call(`/v1/projects/${id}`);
    check(
      phase,
      `${who}: проект ${label} читается`,
      p.status === 200 && p.json?.id === id,
      `HTTP ${p.status}`,
    );
  }
}

/** Проверки затронутых миграцией функций: database/compat/<миграция>.mjs кандидата. */
async function migrationProbes(phase, migrations, ctx) {
  for (const id of migrations) {
    const file = join(ROOT, 'database', 'compat', `${id}.mjs`);
    if (!existsSync(file)) continue;
    const mod = await import(pathToFileURL(file).href);
    try {
      await mod.default({
        ...ctx,
        phase,
        check: (name, ok, detail) => check(phase, `${id}: ${name}`, ok, detail),
      });
    } catch (e) {
      check(phase, `${id}: проверка выполнилась`, false, e.message);
    }
  }
}

// ---------------------------------------------------------------------------- подготовка
console.warn(`\n=== СОВМЕСТИМОСТЬ: ${PREVIOUS} НА СХЕМЕ ${CANDIDATE} ===\n`);
const kits = {};
for (const label of [PREVIOUS, CANDIDATE]) {
  if (!isBuild(label)) {
    console.warn(`  (${label} — метка образов вне комплекта: отладка, отчёт не пишется)`);
    continue;
  }
  const checked = tool('kit.mjs', ['check', '--build', label]);
  if (checked.code !== 0) {
    console.error(`комплект ${label} не прошёл проверку: ${checked.out.slice(-300)}`);
    process.exit(1);
  }
  tool('kit.mjs', ['load', '--build', label]);
  kits[label] = JSON.parse(readFileSync(join(KITS, label, 'kit.json'), 'utf8'));
}
const added =
  kits[PREVIOUS] && kits[CANDIDATE]
    ? kits[CANDIDATE].migrations
        .map((m) => m.id)
        .filter((id) => !kits[PREVIOUS].migrations.some((p) => p.id === id))
    : null;

tool('env.mjs', ['destroy', ENV, '--confirm', ENV]);
let fatal = null;
let newIds = added ?? [];
try {
  // --------------------------------------------------------------- 1. прежний комплект
  console.warn(`[1] Прежний комплект ${PREVIOUS}: записи прежнего ядра`);
  const created = tool('env.mjs', [
    'create',
    ENV,
    '--kit',
    PREVIOUS,
    '--web-port',
    PORT,
    // Адрес загрузки для этого процесса: хранилище стенда проброшено на узел.
    '--files-url',
    opt('--files-url', 'http://localhost:9000'),
  ]);
  if (created.code !== 0) throw new Error(`среда не поднялась: ${created.out.slice(-300)}`);
  const before = sql('SELECT id FROM public.schema_migrations ORDER BY id').split('\n');
  const a = await newPerson('a');
  check('previous', 'A зарегистрирован прежним ядром', a.status === 201, `HTTP ${a.status}`);
  const aAvatar = await uploadAvatar(a.c);
  check('previous', 'A: файл загружен', aAvatar.ok, aAvatar.detail);
  const a1 = await createProject(a.c, 'Проект A1 прежнего ядра');
  check('previous', 'A: проект создан', Boolean(a1.id), `HTTP ${a1.status}`);
  await reads('previous', 'A', a.c, [['A1', a1.id]]);

  // ------------------------------------------------------------------ 2. кандидат
  console.warn(`\n[2] Кандидат ${CANDIDATE}: миграции и новое ядро`);
  const up = tool('env.mjs', ['update', ENV, '--kit', CANDIDATE]);
  if (up.code !== 0) throw new Error(`кандидат не поднялся: ${up.out.slice(-300)}`);
  if (!(await webReady())) throw new Error('кандидат: web не ответил /v1/ready за 90 с');
  const after = sql('SELECT id FROM public.schema_migrations ORDER BY id').split('\n');
  newIds = after.filter((m) => !before.includes(m));
  console.warn(
    `  новых миграций: ${newIds.length}${newIds.length ? ` (${newIds.join(', ')})` : ''}`,
  );
  await reads('candidate', 'A (сессия прежнего ядра)', a.c, [['A1', a1.id]]);
  const b = await newPerson('b');
  check('candidate', 'B зарегистрирован кандидатом', b.status === 201, `HTTP ${b.status}`);
  const bAvatar = await uploadAvatar(b.c);
  check('candidate', 'B: файл загружен', bAvatar.ok, bAvatar.detail);
  const b1 = await createProject(b.c, 'Проект B1 кандидата');
  check('candidate', 'B: проект создан', Boolean(b1.id), `HTTP ${b1.status}`);
  const peek = await b.c.call(`/v1/projects/${a1.id}`);
  check(
    'candidate',
    'права: B не видит черновик A',
    [403, 404].includes(peek.status),
    `HTTP ${peek.status}`,
  );

  // --------------------------------------------- 3. прежний образ на новой схеме
  console.warn(`\n[3] Прежнее ядро ${PREVIOUS} на новой схеме и данных`);
  const back = tool('env.mjs', ['update', ENV, '--kit', PREVIOUS, '--images-only']);
  const backWeb = back.code === 0 && (await webReady());
  check(
    'rollback',
    'прежнее ядро поднялось на новой схеме',
    backWeb,
    back.code !== 0 ? back.out.slice(-200) : backWeb ? '' : 'web не ответил /v1/ready за 90 с',
  );
  if (back.code !== 0) throw new Error('прежнее ядро не готово — дальше проверять нечего');
  const aOld = await login(a);
  check('rollback', 'вход A', aOld.status === 201 || aOld.status === 200, `HTTP ${aOld.status}`);
  await reads('rollback', 'A', aOld.c, [['A1', a1.id]]);
  const bOld = await login(b);
  check(
    'rollback',
    'вход B (создан кандидатом)',
    bOld.status === 201 || bOld.status === 200,
    `HTTP ${bOld.status}`,
  );
  await reads('rollback', 'B (записи кандидата)', bOld.c, [['B1', b1.id]]);
  const peekOld = await bOld.c.call(`/v1/projects/${a1.id}`);
  check(
    'rollback',
    'права: B не видит черновик A',
    [403, 404].includes(peekOld.status),
    `HTTP ${peekOld.status}`,
  );
  const a2 = await createProject(aOld.c, 'Проект A2 прежнего ядра на новой схеме');
  check('rollback', 'запись прежним ядром на новой схеме', Boolean(a2.id), `HTTP ${a2.status}`);
  await migrationProbes('rollback', newIds, { base: BASE, sql, client, login, people: { a, b } });

  // ------------------------------------------------------------- 4. кандидат снова
  console.warn(`\n[4] Кандидат читает запись прежнего ядра`);
  const again = tool('env.mjs', ['update', ENV, '--kit', CANDIDATE, '--images-only']);
  if (again.code !== 0) throw new Error(`кандидат не вернулся: ${again.out.slice(-300)}`);
  if (!(await webReady())) throw new Error('кандидат снова: web не ответил /v1/ready за 90 с');
  const aNew = await login(a);
  await reads('forward', 'A', aNew.c, [
    ['A1', a1.id],
    ['A2 (прежнего ядра)', a2.id],
  ]);
  await migrationProbes('forward', newIds, { base: BASE, sql, client, login, people: { a, b } });
} catch (e) {
  fatal = e.message;
  check(
    'run',
    'прогон дошёл до конца',
    false,
    `${e.message}${e.cause?.code ? ` (${e.cause.code})` : ''}`,
  );
} finally {
  if (!process.argv.includes('--keep')) tool('env.mjs', ['destroy', ENV, '--confirm', ENV]);
}

const failed = results.filter((r) => !r.ok);
const result = failed.length === 0 ? 'ok' : 'failed';
console.warn(
  `\nИтог: ${results.length - failed.length} пройдено, ${failed.length} провалено — ${result}\n`,
);
if (kits[PREVIOUS] && kits[CANDIDATE]) {
  const report = {
    format: 1,
    at: new Date().toISOString(),
    result,
    previous: {
      build: PREVIOUS,
      kitId: kitId(kits[PREVIOUS]),
      kitSha256: kits[PREVIOUS].tar.sha256,
      coreDigest: kits[PREVIOUS].images.core.digest,
    },
    candidate: {
      build: CANDIDATE,
      kitId: kitId(kits[CANDIDATE]),
      kitSha256: kits[CANDIDATE].tar.sha256,
      coreDigest: kits[CANDIDATE].images.core.digest,
    },
    newMigrations: newIds,
    probes: newIds.filter((id) => existsSync(join(ROOT, 'database', 'compat', `${id}.mjs`))),
    fatal,
    checks: results,
    // Версия средств проверки (Тэнк 09.11): коммит и хеши самого прогона и проверок миграций.
    tools: {
      commit: spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: ROOT,
        encoding: 'utf8',
      }).stdout.trim(),
      script: createHash('sha256')
        .update(readFileSync(fileURLToPath(import.meta.url)))
        .digest('hex'),
      probes: Object.fromEntries(
        newIds
          .map((id) => join(ROOT, 'database', 'compat', `${id}.mjs`))
          .filter(existsSync)
          .map((f) => [
            f.split(/[\\/]/).pop(),
            createHash('sha256').update(readFileSync(f)).digest('hex'),
          ]),
      ),
    },
  };
  const out = join(KITS, CANDIDATE, `compat-${PREVIOUS}.json`);
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(out, bytes);
  // Подпись — только защищённой задачей CI после успешного прогона (ключ CI недоступен
  // проверкам недоверенных изменений). Без ключа отчёт не подписан и основанием возврата не служит.
  const keyFile = opt('--sign-key-file');
  if (keyFile && result === 'ok') {
    writeFileSync(`${out}.sig`, `${signCompat(bytes, readFileSync(keyFile, 'utf8'))}\n`);
    console.warn(`Отчёт подписан: ${out}.sig`);
  }
  console.warn(`Отчёт: ${out}`);
}
process.exitCode = failed.length ? 1 : 0;
