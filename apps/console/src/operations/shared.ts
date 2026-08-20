import type { FormValues, OperationField } from '../types';

/**
 * Помощники разбора значений формы.
 *
 * Форма всегда отдаёт строки — а контракты требуют чисел, булевых значений и
 * объектов. Приведение собрано здесь, чтобы каждая операция не повторяла его и
 * не расходилась в мелочах: пустая строка в необязательном поле должна стать
 * `undefined`, а не `''` (сервер отвергает `''` там, где поле можно опустить).
 */

export function str(values: FormValues, name: string): string {
  const value = values[name];
  if (value === undefined || value === null) return '';
  // Файл в текстовом поле — почти наверняка ошибка описания операции. Молчаливое
  // приведение дало бы в запросе строку «[object File]», которую пришлось бы
  // искать глазами в теле запроса.
  if (value instanceof File) throw new Error(`Поле «${name}»: ожидалась строка, а не файл`);
  return String(value);
}

/** Выбранный файл. `undefined`, если пользователь ничего не приложил. */
export function fileValue(values: FormValues, name: string): File | undefined {
  const value = values[name];
  return value instanceof File ? value : undefined;
}

/** Необязательная строка: пустое поле означает «не передавать». */
export function optionalStr(values: FormValues, name: string): string | undefined {
  const value = str(values, name).trim();
  return value === '' ? undefined : value;
}

export function num(values: FormValues, name: string): number {
  const value = Number(str(values, name));
  if (!Number.isFinite(value)) throw new Error(`Поле «${name}»: нужно число`);
  return value;
}

export function optionalNum(values: FormValues, name: string): number | undefined {
  const raw = str(values, name).trim();
  if (raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Поле «${name}»: нужно число`);
  return value;
}

/**
 * Денежная сумма.
 *
 * В контрактах деньги — СТРОКА («12500.00»), а не число: двоичное `number` не
 * представляет копейки точно, и округление накапливается в расчётах комиссии.
 * Поле формы при этом числовое — так удобнее вводить, — поэтому приведение к
 * строке живёт здесь, в одном месте, а не в каждой операции по-своему.
 */
export function money(values: FormValues, name: string): string {
  const raw = str(values, name).trim().replace(',', '.');
  if (raw === '') throw new Error(`Поле «${name}»: сумма обязательна`);
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(raw)) {
    throw new Error(`Поле «${name}»: до 12 цифр целой части и не более 2 знаков после точки`);
  }
  return raw;
}

export function optionalMoney(values: FormValues, name: string): string | undefined {
  return str(values, name).trim() === '' ? undefined : money(values, name);
}

export function bool(values: FormValues, name: string): boolean {
  return values[name] === true || values[name] === 'true';
}

/**
 * Разбор поля со свободным JSON.
 *
 * Сообщение об ошибке намеренно подробное: неверная запятая в объекте условий
 * иначе выглядит как отказ сервера, и разбираться начинают не с той стороны.
 */
export function jsonValue(values: FormValues, name: string, fallback: unknown = {}): unknown {
  const raw = str(values, name).trim();
  if (raw === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Поле «${name}»: не разбирается как JSON — ${error instanceof Error ? error.message : 'ошибка разбора'}`,
      // Исходная ошибка сохраняется: без неё в консоли браузера теряется
      // позиция, на которой разбор споткнулся.
      { cause: error },
    );
  }
}

/**
 * Ключ идемпотентности.
 *
 * Денежные и регулируемые мутации требуют его по контракту. В консоли он
 * генерируется автоматически, но остаётся ВИДИМЫМ полем: половина смысла
 * идемпотентности — повторить запрос с тем же ключом и увидеть тот же результат
 * вместо второй записи. Спрятанный ключ такую проверку сделать не позволяет.
 */
export function idempotencyKey(prefix: string): string {
  const random = crypto.randomUUID().replaceAll('-', '').slice(0, 20);
  return `${prefix}-${random}`;
}

export function idempotencyField(prefix: string): OperationField {
  return {
    name: 'idempotencyKey',
    label: 'Ключ идемпотентности',
    kind: 'text',
    required: true,
    defaultValue: idempotencyKey(prefix),
    help: 'Повтори запрос с ТЕМ ЖЕ ключом — сервер обязан вернуть прежний результат, а не создать второй объект.',
  };
}

/** Поле идентификатора: подхватывается из блокнота по имени. */
export function idField(
  name: string,
  label: string,
  help = 'Подставляется из блокнота автоматически, если объект уже создавался в этом прогоне.',
): OperationField {
  return { name, label, kind: 'text', required: true, help };
}

export const LOCALE_OPTIONS = [
  { value: 'ru-RU', label: 'ru-RU' },
  { value: 'en-US', label: 'en-US' },
];

export const CURRENCY_OPTIONS = [{ value: 'RUB', label: 'RUB' }];

export const PROJECT_STAGE_OPTIONS = [
  { value: 'idea', label: 'idea — идея' },
  { value: 'mvp', label: 'mvp — прототип' },
  { value: 'early_revenue', label: 'early_revenue — первая выручка' },
  { value: 'growth', label: 'growth — рост' },
];
