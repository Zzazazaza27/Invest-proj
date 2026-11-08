import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Features, GroupStatus } from '@fifth/contracts';
import {
  REQUEST_HOLD_MS,
  currentFilesAvailability,
  noteGroupError,
  refreshFiles,
  resetFilesAvailability,
} from '../src/availability';

/**
 * Отказ конкретного запроса не теряется исправной сводкой (4.11, замечание Тэнка 08.11):
 * files.write/circuit_open от обслуживающего экземпляра, затем сводка «доступна» — запись
 * всё равно закрыта и причина видна, пока не истечёт срок удержания.
 */
const available: GroupStatus = {
  state: 'available',
  read: { allowed: true, reason: 'ok', observedAt: '2026-11-08T12:00:00.000Z' },
  write: { allowed: true, reason: 'ok', observedAt: '2026-11-08T12:00:00.000Z' },
};
const features = (files: GroupStatus) => async () => ({ groups: { files } }) as unknown as Features;
const circuitOpen = {
  code: 'group_unavailable',
  problem: { errors: [{ path: 'files.write', message: 'circuit_open' }] },
};

beforeEach(() => {
  vi.useFakeTimers();
  resetFilesAvailability();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Отказ запроса и сводка «Файлов»', () => {
  it('исправная сводка не отменяет отказ конкретного запроса', async () => {
    noteGroupError(circuitOpen);
    await refreshFiles(features(available));
    const now = currentFilesAvailability();
    expect(now.canWrite).toBe(false);
    expect(now.canRead).toBe(true);
    expect(now.status).toMatchObject({
      state: 'read_only',
      write: { allowed: false, reason: 'circuit_open' },
    });
  });

  it('по истечении удержания решает снова сводка', async () => {
    noteGroupError(circuitOpen);
    await refreshFiles(features(available));
    vi.advanceTimersByTime(REQUEST_HOLD_MS + 100);
    expect(currentFilesAvailability().canWrite).toBe(true);
  });

  it('отказ чтения закрывает чтение; другие ошибки не запоминаются', async () => {
    noteGroupError({ code: 'validation_failed' });
    expect(currentFilesAvailability().status).toBeNull();
    noteGroupError({
      code: 'group_unavailable',
      problem: { errors: [{ path: 'files.read', message: 'dependency_failure' }] },
    });
    await refreshFiles(features(available));
    expect(currentFilesAvailability()).toMatchObject({ canRead: false, canWrite: true });
    expect(currentFilesAvailability().status?.state).toBe('unavailable');
  });
});
