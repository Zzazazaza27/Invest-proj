import { z } from 'zod';
import { boundedString, IsoDateTimeSchema, UuidSchema } from '../common/primitives';

/**
 * Контент публичной витрины.
 *
 * Тексты лендинга и баннеры раньше были зашиты в исходники фронтенда, и правка
 * формулировки требовала выкладки. Часть этих текстов — публичные утверждения
 * оператора, поэтому у них должны быть и версия, и автор, и история: витрина
 * может быть переписана целиком, а сказанное на ней — нет (M048).
 */

/**
 * Место на странице, куда встаёт блок.
 *
 * Перечисление, а не свободная строка: ключ связывает содержимое с вёрсткой, и
 * опечатка означала бы молча пустое место на публичной странице.
 */
export const LandingBlockKeySchema = z.enum([
  'hero_title',
  'hero_subtitle',
  'hero_cta',
  'about',
  'for_founders',
  'for_investors',
  'disclaimer',
  'banner_primary',
  'banner_secondary',
]);
export type LandingBlockKey = z.infer<typeof LandingBlockKeySchema>;

export const LandingLocaleSchema = z.enum(['ru-RU', 'en-US']);
export type LandingLocale = z.infer<typeof LandingLocaleSchema>;

export const LandingBlockSchema = z.object({
  id: UuidSchema,
  key: LandingBlockKeySchema,
  locale: LandingLocaleSchema,
  title: z.string().nullable(),
  body: z.string(),
  linkUrl: z.string().nullable(),
  validFrom: IsoDateTimeSchema,
  validTo: IsoDateTimeSchema.nullable(),
});
export type LandingBlock = z.infer<typeof LandingBlockSchema>;

export const LandingContentSchema = z.object({
  locale: LandingLocaleSchema,
  blocks: z.array(LandingBlockSchema),
});
export type LandingContent = z.infer<typeof LandingContentSchema>;

/**
 * Публикация новой версии блока.
 *
 * Предыдущая версия закрывается тем же действием: двух действующих версий
 * одного блока быть не может, и это обеспечивается индексом в БД, а не
 * аккуратностью вызывающего.
 */
export const PublishLandingBlockSchema = z.object({
  key: LandingBlockKeySchema,
  locale: LandingLocaleSchema.default('ru-RU'),
  title: boundedString(1, 300).nullable().optional(),
  body: boundedString(1, 8000),
  /** Только https: текст попадает на публичную страницу как есть. */
  linkUrl: z.url().startsWith('https://').max(2000).nullable().optional(),
  /** Основание правки — попадает в журнал вместе с автором. */
  reason: boundedString(3, 500),
});
export type PublishLandingBlock = z.infer<typeof PublishLandingBlockSchema>;

/** Снятие блока с витрины без замены. */
export const WithdrawLandingBlockSchema = z.object({
  reason: boundedString(3, 500),
});
export type WithdrawLandingBlock = z.infer<typeof WithdrawLandingBlockSchema>;
