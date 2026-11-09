/**
 * Ворота восстановленной среды (2.1.5, M167).
 *
 * Пока ворота закрыты — или строки ворот нет, как в базе, восстановленной из комплекта
 * копии, — ядро людей не обслуживает: 503 на всё, кроме проверок живости, и публичная
 * готовность «не готов». Открывает их только итоговая проверка применения журнала
 * удалений (`scripts/deletions-apply.mjs open`), а не код возврата отдельного шага.
 *
 * Состояние читается не чаще раза в 5 секунд. Ошибка чтения не открывает ворота:
 * остаётся последнее известное состояние, а до первого успешного чтения — закрыто.
 */
let reader: (() => Promise<'open' | 'closed'>) | null = null;
let last: { at: number; open: boolean } | null = null;
const TTL_MS = 5_000;

export function setRestoreGate(fn: (() => Promise<'open' | 'closed'>) | null): void {
  reader = fn;
  last = null;
}

export async function restoreGateOpen(now = Date.now()): Promise<boolean> {
  // Без чтения ворот (проверки без main) — ворот нет.
  if (!reader) return true;
  if (last && now - last.at < TTL_MS) return last.open;
  try {
    const open = (await reader()) === 'open';
    last = { at: now, open };
    return open;
  } catch {
    return last?.open ?? false;
  }
}

/** Маршруты, которые отвечают и при закрытых воротах: живость и готовность. */
export function passesClosedGate(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return path === '/v1/health' || path === '/v1/ready';
}
