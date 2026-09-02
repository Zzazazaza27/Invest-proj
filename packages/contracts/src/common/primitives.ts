import { z } from 'zod';

/**
 * Базовые примитивы контрактов.
 *
 * Эти схемы валидируют вход НА ГРАНИЦЕ и на сервере, и на клиенте. Сервер —
 * источник правды: клиентская проверка нужна для UX, но её отсутствие ничего
 * не должно ломать в безопасности (ADR-002).
 */

// ---------------------------------------------------------------- идентификаторы

/** UUID любой версии. Формат проверяется, версия — нет: id приходят и извне. */
export const UuidSchema = z.uuid();
export type Uuid = z.infer<typeof UuidSchema>;

/**
 * Генератор UUIDv7 (RFC 9562).
 *
 * 48 бит — unix-время в мс, затем 12 бит счётчика внутри одной миллисекунды
 * (обеспечивает монотонность при быстрой генерации), остальное — CSPRNG.
 * Монотонность важна: id используются как ключи с временной локальностью,
 * и «прыжки назад» ломают локальность индексов B-tree.
 */
let lastTimestampMs = 0;
let intraMsCounter = 0;

export function uuidv7(): string {
  const now = Date.now();
  if (now === lastTimestampMs) {
    intraMsCounter = (intraMsCounter + 1) & 0x0fff;
  } else {
    lastTimestampMs = now;
    intraMsCounter = 0;
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // 48 бит времени
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  // версия 7 + старшие 4 бита счётчика
  bytes[6] = 0x70 | ((intraMsCounter >> 8) & 0x0f);
  bytes[7] = intraMsCounter & 0xff;
  // вариант RFC 4122
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --------------------------------------------------------------------- деньги

/**
 * Денежная сумма. Строка, а не number: IEEE-754 не представляет 0.1 точно, а
 * округление копеек в вознаграждении ОИП — не та вещь, которую можно доверить
 * плавающей точке. В БД это NUMERIC(14,2).
 */
export const MoneyAmountSchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'сумма: до 12 цифр целой части и не более 2 знаков после точки')
  .refine((v) => Number(v) > 0, 'сумма должна быть положительной');
export type MoneyAmount = z.infer<typeof MoneyAmountSchema>;

/** Launch v1 работает только в рублях (docs/architecture/Database_Launch.md §1). */
export const CurrencySchema = z.literal('RUB');
export type Currency = z.infer<typeof CurrencySchema>;

export const MoneySchema = z.object({
  amount: MoneyAmountSchema,
  currency: CurrencySchema,
});
export type Money = z.infer<typeof MoneySchema>;

/** Копейки как целое — для арифметики без потерь. */
export function toMinorUnits(amount: MoneyAmount): bigint {
  const [whole = '0', fraction = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
}

export function fromMinorUnits(minor: bigint): MoneyAmount {
  const sign = minor < 0n ? '-' : '';
  const abs = minor < 0n ? -minor : minor;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

// --------------------------------------------------------------------- время

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

// -------------------------------------------------------------------- прочее

export const LocaleSchema = z.enum(['ru-RU', 'en-US']).default('ru-RU');
export const CountryCodeSchema = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2');

/**
 * Строка, приходящая от пользователя. Ограничение длины — не косметика:
 * без него тело запроса становится вектором отказа в обслуживании.
 */
export const boundedString = (min: number, max: number) => z.string().trim().min(min).max(max);

/** Заголовок идемпотентности для денежных и регулируемых мутаций. */
export const IdempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'допустимы латиница, цифры и . _ : -');
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
