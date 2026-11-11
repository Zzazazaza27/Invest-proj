#!/usr/bin/env node
/**
 * Повышенная нагрузка и возврат к номиналу (работа № 2 раздела 01, W32).
 *
 *   FIFTH_LOAD_BASE=https://test-1.5espace.com FIFTH_LOAD_BASIC_AUTH_FILE=.local/load/test-1-basic.txt \
 *     node scripts/load/w32-recover.mjs --run-id <id> [--steps 2,4,8,16] [--step-duration 10m]
 *       [--return-duration 10m] [--profile p1] [--native]
 *
 * Порядок:
 *  1. сверка операций (`fault-check.mjs --kind load`) запускается рядом и ведёт подтверждённые
 *     изменения с ключами повтора всё окно;
 *  2. ступени (`run.mjs --mode steps`, без встроенного возврата) — до конца или до первой
 *     границы: порог сервера, отказ генератора;
 *  3. сразу после — возврат к номиналу отдельным запуском (`run.mjs --mode base`, 2/с): он
 *     начинается и тогда, когда ступени прервал порог сервера (раньше возврат при этом
 *     не измерялся вовсе);
 *  4. окно сверки закрывается: повтор неподтверждённых, сверка с базой (нет потерь, нет дублей,
 *     нет ложного успеха), outbox разгружается до исходного уровня;
 *  5. вердикт `verdict.json` и `verdict.md`: какая граница достигнута и чья она — платформы или
 *     генератора; восстановился ли номинал.
 *
 * Отчёт — `out/suites/load-<run_id>/recover-<время>/`; отчёты запусков run.mjs — рядом, как обычно.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLocalBase, parseArgs } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const runId = String(args['run-id'] ?? '');
if (!runId) {
  console.error('нужен --run-id (данные прогона — seed.mjs)');
  process.exit(2);
}
const steps = String(args.steps ?? '2,4,8,16');
const stepDuration = String(args['step-duration'] ?? '10m');
const returnDuration = String(args['return-duration'] ?? '10m');
const profile = String(args.profile ?? 'p1');
const native = Boolean(args.native);
const NOMINAL = 2;

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
const runRoot = join('out', 'suites', `load-${runId}`);
const out = join(runRoot, `recover-${stamp}`);
mkdirSync(out, { recursive: true });
const until = join(out, 'window-closed');

const secs = (d) => {
  const m = /^(\d+)([hms]?)$/.exec(d);
  return m ? Number(m[1]) * { h: 3600, m: 60, s: 1 }[m[2] || 's'] : 600;
};
const stepCount = steps.split(',').length;

function node(script, a) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [script, ...a], { stdio: 'inherit' });
    child.on('close', (code) => res(code));
  });
}
/** Новейший каталог отчёта run.mjs, появившийся после `since`. */
function latestReport(since) {
  const dirs = readdirSync(runRoot)
    .map((d) => join(runRoot, d))
    .filter((d) => statSync(d).isDirectory() && statSync(d).mtimeMs >= since)
    .filter((d) => existsSync(join(d, 'meta.json')));
  return dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}
const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
// Сборщик на сервере — только для test-1; у локальной цели (сухой прогон) его нет.
const collect = (sec) => (isLocalBase() ? [] : ['--server-collect', String(sec)]);
const common = ['--run-id', runId, '--profile', profile, ...(native ? ['--native'] : [])];

console.log(`\n=== W32: повышенная нагрузка и возврат к номиналу, прогон ${runId} ===`);
console.log(`  отчёт: ${out}\n`);

// 1. Сверка операций — рядом, на всё окно.
const ledger = node('scripts/load/fault-check.mjs', [
  '--run-id',
  runId,
  '--kind',
  'load',
  '--until',
  until,
  '--out',
  out,
]);

// 2. Ступени без встроенного возврата.
const t0 = Date.now();
const stepsCode = await node('scripts/load/run.mjs', [
  ...common,
  '--mode',
  'steps',
  '--steps',
  steps,
  '--step-duration',
  stepDuration,
  '--return-rate',
  '0',
  ...collect(stepCount * secs(stepDuration) + 900),
]);
const stepsDir = latestReport(t0);

// 3. Возврат к номиналу — сразу, при любом исходе ступеней.
const t1 = Date.now();
const returnCode = await node('scripts/load/run.mjs', [
  ...common,
  '--mode',
  'base',
  // Тот же набор данных, что у ступеней: возврат — продолжение того же прогона.
  '--reuse-data',
  '--rate',
  String(NOMINAL),
  '--duration',
  returnDuration,
  ...collect(secs(returnDuration) + 600),
]);
const returnDir = latestReport(t1);

// 4. Окно сверки закрыто — повтор, сверка, разгрузка outbox.
writeFileSync(until, new Date().toISOString());
const ledgerCode = await ledger;

// 5. Вердикт.
const sMeta = stepsDir ? readJson(join(stepsDir, 'meta.json')) : null;
const sSum = stepsDir ? readJson(join(stepsDir, 'summary.json')) : null;
const rMeta = returnDir ? readJson(join(returnDir, 'meta.json')) : null;
const rSum = returnDir ? readJson(join(returnDir, 'summary.json')) : null;
const check = readJson(join(out, 'fault-load.json'));

const ran = (sSum?.stages ?? []).filter((s) => s.iterations > 0);
const stageRows = ran.map((s) => ({
  stage: s.name,
  target: s.targetRatePerSec,
  // Фактическая частота — по времени, когда ступень реально шла: прерванная ступень короче.
  iterations: s.iterations,
  dropped: s.droppedIterations,
  droppedShare: s.iterations ? s.droppedIterations / (s.iterations + s.droppedIterations) : 0,
  errors: s.errors,
  p95: Math.round(s.actionDurationMs?.p95 ?? 0),
}));
const baseline = stageRows.find((r) => r.target === NOMINAL) ?? null;
const last = stageRows.at(-1) ?? null;

// Чья граница. Признаки генератора — из run.mjs (часы, сетевые ошибки соединения, остановка
// итераций); порог сервера — ресурсы общего VPS; пропущенные итерации при медленных ответах
// сервера — платформа (k6 не успевает начать, потому что ответы идут долго).
let limit;
if (sMeta?.generatorFailed) {
  limit = { kind: 'генератор', reason: sMeta.generatorFailed.reason, at: last?.stage ?? null };
} else if (sMeta?.stoppedByServer) {
  limit = { kind: 'платформа', reason: `порог сервера: ${sMeta.stoppedByServer}`, at: last?.stage };
} else if (last && last.droppedShare > 0.02) {
  const serverP95 = Math.max(...Object.values(sMeta?.serverSummary ?? {}).map((r) => r.p95 ?? 0));
  limit =
    last.p95 > 3 * Math.max(serverP95, 1) && serverP95 < 1000
      ? {
          kind: 'генератор',
          reason: `пропуски ${pct(last.droppedShare)} при быстром сервере (p95 ${serverP95} мс)`,
          at: last.stage,
        }
      : {
          kind: 'платформа',
          reason: `пропуски ${pct(last.droppedShare)}, ответы медленные (p95 ${last.p95} мс)`,
          at: last.stage,
        };
} else {
  limit = {
    kind: 'не достигнута',
    reason: `все ступени до ${last?.target ?? '?'}/с прошли`,
    at: last?.stage ?? null,
  };
}
function pct(x) {
  return `${(x * 100).toFixed(1)} %`;
}

const back = rSum?.stages?.[0] ?? null;
const backRate = back ? back.iterations / Math.max(back.durationSec, 1) : 0;
const backP95 = Math.round(back?.actionDurationMs?.p95 ?? 0);
const recovered = {
  ran: Boolean(back),
  rate: Number(backRate.toFixed(2)),
  errors: back?.errors ?? null,
  p95: backP95,
  baselineP95: baseline?.p95 ?? null,
  stoppedByServer: rMeta?.stoppedByServer ?? null,
  generatorFailed: rMeta?.generatorFailed ?? null,
  server: rMeta?.serverSummary ?? null,
};
const problems = [];
if (!back) problems.push('возврат к номиналу не измерен');
else {
  if (backRate < NOMINAL * 0.95) problems.push(`номинал не держится: ${backRate.toFixed(2)}/с`);
  if (back.errors > 0) problems.push(`ошибок в возврате: ${back.errors}`);
  if (baseline && backP95 > 1.5 * baseline.p95)
    problems.push(`p95 возврата ${backP95} мс больше 1,5 × исходного ${baseline.p95} мс`);
  if (rMeta?.stoppedByServer) problems.push(`возврат прерван порогом: ${rMeta.stoppedByServer}`);
  if (rMeta?.generatorFailed)
    problems.push(`возврат: отказ генератора ${rMeta.generatorFailed.reason}`);
}
if (!check) problems.push('сверки операций нет');
else for (const p of check.problems) problems.push(`сверка: ${p}`);

const verdict = {
  runId,
  profile,
  steps,
  stepDuration,
  returnDuration,
  reports: { steps: stepsDir, return: returnDir },
  codes: { steps: stepsCode, return: returnCode, ledger: ledgerCode },
  stages: stageRows,
  limit,
  recovered,
  operations: check && {
    confirmed: check.during.items.filter((x) => x.status >= 200 && x.status < 300).length + 5,
    attempts: check.during.attempts,
    byStatus: check.during.byStatus,
    retried: check.retried.length,
    objectsFound: check.objectsFound,
    outbox: check.events,
  },
  problems,
  passed: problems.length === 0,
};
writeFileSync(join(out, 'verdict.json'), JSON.stringify(verdict, null, 2));

const md = [
  `# W32 — повышенная нагрузка и возврат к номиналу (${runId})`,
  '',
  `Профиль ${profile}; ступени ${steps} по ${stepDuration}; возврат ${NOMINAL}/с ${returnDuration}.`,
  '',
  '| Ступень | Задано, /с | Итераций | Пропущено | Ошибок | p95 действия, мс |',
  '| --- | --- | --- | --- | --- | --- |',
  ...stageRows.map(
    (r) =>
      `| ${r.stage} | ${r.target} | ${r.iterations} | ${r.dropped} (${pct(r.droppedShare)}) | ${r.errors} | ${r.p95} |`,
  ),
  '',
  `**Граница:** ${limit.kind} — ${limit.reason}${limit.at ? ` (ступень ${limit.at})` : ''}.`,
  '',
  `**Возврат к номиналу:** ${recovered.ran ? `${recovered.rate}/с, ошибок ${recovered.errors}, p95 ${recovered.p95} мс (исходно ${recovered.baselineP95 ?? '—'} мс)` : 'не измерен'}.`,
  '',
  check
    ? `**Операции:** попыток в окне ${check.during.attempts} ${JSON.stringify(check.during.byStatus)}, повторено ${check.retried.length}, объектов ${check.objectsFound}; outbox до ${check.events?.base}, после ${check.events?.last}.`
    : '**Операции:** сверки нет.',
  '',
  problems.length
    ? `**Не прошло:**\n\n${problems.map((p) => `- ${p}`).join('\n')}`
    : '**Итог: прошло.**',
  '',
].join('\n');
writeFileSync(join(out, 'verdict.md'), md);
console.log(`\n${md}`);
process.exit(problems.length ? 1 : 0);
