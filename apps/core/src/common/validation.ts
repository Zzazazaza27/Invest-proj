import { z } from 'zod';
import { errors } from './errors';

/**
 * Валидация входа на границе.
 *
 * Три вещи, которые здесь принципиальны:
 *  - неизвестные поля отвергаются (`strict`), а не игнорируются: молчаливое
 *    отбрасывание скрывает и опечатки клиента, и попытку протащить лишнее;
 *  - сообщения об ошибках описывают ПОЛЯ ЗАПРОСА, а не внутреннюю модель;
 *  - результат — типизированное значение, дальше по коду `unknown` не ходит.
 *
 * Строгость применяется ЗДЕСЬ, а не в самих контрактах: пакет контрактов
 * используют и клиенты, которым полезно принимать ответ сервера с полями из
 * более новой версии API. Жёсткость нужна на входе сервера, и только на нём.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  // Глубина проверяется ДО разбора схемой: рекурсивный обход глубоко
  // вложенного JSON стоит стека, а лимит тела (1 МБ) от этого не защищает —
  // 1 МБ вложенных массивов даёт десятки тысяч уровней. Проверка была
  // написана, обещана комментарием и НЕ вызывалась ни разу (INFO аудита №2).
  assertDepth(input);
  const effective = schema instanceof z.ZodObject ? strict(schema) : schema;
  const result = effective.safeParse(input);
  if (result.success) {
    assertNothingDropped(input, result.data);
    return result.data as T;
  }

  throw errors.validation(
    result.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : '(корень)',
      message: issue.message,
    })),
  );
}

/**
 * Делает объектную схему строгой.
 *
 * zod по умолчанию отбрасывает лишние ключи молча. Для API это плохо: клиент,
 * отправивший `amout` вместо `amount`, получит 200 и неверный результат.
 *
 * ВАЖНО: `.strict()` в zod действует ТОЛЬКО на верхний уровень. Комментарий
 * здесь долго обещал рекурсию, которой не было: вложенный объект по-прежнему
 * молча терял неизвестные ключи. Найдено живым прогоном поддержки (Ф61):
 * `context: { cookie: '…' }` принимался ответом 201, хотя поля `cookie` в
 * схеме нет. Рекурсию доделывает `assertNothingDropped` ниже.
 */
export function strict<T extends z.ZodObject<z.ZodRawShape>>(schema: T): T {
  return schema.strict() as unknown as T;
}

/**
 * Ни одно поле входа не должно исчезнуть при разборе.
 *
 * Проверка сравнивает ВХОД с РЕЗУЛЬТАТОМ, а не разбирает схему. Так она не
 * зависит ни от версии zod, ни от того, какими комбинаторами описан конкретный
 * контракт: любое поле, которое схема отбросила молча, видно как ключ, который
 * был во входе и не дошёл до результата.
 *
 * Условие корректности у такого способа одно: контракты не должны менять форму
 * данных при разборе (`.transform()`, `.pipe()`), иначе легальное изменение
 * выглядело бы потерей. Преобразований в `@unicorn/contracts` нет — пакет
 * описывает форму, а не преобразует её; это его заявленное свойство.
 *
 * Обратное направление (ключ есть в результате, но не во входе) не ошибка:
 * так работают значения по умолчанию.
 */
export function assertNothingDropped(input: unknown, parsed: unknown, path: string[] = []): void {
  if (Array.isArray(input)) {
    if (!Array.isArray(parsed)) return;
    for (let i = 0; i < input.length && i < parsed.length; i += 1) {
      assertNothingDropped(input[i], parsed[i], [...path, String(i)]);
    }
    return;
  }
  if (input === null || typeof input !== 'object') return;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;

  const kept = parsed as Record<string, unknown>;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(key in kept)) {
      const where = [...path, key].join('.');
      throw errors.validation([{ path: where, message: 'неизвестное поле' }]);
    }
    assertNothingDropped(value, kept[key], [...path, key]);
  }
}

/** Ограничение размера тела запроса. Больше — отказ до разбора JSON. */
export const MAX_BODY_BYTES = 1024 * 1024; // 1 МБ

/**
 * Ограничение глубины вложенности JSON.
 *
 * Глубоко вложенный объект — дешёвый способ занять процессор на разборе и
 * на любой рекурсивной обработке.
 */
export const MAX_JSON_DEPTH = 20;

export function assertDepth(value: unknown, max = MAX_JSON_DEPTH, depth = 0): void {
  if (depth > max) {
    throw errors.validation([{ path: '(корень)', message: `превышена вложенность ${max}` }]);
  }
  if (Array.isArray(value)) {
    for (const item of value) assertDepth(item, max, depth + 1);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) assertDepth(item, max, depth + 1);
  }
}
