import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from '../common/primitives';
import { ApplicationPreviewSectionSchema, PreviewAudienceSchema } from './application-views';
import { RoundProjectionSchema } from './funding-round';
import { MaterialTypeSchema, ProjectTeaserSchema } from './lab';
import { ScoreAxisSchema } from './misc';
import { AudienceSchema, ProjectVisibilitySchema } from './visibility';

/**
 * Представления проекта наружу (этап 5.7.2, план `заявка-04` §3.5).
 *
 * Собираются одним модулем из аудитории предиката `lab.project_audience` по
 * каждому разрешению отдельно: блок включается по СВОЕМУ разрешению, а не по
 * уровню зрителя. Получатель grant `{materials}` получает тизер и материалы,
 * остальные блоки — `null`. Поля никогда не выше аудитории `investors`.
 */

/** Аудитория зрителя по каждому разрешению; `null` — блока нет. */
export const ViewAccessSchema = z.object({
  profile: AudienceSchema.nullable(),
  round: AudienceSchema.nullable(),
  materials: AudienceSchema.nullable(),
  passport: AudienceSchema.nullable(),
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

/** Явный состав паспорта в Investor View — не строка таблицы. */
export const ViewPassportSchema = z.object({
  version: z.number().int().positive(),
  disclosureTier: z.enum(['teaser', 'full', 'dataroom']),
  irs: z.number().min(0).max(100).nullable(),
  axes: z.array(z.object({ axis: ScoreAxisSchema, value: z.number().min(0).max(100) })),
  publishedAt: IsoDateTimeSchema.nullable(),
});
export type ViewPassport = z.infer<typeof ViewPassportSchema>;

/**
 * Public View — `GET /catalog/:id`: тизер (как прежде, совместим с
 * `ProjectTeaserSchema`) плюс ответы согласованного снимка с эффективной
 * видимостью, прошедшей аудиторию зрителя, и проекция раунда. Аноним в
 * режиме `public` получает аудиторию `public`; допущенный инвестор — `investors`
 * (тогда это тот же состав, что Investor View без описания и материалов).
 */
export const PublicViewSchema = ProjectTeaserSchema.extend({
  /** Аудитория зрителя по разрешению `profile`; `null` — ответы закрыты (режим или нет согласия). */
  profileAudience: AudienceSchema.nullable(),
  /** Версия конфигурации формы снимка; `null` — согласия нет. */
  schemaVersion: z.number().int().nonnegative().nullable(),
  sections: z.array(ApplicationPreviewSectionSchema),
  /** Сколько заполненных ответов не показано этой аудитории. */
  withheld: z.number().int().nonnegative(),
  disclosedAt: IsoDateTimeSchema.nullable(),
});
export type PublicView = z.infer<typeof PublicViewSchema>;

/**
 * Investor View — `GET /projects/:id/investor-view`: нужен только доступ к
 * тизеру; каждый блок — по своему разрешению. `round` без права —
 * `undisclosed` без суммы, как в каталоге.
 */
export const InvestorViewSchema = PublicViewSchema.extend({
  access: ViewAccessSchema,
  /**
   * Доступ открыт лично владельцем проекта (разрешение выбранному
   * получателю, 5.8): дата выдачи. `null` — доступ следует из режима
   * проекта. Причина выдачи — внутренняя пометка владельца и получателю не
   * показывается, поэтому её здесь нет.
   */
  grant: z.object({ grantedAt: IsoDateTimeSchema }).nullable(),
  description: z.string().nullable(),
  geoRegion: z.string().nullable(),
  round: RoundProjectionSchema,
  materials: z.array(ViewMaterialSchema).nullable(),
  passport: ViewPassportSchema.nullable(),
});
export type InvestorView = z.infer<typeof InvestorViewSchema>;

/** Кто увидит проект в его режиме — для предпросмотра владельцу. */
export const AudienceSummarySchema = z.object({
  mode: ProjectVisibilitySchema,
  /** Аноним видит тизер и public-поля. */
  anonymous: z.boolean(),
  /** Кто из инвесторов допущен: never — никто; subscribed — с действующим членством; registered — любой с ролью; selected — по grant. */
  investors: z.enum(['never', 'subscribed', 'registered', 'selected']),
  /** Положение барьера подписки (`billing.investor_access_requires_subscription`). */
  subscriptionRequired: z.boolean(),
});
export type AudienceSummary = z.infer<typeof AudienceSummarySchema>;

/** Поле, которое станет видно дополнительно после применения активной версии условий. */
export const PendingDisclosureSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** Эффективная видимость сейчас (строже из двух). */
  current: AudienceSchema,
  /** Видимость по активной конфигурации — станет эффективной после «Применить». */
  active: AudienceSchema,
});
export type PendingDisclosure = z.infer<typeof PendingDisclosureSchema>;

export const ViewPreviewQuerySchema = z.object({
  audience: PreviewAudienceSchema.optional(),
  locale: z.string().optional(),
});

/**
 * Предпросмотр владельца — `GET /projects/:id/view-preview?audience=`: то, что
 * увидит выбранная аудитория, плюс кто это увидит и что станет видно после
 * применения новых условий раскрытия (профиль и незавершённый раунд отдельно).
 */
export const ViewPreviewSchema = z.object({
  audience: PreviewAudienceSchema,
  view: InvestorViewSchema.nullable(),
  audienceSummary: AudienceSummarySchema,
  consent: z.object({
    /** Версия условий, на которую согласился владелец (профиль); `null` — согласия нет. */
    formVersion: z.number().int().nonnegative().nullable(),
    /** Активная версия конфигурации. */
    activeFormVersion: z.number().int().nonnegative().nullable(),
    /** Версия условий незавершённого раунда; `null` — раунда нет. */
    roundDisclosureVersion: z.number().int().nonnegative().nullable(),
    roundId: UuidSchema.nullable(),
  }),
  pending: z.object({
    profile: z.array(PendingDisclosureSchema),
    round: z.array(PendingDisclosureSchema),
  }),
  /** Ответы, видимые аудитории, чьё подтверждение (материал) для неё закрыто. */
  evidenceConflicts: z.array(z.object({ key: z.string(), label: z.string() })),
  /** Отпечаток показанного содержимого — «Применить» возвращает его (5.7.4). */
  contentDigest: z.string(),
});
export type ViewPreview = z.infer<typeof ViewPreviewSchema>;

/** Предпросмотр перед открытием раунда — `GET /rounds/:id/open-preview`. */
export const RoundOpenPreviewSchema = z.object({
  roundId: UuidSchema,
  /** Версия условий, которая будет зафиксирована при открытии (активная). */
  activeFormVersion: z.number().int().nonnegative(),
  public: RoundProjectionSchema,
  investors: RoundProjectionSchema,
  audienceSummary: AudienceSummarySchema,
  /** Проект в режиме private: раунд никто не увидит. */
  warnings: z.array(z.enum(['private_project', 'no_profile_consent'])),
  /** Отпечаток параметров раунда — открытие возвращает его (5.7.4). */
  contentDigest: z.string(),
});
export type RoundOpenPreview = z.infer<typeof RoundOpenPreviewSchema>;
