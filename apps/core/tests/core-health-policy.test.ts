import { describe, expect, it } from 'vitest';
// @ts-expect-error — модуль образа на JS без деклараций.
import * as policy from '../../../infra/images/core-health-policy.mjs';
// @ts-expect-error — модуль скриптов на JS без деклараций.
import { containerRecord } from '../../../scripts/lib/monitor-containers.mjs';

/**
 * Предел перезапусков зависшего ядра (блок 2, 2.4; решение Томаса 09.11.2026): три
 * автоматических перезапуска за скользящие 30 минут, четвёртое зависание — остановка
 * автовосстановления; отметка снимается после трёх успешных /live подряд; счётчик отказов
 * принадлежит процессу.
 */
type State = ReturnType<typeof policy.initialState>;
const { decide, initialState, WINDOW_MS } = policy as {
  decide: (
    s: State,
    p: { now: number; live: boolean; proc: string | null },
  ) => {
    state: State;
    action: 'none' | 'kill';
    status: string;
    exitCode: number;
  };
  initialState: () => State;
  WINDOW_MS: number;
};

/** Процесс стартовал и ответил, затем завис: вернуть время, когда пришло решение. */
function hang(s: State, proc: string, t0: number) {
  let state = decide(s, { now: t0, live: true, proc }).state;
  let last = { state, action: 'none' as string, status: '' };
  for (let i = 1; i <= 3; i += 1) {
    last = decide(state, { now: t0 + i * 5_000, live: false, proc });
    state = last.state;
  }
  return last;
}

describe('предел перезапусков зависшего ядра', () => {
  it('три зависания за окно — три убийства, четвёртое — остановка без убийства', () => {
    let s = initialState();
    const t = 1_000_000;
    for (let n = 0; n < 3; n += 1) {
      const r = hang(s, `p${n}`, t + n * 60_000);
      expect(r.action).toBe('kill');
      s = r.state;
    }
    const fourth = hang(s, 'p3', t + 3 * 60_000);
    expect(fourth.action).toBe('none');
    expect(fourth.status).toContain('recovery=stopped');
    // Дальше зависший процесс так и остаётся — повторных убийств нет.
    const later = decide(fourth.state, { now: t + 4 * 60_000, live: false, proc: 'p3' });
    expect(later.action).toBe('none');
    expect(later.status).toContain('recovery=stopped');
  });

  it('скользящее окно: убийство старше 30 минут не считается', () => {
    let s = initialState();
    const t = 5_000_000;
    s = hang(s, 'a', t).state;
    s = hang(s, 'b', t + 10 * 60_000).state;
    s = hang(s, 'c', t + 20 * 60_000).state;
    const r = hang(s, 'd', t + WINDOW_MS + 60_000);
    expect(r.action).toBe('kill');
    expect(r.status).toContain('recovery=active');
  });

  it('отметка снимается только после трёх успешных /live подряд', () => {
    let s = initialState();
    const t = 9_000_000;
    for (let n = 0; n < 4; n += 1) s = hang(s, `q${n}`, t + n * 60_000).state;
    expect(s.stoppedAt).not.toBeNull();
    // Человек перезапустил: новый процесс.
    let r = decide(s, { now: t + 10 * 60_000, live: true, proc: 'manual' });
    r = decide(r.state, { now: t + 10 * 60_000 + 5_000, live: true, proc: 'manual' });
    expect(r.status).toContain('recovery=stopped');
    r = decide(r.state, { now: t + 10 * 60_000 + 10_000, live: false, proc: 'manual' });
    r = decide(r.state, { now: t + 10 * 60_000 + 15_000, live: true, proc: 'manual' });
    r = decide(r.state, { now: t + 10 * 60_000 + 20_000, live: true, proc: 'manual' });
    expect(r.status).toContain('recovery=stopped');
    r = decide(r.state, { now: t + 10 * 60_000 + 25_000, live: true, proc: 'manual' });
    expect(r.status).toContain('recovery=active');
  });

  it('счётчик отказов принадлежит процессу: перезапущенный не убивается до своего первого успеха', () => {
    const killed = hang(initialState(), 'old', 1_000);
    expect(killed.action).toBe('kill');
    // Новый процесс стартует долго: отказы до первого успеха не считаются.
    let r = { state: killed.state, action: 'none' as string };
    for (let i = 0; i < 10; i += 1) {
      r = decide(r.state, { now: 100_000 + i * 5_000, live: false, proc: 'new' });
      expect(r.action).toBe('none');
    }
  });

  it('процесса нет — отказ без счёта', () => {
    let s = decide(initialState(), { now: 0, live: true, proc: 'x' }).state;
    for (let i = 1; i < 6; i += 1) {
      const r = decide(s, { now: i * 5_000, live: false, proc: null });
      expect(r.action).toBe('none');
      s = r.state;
    }
  });
});

describe('выгрузка наблюдения', () => {
  const base = {
    Name: '/fifth-core',
    State: { Status: 'running', Health: { Status: 'unhealthy', Log: [] as { Output: string }[] } },
    RestartCount: 3,
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
  };
  it('recoveryStopped — по последней строке проверки; текст наружу не выгружается', () => {
    const stopped = containerRecord({
      ...base,
      State: {
        ...base.State,
        Health: {
          Status: 'unhealthy',
          Log: [
            { Output: 'core-health live=0 recovery=active kills=3/30m' },
            { Output: 'core-health live=0 recovery=stopped kills=3/30m stopped_at=x\n' },
          ],
        },
      },
    });
    expect(stopped).toEqual({
      name: 'fifth-core',
      state: 'running',
      health: 'unhealthy',
      restarts: 3,
      expected: true,
      recoveryStopped: true,
      crashLoop: false,
    });
    expect(containerRecord(base).recoveryStopped).toBe(false);
  });
});

// @ts-expect-error — модуль образа на JS без деклараций.
import * as startPolicy from '../../../infra/images/core-start-policy.mjs';

/**
 * Петля падений (решение Томаса 09.11.2026): после третьего незапланированного выхода за
 * скользящие 30 минут следующий запуск — через 10 минут после предыдущего, дальше не чаще раза
 * в 10 минут; штатная остановка и убийство зависшего — не падения; три успешных /live снимают
 * редкий режим, но не историю.
 */
describe('петля падений', () => {
  type S = Record<string, unknown>;
  const sp = startPolicy as {
    initialStartState: () => S;
    beforeStart: (
      s: S,
      now: number,
      slowMs?: number,
    ) => { state: S; delayMs: number; slow: boolean };
    started: (s: S, now: number, id: string) => S;
    exited: (
      s: S,
      now: number,
      o: { stopRequested: boolean; killedByHealth: boolean },
    ) => { state: S; crash: boolean };
    crashMode: (
      s: S,
      cleared: string | null,
      o: { now: number; procId: string | null; okStreak: number },
    ) => { slow: boolean; cleared: string | null; crashes: number; nextStart: number | null };
  };
  const MIN = 60_000;
  /** Запуск в момент t и падение через 5 с. */
  function crashAt(s: S, t: number, id: string) {
    const b = sp.beforeStart(s, t);
    const st = sp.started(b.state, t + b.delayMs, id);
    return {
      before: b,
      state: sp.exited(st, t + b.delayMs + 5_000, { stopRequested: false, killedByHealth: false })
        .state,
    };
  }

  it('три падения — сразу; после третьего запуск через 10 минут, дальше не чаще раза в 10 минут', () => {
    let s = sp.initialStartState();
    let t = 0;
    for (const id of ['a', 'b', 'c']) {
      const r = crashAt(s, t, id);
      expect(r.before.delayMs).toBe(0);
      s = r.state;
      t += 10_000;
    }
    const fourth = sp.beforeStart(s, t);
    expect(fourth.slow).toBe(true);
    expect(fourth.delayMs).toBe(10 * MIN - (t - 20_000));
    const s4 = sp.exited(
      sp.started(fourth.state, t + fourth.delayMs, 'd'),
      t + fourth.delayMs + 5_000,
      {
        stopRequested: false,
        killedByHealth: false,
      },
    ).state;
    const fifth = sp.beforeStart(s4, t + fourth.delayMs + 6_000);
    expect(fifth.delayMs).toBeGreaterThan(9 * MIN);
  });

  it('штатная остановка и убийство зависшего — не падения', () => {
    let s = sp.started(sp.initialStartState(), 0, 'p');
    s = sp.exited(s, 1_000, { stopRequested: true, killedByHealth: false }).state;
    s = sp.exited(sp.started(s, 2_000, 'q'), 3_000, {
      stopRequested: false,
      killedByHealth: true,
    }).state;
    expect((s.crashes as number[]).length).toBe(0);
    expect(
      sp.exited(sp.started(s, 4_000, 'r'), 5_000, { stopRequested: false, killedByHealth: false })
        .crash,
    ).toBe(true);
  });

  it('падения старше 30 минут не считаются', () => {
    let s = sp.initialStartState();
    for (const [i, id] of ['a', 'b', 'c'].entries()) s = crashAt(s, i * MIN, id).state;
    expect(sp.beforeStart(s, 31 * MIN + 10_000).delayMs).toBe(0);
  });

  it('три успешных /live снимают редкий режим, история остаётся — следующее падение снова редкое', () => {
    let s = sp.initialStartState();
    for (const [i, id] of ['a', 'b', 'c'].entries()) s = crashAt(s, i * 10_000, id).state;
    const waitState = { ...sp.beforeStart(s, 30_000).state, nextStart: 600_000 };
    expect(sp.crashMode(waitState, null, { now: 30_000, procId: null, okStreak: 0 }).slow).toBe(
      true,
    );
    const run = sp.started({ ...waitState, nextStart: null }, 600_000, 'd');
    let m = sp.crashMode(run, null, { now: 601_000, procId: 'd', okStreak: 2 });
    expect(m.slow).toBe(true);
    m = sp.crashMode(run, m.cleared, { now: 602_000, procId: 'd', okStreak: 3 });
    expect(m.slow).toBe(false);
    expect(m.crashes).toBe(3);
    const after = sp.exited(run, 603_000, { stopRequested: false, killedByHealth: false }).state;
    expect(sp.beforeStart(after, 604_000).slow).toBe(true);
  });
});

/**
 * Зависание при первоначальном запуске (решение Тэнка и Томаса 09.11.2026): предел 5 минут от
 * запуска ЭТОГО процесса по записи обёртки; общий счёт с W23; первый /live — обычное правило.
 */
describe('зависание при запуске', () => {
  type P = { now: number; live: boolean; proc: string | null; startedAt?: number | null };
  const d = (s: State, p: P) =>
    (
      policy as { decide: (s: State, p: P) => { state: State; action: string; status: string } }
    ).decide(s, p);
  const MIN = 60_000;

  it('без /live дольше 5 минут от запуска — снят, stage=start; до предела — нет', () => {
    let s = initialState();
    let r = d(s, { now: 4 * MIN, live: false, proc: 'p', startedAt: 0 });
    expect(r.action).toBe('none');
    s = r.state;
    r = d(s, { now: 5 * MIN, live: false, proc: 'p', startedAt: 0 });
    expect(r.action).toBe('kill');
    expect(r.status).toContain('stage=start');
  });

  it('записи обёртки нет или она о другом процессе — предела запуска нет', () => {
    const r1 = d(initialState(), { now: 60 * MIN, live: false, proc: 'p', startedAt: null });
    expect(r1.action).toBe('none');
  });

  it('первый /live — обычное правило: дальше считаются отказы, а не предел запуска', () => {
    let r = d(initialState(), { now: 2_000, live: true, proc: 'p', startedAt: 0 });
    expect(r.status).toContain('startup=2.0s');
    r = d(r.state, { now: 10 * MIN, live: false, proc: 'p', startedAt: 0 });
    expect(r.action).toBe('none');
  });

  it('общий счёт с W23: два зависания в работе и одно при запуске — четвёртое останавливает', () => {
    let s = initialState();
    let t = 0;
    for (const id of ['a', 'b']) {
      s = d(s, { now: t, live: true, proc: id, startedAt: t }).state;
      for (let i = 1; i <= 3; i += 1)
        s = d(s, { now: t + i * 5_000, live: false, proc: id, startedAt: t }).state;
      t += MIN;
    }
    const start = d(s, { now: t + 5 * MIN, live: false, proc: 'c', startedAt: t });
    expect(start.action).toBe('kill');
    t += 6 * MIN;
    const fourth = d(start.state, { now: t + 5 * MIN, live: false, proc: 'd', startedAt: t });
    expect(fourth.action).toBe('none');
    expect(fourth.status).toContain('recovery=stopped');
    expect(fourth.status).toContain('stage=start');
  });
});
