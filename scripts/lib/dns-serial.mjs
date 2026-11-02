/**
 * Следующая версия зоны (SOA serial) для схемы «скрытый первичный +
 * вторичные» (план docs/architecture/dns-independence-plan.md).
 *
 * Вторичные забирают зону, только если serial вырос. Поэтому новая версия —
 * не просто текущее время, а строго больше любой уже опубликованной:
 *   - две выкладки в одну секунду дают разные версии;
 *   - часы, переведённые назад, не дают меньшую версию;
 *   - при восстановлении на другой машине учитываются последняя записанная
 *     версия и версии, которые сейчас отдают вторичные.
 * Основа — unixtime: при потере всех записей версия всё равно растёт.
 * Предел — 32 бита (RFC 1982); ближе к нему — отказ, а не тихий перенос.
 */
export const SERIAL_MAX = 2 ** 32 - 1;

/** Корректная опубликованная версия: целое в диапазоне 1..2^32-1. */
const valid = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isInteger(n) && n > 0 && n <= SERIAL_MAX ? n : null;
};

export function nextSerial({ nowMs = Date.now(), published = [] } = {}) {
  const known = published.map(valid).filter((n) => n !== null);
  const next = Math.max(Math.floor(nowMs / 1000), ...known.map((n) => n + 1));
  if (next > SERIAL_MAX) throw new Error(`serial ${next} выходит за 32 бита`);
  return next;
}
