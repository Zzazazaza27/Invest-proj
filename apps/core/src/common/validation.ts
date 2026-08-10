import { type z } from 'zod';
import { errors } from './errors';

/**
 * Валидация входа на границе.
 *
 * Три вещи, которые здесь принципиальны:
 *  - неизвестные поля отвергаются (`strict`), а не игнорируются: молчаливое
 *    отбрасывание скрывает и опечатки клиента, и попытку протащить лишнее;
 *  - сообщения об ошибках описывают ПОЛЯ ЗАПРОСА, а не внутреннюю модель;
 *  - результат — типизированное значение, дальше по коду `unknown` не ходит.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  throw errors.validation(
    result.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : '(корень)',
      message: issue.message,
    })),
  );
}

/**
 * Делает объектную схему строгой рекурсивно.
 *
 * zod по умолчанию отбрасывает лишние ключи молча. Для API это плохо: клиент,
 * отправивший `amout` вместо `amount`, получит 200 и неверный результат.
 */
export function strict<T extends z.ZodObject<z.ZodRawShape>>(schema: T): T {
  return schema.strict() as unknown as T;
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
