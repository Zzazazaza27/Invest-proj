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

// ------------------------------------------------ продуктовые тексты (M079)

/**
 * Словарь и ЧАВО — записи со стабильным ключом и версионированными текстами
 * по языкам (план 0.2 §2.6). Поля записи задаёт пространство: у термина —
 * `term`, `short_md`, `full_md`; у вопроса ЧАВО — `question`, `answer_md`.
 * Тексты вопросов анкеты сюда не входят — они в документе конфигурации.
 */
export const TextNamespaceSchema = z.enum(['glossary', 'faq']);
export type TextNamespace = z.infer<typeof TextNamespaceSchema>;

export const TEXT_FIELDS: Record<TextNamespace, readonly string[]> = {
  glossary: ['term', 'short_md', 'full_md'],
  faq: ['question', 'answer_md'],
};

export const TextKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'ключ записи');
export const TextLocaleSchema = z.string().regex(/^[a-z]{2}-[A-Z]{2}$/, 'код языка');
const TextFieldSchema = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);

export const LanguageSchema = z.object({
  code: TextLocaleSchema,
  name: z.string(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
});
export type Language = z.infer<typeof LanguageSchema>;

/** Действующие тексты записи по языкам: `{ 'ru-RU': { term: '…', short_md: '…' } }`. */
export const TextBodiesSchema = z.record(TextLocaleSchema, z.record(TextFieldSchema, z.string()));

export const TextEntrySchema = z.object({
  id: UuidSchema,
  namespace: TextNamespaceSchema,
  key: TextKeySchema,
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  texts: TextBodiesSchema,
  updatedAt: IsoDateTimeSchema,
});
export type TextEntry = z.infer<typeof TextEntrySchema>;

/** Публичная выдача на языке с fallback на `ru-RU`; `missing` — пути без перевода. */
export const TextsResponseSchema = z.object({
  namespace: TextNamespaceSchema,
  locale: TextLocaleSchema,
  entries: z.array(
    z.object({
      key: TextKeySchema,
      sortOrder: z.number().int(),
      texts: z.record(TextFieldSchema, z.string()),
    }),
  ),
  missing: z.array(z.string()),
});
export type TextsResponse = z.infer<typeof TextsResponseSchema>;

/**
 * Сохранить запись: создаётся при отсутствии; изменившиеся тексты
 * публикуются новыми версиями с одним основанием; порядок и активность —
 * свойства записи. Пустая строка в поле закрывает действующую версию.
 */
export const UpsertTextEntrySchema = z.object({
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  isActive: z.boolean().optional(),
  texts: z.record(TextLocaleSchema, z.record(TextFieldSchema, z.string().max(20_000))).optional(),
  reason: boundedString(3, 500),
});
export type UpsertTextEntry = z.infer<typeof UpsertTextEntrySchema>;

export const TextVersionSchema = z.object({
  id: UuidSchema,
  locale: TextLocaleSchema,
  field: TextFieldSchema,
  body: z.string(),
  version: z.number().int().positive(),
  validFrom: IsoDateTimeSchema,
  validTo: IsoDateTimeSchema.nullable(),
  reason: z.string(),
});
export type TextVersion = z.infer<typeof TextVersionSchema>;
