/**
 * Публичная готовность API (блок 2, 2.3): кабинет подтверждает ею восстановление после
 * общего отказа. Тот же расчёт, что у служебного `/ready` (обязательные зависимости и
 * состояние процесса), но наружу — только «готов / не готов», без состава проверок.
 *
 * Расчёт ограничен по времени самими проверками; повторные обращения чаще раза в секунду
 * получают последний результат — открытый маршрут не должен нагружать зависимости.
 */
let probe: (() => Promise<boolean>) | null = null;
let last: { at: number; ready: boolean } | null = null;
const MIN_INTERVAL_MS = 1_000;

export function setPublicReadiness(fn: () => Promise<boolean>): void {
  probe = fn;
  last = null;
}

export async function publicReady(now = Date.now()): Promise<boolean> {
  // До конца запуска (и в проверках без main) — не готов.
  if (!probe) return false;
  if (last && now - last.at < MIN_INTERVAL_MS) return last.ready;
  const ready = await probe().catch(() => false);
  last = { at: Date.now(), ready };
  return ready;
}
