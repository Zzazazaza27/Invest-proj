import { describe, expect, it } from 'vitest';
import { Breaker, dependencyState, groupStatus, type Observation } from '../src/availability/rules';

/** Правила сведения доступности групп (4.11): модульно, без БД и хранилища. */
const now = new Date('2026-11-08T12:00:00Z');
const at = (sec: number) => new Date(now.getTime() + sec * 1000);
const obs = (o: Partial<Observation>): Observation => ({
  instance: 'core-1',
  mode: 'write',
  ok: true,
  reason: 'ok',
  observedAt: at(-10),
  validUntil: at(80),
  stopped: false,
  ...o,
});

describe('Сведение наблюдений по экземплярам', () => {
  it('нет наблюдений — «неизвестно», а не «доступна»', () => {
    expect(dependencyState([], 'write', now).health).toBe('unknown');
  });

  it('просроченное наблюдение не даёт доступности', () => {
    const d = dependencyState([obs({ validUntil: at(-1) })], 'write', now);
    expect(d).toMatchObject({ health: 'unknown', reason: 'observations_stale' });
  });

  it('остановленный экземпляр исключён, даже если наблюдение ещё не истекло', () => {
    expect(dependencyState([obs({ stopped: true })], 'write', now).health).toBe('unknown');
  });

  it('один свежий исправный экземпляр из двух — зависимость работает', () => {
    const d = dependencyState(
      [
        obs({ instance: 'core-1', ok: false, reason: 'dependency_failure' }),
        obs({ instance: 'core-2' }),
      ],
      'write',
      now,
    );
    expect(d.health).toBe('ok');
  });

  it('свежий отказ A и просроченное наблюдение необслуживающего B — «неизвестно», не отказ', () => {
    // B не остановлен: он может ещё обслуживать — отказ всех обслуживающих не подтверждён
    // (замечание Тэнка 08.11).
    const d = dependencyState(
      [
        obs({ instance: 'core-1', ok: false, reason: 'circuit_open' }),
        obs({ instance: 'core-2', observedAt: at(-100), validUntil: at(-5) }),
      ],
      'write',
      now,
    );
    expect(d).toMatchObject({ health: 'unknown', reason: 'observations_stale' });
  });

  it('молчащий сутки, но не остановленный B — по-прежнему «неизвестно»: возраст не доказывает исключения', () => {
    // B принимает запросы, но не сохраняет наблюдения (сбой фоновой задачи или записи).
    const d = dependencyState(
      [
        obs({ instance: 'core-1', ok: false, reason: 'circuit_open' }),
        obs({ instance: 'core-2', observedAt: at(-86_400), validUntil: at(-86_310) }),
      ],
      'write',
      now,
    );
    expect(d).toMatchObject({ health: 'unknown', reason: 'observations_stale' });
  });

  it('B подтверждённо остановлен — отказ A подтверждён', () => {
    const d = dependencyState(
      [
        obs({ instance: 'core-1', ok: false, reason: 'circuit_open' }),
        obs({ instance: 'core-2', stopped: true }),
      ],
      'write',
      now,
    );
    expect(d).toMatchObject({ health: 'fail', reason: 'circuit_open' });
  });

  it('исправность просроченного B не даёт доступности', () => {
    const d = dependencyState(
      [
        obs({ instance: 'core-1', ok: false, reason: 'dependency_failure' }),
        obs({ instance: 'core-2', observedAt: at(-100), validUntil: at(-5) }),
      ],
      'write',
      now,
    );
    expect(d.health).not.toBe('ok');
  });

  it('режимы сводятся раздельно', () => {
    const all = [
      obs({ mode: 'read' }),
      obs({ mode: 'write', ok: false, reason: 'dependency_failure' }),
    ];
    expect(dependencyState(all, 'read', now).health).toBe('ok');
    expect(dependencyState(all, 'write', now).health).toBe('fail');
  });
});

const ok = { health: 'ok' as const, reason: 'ok' as const, observedAt: at(-5) };
const fail = { health: 'fail' as const, reason: 'dependency_failure' as const, observedAt: at(-5) };
const unknown = {
  health: 'unknown' as const,
  reason: 'observations_stale' as const,
  observedAt: null,
};

describe('Итоговое состояние группы', () => {
  it('всё исправно — доступна', () => {
    expect(groupStatus({ read: ok, write: ok, restriction: null }).state).toBe('available');
  });

  it('запись отказала, чтение работает — только чтение, чтение разрешено', () => {
    const s = groupStatus({ read: ok, write: fail, restriction: null });
    expect(s.state).toBe('read_only');
    expect(s.read.allowed).toBe(true);
    expect(s.write).toMatchObject({ allowed: false, reason: 'dependency_failure' });
  });

  it('запись неизвестна — изменение вслепую не разрешено', () => {
    const s = groupStatus({ read: ok, write: unknown, restriction: null });
    expect(s.state).toBe('unknown');
    expect(s.write.allowed).toBe(false);
  });

  it('чтение неизвестно — разрешено, проверит себя само', () => {
    expect(groupStatus({ read: unknown, write: ok, restriction: null }).read.allowed).toBe(true);
  });

  it('ручное «только чтение» при исправной зависимости закрывает запись', () => {
    const s = groupStatus({ read: ok, write: ok, restriction: { mode: 'read_only' } });
    expect(s.state).toBe('read_only');
    expect(s.write).toMatchObject({ allowed: false, reason: 'manual_restriction' });
    expect(s.read.allowed).toBe(true);
  });

  it('ручной запрет закрывает и чтение; причина — безопасный код', () => {
    const s = groupStatus({ read: ok, write: ok, restriction: { mode: 'unavailable' } });
    expect(s.state).toBe('unavailable');
    expect(s.read.reason).toBe('manual_restriction');
  });

  it('продуктовый допуск выключен — ничего не разрешено', () => {
    const s = groupStatus({ read: ok, write: ok, restriction: null, productEnabled: false });
    expect(s.read.allowed || s.write.allowed).toBe(false);
  });
});

describe('Размыкатель в экземпляре', () => {
  const make = () => {
    let t = 0;
    const b = new Breaker({ failures: 3, windowMs: 60_000, openMs: 30_000 }, () => t);
    return { b, tick: (ms: number) => (t += ms) };
  };

  it('три технических отказа за минуту закрывают режим, другой режим не затронут', () => {
    const { b } = make();
    b.record('write', false);
    b.record('write', false);
    expect(b.isOpen('write')).toBe(false);
    b.record('write', false);
    expect(b.isOpen('write')).toBe(true);
    expect(b.isOpen('read')).toBe(false);
  });

  it('отказы вне окна не копятся; успех сбрасывает счёт', () => {
    const { b, tick } = make();
    b.record('write', false);
    tick(61_000);
    b.record('write', false);
    b.record('write', true);
    b.record('write', false);
    expect(b.isOpen('write')).toBe(false);
  });

  it('по истечении срока режим открывается; успешная проба закрывает досрочно', () => {
    const { b, tick } = make();
    for (let i = 0; i < 3; i += 1) b.record('read', false);
    tick(10_000);
    b.probe('read', true);
    expect(b.isOpen('read')).toBe(false);
    for (let i = 0; i < 3; i += 1) b.record('read', false);
    tick(30_001);
    expect(b.isOpen('read')).toBe(false);
  });
});
