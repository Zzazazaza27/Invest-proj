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
    });
    expect(containerRecord(base).recoveryStopped).toBe(false);
  });
});
