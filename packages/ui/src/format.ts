/**
 * Представление чисел и денег.
 *
 * Пакет `@fifth/ui` намеренно не знает доменных типов, и это правило здесь не
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

/**
 * Оценка по стобалльной шкале в понятном виде: `25.18` → `3/10`.
 *
 * Сервер считает оценки от 0 до 100 с сотыми — это внутренняя точность модели,
 * и показывать её человеку значит обещать различие, которого нет: «25.18»
 * читается как измерение, хотя это результат эвристики с широким интервалом
 * уверенности. Десятибалльная шкала честнее: она сразу говорит, что оценка
 * грубая, и её не с чем спутать.
 */
export function formatScore10(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return '—';
  const clamped = Math.min(100, Math.max(0, numeric));
  return `${Math.round(clamped / 10)}/10`;
}
