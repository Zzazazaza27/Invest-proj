import { z } from 'zod';
import {
  boundedString,
  CountryCodeSchema,
  CurrencySchema,
  IsoDateTimeSchema,
  MoneyAmountSchema,
  UuidSchema,
} from '../common/primitives.ts';

export const ProjectStageSchema = z.enum(['idea', 'mvp', 'early_revenue', 'growth']);
export type ProjectStage = z.infer<typeof ProjectStageSchema>;

/** Статус проекта в воронке. `graduated` — выпускник, точка входа Capital. */
export const ProjectStatusSchema = z.enum([
  'draft',
  'submitted',
  'ai_review',
  'expert_review',
  'bootcamp',
  'finalist',
  'graduated',
  'rejected',
  'archived',
]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

/** Статус листинга. НЕ путать со статусом проекта: это разные оси. */
export const ListingStatusSchema = z.enum([
  'not_listed',
  'listed',
  'suspended_billing',
  'unlisted',
]);
export type ListingStatus = z.infer<typeof ListingStatusSchema>;

export const MaterialTypeSchema = z.enum(['deck', 'video', 'doc', 'product_link']);

export const TaxonomyNodeSchema = z.object({
  id: UuidSchema,
  parentId: UuidSchema.nullable(),
  slug: z.string(),
  nameRu: z.string(),
  nameEn: z.string().nullable(),
});
export type TaxonomyNode = z.infer<typeof TaxonomyNodeSchema>;

/**
 * Заявка проекта. `investmentAsk` обязателен: именно он определяет тариф
 * (Architect_Launch.md §5.1). Тариф резолвится СЕРВЕРОМ — клиент его не выбирает.
 */
export const CreateProjectRequestSchema = z.object({
  title: boundedString(2, 200),
  tagline: boundedString(0, 300).optional(),
  description: boundedString(0, 20_000).optional(),
  stage: ProjectStageSchema,
  taxonomyId: UuidSchema,
  geoCountry: CountryCodeSchema.optional(),
  geoRegion: boundedString(0, 120).optional(),
  investmentAsk: MoneyAmountSchema,
  askCurrency: CurrencySchema,
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const UpdateProjectRequestSchema = CreateProjectRequestSchema.partial();
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;

/**
 * Тизер — то, что видно БЕЗ авторизации и без подписки.
 * Состав полей — явный allowlist, зеркало `lab.v_public_catalog`.
 */
export const ProjectTeaserSchema = z.object({
  id: UuidSchema,
  title: z.string(),
  tagline: z.string().nullable(),
  stage: ProjectStageSchema,
  taxonomyId: UuidSchema.nullable(),
  geoCountry: CountryCodeSchema.nullable(),
  investmentAsk: z.string(),
  askCurrency: CurrencySchema,
  listedAt: IsoDateTimeSchema.nullable(),
});
export type ProjectTeaser = z.infer<typeof ProjectTeaserSchema>;

/** Полная карточка — только владельцу, эксперту по назначению и инвестору с подпиской. */
export const ProjectFullSchema = ProjectTeaserSchema.extend({
  description: z.string().nullable(),
  geoRegion: z.string().nullable(),
  status: ProjectStatusSchema,
  listingStatus: ListingStatusSchema,
  seasonId: UuidSchema.nullable(),
  requiredPlanId: UuidSchema.nullable(),
  currentVersionId: UuidSchema.nullable(),
  irs: z.number().min(0).max(100).nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ProjectFull = z.infer<typeof ProjectFullSchema>;

export const CatalogFilterSchema = z.object({
  q: boundedString(0, 200).optional(),
  taxonomyId: UuidSchema.optional(),
  stage: ProjectStageSchema.optional(),
  geoCountry: CountryCodeSchema.optional(),
  askMin: MoneyAmountSchema.optional(),
  askMax: MoneyAmountSchema.optional(),
});
export type CatalogFilter = z.infer<typeof CatalogFilterSchema>;

/**
 * Запрос на загрузку материала. Файл идёт напрямую в S3 по presigned URL —
 * через API не проходит: иначе он становится и узким местом, и точкой,
 * где недоверенный контент касается прикладного процесса.
 */
export const RequestUploadSchema = z.object({
  projectId: UuidSchema,
  type: MaterialTypeSchema.exclude(['product_link']),
  fileName: boundedString(1, 255),
  contentType: z.enum([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'video/mp4',
    'image/png',
    'image/jpeg',
  ]),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(500 * 1024 * 1024, 'максимум 500 МБ'),
});
export type RequestUpload = z.infer<typeof RequestUploadSchema>;

export const UploadTicketSchema = z.object({
  materialId: UuidSchema,
  uploadUrl: z.url(),
  /** Заголовки, обязательные к отправке вместе с файлом. */
  requiredHeaders: z.record(z.string(), z.string()),
  expiresAt: IsoDateTimeSchema,
});
export type UploadTicket = z.infer<typeof UploadTicketSchema>;

/** Внешняя ссылка на продукт: только https, без приватных адресов (SSRF). */
export const AddProductLinkSchema = z.object({
  projectId: UuidSchema,
  url: z
    .url()
    .refine((u) => u.startsWith('https://'), 'только https')
    .refine(
      (u) =>
        !/^https:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[::1\]|metadata\.)/i.test(
          u,
        ),
      'внутренние и метаданные-адреса недопустимы',
    ),
});
export type AddProductLink = z.infer<typeof AddProductLinkSchema>;

export const PublishListingRequestSchema = z.object({
  projectId: UuidSchema,
});
