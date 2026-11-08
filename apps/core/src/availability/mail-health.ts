import { Breaker } from './rules';

/**
 * Размыкатель группы «Почта» в этом экземпляре (4.11). Технический исход отправки сообщает
 * сам вызывающий транспорт: отказ канала (соединение, TLS, вход, 4xx) и неизвестный исход —
 * отказ; «принято релеем» и отказ по вине письма (получатель, текст) — канал работает.
 *
 * Пороги — общие с «Файлами»: AVAILABILITY_BREAKER_FAILURES, _WINDOW_MS, _OPEN_MS.
 */
let breaker: Breaker | null = null;

export function mailBreaker(): Breaker {
  breaker ??= new Breaker({
    failures: Number(process.env.AVAILABILITY_BREAKER_FAILURES ?? 3),
    windowMs: Number(process.env.AVAILABILITY_BREAKER_WINDOW_MS ?? 60_000),
    openMs: Number(process.env.AVAILABILITY_BREAKER_OPEN_MS ?? 30_000),
  });
  return breaker;
}

/** Для модульных проверок. */
export function resetMailBreaker(): void {
  breaker = null;
}
