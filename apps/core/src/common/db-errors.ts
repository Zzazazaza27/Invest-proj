import { AppError, errors } from './errors';

/**
 * Перевод отказов политики БД в доменную ошибку.
 *
 * Отказ RLS (42501) — это «нельзя», а не внутренняя ошибка: наружу он уходит
 * 403, а не 500. Прочие ошибки пробрасываются как есть.
 */
export async function mapDbErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError) throw error;
    if ((error as { code?: string }).code === '42501') {
      throw errors.forbidden({ stage: 'db-policy' });
    }
    throw error;
  }
}
