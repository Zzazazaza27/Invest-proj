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
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { BASE, client, parseArgs, runDir } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const runId = String(args['run-id'] ?? '');
const kind = String(args.kind ?? '');
const collectId = String(args['collect-id'] ?? '');
const out = String(args.out ?? join('out', 'suites', `load-${runId}`));
if (!['core', 'postgres', 'valkey', 'nats'].includes(kind) || !collectId) {
  console.error('нужны --run-id, --kind core|postgres|valkey|nats, --collect-id');
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
const DURING_EVERY_MS = 5000;

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
  const host = new URL(BASE).hostname;
  const adm = JSON.parse(readFileSync(join('.local', 'load', `${host}-admin.json`), 'utf8'));
  const admin = client();
  const al = await admin.call('/v1/auth/login', {
    method: 'POST',
    body: { email: adm.email, password: adm.password },
  });
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
let serverOut = '';
const fault = spawn('ssh', SSH, { stdio: ['ignore', 'pipe', 'pipe'] });
fault.stdout.on('data', (d) => {
  serverOut += d;
  process.stdout.write(d);
});
fault.stderr.on('data', (d) => process.stderr.write(d));
const faultDone = new Promise((res) => fault.on('close', (code) => res(code)));
let finished = null;
void faultDone.then((code) => {
  finished = code;
});

const during = [];
let n = 0;
while (finished === null) {
  during.push(await addLink(`https://example.com/fault/${tag}/during-${n}`, randomUUID()));
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
if (finished !== 0) problems.push(`шаг отказа на сервере завершился с кодом ${finished}`);

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
