import { z } from 'zod';

/**
 * Keyset-пагинация (курсор), а не offset.
 *
 * Offset на больших каталогах даёт и деградацию плана запроса, и «дребезг»:
 * при вставке новых листингов пользователь видит одни и те же карточки на
 * разных страницах. Курсор непрозрачен для клиента — это позиция, а не смещение.
 */

export const CursorSchema = z.string().min(1).max(512);

export const PageQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

export function pageResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    /** Курсор следующей страницы. null — данных больше нет. */
    nextCursor: CursorSchema.nullable(),
    /**
     * Приблизительное общее количество. Отсутствует там, где точный подсчёт
     * дороже пользы: обещать точность и не давать её — хуже, чем не обещать.
     */
    estimatedTotal: z.number().int().nonnegative().optional(),
  });
}

export type PageResponse<T> = {
  items: T[];
  nextCursor: string | null;
  estimatedTotal?: number;
};

/** Сортировка каталога — фиксированный allowlist, а не произвольное поле. */
export const CatalogSortSchema = z
  .enum(['listed_at_desc', 'ask_asc', 'ask_desc', 'irs_desc', 'relevance'])
  .default('listed_at_desc');
export type CatalogSort = z.infer<typeof CatalogSortSchema>;
