#!/usr/bin/env node
/**
 * Сравнение окон сопоставимого замера (window.sh, W32): одни и те же показатели рядом.
 *   node scripts/load/window-compare.mjs <метка А> <метка Б> [...]
 * Показатели — приросты за окно (сборщик) и замеры в базе; накопленное с запуска не берётся.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const labels = process.argv.slice(2);
if (labels.length < 1) {
  console.error('нужны метки окон');
  process.exit(2);
}

/** Разделы выгрузки сборщика: `### имя` → строки. */
function sections(text) {
  const out = {};
  for (const part of text.split(/^### /m).filter(Boolean)) {
    const nl = part.indexOf('\n');
    out[part.slice(0, nl).trim()] = part
      .slice(nl + 1)
      .split('\n')
      .filter((l) => l.trim());
  }
  return out;
}
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const pct = (a, p) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
};
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '—');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—');

function collectorView(sec) {
  const host = (sec['host.csv'] ?? []).slice(1).map((l) => l.split(',').map(Number));
  const cg = (sec['cgroup.csv'] ?? []).slice(1).map((l) => l.split(','));
  const by = {};
  for (const [, name, cores, periods, thr, thrMs, psi] of cg) {
    const b = (by[name] ??= { cores: [], periods: 0, thr: 0, thrMs: [], psi: [] });
    b.cores.push(Number(cores));
    b.periods += Number(periods);
    b.thr += Number(thr);
    b.thrMs.push(Number(thrMs));
    b.psi.push(Number(psi));
  }
  const valkey = (sec['valkey.csv'] ?? []).slice(1).map((l) => l.split(',').map(Number));
  return {
    iowait: avg(host.map((r) => r[1])),
    psiCpu: avg(host.map((r) => r[2])),
    psiIo: avg(host.map((r) => r[3])),
    psiMem: avg(host.map((r) => r[4])),
    containers: by,
    valkeyCmds: avg(valkey.map((r) => r[1])),
    valkeyUsec: avg(valkey.map((r) => r[2])),
    samples: host.length,
  };
}
function timing(text) {
  const m = [...text.matchAll(/n=(\d+) мин=([\d.]+) медиана=([\d.]+) p90=([\d.]+) макс=([\d.]+)/g)];
  return {
    card: m[0] ? { med: Number(m[0][3]), p90: Number(m[0][4]), max: Number(m[0][5]) } : null,
    cpu: m[1] ? { min: Number(m[1][2]), med: Number(m[1][3]), max: Number(m[1][5]) } : null,
  };
}

const W = {};
for (const L of labels) {
  const dir = join(ROOT, 'out', 'suites', `load-window-${L}`);
  const idle = collectorView(sections(read(join(dir, 'idle-export.txt'))));
  const loadDir = read(join(dir, 'load-dir.txt')).trim().split('\n').at(-1);
  const ld = loadDir ? join(ROOT, loadDir) : null;
  const sum =
    ld && existsSync(join(ld, 'summary.json')) ? JSON.parse(read(join(ld, 'summary.json'))) : null;
  const load = {};
  if (ld) {
    for (const f of ['host.csv', 'cgroup.csv', 'valkey.csv']) {
      const t = read(join(ld, 'server', f));
      if (t) load[f] = t.split('\n').filter((l) => l.trim());
    }
  }
  const routes = {};
  for (const l of read(ld ? join(ld, 'server', 'core-requests.csv') : '')
    .split('\n')
    .slice(1)) {
    const [, , route, , ms] = l.split(',');
    if (route) (routes[route] ??= []).push(Number(ms));
  }
  const pg = read(ld ? join(ld, 'server', 'pg-statements.csv') : '')
    .split('\n')
    .filter((l) => l.includes('|'))
    .map((l) => l.split('|'))
    .map(([calls, , mean, q]) => ({ calls: Number(calls), mean: Number(mean), q }));
  W[L] = {
    idle,
    load: collectorView(load),
    sum,
    routes,
    pg,
    before: timing(read(join(dir, 'db-timing-before.txt'))),
    after: timing(read(join(dir, 'db-timing-after.txt'))),
  };
}

const row = (name, fn) => console.log(`| ${name} | ${labels.map((L) => fn(W[L])).join(' | ')} |`);
console.log(`| показатель | ${labels.join(' | ')} |`);
console.log(`|---|${labels.map(() => '---').join('|')}|`);
console.log('| **простой, уровень хоста** |' + labels.map(() => '').join(' |') + ' |');
row('PSI cpu some, % окна', (w) => f1(w.idle.psiCpu));
row('ожидание диска, ядер', (w) => f2(w.idle.iowait));
row('PSI io / memory, %', (w) => `${f1(w.idle.psiIo)} / ${f1(w.idle.psiMem)}`);
for (const c of ['fifth-test-1-core', 'fifth-test-1-postgres', 'fifth-test-1-valkey']) {
  row(`простой ${c}: ядер; заторм. периодов %`, (w) => {
    const b = w.idle.containers[c];
    return b ? `${f2(avg(b.cores))}; ${f1(b.periods ? (100 * b.thr) / b.periods : 0)}` : '—';
  });
}
row('карточка в базе (контекст ядра), медиана / p90 мс — до', (w) =>
  w.before.card ? `${f2(w.before.card.med)} / ${f2(w.before.card.p90)}` : '—',
);
row('эталон процессора, мин / медиана мс — до', (w) =>
  w.before.cpu ? `${f1(w.before.cpu.min)} / ${f1(w.before.cpu.med)}` : '—',
);
console.log('| **нагрузка p1-api 2/с 10 мин** |' + labels.map(() => '').join(' |') + ' |');
row('действий; пропущено; ошибок', (w) => {
  const st = w.sum?.stages?.[0];
  return st ? `${st.iterations}; ${st.droppedIterations}; ${st.errors}` : '—';
});
for (const r of ['/v1/catalog', '/v1/catalog/:id', '/v1/projects']) {
  row(`сервер ${r}: медиана / p95 мс`, (w) =>
    w.routes[r] ? `${pct(w.routes[r], 50)} / ${pct(w.routes[r], 95)}` : '—',
  );
}
row('PSI cpu some хоста, %', (w) => f1(w.load.psiCpu));
for (const c of ['fifth-test-1-core', 'fifth-test-1-postgres', 'fifth-test-1-valkey']) {
  row(`${c}: ядер; заторм. периодов %`, (w) => {
    const b = w.load.containers[c];
    return b ? `${f2(avg(b.cores))}; ${f1(b.periods ? (100 * b.thr) / b.periods : 0)}` : '—';
  });
}
row(
  'Valkey: команд/срез; мкс на команду',
  (w) => `${f1(w.load.valkeyCmds)}; ${f1(w.load.valkeyUsec)}`,
);
for (const [name, re] of [
  ['БД: витрина, мс/вызов (макс. из вариантов)', /p\.geo_country/],
  ['БД: карточка (project_view_base), мс/вызов', /project_view_base/],
  ['БД: запись события, мс/вызов (макс.)', /app_emit_event/],
]) {
  row(name, (w) => f2(Math.max(...w.pg.filter((p) => re.test(p.q)).map((p) => p.mean))));
}
row('карточка в базе, медиана / p90 мс — после', (w) =>
  w.after.card ? `${f2(w.after.card.med)} / ${f2(w.after.card.p90)}` : '—',
);
row('эталон процессора, мин / медиана мс — после', (w) =>
  w.after.cpu ? `${f1(w.after.cpu.min)} / ${f1(w.after.cpu.med)}` : '—',
);
