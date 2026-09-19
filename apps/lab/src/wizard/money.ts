/**
 * Разбор суммы, введённой человеком (замечание ручного прохода 5.7).
 *
 * Поле суммы раньше отправляло на сервер ровно то, что оказалось в строке:
 * быстрый ввод поверх старого значения давал `3500000.003500000`, сервер
 * отвечал ошибкой, а введённое пропадало. Здесь — единственное место, где
 * человеческая запись превращается в формат контракта (`MoneyAmountSchema`:
 * до 12 цифр целой части, точка, не более двух знаков).
 *
 * Разрешены привычные записи: пробелы-разделители тысяч (включая неразрывные)
 * и запятая как разделитель копеек. Всё остальное — ошибка у поля, а не тихое
 * «исправление»: сумма никогда не превращается молча в другую сумму, а
 * нормализованный вид сразу показывается в поле, чтобы замена была видна.
 *
 * Серверная проверка остаётся на месте: это подсказка, а не защита.
 */

export type MoneyParse = { ok: true; value: string | null } | { ok: false; error: string };

/**
 * Пробелы-разделители тысяч. `\s` в JS — это вся категория пробельных,
 * включая неразрывный и узкий неразрывный, которые подставляет копирование
 * из таблиц; отдельно перечислять их не нужно.
 */
const SPACES = /\s+/g;

export const MONEY_ERRORS = {
  chars: 'Только цифры: 1 000 000 или 1000000,50. Другие знаки не принимаются.',
  separators: 'Разделитель копеек один — точка или запятая: 1000000.50.',
  fraction: 'Копейки — не больше двух знаков: 1000000.50.',
  tooBig: 'Слишком большая сумма: до 12 цифр в целой части.',
  notPositive: 'Сумма должна быть больше нуля.',
} as const;

/**
 * Разбирает введённое значение.
 *
 * `allowZero` — для поля «уже подтверждено»: ноль там осмыслен, в сумме
 * раунда и чеках — нет (контракт требует положительную сумму).
 */
export function parseMoneyInput(raw: string, allowZero = false): MoneyParse {
  const compact = raw.replace(SPACES, '');
  if (compact === '') return { ok: true, value: null };

  const unified = compact.replace(/,/g, '.');
  if (!/^[0-9.]+$/.test(unified)) return { ok: false, error: MONEY_ERRORS.chars };
  const dots = unified.split('.').length - 1;
  if (dots > 1) return { ok: false, error: MONEY_ERRORS.separators };

  const parts = unified.split('.');
  const whole = parts[0] ?? '';
  const fraction = parts[1] ?? '';
  if (fraction.length > 2) return { ok: false, error: MONEY_ERRORS.fraction };

  // Ведущие нули — не ошибка ввода, а запись: 0001000 это тысяча; запись
  // «,50» без целой части — половина рубля.
  const normalizedWhole = (whole === '' ? '0' : whole).replace(/^0+(?=\d)/, '');
  if (normalizedWhole.length > 12) return { ok: false, error: MONEY_ERRORS.tooBig };

  const value = fraction === '' ? normalizedWhole : `${normalizedWhole}.${fraction}`;
  if (!allowZero && Number(value) <= 0) return { ok: false, error: MONEY_ERRORS.notPositive };
  return { ok: true, value };
}
