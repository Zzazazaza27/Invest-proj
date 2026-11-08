import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setGuardOwner } from '../src/guarded-send';
import { createOwnedPendingStore, runOwnedPending } from '../src/owned-pending';

/**
 * Незавершённое подтверждение медиа принадлежит начавшему (2.6, замечание Тэнка к
 * 5611f26): A оставил неизвестный исход → B в той же вкладке его не видит и не отправляет →
 * при возвращении A проверяется прежний uploadId.
 */
interface Pending {
  uploadId: string;
  unresolved: boolean;
}
const slot = 'project-1:logo';
const keep = (v: Pending) => ({ ...v, unresolved: true });
let store = createOwnedPendingStore<Pending>();

beforeEach(() => {
  store = createOwnedPendingStore<Pending>();
  setGuardOwner(null);
});

describe('Незавершённое подтверждение — по владельцу', () => {
  it('A → неизвестный исход → B не видит и не отправляет → A проверяет прежний uploadId', async () => {
    setGuardOwner('A');
    store.set(slot, { uploadId: 'upload-A', unresolved: false });
    const lost = vi.fn(async () => {
      throw new Error('ответ потерян');
    });
    expect((await runOwnedPending(store, slot, lost, keep)).status).toBe('kept');

    setGuardOwner('B');
    expect(store.get(slot)).toBeUndefined();
    const sendB = vi.fn(async () => 'ok');
    expect((await runOwnedPending(store, slot, sendB, keep)).status).toBe('none');
    expect(sendB).not.toHaveBeenCalled();

    setGuardOwner('A');
    const sendA = vi.fn(async (v: Pending) => v.uploadId);
    const back = await runOwnedPending(store, slot, sendA, keep);
    expect(sendA).toHaveBeenCalledWith({ uploadId: 'upload-A', unresolved: true });
    expect(back).toEqual({ status: 'done', result: 'upload-A' });
    expect(store.get(slot)).toBeUndefined();
  });

  it('запоздавший ответ A после входа B — экран B не трогается, меняется только запись A', async () => {
    setGuardOwner('A');
    store.set(slot, { uploadId: 'upload-A', unresolved: false });
    let release!: () => void;
    const slow = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          release = () => reject(new Error('ответ потерян'));
        }),
    );
    const running = runOwnedPending(store, slot, slow, keep);
    setGuardOwner('B');
    store.set(slot, { uploadId: 'upload-B', unresolved: false });
    release();
    expect((await running).status).toBe('stale');
    // Запись B не тронута, запись A сохранена неразрешённой.
    expect(store.get(slot)).toEqual({ uploadId: 'upload-B', unresolved: false });
    setGuardOwner('A');
    expect(store.get(slot)).toEqual({ uploadId: 'upload-A', unresolved: true });
  });
});
