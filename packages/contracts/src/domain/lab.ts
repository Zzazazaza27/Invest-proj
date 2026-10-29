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

/**
 * Статус проекта. Сезонная воронка (`ai_review` … `graduated`) и подача заявки
 * (`submitted`) удалены вместе с инвестиционным процессом (2.1-W05); правила
 * рассмотрения проекта проектируются заново.
 */
export const ProjectStatusSchema = z.enum(['draft', 'rejected', 'archived']);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

/** Допустимые переходы статуса. Назад хода нет. */
export const PROJECT_TRANSITIONS: Record<ProjectStatus, readonly ProjectStatus[]> = {
  draft: ['archived'],
  rejected: ['archived'],
  archived: [],
};

/** Статус листинга. НЕ путать со статусом проекта: это разные оси. */
export const ListingStatusSchema = z.enum(['not_listed', 'listed', 'unlisted']);
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

/** Создание проекта. Сумма и валюта запроса — поля самого проекта. */
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

/**
 * Валюты в обновлении нет: сервер её никогда не записывал (0.1 §11), а
 * принимать поле, которое молча теряется, — расхождение контракта и
 * поведения. Валюта одна и задаётся при создании.
 */
export const UpdateProjectRequestSchema = CreateProjectRequestSchema.omit({
  askCurrency: true,
}).partial();
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
  listedAt: IsoDateTimeSchema.nullable(),
  /**
   * Адрес логотипа для карточки; `null` — логотипа нет.
   *
   * Это маршрут ядра, а не ссылка в хранилище: доступ проверяется на каждом
   * запросе, и знание адреса ничего не открывает (7.2).
   */
  logoUrl: z.string().nullable().default(null),
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

/** Полная карточка — команде проекта и администратору. */
export const ProjectFullSchema = ProjectTeaserSchema.extend({
  description: z.string().nullable(),
  geoRegion: z.string().nullable(),
  investmentAsk: MoneyAmountSchema,
  askCurrency: CurrencySchema,
  status: ProjectStatusSchema,
  listingStatus: ListingStatusSchema,
  /** Режим «кто может видеть проект» (5.7); листинг — его следствие. */
  visibility: z.enum(['private', 'public', 'registered_investors', 'selected_investors']),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ProjectFull = z.infer<typeof ProjectFullSchema>;

export const CatalogFilterSchema = z.object({
  q: boundedString(0, 200).optional(),
  taxonomyId: UuidSchema.optional(),
  stage: ProjectStageSchema.optional(),
  geoCountry: CountryCodeSchema.optional(),
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

/**
 * «Кто может видеть проект» (5.7.3): режим ставит владелец с теми же
 * проверками, что листинг (KYC владельца); `listing_status` — следствие.
 * `selected_investors` появится вместе с выдачей разрешений (5.8).
 */
export const SetProjectVisibilityRequestSchema = z.object({
  visibility: z.enum(['private', 'public', 'registered_investors', 'selected_investors']),
});
export type SetProjectVisibilityRequest = z.infer<typeof SetProjectVisibilityRequestSchema>;

/** Отметка материала владельцем; `public` в интерфейсе 5.7 не предлагается. */
export const SetMaterialVisibilityRequestSchema = z.object({
  visibility: z.enum(['private', 'investors']),
});
export type SetMaterialVisibilityRequest = z.infer<typeof SetMaterialVisibilityRequestSchema>;

/** Материал проекта. Ни `s3Key`, ни presigned-URL наружу не отдаются. */
export const ProjectMaterialSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  type: MaterialTypeSchema,
  version: z.number().int().positive(),
  /** Внешняя ссылка — только для `product_link`, иначе null. */
  url: z.url().nullable(),
  /** Отметка владельца (M087): кому материал показывается по предикату `materials`. */
  visibility: z.enum(['private', 'investors', 'public']),
  createdAt: IsoDateTimeSchema,
});
export type ProjectMaterial = z.infer<typeof ProjectMaterialSchema>;

/**
 * Итог подтверждения загрузки (2.1-W03). Успех — только `ready`: файл
 * скопирован, проверен и связан с проектом. `pending` — сохранение не
 * завершено; `received` различает «объект получен, сохраняем» и «загрузка ещё
 * не завершена, проверяем состояние». `rejected` — проверенное несоответствие
 * формату или размеру, `reason` объясняет пользователю, что выбрать другой
 * файл. `needs_attention` — сбой сохранения разбирает эксплуатация.
 */
export const MaterialUploadResultSchema = z.object({
  uploadState: z.enum(['pending', 'ready', 'rejected', 'needs_attention']),
  received: z.boolean(),
  reason: z.string().nullable(),
  material: ProjectMaterialSchema.nullable(),
});
export type MaterialUploadResult = z.infer<typeof MaterialUploadResultSchema>;

/** Карточка проекта в кабинете основателя: без описания, для списка. */
export const ProjectSummarySchema = z.object({
  id: UuidSchema,
  title: z.string(),
  stage: ProjectStageSchema,
  status: ProjectStatusSchema,
  listingStatus: ListingStatusSchema,
  investmentAsk: MoneyAmountSchema,
  askCurrency: CurrencySchema,
  role: z.enum(['owner', 'cofounder']),
  createdAt: IsoDateTimeSchema,
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

/**
 * Запрос каталога. Сортировка и фильтры — строгий allowlist: произвольное поле
 * сортировки означало бы, что клиент управляет планом запроса.
 */
export const CatalogQuerySchema = CatalogFilterSchema.extend({
  sort: z.enum(['listed_at_desc', 'relevance']).default('listed_at_desc'),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type CatalogQuery = z.infer<typeof CatalogQuerySchema>;
