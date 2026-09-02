import { z } from 'zod';
import {
  boundedString,
  CountryCodeSchema,
  CurrencySchema,
  IsoDateTimeSchema,
  MoneyAmountSchema,
  UuidSchema,
} from '../common/primitives';

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

/**
 * Движение проекта по воронке сезона.
 *
 * Вперёд — ровно на один этап: «перепрыгнуть» экспертизу и оказаться финалистом
 * нельзя, иначе отбор перестаёт что-либо означать. Назад хода нет — этап уже
 * объявлен участнику и внешним потребителям события.
 *
 * `rejected` доступен с любого рабочего этапа: отказ — это выход из воронки, а
 * не движение по ней. `archived` — только из терминальных состояний: архивация
 * живой заявки скрывала бы её от участника без решения по существу.
 */
export const PROJECT_TRANSITIONS: Record<ProjectStatus, readonly ProjectStatus[]> = {
  draft: ['submitted', 'archived'],
  submitted: ['ai_review', 'rejected'],
  ai_review: ['expert_review', 'rejected'],
  expert_review: ['bootcamp', 'rejected'],
  bootcamp: ['finalist', 'rejected'],
  finalist: ['graduated', 'rejected'],
  graduated: ['archived'],
  rejected: ['archived'],
  archived: [],
};

/** Этапы, на которые проект переводит организатор отбором внутри сезона. */
export const SEASON_SELECTION_STAGES = [
  'ai_review',
  'expert_review',
  'bootcamp',
  'finalist',
  'graduated',
] as const;

/**
 * Перевод проекта на следующий этап. Целевой этап называет клиент, допустимость
 * решает сервер: таблица переходов не является предметом договорённости с
 * фронтендом.
 *
 * `useGoldenTicket` — проход мимо порога отбора по золотому билету. Билет
 * погашается ровно в этом переводе и только один раз.
 */
export const AdvanceProjectStageRequestSchema = z.object({
  status: z.enum(['ai_review', 'expert_review', 'bootcamp', 'finalist', 'graduated', 'rejected']),
  reason: boundedString(3, 500),
  useGoldenTicket: z.boolean().default(false),
});
export type AdvanceProjectStageRequest = z.infer<typeof AdvanceProjectStageRequestSchema>;

/** Результат перевода: сам факт и был ли при этом погашен билет. */
export const ProjectStageChangeSchema = z.object({
  projectId: UuidSchema,
  from: ProjectStatusSchema,
  to: ProjectStatusSchema,
  goldenTicketRedeemed: z.boolean(),
  changedAt: IsoDateTimeSchema,
});
export type ProjectStageChange = z.infer<typeof ProjectStageChangeSchema>;

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
 * (docs/architecture/Architect_Launch.md §5.1). Тариф резолвится СЕРВЕРОМ — клиент его не выбирает.
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

/**
 * Избранный проект инвестора.
 *
 * Это ТОТ ЖЕ тизер, что и в каталоге, плюс момент добавления. Отдельной,
 * более подробной формы у избранного нет намеренно: закладка не открывает
 * доступ к данным, которых инвестор без неё не видит, — иначе «добавить в
 * избранное» стало бы способом обойти подписку.
 */
export const FavoriteProjectSchema = ProjectTeaserSchema.extend({
  favoritedAt: IsoDateTimeSchema,
});
export type FavoriteProject = z.infer<typeof FavoriteProjectSchema>;

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
 * Правила загрузки по типу материала — единственный источник правды для API,
 * сервера и интерфейсов (CODE-HIGH-09, CODE-MED-02).
 *
 * Раньше DTO разрешал пять MIME НЕЗАВИСИМО от типа материала (video/mp4
 * проходил как «презентация»), а интерфейс обещал «до 500 МБ» там, где сервер
 * принимал 50: два разных списка в двух местах разошлись при первом же
 * изменении. Лимиты и допустимые MIME объявлены здесь один раз; клиент читает
 * их отсюда же, поэтому обещание в UI не может разойтись с проверкой сервера.
 */
export const MATERIAL_UPLOAD_RULES = {
  deck: {
    maxBytes: 50 * 1024 * 1024,
    mimeTypes: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
  },
  video: {
    maxBytes: 500 * 1024 * 1024,
    mimeTypes: ['video/mp4'],
  },
  doc: {
    maxBytes: 25 * 1024 * 1024,
    mimeTypes: ['application/pdf', 'image/png', 'image/jpeg'],
  },
} as const satisfies Record<string, { maxBytes: number; mimeTypes: readonly string[] }>;

export type UploadableMaterialType = keyof typeof MATERIAL_UPLOAD_RULES;

/**
 * Запрос на загрузку материала. Файл идёт напрямую в S3 по presigned URL —
 * через API не проходит: иначе он становится и узким местом, и точкой,
 * где недоверенный контент касается прикладного процесса.
 *
 * Соответствие «тип материала ↔ MIME ↔ размер» проверяется НА ГРАНИЦЕ, а не
 * доброй волей клиента: заявка video/mp4 как `deck` — отказ разбора.
 */
export const RequestUploadSchema = z
  .object({
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
  })
  .superRefine((input, ctx) => {
    const rules = MATERIAL_UPLOAD_RULES[input.type];
    if (!rules.mimeTypes.includes(input.contentType as never)) {
      ctx.addIssue({
        code: 'custom',
        path: ['contentType'],
        message: `для типа ${input.type} допустимы: ${rules.mimeTypes.join(', ')}`,
      });
    }
    if (input.sizeBytes > rules.maxBytes) {
      ctx.addIssue({
        code: 'custom',
        path: ['sizeBytes'],
        message: `для типа ${input.type} максимум ${rules.maxBytes} байт`,
      });
    }
  });
export type RequestUpload = z.infer<typeof RequestUploadSchema>;

/**
 * Билет на загрузку: подписанная ФОРМА, а не голый URL.
 *
 * Хранилище проверяет условия подписи само — точный ключ, точный Content-Type и
 * диапазон размера. Поэтому лимит здесь настоящий: клиент, заявивший 10 МБ и
 * отправивший 5 ГБ, получит отказ от хранилища, а не запись в БД.
 */
export const UploadTicketSchema = z.object({
  materialId: UuidSchema,
  uploadUrl: z.url(),
  method: z.literal('POST'),
  /** Поля multipart/form-data. Файл добавляется последним, под именем `file`. */
  formFields: z.record(z.string(), z.string()),
  maxSizeBytes: z.number().int().positive(),
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

/** Материал проекта. Ни `s3Key`, ни presigned-URL наружу не отдаются. */
export const ProjectMaterialSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  type: MaterialTypeSchema,
  version: z.number().int().positive(),
  /** Внешняя ссылка — только для `product_link`, иначе null. */
  url: z.url().nullable(),
  parseStatus: z.enum(['queued', 'running', 'succeeded', 'failed', 'not_required']),
  createdAt: IsoDateTimeSchema,
});
export type ProjectMaterial = z.infer<typeof ProjectMaterialSchema>;

/**
 * Неизменяемый снимок заявки. Именно на него ссылаются AI-скоринг и эксперты,
 * поэтому наружу отдаются только метаданные версии, а не право её изменить.
 */
export const ProjectVersionSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  seasonId: UuidSchema,
  versionNo: z.number().int().positive(),
  submittedAt: IsoDateTimeSchema,
});
export type ProjectVersion = z.infer<typeof ProjectVersionSchema>;

/** Карточка проекта в кабинете основателя: без описания, для списка. */
export const ProjectSummarySchema = z.object({
  id: UuidSchema,
  title: z.string(),
  stage: ProjectStageSchema,
  status: ProjectStatusSchema,
  listingStatus: ListingStatusSchema,
  investmentAsk: z.string(),
  askCurrency: CurrencySchema,
  requiredPlanId: UuidSchema.nullable(),
  requiredPlanCode: z.string().nullable(),
  role: z.enum(['owner', 'cofounder']),
  createdAt: IsoDateTimeSchema,
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

/**
 * Запрос каталога. Сортировка и фильтры — строгий allowlist: произвольное поле
 * сортировки означало бы, что клиент управляет планом запроса.
 *
 * `irs_desc` объявлен в контракте пагинации, но каталогом пока не принимается:
 * скоринга нет, и «сортировка по IRS» была бы сортировкой по пустоте.
 */
export const CatalogQuerySchema = CatalogFilterSchema.extend({
  sort: z.enum(['listed_at_desc', 'ask_asc', 'ask_desc', 'relevance']).default('listed_at_desc'),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type CatalogQuery = z.infer<typeof CatalogQuerySchema>;
