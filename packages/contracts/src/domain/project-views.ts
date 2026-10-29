import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from '../common/primitives';
import { MaterialTypeSchema, ProjectTeaserSchema } from './lab';
import { AudienceSchema, ProjectVisibilitySchema } from './visibility';

/**
 * Представления проекта наружу (5.7.2).
 *
 * Собираются из аудитории предиката `lab.project_audience` по каждому
 * разрешению отдельно: блок включается по СВОЕМУ разрешению, а не по уровню
 * зрителя. Поля никогда не выше аудитории `investors`.
 *
 * С 2.1-W05 в карточке только данные самого проекта: ответы заявки, раунд и
 * паспорт удалены вместе с инвестиционным процессом и анализом ИИ.
 */

/** Для кого владелец смотрит предпросмотр. */
export const PreviewAudienceSchema = z.enum(['public', 'investors']);
export type PreviewAudience = z.infer<typeof PreviewAudienceSchema>;

/** Аудитория зрителя по каждому разрешению; `null` — блока нет. */
export const ViewAccessSchema = z.object({
  /** Описание и регион проекта. */
  profile: AudienceSchema.nullable(),
  materials: AudienceSchema.nullable(),
});
export type ViewAccess = z.infer<typeof ViewAccessSchema>;

export const ViewMaterialSchema = z.object({
  id: UuidSchema,
  type: MaterialTypeSchema,
  version: z.number().int().positive(),
  url: z.url().nullable(),
  /** Отметка владельца: `investors` — допущенным инвесторам; `public` — зарезервировано (7.2). */
  visibility: z.enum(['private', 'investors', 'public']),
  createdAt: IsoDateTimeSchema,
});
export type ViewMaterial = z.infer<typeof ViewMaterialSchema>;

/** Public View — `GET /catalog/:id`: тизер проекта. */
export const PublicViewSchema = ProjectTeaserSchema;
export type PublicView = z.infer<typeof PublicViewSchema>;

/** Investor View — тизер плюс блоки по своим разрешениям. */
export const InvestorViewSchema = PublicViewSchema.extend({
  /** Доступ выдан лично владельцем; `null` — доступ по режиму проекта. */
  grant: z.object({ grantedAt: IsoDateTimeSchema }).nullable(),
  access: ViewAccessSchema,
  description: z.string().nullable(),
  geoRegion: z.string().nullable(),
  materials: z.array(ViewMaterialSchema).nullable(),
});
export type InvestorView = z.infer<typeof InvestorViewSchema>;

/**
 * Кому открыт проект при данном режиме. Инвесторы — только лично выбранные:
 * допуск по роли держался на подписке, а подписки удалены (2.1-W05).
 */
export const AudienceSummarySchema = z.object({
  mode: ProjectVisibilitySchema,
  anonymous: z.boolean(),
  investors: z.enum(['never', 'selected']),
});
export type AudienceSummary = z.infer<typeof AudienceSummarySchema>;

export const ViewPreviewQuerySchema = z.object({
  audience: PreviewAudienceSchema.optional(),
});
export type ViewPreviewQuery = z.infer<typeof ViewPreviewQuerySchema>;

/** Предпросмотр владельца: что увидит выбранная аудитория при текущем режиме. */
export const ViewPreviewSchema = z.object({
  audience: PreviewAudienceSchema,
  /** `null` — аудитория проекта не видит вовсе. */
  view: InvestorViewSchema.nullable(),
  audienceSummary: AudienceSummarySchema,
});
export type ViewPreview = z.infer<typeof ViewPreviewSchema>;
