#!/usr/bin/env node
/**
 * Логика переключения слотов (scripts/lib/slot-switch.mjs) на имитации среды — без Docker.
 *
 * Порядок шагов и все пути отказа (блок 09, задание 3; уточнения Тэнка 09.11), включая
 * перезапуски слотов в опасные моменты: кандидат — после записи маршрута до подтверждения;
 * старый — после паузы; неактивный — в окне наблюдения. Слот после перезапуска решает о фоне
 * так же, как ядро (apps/core: BACKGROUND_START=grant): только по разрешению.
 * Настоящие контейнеры и nginx — испытание на временной среде.
 *
 * Запуск: node scripts/check-slot-switch.mjs
 */
import { factualState, switchSlots } from './lib/slot-switch.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.warn(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Имитация среды: файлы маршрута и разрешения, слоты с фоном, nginx. */
function world(over = {}) {
  const s = {
    t: 0,
    grant: { owner: 'core-a' },
    route: { slot: 'core-a', build: 'b1', prevBuild: 'b0' },
    nginx: { slot: 'core-a', build: 'b1' }, // что фактически обслуживает
    slots: {
      'core-a': { up: true, bg: 'running', build: 'b1', active: 0 },
      'core-b': { up: false, bg: 'idle' },
    },
    oldWorkers: 0,
    log: [],
    hooks: {},
  };
  const restart = (slot) => {
    // Перезапуск слота: фон — только по разрешению этому слоту.
    s.slots[slot].bg = s.grant?.owner === slot ? 'running' : 'paused';
    s.log.push(`restart ${slot} → ${s.slots[slot].bg}`);
  };
  const ops = {
    now: () => s.t,
    sleep: async (ms) => {
      s.t += ms;
    },
    record: (stage, status, detail) =>
      s.log.push(`${stage}:${status}${detail ? ` ${detail}` : ''}`),
    startCandidate: async (slot, build) => {
      s.slots[slot] = {
        up: true,
        bg: s.grant?.owner === slot ? 'running' : 'paused',
        build,
        active: 0,
      };
    },
    ready: async (slot) => (over.notReady ? false : s.slots[slot].up),
    candidateChecks: async () =>
      over.checksFail ? { ok: false, detail: 'вход не прошёл' } : { ok: true },
    writeGrant: (owner) => {
      s.grant = { owner };
      s.log.push(`grant ${owner}`);
    },
    readGrant: () => s.grant,
    pause: async (slot) => {
      if (over.stuckPause && slot === 'core-a') return 'pausing';
      if (over.candidatePausing && slot === 'core-b') return 'pausing';
      s.slots[slot].bg = 'paused';
      s.hooks.afterPause?.(slot, restart);
      return 'paused';
    },
    resume: async (slot) => {
      if (s.grant?.owner !== slot) return s.slots[slot].bg; // ядро откажет без разрешения
      if (over.candidateResumeFails && slot === 'core-b') return 'paused';
      s.log.push(`resume ${slot}`);
      s.slots[slot].bg = 'running';
      return 'running';
    },
    writeRoute: (r) => {
      s.route = { ...r };
      s.hooks.afterRoute?.(r, restart);
    },
    readRoute: () => s.route,
    reloadNginx: async () => {
      if (over.reloadFail) return { ok: false, detail: 'nginx -t: ошибка' };
      const target = s.slots[s.route.slot];
      s.nginx = { slot: s.route.slot, build: target?.build };
      return { ok: true };
    },
    viaNginx: async () =>
      over.wrongVia && s.nginx.slot === 'core-b' ? { slot: 'core-a', build: 'b1' } : { ...s.nginx },
    observe: async () => {
      s.hooks.observe?.(restart);
      return over.observeFail ? { ok: false, detail: 'ошибки 5xx выше порога' } : { ok: true };
    },
    nginxOldWorkers: async () => (over.unknownDrain ? null : s.oldWorkers),
    activeRequests: async (slot) => (over.unknownDrain ? null : s.slots[slot].active),
    slotStopped: async (slot) => !s.slots[slot].up,
    stopSlot: async (slot) => {
      if (over.stopFails && slot === 'core-b') return;
      s.slots[slot].up = false;
      s.slots[slot].bg = 'stopped';
      s.log.push(`stop ${slot}`);
    },
    backgroundMode: async (slot) => s.slots[slot].bg,
  };
  return { s, ops };
}

const plan = { from: 'core-a', to: 'core-b', build: 'b2', prevBuild: 'b1' };
const idx = (s, entry) => s.log.findIndex((l) => l.startsWith(entry));
const running = (s) =>
  Object.entries(s.slots)
    .filter(([, v]) => v.bg === 'running')
    .map(([k]) => k);

console.warn('\n=== ПЕРЕКЛЮЧЕНИЕ СЛОТОВ: ИМИТАЦИЯ ===\n');

console.warn('[1] Успешное переключение');
{
  const { s, ops } = world();
  const r = await switchSlots(ops, plan);
  check('итог ok, активен кандидат', r.ok && r.active === 'core-b', r.detail);
  check('разрешение снято до паузы', idx(s, 'grant null') < idx(s, 'pause:ok'));
  check('фон кандидату — после подтверждения', idx(s, 'confirm:ok') < idx(s, 'grant core-b'));
  check(
    'старый остановлен после наблюдения и завершения',
    idx(s, 'drain:ok') < idx(s, 'stop core-a'),
  );
  check('фон ровно в одном слоте — кандидате', running(s).join() === 'core-b', running(s).join());
}

console.warn('\n[2] Кандидат не готов');
{
  const { s, ops } = world({ notReady: true });
  const r = await switchSlots(ops, { ...plan, limits: { readyWaitMs: 10_000 } });
  check(
    'отказ до переключения, активен старый',
    !r.ok && r.active === 'core-a' && r.stage === 'candidate',
  );
  check('маршрут и разрешение не тронуты', s.route.slot === 'core-a' && s.grant.owner === 'core-a');
  check(
    'кандидат остановлен, фон старого идёт',
    !s.slots['core-b'].up && s.slots['core-a'].bg === 'running',
  );
}

console.warn('\n[3] Пауза старого не завершилась');
{
  const { s, ops } = world({ stuckPause: true });
  const r = await switchSlots(ops, plan);
  check('отказ на паузе, активен старый', !r.ok && r.stage === 'pause' && r.active === 'core-a');
  check(
    'разрешение возвращено старому, маршрут не тронут',
    s.grant.owner === 'core-a' && s.route.slot === 'core-a',
  );
}

console.warn('\n[4] Отказ перезагрузки nginx после паузы старого фона');
{
  const { s, ops } = world({ reloadFail: true });
  const r = await switchSlots(ops, plan);
  check(
    'отказ на перезагрузке, активен старый',
    !r.ok && r.stage === 'reload' && r.active === 'core-a',
  );
  check('файл маршрута возвращён старому', s.route.slot === 'core-a');
  check(
    'прежняя работа восстановлена: фон старого идёт',
    s.slots['core-a'].bg === 'running' && s.grant.owner === 'core-a',
  );
  check('кандидат остановлен', !s.slots['core-b'].up);
}

console.warn('\n[5] Переключение не подтверждено запросом');
{
  const { s, ops } = world({ wrongVia: true });
  const r = await switchSlots(ops, plan);
  check(
    'отказ на подтверждении, активен старый',
    !r.ok && r.stage === 'confirm' && r.active === 'core-a',
    r.detail,
  );
  check(
    'маршрут возвращён и подтверждён прежней сборкой',
    s.route.slot === 'core-a' && s.nginx.slot === 'core-a',
  );
  check('фон только у старого', running(s).join() === 'core-a', running(s).join());
}

console.warn('\n[6] Отказ в наблюдении, возврат планом не разрешён');
{
  const { s, ops } = world({ observeFail: true });
  const r = await switchSlots(ops, plan);
  check(
    'остановка с решением за Томасом, кандидат обслуживает',
    !r.ok && r.stage === 'observe' && r.active === 'core-b',
  );
  check('старый жив без фона', s.slots['core-a'].up && s.slots['core-a'].bg === 'paused');
}

console.warn('\n[7] Отказ в наблюдении, возврат разрешён планом');
{
  const { s, ops } = world({ observeFail: true });
  const r = await switchSlots(ops, { ...plan, autoRollback: true });
  check('возврат: активен старый', !r.ok && r.active === 'core-a' && s.nginx.slot === 'core-a');
  check(
    'фон только у старого, кандидат остановлен',
    running(s).join() === 'core-a' && !s.slots['core-b'].up,
  );
}

console.warn('\n[8] Старый не завершил запросы к сроку');
{
  const { s, ops } = world();
  s.slots['core-a'].active = 2;
  const r = await switchSlots(ops, { ...plan, limits: { drainWaitMs: 10_000 } });
  check(
    'явный порядок: число оборванных в журнале, затем остановка',
    r.ok &&
      s.log.some((l) => l.startsWith('drain:timeout незавершённых запросов 2')) &&
      !s.slots['core-a'].up,
  );
}

console.warn('\n[9] Перезапуски слотов в опасные моменты');
{
  // Кандидат перезапущен после записи маршрута, до подтверждения reload.
  const { s, ops } = world();
  let seen = null;
  s.hooks.afterRoute = (r, restart) => {
    if (r.slot === 'core-b' && seen === null) {
      restart('core-b');
      seen = s.slots['core-b'].bg;
    }
  };
  await switchSlots(ops, plan);
  check('кандидат после записи маршрута: фон не стартовал', seen === 'paused', seen);
}
{
  // Старый перезапущен сразу после паузы.
  const { s, ops } = world();
  let seen = null;
  s.hooks.afterPause = (slot, restart) => {
    if (slot === 'core-a' && seen === null) {
      restart('core-a');
      seen = s.slots['core-a'].bg;
    }
  };
  await switchSlots(ops, plan);
  check('старый после паузы: пауза сохранилась', seen === 'paused', seen);
}
{
  // Неактивный и оба слота перезапущены в окне наблюдения.
  const { s, ops } = world();
  s.hooks.observe = (restart) => {
    restart('core-a');
    restart('core-b');
  };
  await switchSlots(ops, plan);
  check(
    'перезапуск обоих в наблюдении: фон только у активного',
    running(s).join() === 'core-b',
    running(s).join(),
  );
}

console.warn('\n[10] Фактическое состояние после обрыва');
{
  const { s, ops } = world();
  s.route = { slot: 'core-b', build: 'b2' }; // маршрут записан, nginx ещё не перезагружен
  s.grant = { owner: null };
  s.slots['core-a'].bg = 'paused';
  s.slots['core-b'] = { up: true, bg: 'paused', build: 'b2', active: 0 };
  const f = await factualState(ops);
  check(
    'обрыв между записью маршрута и перезагрузкой — несогласованно',
    f.consistent === false,
    JSON.stringify(f.via),
  );
  s.route = { slot: 'core-a', build: 'b1' };
  s.grant = { owner: 'core-a' };
  s.slots['core-a'].bg = 'running';
  const g = await factualState(ops);
  check('прежнее состояние — согласованно', g.consistent === true);
}

console.warn('\n[11] Регрессии Тэнка 09.11');
{
  // 1. Фон кандидата не запустился — выпуск не успешен, всё старому.
  const { s, ops } = world({ candidateResumeFails: true });
  const r = await switchSlots(ops, plan);
  check(
    'фон кандидата не запустился — выпуск не успешен',
    !r.ok && r.stage === 'grant' && r.active === 'core-a',
    r.detail,
  );
  check(
    'старый не остановлен, его фон идёт, кандидат остановлен',
    s.slots['core-a'].up && s.slots['core-a'].bg === 'running' && !s.slots['core-b'].up,
  );
  check('маршрут возвращён старому', s.route.slot === 'core-a' && s.nginx.slot === 'core-a');
}
{
  // 2. Возврат при паузе кандидата pausing: старый возобновлён только после остановки кандидата.
  const { s, ops } = world({ observeFail: true, candidatePausing: true });
  const r = await switchSlots(ops, { ...plan, autoRollback: true });
  check('возврат выполнен', !r.ok && r.active === 'core-a', r.detail);
  check(
    'кандидат остановлен ДО возобновления фона старого',
    idx(s, 'stop core-b') >= 0 && idx(s, 'stop core-b') < idx(s, 'resume core-a'),
    s.log.filter((l) => /^(stop|resume)/.test(l)).join(' → '),
  );
}
{
  // 2б. Остановку кандидата подтвердить не удалось — фон старого не возобновляется.
  const { s, ops } = world({ observeFail: true, candidatePausing: true, stopFails: true });
  const r = await switchSlots(ops, { ...plan, autoRollback: true, limits: { stopWaitMs: 10_000 } });
  check(
    'кандидат не остановлен — решение за Томасом',
    !r.ok && r.stage === 'stop-candidate',
    r.detail,
  );
  check(
    'фон старого не возобновлён',
    s.slots['core-a'].bg !== 'running' && idx(s, 'resume core-a') < 0,
  );
}
{
  // 3. Неизвестное состояние завершения — не ноль: ждём до срока, затем остановка с причиной.
  const { s, ops } = world({ unknownDrain: true });
  const t0 = s.t;
  const r = await switchSlots(ops, { ...plan, limits: { drainWaitMs: 20_000 } });
  const line = s.log.find((l) => l.startsWith('drain:timeout'));
  check('ожидание до срока, а не сразу', r.ok && s.t - t0 >= 20_000, `${(s.t - t0) / 1000} с`);
  check(
    'в журнале — «неизвестно» и остановка по сроку',
    /drain:timeout .*неизвестно.*остановка по сроку/.test(line ?? ''),
    line,
  );
}
console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено.\n`);
if (failed > 0) process.exitCode = 1;
