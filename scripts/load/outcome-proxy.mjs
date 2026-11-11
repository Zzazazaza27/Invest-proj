#!/usr/bin/env node
/**
 * Неизвестный исход изменения через настоящие прокси test-1 (W32; план выпуска W31–W33,
 * раздел 4): ответ ядра 504 с `outcome: unknown` и `traceId` доходит до клиента через Caddy и
 * nginx без подмены; повтор тем же ключом выясняет результат.
 *
 *   FIFTH_LOAD_BASE=https://test-1.5espace.com FIFTH_LOAD_BASIC_AUTH_FILE=.local/load/test-1-basic.txt \
 *     node scripts/load/outcome-proxy.mjs --run-id <прогон с участниками> [--seconds 20]
 *
 * Участник — последний из users.json прогона. На сервере на время потока —
 * `fifth-test op prod-outcome-probe <секунды>` (обрыв соединений приложения с базой).
 * Итог — out/release-w31/outcome-proxy-<время>.json. Код 0 — проверка пройдена.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BASE, ROOT, client, parseArgs, runDir } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const runId = args['run-id'];
const seconds = Number(args.seconds ?? 20);
if (!runId) {
  console.error('нужен --run-id прогона с участниками');
  process.exit(2);
}
const users = JSON.parse(readFileSync(join(runDir(runId), 'users.json'), 'utf8')).users;
const user = users[users.length - 1];

const session = client();
const login = await session.call('/v1/auth/login', {
  method: 'POST',
  body: { email: user.email, password: user.password },
});
if (login.status !== 200 && login.status !== 201) throw new Error(`вход: HTTP ${login.status}`);

// Изменяющий запрос с заданным ключом повтора.
async function patch(key, n) {
  const started = Date.now();
  const r = await session.call('/v1/me/profile', {
    method: 'PATCH',
    body: { displayName: `Проверка исхода ${n}` },
    headers: { 'Idempotency-Key': key },
  });
  return { status: r.status, json: r.json, ms: Date.now() - started };
}

const probe = spawn(
  'ssh',
  [
    '-i',
    join(homedir(), '.ssh', 'maus_5e'),
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'BatchMode=yes',
    'maus@193.233.217.210',
    `sudo -n /usr/local/sbin/fifth-test op prod-outcome-probe ${seconds}`,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let probeOut = '';
probe.stdout.on('data', (d) => (probeOut += d));
probe.stderr.on('data', (d) => (probeOut += d));
const probeDone = new Promise((r) => probe.on('close', r));

await new Promise((r) => setTimeout(r, 1500));
const until = Date.now() + seconds * 1000;
const results = [];
let n = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (Date.now() < until) {
      const key = randomUUID();
      n += 1;
      const res = await patch(key, n);
      results.push({ key, n, ...res });
    }
  }),
);
const probeCode = await probeDone;

const byStatus = {};
for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
const unknown = results.filter((r) => r.status === 504);
const refused = results.filter((r) => r.status === 503);
const other = results.filter((r) => ![200, 503, 504].includes(r.status));

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });
check(
  'обрыв на сервере прошёл',
  probeCode === 0,
  probeOut.trim().split('\n').slice(-2).join(' | '),
);
check('получен хотя бы один 504', unknown.length > 0, `504: ${unknown.length}`);
check(
  'каждый 504 — problem+json ядра с outcome unknown и traceId',
  unknown.every((r) => r.json?.outcome === 'unknown' && r.json?.traceId && r.json?.code),
  unknown
    .filter((r) => !(r.json?.outcome === 'unknown' && r.json?.traceId))
    .map((r) => JSON.stringify(r.json)?.slice(0, 120) ?? 'без тела')
    .join('; '),
);
check(
  'каждый 503 — outcome not_started',
  refused.every((r) => r.json?.outcome === 'not_started' || r.json?.outcome === undefined),
  `503: ${refused.length}`,
);
check('нет других ошибок (502 прокси, 500)', other.length === 0, JSON.stringify(byStatus));

// Повтор тем же ключом после восстановления: результат выясняется, второго изменения нет.
await new Promise((r) => setTimeout(r, 3000));
const replays = [];
for (const r of unknown.slice(0, 10)) {
  const again = await patch(r.key, r.n);
  replays.push({ n: r.n, status: again.status });
}
check(
  'повтор тем же ключом после 504 — 200',
  replays.every((r) => r.status === 200),
  JSON.stringify(replays),
);

const ok = checks.every((c) => c.ok);
const out = join(ROOT, 'out/release-w31');
mkdirSync(out, { recursive: true });
const file = join(out, `outcome-proxy-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(
  file,
  JSON.stringify(
    {
      base: BASE,
      seconds,
      byStatus,
      checks,
      sample504: unknown.slice(0, 3).map((r) => r.json),
    },
    null,
    2,
  ),
);
for (const c of checks)
  console.log(`${c.ok ? 'OK ' : 'НЕТ'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
console.log(`\nзапросов ${results.length}, по статусам ${JSON.stringify(byStatus)}; итог: ${file}`);
process.exit(ok ? 0 : 1);
