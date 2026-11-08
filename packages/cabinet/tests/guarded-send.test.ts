import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardedMemory, makeRun, setGuardOwner } from '../src/guarded-send';

/**
 * Старый таймер автоматической проверки после смены владельца вкладки (2.6, замечание
 * Тэнка 08.11): A отправил → ответ потерян → назначена проверка → вошёл B → таймер
 * сработал. Ни ключ, ни содержимое A не должны уйти при активном B.
 */
function setup() {
  const name = 'A|lab.project.create';
  guardedMemory.set(name, { owner: 'A', key: 'key-of-A', payload: { title: 'проект A' }, at: 0 });
  const send = vi.fn().mockRejectedValue({ outcomeUnknown: true, code: 'dependency_unavailable' });
  const state = vi.fn().mockResolvedValue({ state: 'absent' });
  const run = makeRun({
    name,
    opts: {
      current: {
        scope: 'lab.project.create',
        operation: 'lab.project.create',
        send,
        state,
        onDone: vi.fn(),
        onResolved: vi.fn(),
        onFail: vi.fn(),
      },
    },
    timer: { current: null },
    finish: (slot) => guardedMemory.delete(slot),
    setPhase: vi.fn(),
    setPending: vi.fn(),
    setNote: vi.fn(),
  });
  return { send, state, run };
}

afterEach(() => {
  guardedMemory.clear();
  setGuardOwner(null);
  vi.useRealTimers();
});

describe('Защищённая отправка: владелец вкладки', () => {
  it('старый таймер после входа другого человека ничего не отправляет', async () => {
    vi.useFakeTimers();
    setGuardOwner('A');
    const { send, state, run } = setup();
    await run('first');
    expect(send).toHaveBeenCalledTimes(1);

    setGuardOwner('B');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(send).toHaveBeenCalledTimes(1);
    expect(state).not.toHaveBeenCalled();
  });

  it('без смены владельца тот же таймер проверяет — тест чувствителен', async () => {
    vi.useFakeTimers();
    setGuardOwner('A');
    const { send, run } = setup();
    await run('first');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[1]).toBe('key-of-A');
  });

  it('проверка кнопкой у чужой операции не начинается', async () => {
    setGuardOwner('A');
    const { send, state, run } = setup();
    setGuardOwner('B');
    await run('check');
    expect(send).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
  });
});
