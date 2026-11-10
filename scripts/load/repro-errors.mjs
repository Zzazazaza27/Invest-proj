#!/usr/bin/env node
/**
 * Узкое воспроизведение отказов прогона p1 (W32, разбор 401 и 422 часового прогона).
 *
 *   FIFTH_LOAD_BASE=… FIFTH_LOAD_BASIC_AUTH_FILE=… node scripts/load/repro-errors.mjs --run-id <id>
 *
 * 422: число материалов в проектах участников прогона против предела 50; затем один запрос
 *      билета загрузки в заполненный проект — ожидается 422 с кодом LIMIT_EXCEEDED (без
 *      побочного эффекта: отказ до записи). Печатается код и requestId ответа.
 * 401: срок сеанса из ответа входа (Max-Age cookie сеанса) — сравнить с длительностью прогона.
 * Только чтение, кроме одного отказанного запроса билета.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE, basicAuthHeader, client, parseArgs, runDir } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const data = JSON.parse(readFileSync(join(runDir(String(args['run-id'])), 'users.json'), 'utf8'));
const LIMIT = 50;

// --- 401: срок сеанса
const auth = basicAuthHeader();
const u0 = data.users[0];
const r = await fetch(`${BASE}/v1/auth/login`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Fifth-Origin': 'render_check',
    ...(auth ? { Authorization: auth } : {}),
  },
  body: JSON.stringify({ email: u0.email, password: u0.password }),
});
const cookies = r.headers.getSetCookie?.() ?? [];
const ages = cookies.map((c) => {
  const name = c.split('=')[0];
  const age = /max-age=(\d+)/i.exec(c)?.[1] ?? null;
  const exp = /expires=([^;]+)/i.exec(c)?.[1] ?? null;
  return { name, maxAge: age ? Number(age) : null, expires: exp };
});
console.log(`вход: HTTP ${r.status}; cookie:`, JSON.stringify(ages));

// --- 422: заполненность проектов
const counts = [];
for (const u of data.users) {
  const c = client();
  const l = await c.call('/v1/auth/login', {
    method: 'POST',
    body: { email: u.email, password: u.password },
  });
  if (l.status >= 300) {
    console.log(`участник ${u.index}: вход HTTP ${l.status}`);
    continue;
  }
  for (const p of u.projects) {
    const m = await c.call(`/v1/projects/${p.id}/materials`);
    counts.push({ user: u.index, project: p.id, n: m.json?.items?.length ?? -1, c });
  }
}
const full = counts.filter((x) => x.n >= LIMIT);
const hist = {};
for (const x of counts) {
  const b =
    x.n >= LIMIT ? `≥${LIMIT}` : `${Math.floor(x.n / 10) * 10}-${Math.floor(x.n / 10) * 10 + 9}`;
  hist[b] = (hist[b] ?? 0) + 1;
}
console.log(`проектов участников: ${counts.length}; материалов по проектам:`, JSON.stringify(hist));
console.log(`заполнено до предела ${LIMIT}: ${full.length}`);
if (full.length) {
  const x = full[0];
  const t = await x.c.call(`/v1/projects/${x.project}/materials/upload`, {
    method: 'POST',
    key: true,
    body: {
      type: 'deck',
      fileName: 'repro.pdf',
      contentType: 'application/pdf',
      sizeBytes: 65536,
    },
  });
  console.log(
    `билет в заполненный проект (${x.n} материалов): HTTP ${t.status}, code=${t.json?.code ?? '—'}, ` +
      `detail=${JSON.stringify(t.json?.detail ?? null)}, requestId=${t.json?.requestId ?? t.json?.traceId ?? '—'}`,
  );
}
