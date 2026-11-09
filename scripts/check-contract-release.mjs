#!/usr/bin/env node
/**
 * Выпуск с contract-миграцией (scripts/lib/contract-release.mjs) на имитации — без Docker.
 * Уточнение Тэнка 09.11 (п. 5): несовместимая миграция не идёт поверх обслуживающего
 * старого ядра; после неё возврата нет — исправление вперёд.
 *
 * Запуск: node scripts/check-contract-release.mjs
 */
import { contractRelease } from './lib/contract-release.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.warn(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

function world(over = {}) {
  const s = {
    t: 0,
    grant: { owner: 'core-a' },
    route: { slot: 'core-a', build: 'b1' },
    nginx: { slot: 'core-a', build: 'b1' },
    schema: 'old',
    slots: {
      'core-a': { up: true, bg: 'running', build: 'b1' },
      'core-b': { up: false, bg: 'idle' },
    },
    log: [],
  };
  const ops = {
    now: () => s.t,
    sleep: async (ms) => {
      s.t += ms;
    },
    record: (stage, status, detail) =>
      s.log.push(`${stage}:${status}${detail ? ` ${detail}` : ''}`),
    writeGrant: (owner) => {
      s.grant = { owner };
    },
    pause: async (slot) => {
      if (over.stuckPause) return 'pausing';
      s.slots[slot].bg = 'paused';
      return 'paused';
    },
    resume: async (slot) => {
      if (s.grant.owner !== slot) return s.slots[slot].bg;
      s.slots[slot].bg = 'running';
      s.log.push(`resume ${slot}`);
      return 'running';
    },
    stopSlot: async (slot) => {
      s.slots[slot].up = false;
      s.slots[slot].bg = 'stopped';
      s.log.push(`stop ${slot} (схема ${s.schema})`);
    },
    slotStopped: async (slot) => !s.slots[slot].up,
    startSlot: async (slot) => {
      s.slots[slot].up = true;
      s.slots[slot].bg = 'paused';
    },
    migrate: async () => {
      // Старое ядро обязано быть остановлено к моменту несовместимого изменения.
      s.migratedWhileOldUp = s.slots['core-a'].up;
      if (over.migrateRolledBack)
        return { ok: false, applied: false, detail: 'миграция откатилась' };
      s.schema = 'new';
      s.log.push('migrate');
      return { ok: true };
    },
    startCandidate: async (slot, build) => {
      s.slots[slot] = { up: true, bg: 'paused', build };
    },
    ready: async (slot) => (over.candidateNotReady && slot === 'core-b' ? false : s.slots[slot].up),
    candidateChecks: async () => ({ ok: true }),
    writeRoute: (r) => {
      s.route = r;
    },
    reloadNginx: async () => {
      s.nginx = { slot: s.route.slot, build: s.slots[s.route.slot].build };
      return { ok: true };
    },
    viaNginx: async () => (over.wrongVia ? { slot: 'core-a', build: 'b1' } : { ...s.nginx }),
  };
  return { s, ops };
}

const plan = {
  from: 'core-a',
  to: 'core-b',
  build: 'b2',
  prevBuild: 'b1',
  limits: { readyWaitMs: 10_000 },
};
const at = (s, e) => s.log.findIndex((l) => l.startsWith(e));

console.warn('\n=== ВЫПУСК С CONTRACT-МИГРАЦИЕЙ: ИМИТАЦИЯ ===\n');
{
  const { s, ops } = world();
  const r = await contractRelease(ops, plan);
  check('успешный выпуск, активен кандидат', r.ok && r.active === 'core-b' && r.migrated);
  check(
    'миграция — только после остановки старого',
    s.migratedWhileOldUp === false && at(s, 'stop core-a') < at(s, 'migrate'),
  );
  check('фон кандидату — после подтверждения', at(s, 'confirm:ok') < at(s, 'resume core-b'));
  check(
    'фон только у кандидата',
    s.slots['core-b'].bg === 'running' && s.slots['core-a'].bg === 'stopped',
  );
}
{
  const { s, ops } = world({ stuckPause: true });
  const r = await contractRelease(ops, plan);
  check(
    'пауза старого не завершилась — миграции нет, старое в работе',
    !r.ok &&
      !r.migrated &&
      r.active === 'core-a' &&
      s.schema === 'old' &&
      s.slots['core-a'].bg === 'running',
  );
}
{
  const { s, ops } = world({ migrateRolledBack: true });
  const r = await contractRelease(ops, plan);
  check(
    'миграция откатилась — старое ядро возвращено в работу',
    !r.ok &&
      r.active === 'core-a' &&
      s.slots['core-a'].up &&
      s.slots['core-a'].bg === 'running' &&
      s.schema === 'old',
    r.detail,
  );
}
{
  const { s, ops } = world({ candidateNotReady: true });
  const r = await contractRelease(ops, plan);
  check(
    'кандидат не готов после миграции — возврата нет, исправление вперёд',
    !r.ok && r.forwardOnly && r.migrated && !s.slots['core-a'].up,
    r.detail,
  );
  check(
    'старое ядро на новой схеме не поднято',
    s.slots['core-a'].up === false && s.schema === 'new',
  );
}
{
  const { s, ops } = world({ wrongVia: true });
  const r = await contractRelease(ops, plan);
  check(
    'переключение не подтверждено — исправление вперёд, фон никому',
    !r.ok && r.forwardOnly && s.slots['core-b'].bg !== 'running' && s.grant.owner !== 'core-a',
  );
}

console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено.\n`);
if (failed > 0) process.exitCode = 1;
