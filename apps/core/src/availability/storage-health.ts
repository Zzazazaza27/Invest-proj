import type { GroupMode } from '@fifth/contracts';
import { Breaker } from './rules';

/**
 * Размыкатель группы «Файлы» в этом экземпляре (4.11). Один на процесс: о технических
 * отказах сообщает сам клиент хранилища (сеть, таймаут, 5xx), без участия операций.
 * Ответы 4xx — не отказ зависимости: это ответ хранилища о конкретном запросе.
 *
 * Пороги настраиваются: AVAILABILITY_BREAKER_FAILURES, _WINDOW_MS, _OPEN_MS.
 */
let breaker: Breaker | null = null;

export function storageBreaker(): Breaker {
  breaker ??= new Breaker({
    failures: Number(process.env.AVAILABILITY_BREAKER_FAILURES ?? 3),
    windowMs: Number(process.env.AVAILABILITY_BREAKER_WINDOW_MS ?? 60_000),
    openMs: Number(process.env.AVAILABILITY_BREAKER_OPEN_MS ?? 30_000),
  });
  return breaker;
}

export function storageMode(method: string): GroupMode {
  return method === 'GET' || method === 'HEAD' ? 'read' : 'write';
}

/** Для модульных проверок: новый размыкатель с текущими порогами. */
export function resetStorageBreaker(): void {
  breaker = null;
}
