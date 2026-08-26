/**
 * Представление чисел и денег.
 *
 * Пакет `@unicorn/ui` намеренно не знает доменных типов, и это правило здесь не
 * нарушается: группировка разрядов — свойство показа числа, а не смысла суммы.
 *
 * Деньги приходят с сервера строкой и строкой же остаются: `5000000.00` — это
 * точное значение NUMERIC, и превращать его в число значит округлять там, где
 * округлять нечем и незачем.
 *
 * Разделитель разрядов — неразрывный пробел, записанный последовательностью, а
 * не самим символом: невидимый символ в исходнике легко потерять при
 * копировании и невозможно заметить при чтении.
 */

const NBSP = ' ';

/** Сумма с разделителями разрядов: `5000000.00` → `5 000 000.00`. */
export function formatAmount(amount: string | number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  const raw = typeof amount === 'number' ? amount.toString() : amount;
  const [whole = '0', fraction] = raw.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = sign ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return fraction === undefined ? `${sign}${grouped}` : `${sign}${grouped}.${fraction}`;
}

/** Сумма с валютой: `5000000.00`, `RUB` → `5 000 000.00 RUB`. */
export function formatMoney(
  amount: string | number | null | undefined,
  currency?: string | null,
): string {
  const value = formatAmount(amount);
  if (value === '—' || !currency) return value;
  return `${value}${NBSP}${currency}`;
}
