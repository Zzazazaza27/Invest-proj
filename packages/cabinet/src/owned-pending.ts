import { getGuardOwner } from './guarded-send';

/**
 * Незавершённые операции вне компонента, РАЗДЕЛЁННЫЕ ПО ВЛАДЕЛЬЦУ (2.6).
 *
 * Запись принадлежит пользователю, который начал операцию: другой пользователь, вошедший в
 * ту же вкладку без перезагрузки, её не видит и не может отправить от своего имени. Когда A
 * вернётся, его запись снова доступна ему. Владелец — тот же, что у защищённой отправки
 * (`setGuardOwner`).
 */
export interface OwnedPendingStore<T> {
  /** Запись ТЕКУЩЕГО владельца или `undefined`. */
  get(slot: string): T | undefined;
  /** Сохранить для текущего владельца; возвращает владельца, под которым сохранено. */
  set(slot: string, value: T): string | null;
  /** Обновить запись указанного владельца (запоздавший обработчик пишет только в свою). */
  setFor(owner: string | null, slot: string, value: T): void;
  deleteFor(owner: string | null, slot: string): void;
  /** Текущий владелец вкладки. */
  owner(): string | null;
  clear(): void;
}

/**
 * Довести незавершённую операцию ТЕКУЩЕГО владельца. Владелец фиксируется до запроса:
 * запоздавший ответ меняет только запись того, кто операцию начал, а если вкладка за это
 * время перешла к другому пользователю — итог `stale`, и экран другого пользователя не
 * трогается.
 */
export type OwnedRunResult<R> =
  | { status: 'none' }
  | { status: 'done'; result: R }
  | { status: 'kept'; error: unknown }
  | { status: 'failed'; error: unknown }
  | { status: 'stale' };

export async function runOwnedPending<T, R>(
  store: OwnedPendingStore<T>,
  slot: string,
  send: (value: T) => Promise<R>,
  keepAfterError: (value: T, error: unknown) => T | null,
): Promise<OwnedRunResult<R>> {
  const owner = store.owner();
  const value = store.get(slot);
  if (value === undefined) return { status: 'none' };
  try {
    const result = await send(value);
    store.deleteFor(owner, slot);
    return store.owner() === owner ? { status: 'done', result } : { status: 'stale' };
  } catch (error) {
    const kept = keepAfterError(value, error);
    if (kept) store.setFor(owner, slot, kept);
    else store.deleteFor(owner, slot);
    if (store.owner() !== owner) return { status: 'stale' };
    return kept ? { status: 'kept', error } : { status: 'failed', error };
  }
}

export function createOwnedPendingStore<T>(): OwnedPendingStore<T> {
  const map = new Map<string, T>();
  const key = (owner: string | null, slot: string) => `${owner ?? '-'}|${slot}`;
  return {
    get: (slot) => map.get(key(getGuardOwner(), slot)),
    set: (slot, value) => {
      const owner = getGuardOwner();
      map.set(key(owner, slot), value);
      return owner;
    },
    setFor: (owner, slot, value) => map.set(key(owner, slot), value),
    deleteFor: (owner, slot) => map.delete(key(owner, slot)),
    owner: () => getGuardOwner(),
    clear: () => map.clear(),
  };
}
