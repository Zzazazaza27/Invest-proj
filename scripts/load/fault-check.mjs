#!/usr/bin/env node
/**
 * Отказ под номинальной нагрузкой и проверка последствий (W32, план, раздел 4).
 *
 *   FIFTH_LOAD_BASE=https://test-1.5espace.com FIFTH_LOAD_BASIC_AUTH_FILE=.local/load/test-1-basic.txt \
 *     node scripts/load/fault-check.mjs --run-id <id> --kind core|postgres|valkey|nats \
 *       --collect-id <id сборщика> --out <каталог>
 *
 * Работает без Docker (Node на ноутбуке) рядом с идущим прогоном k6:
 *  1. до отказа — подтверждённые изменения: материалы-ссылки с известным ключом повтора,
 *     и повтор каждого с тем же ключом;
 *  2. отказ — шагом на сервере `prod-load-fault run` (очереди до/во время/после, готовность,
 *     разгрузка outbox);
 *  3. во время — попытка изменения раз в 2 с с новым ключом; ответ записывается;
 *  4. после — повтор неподтверждённых попыток с тем же ключом, затем сверка с базой через API:
 *     каждое подтверждённое (2xx) изменение есть ровно один раз; повтор не создал второго;
 *     ложного успеха нет (2xx без объекта).
 * Итог — `<out>/fault-<kind>.json`; код выхода 0 только если все проверки прошли.
 *
 * --kind load --until <файл> (работа № 2 раздела 01): отказа нет — «окно» длится, пока идут
 * повышенная нагрузка и возврат к номиналу (оркестратор `w32-recover.mjs` создаёт файл в конце).
 * Попытка раз в 20 с (не больше 90: список материалов отдаёт 100 последних), переключение
 * видимости — для потока событий outbox; после — та же сверка и разгрузка outbox до исходного.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { BASE, adminLogin, client, isLocalBase, parseArgs, runDir } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const runId = String(args['run-id'] ?? '');
const kind = String(args.kind ?? '');
const collectId = String(args['collect-id'] ?? '');
const until = String(args.until ?? '');
const out = String(args.out ?? join('out', 'suites', `load-${runId}`));
const isLoad = kind === 'load';
if (
  !['core', 'postgres', 'valkey', 'nats', 'load'].includes(kind) ||
  (isLoad ? !until : !collectId)
) {
  console.error(
    'нужны --run-id и --kind core|postgres|valkey|nats --collect-id | --kind load --until <файл>',
  );
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const data = JSON.parse(readFileSync(join(runDir(runId), 'users.json'), 'utf8'));
// Последний участник прогона; проект — свой на каждое испытание (ниже): список материалов
// отдаёт только 100 последних, а в проекты участников ссылки добавляет и k6.
const user = data.users[data.users.length - 1];
let projectId = null;
const tag = `${kind}-${Date.now()}`;
const c = client();
// Попытка во время отказа — раз в 5 с: за самый долгий отказ (NATS, ~6 мин с окном)
// объектов меньше 100, и сверка видит их все.
const DURING_EVERY_MS = isLoad ? 20_000 : 5000;
const DURING_MAX = isLoad ? 90 : Infinity;

async function call(path, opts = {}) {
  try {
    return await c.call(path, opts);
  } catch (e) {
    return { status: 0, error: String(e?.cause?.code ?? e?.name ?? e) };
  }
}
async function login() {
  const r = await call('/v1/auth/login', {
    method: 'POST',
    body: { email: user.email, password: user.password },
  });
  return r.status === 200 || r.status === 201;
}
/** Ссылка с заданным ключом повтора. Ответ без тела объекта — тоже фиксируется. */
async function addLink(url, key) {
  const t = Date.now();
  let r = await call(`/v1/projects/${projectId}/materials/link`, {
    method: 'POST',
    body: { url },
    headers: { 'Idempotency-Key': key },
  });
  // Сеанс мог пропасть при отказе ядра или хранилища сеансов — вход и один повтор.
  if (r.status === 401) {
    await login();
    r = await call(`/v1/projects/${projectId}/materials/link`, {
      method: 'POST',
      body: { url },
      headers: { 'Idempotency-Key': key },
    });
  }
  return {
    url,
    key,
    at: new Date(t).toISOString(),
    ms: Date.now() - t,
    status: r.status,
    id: r.json?.id ?? null,
    code: r.json?.code ?? r.error ?? null,
  };
}
const ok = (s) => s >= 200 && s < 300;

// ---------------------------------------------------------------- до отказа
if (!(await login())) {
  console.error('вход участника прогона не удался');
  process.exit(1);
}
// Свой проект испытания; учитывается в сессии прогона администратором цели — уборка прогона
// удалит его вместе с остальным.
{
  const p = await call('/v1/projects', {
    method: 'POST',
    key: true,
    body: {
      title: `Нагрузка p1 ${runId} отказ ${kind}`,
      tagline: 'Синтетический проект испытания отказа',
      description: 'Создан испытанием отказа W32; уберётся вместе с прогоном.',
      stage: 'idea',
      taxonomyId: data.taxonomyIds[0],
      investmentAsk: '1000000',
      askCurrency: 'RUB',
    },
  });
  projectId = p.json?.id;
  if (!projectId) {
    console.error(`проект испытания: HTTP ${p.status} ${p.json?.code ?? ''}`);
    process.exit(1);
  }
  // Учётка администратора цели: файл `<узел>-admin.json` (test-1) или общий вход lib.mjs
  // (локальный стенд — пароль из `.env`).
  const admFile = join('.local', 'load', `${new URL(BASE).hostname}-admin.json`);
  let admin;
  let al = { status: 200 };
  if (existsSync(admFile)) {
    const adm = JSON.parse(readFileSync(admFile, 'utf8'));
    admin = client();
    al = await admin.call('/v1/auth/login', {
      method: 'POST',
      body: { email: adm.email, password: adm.password },
    });
  } else {
    admin = await adminLogin();
  }
  const reg = await admin.call(`/v1/admin/testing/sessions/${data.sessionId}/objects`, {
    method: 'POST',
    body: { table: 'lab.projects', id: projectId },
  });
  if (al.status >= 300 || reg.status >= 300) {
    console.error(`учёт проекта испытания в сессии: вход ${al.status}, учёт ${reg.status}`);
    process.exit(1);
  }
}
const before = [];
for (let i = 0; i < 5; i += 1) {
  const r = await addLink(`https://example.com/fault/${tag}/pre-${i}`, randomUUID());
  const again = await addLink(r.url, r.key);
  before.push({ ...r, repeat: { status: again.status, id: again.id } });
}

// ---------------------------------------------------------------- отказ
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
  `sudo -n /usr/local/sbin/fifth-test op prod-load-fault run ${kind} ${collectId}`,
];
// Очереди test-1 (шаг сервера); у локальной цели их нет — разгрузка не проверяется (сухой прогон).
const queuesNow = () => {
  if (isLocalBase()) return NaN;
  const q = spawnSync(
    'ssh',
    [...SSH.slice(0, -1), 'sudo -n /usr/local/sbin/fifth-test op prod-load-fault queues'],
    { encoding: 'utf8', timeout: 60_000 },
  );
  return Number((q.stdout ?? '').trim().split('\n').at(-1)?.split(',')[0]);
};
let serverOut = '';
let finished = null;
let loadBase = NaN;
if (isLoad) {
  // Окно — до файла оркестратора; очередь outbox до начала — исходный уровень.
  loadBase = queuesNow();
  void (async () => {
    while (!existsSync(until)) await sleep(2000);
    finished = 0;
  })();
} else {
  const fault = spawn('ssh', SSH, { stdio: ['ignore', 'pipe', 'pipe'] });
  fault.stdout.on('data', (d) => {
    serverOut += d;
    process.stdout.write(d);
  });
  fault.stderr.on('data', (d) => process.stderr.write(d));
  const faultDone = new Promise((res) => fault.on('close', (code) => res(code)));
  void faultDone.then((code) => {
    finished = code;
  });
}

const during = [];
// Ссылки и правки p1 событий в outbox не порождают (только журнал). Для NATS нужен поток
// событий: смена видимости своего проекта пишет lab.listing.published/unpublished.
const toggles = [];
let n = 0;
while (finished === null) {
  if (during.length >= DURING_MAX) {
    await sleep(2000);
    continue;
  }
  during.push(await addLink(`https://example.com/fault/${tag}/during-${n}`, randomUUID()));
  if (kind === 'nats' || isLoad) {
    const visibility = n % 2 === 0 ? 'public' : 'private';
    const r = await call(`/v1/projects/${projectId}/visibility`, {
      method: 'PUT',
      body: { visibility },
    });
    toggles.push({ visibility, status: r.status, at: new Date().toISOString() });
  }
  n += 1;
  await sleep(DURING_EVERY_MS);
}

// ---------------------------------------------------------------- после
await login();
// Неподтверждённые попытки — повтор с тем же ключом: исход должен стать определённым,
// без второго объекта.
const retried = [];
for (const d of during.filter((x) => !ok(x.status))) {
  const r = await addLink(d.url, d.key);
  retried.push({ url: d.url, first: d.status, status: r.status, id: r.id });
}
const list = await call(`/v1/projects/${projectId}/materials`);
const items = (list.json?.items ?? []).filter((m) => JSON.stringify(m).includes(`/fault/${tag}/`));
const byUrl = new Map();
for (const m of items) {
  const url = /https:\/\/example\.com\/fault\/[^"\\]+/.exec(JSON.stringify(m))?.[0];
  byUrl.set(url, [...(byUrl.get(url) ?? []), m.id]);
}

const problems = [];
const confirmed = [...before, ...during].filter((x) => ok(x.status));
for (const x of confirmed) {
  const ids = byUrl.get(x.url) ?? [];
  if (ids.length === 0) problems.push(`ложный успех: ${x.url} — 2xx, а объекта нет`);
  if (x.id && ids.length && !ids.includes(x.id))
    problems.push(`${x.url}: id ответа не совпадает с объектом`);
}
for (const [url, ids] of byUrl) if (ids.length > 1) problems.push(`дубль: ${url} × ${ids.length}`);
for (const b of before)
  if (ok(b.status) && b.repeat.id && b.repeat.id !== b.id)
    problems.push(`повтор с тем же ключом дал другой объект: ${b.url}`);
for (const r of retried)
  if (!ok(r.status)) problems.push(`после восстановления повтор не прошёл: ${r.url} (${r.status})`);
if (list.status !== 200) problems.push(`список материалов: HTTP ${list.status}`);
if (isLoad && during.length === 0) problems.push('за окно нагрузки не было ни одной попытки');
if (finished !== 0) problems.push(`шаг отказа на сервере завершился с кодом ${finished}`);

// NATS: события копились, пока брокера не было, и ушли после; видимость — как в последнем
// подтверждённом переключении.
let events = null;
if (kind === 'nats' || isLoad) {
  const rows = serverOut
    .split('\n')
    .filter((l) => l.startsWith('Q,'))
    .map((l) => l.split(','))
    .map(([, ts, phase, unpub]) => ({ ts, phase, unpub: Number(unpub) }));
  const base = isLoad ? loadBase : (rows.find((r) => r.phase === 'before')?.unpub ?? NaN);
  const peak = isLoad
    ? null
    : Math.max(...rows.filter((r) => r.phase === 'during').map((r) => r.unpub));
  // Последний срез сервера снят, пока переключения ещё шли; итог — отдельным запросом
  // после их окончания: очередь должна вернуться к исходной не дольше чем за 2 мин.
  let last = NaN;
  for (let i = 0; i < 12; i += 1) {
    last = queuesNow();
    if (last <= base) break;
    await sleep(10_000);
  }
  const okToggles = toggles.filter((t) => ok(t.status));
  const view = await call(`/v1/projects/${projectId}`);
  const lastVis = okToggles.at(-1)?.visibility ?? null;
  events = { base, peak, last, toggles: toggles.length, confirmed: okToggles.length };
  events.finalVisibility = view.json?.visibility ?? null;
  if (!isLoad && !(peak > base))
    problems.push(`outbox не копился во время отказа NATS (до ${base}, максимум ${peak})`);
  if (!(last <= base) && !(isLoad && isLocalBase()))
    problems.push(`outbox не вернулся к исходному: до ${base}, после ${last}`);
  if (lastVis && events.finalVisibility !== lastVis)
    problems.push(`видимость ${events.finalVisibility}, ожидалась ${lastVis}`);
}

const counts = {};
for (const d of during) counts[d.status] = (counts[d.status] ?? 0) + 1;
const result = {
  kind,
  runId,
  target: BASE,
  tag,
  project: projectId,
  before: before.map(({ url, status, repeat }) => ({ url, status, repeat: repeat.status })),
  during: { attempts: during.length, byStatus: counts, items: during },
  retried,
  events,
  toggles,
  objectsFound: items.length,
  server: serverOut,
  problems,
  passed: problems.length === 0,
};
writeFileSync(join(out, `fault-${kind}.json`), JSON.stringify(result, null, 2));
console.log(
  `\nотказ ${kind}: попыток во время ${during.length} ${JSON.stringify(counts)}; ` +
    `повторено ${retried.length}; объектов ${items.length}; ` +
    (problems.length ? `ПРОБЛЕМЫ:\n  ${problems.join('\n  ')}` : 'последствия в порядке'),
);
process.exit(problems.length ? 1 : 0);
