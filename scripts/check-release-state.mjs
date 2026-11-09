#!/usr/bin/env node
/**
 * Вывод наблюдения о выпуске (scripts/lib/release-state.mjs) — без Docker и баз.
 * Уточнения Тэнка 09.11: зависание — нет продвижения сверх срока этапа; сосуществование
 * версий во время выпуска — норма; непрочитанный источник — «неизвестно».
 *
 * Запуск: node scripts/check-release-state.mjs
 */
import { releaseState } from './lib/release-state.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.warn(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const T0 = Date.parse('2026-11-09T12:00:00Z');
const min = (m) => T0 + m * 60_000;
const iso = (t) => new Date(t).toISOString();
const okDb = (over = {}) => ({
  ok: true,
  running: [],
  last: { id: 'op0', status: 'succeeded', kind: 'install' },
  ...over,
});
const okJournal = (events = []) => ({ ok: true, events });
const steadySlots = (over = {}) => ({
  ok: true,
  route: { slot: 'core-a', build: 'b1' },
  grant: { owner: 'core-a' },
  background: { 'core-a': 'running', 'core-b': 'не работает' },
  via: { slot: 'core-a', build: 'b1' },
  ...over,
});
const codes = (r) => r.problems.map((p) => p.code).join(',');

console.warn('\n=== СОСТОЯНИЕ ВЫПУСКА ДЛЯ НАБЛЮДЕНИЯ ===\n');

{
  const r = releaseState({ db: okDb(), journal: okJournal(), slots: steadySlots() }, min(0));
  check('вне выпуска, всё на месте — ok', r.verdict === 'ok' && r.code === 0, codes(r));
}

console.warn('\n[1] Зависание — по продвижению и сроку этапа');
{
  const running = [{ id: 'op1', build: 'b2', startedAt: iso(min(0)) }];
  const events = [
    { at: iso(min(1)), op: 'op1', stage: 'grant', status: 'ok' },
    { at: iso(min(2)), op: 'op1', stage: 'observe', status: 'start', expectMs: 10 * 60_000 },
  ];
  const during = releaseState(
    { db: okDb({ running }), journal: okJournal(events), slots: null },
    min(35),
  );
  check('наблюдение 10 мин, прошло 33 — не зависание', during.verdict === 'ok', codes(during));
  const late = releaseState(
    { db: okDb({ running }), journal: okJournal(events), slots: null },
    min(45),
  );
  check('прошло 43 мин сверх 10+30 — зависание', codes(late) === 'stalled', late.problems[0]?.text);
  const short = [{ at: iso(min(1)), op: 'op1', stage: 'route', status: 'written' }];
  const stuck = releaseState(
    { db: okDb({ running }), journal: okJournal(short), slots: null },
    min(32),
  );
  check('этап без срока, 31 мин без записи — зависание', codes(stuck) === 'stalled');
}

console.warn('\n[2] Сосуществование версий — норма, нарушение этапа — нет');
{
  const running = [{ id: 'op2', build: 'b2', startedAt: iso(min(0)) }];
  const events = [
    { at: iso(min(1)), op: 'op2', stage: 'grant', status: 'ok', detail: 'owner=null' },
  ];
  const both = steadySlots({
    grant: { owner: null },
    background: { 'core-a': 'paused', 'core-b': 'paused' },
    route: { slot: 'core-b', build: 'b2' },
    via: { slot: 'core-a', build: 'b1' },
  });
  const r = releaseState(
    { db: okDb({ running }), journal: okJournal(events), slots: both },
    min(2),
  );
  check(
    'во время выпуска: маршрут уже на кандидате, отвечает старый — норма',
    r.verdict === 'ok',
    codes(r),
  );
  const two = steadySlots({
    background: { 'core-a': 'running', 'core-b': 'running' },
    grant: { owner: 'core-b' },
  });
  const r2 = releaseState(
    { db: okDb({ running }), journal: okJournal(events), slots: two },
    min(2),
  );
  check(
    'фон в двух слотах — проблема и во время выпуска',
    /two-backgrounds/.test(codes(r2)),
    codes(r2),
  );
  const wrongOwner = steadySlots({ grant: { owner: null } });
  const r3 = releaseState(
    { db: okDb({ running }), journal: okJournal(events), slots: wrongOwner },
    min(2),
  );
  check('фон у слота без разрешения — проблема', /background-owner/.test(codes(r3)), codes(r3));
  const after = releaseState(
    {
      db: okDb(),
      journal: okJournal(events),
      slots: steadySlots({ via: { slot: 'core-b', build: 'b2' } }),
    },
    min(30),
  );
  check(
    'после выпуска маршрут и ответ через nginx расходятся — проблема',
    /route-mismatch/.test(codes(after)),
    codes(after),
  );
}

console.warn('\n[3] Непрочитанный источник — неизвестно');
{
  const r = releaseState(
    { db: { ok: false, error: 'нет соединения' }, journal: okJournal(), slots: steadySlots() },
    min(0),
  );
  check(
    'база не прочитана — unknown, не ok',
    r.verdict === 'unknown' && r.code === 2,
    r.unknown.join('; '),
  );
  const j = releaseState(
    { db: okDb(), journal: { ok: false, error: 'нет файла' }, slots: steadySlots() },
    min(0),
  );
  check('журнал не прочитан — unknown', j.verdict === 'unknown');
  const s = releaseState(
    { db: okDb(), journal: okJournal(), slots: { ok: false, error: 'маршрут не разобран' } },
    min(0),
  );
  check('слоты не прочитаны — unknown', s.verdict === 'unknown');
  const silent = releaseState(
    {
      db: okDb(),
      journal: okJournal(),
      slots: steadySlots({ background: { 'core-a': 'нет ответа', 'core-b': 'не работает' } }),
    },
    min(0),
  );
  check(
    'фон активного не ответил — unknown, не «проблем нет»',
    silent.verdict === 'unknown',
    silent.unknown.join('; '),
  );
  const noVia = releaseState(
    { db: okDb(), journal: okJournal(), slots: steadySlots({ via: null }) },
    min(0),
  );
  check('ответа через nginx нет — unknown', noVia.verdict === 'unknown');
}

console.warn('\n[4] Исходы выпуска');
{
  const f = releaseState(
    {
      db: okDb({
        last: { id: 'op3', status: 'failed', kind: 'install', detail: 'кандидат не готов' },
      }),
      journal: okJournal(),
      slots: steadySlots(),
    },
    min(0),
  );
  check(
    'неудачный выпуск — проблема до следующей успешной установки',
    codes(f) === 'failed',
    f.problems[0]?.text,
  );
  const rb = releaseState(
    {
      db: okDb({ last: { id: 'op4', status: 'succeeded', kind: 'rollback' } }),
      journal: okJournal(),
      slots: steadySlots(),
    },
    min(0),
  );
  check('возврат — проблема', codes(rb) === 'rolled-back');
  const obs = [{ at: iso(min(1)), op: 'op5', stage: 'observe', status: 'fail', detail: 'ошибки' }];
  const o = releaseState({ db: okDb(), journal: okJournal(obs), slots: steadySlots() }, min(2));
  check('отказ в наблюдении — решение за Томасом', /observe-failed/.test(codes(o)));
  const later = [...obs, { at: iso(min(10)), op: 'op6', stage: 'stop-old', status: 'ok' }];
  const o2 = releaseState({ db: okDb(), journal: okJournal(later), slots: steadySlots() }, min(11));
  check('следующий удачный выпуск снимает отказ наблюдения', o2.verdict === 'ok', codes(o2));
}

console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено.\n`);
if (failed > 0) process.exitCode = 1;
