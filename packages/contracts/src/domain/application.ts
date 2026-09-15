import { z } from 'zod';
import {
  boundedString,
  CurrencySchema,
  IsoDateTimeSchema,
  MoneyAmountSchema,
  UuidSchema,
} from '../common/primitives';
import { ProjectStageSchema } from './lab';

/**
 * Инвестиционная заявка — отдельная от проекта сущность
 * (docs/architecture/заявка-02-технический-план.md §2.2).
 *
 * Проект хранит долгоживущее: название, направление, географию. Заявка —
 * состояние проекта и конкретный запрос в момент подачи. У проекта может быть
 * несколько заявок. Core-поля типизированы; ответы на вопросы формы лежат в
 * `answers` по стабильным ключам схемы вопросов (этап 3) и здесь проверяются
 * только по форме ключа.
 *
 * Черновик свободен: сумма, тип бизнеса и уточнение направления могут быть
 * пустыми. Обязательность — условие подачи (`ApplicationSubmissionCheck`),
 * а не создания: основатель должен иметь возможность начать и выйти.
 */

export const BusinessTypeSchema = z.enum([
  'saas',
  'marketplace',
  'consumer',
  'enterprise',
  'hardware_deeptech',
  'regulated_biotech',
  'other',
]);
export type BusinessType = z.infer<typeof BusinessTypeSchema>;

export const FundingScopeSchema = z.enum(['project', 'direction']);
export type FundingScope = z.infer<typeof FundingScopeSchema>;

/** `submitted` — открытая заявка: её видит инвестор и она держит проекцию проекта. */
export const ApplicationStatusSchema = z.enum(['draft', 'submitted', 'archived']);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

/** Ключ вопроса: стабильный, латиница, как в схеме вопросов. */
export const QuestionKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'ключ вопроса');

/**
 * Ответы по ключам. Значения здесь не типизируются: их форму задаёт схема
 * вопросов конкретной версии (этап 3), и проверять их надо по ней, а не по
 * общему контракту. Верхняя граница размера — защита от тела-мусора.
 */
export const ApplicationAnswersSchema = z
  .record(QuestionKeySchema, z.unknown())
  .refine((answers) => Object.keys(answers).length <= 500, 'слишком много ответов');
export type ApplicationAnswers = z.infer<typeof ApplicationAnswersSchema>;

/** Привязка подтверждений к вопросам: ключ → материалы проекта. */
export const ApplicationEvidenceSchema = z.record(QuestionKeySchema, z.array(UuidSchema).max(20));
export type ApplicationEvidence = z.infer<typeof ApplicationEvidenceSchema>;

export const InvestmentApplicationSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  status: ApplicationStatusSchema,
  title: z.string().nullable(),
  stage: ProjectStageSchema,
  businessType: BusinessTypeSchema.nullable(),
  /** `null` в черновике — основатель ещё не выбирал (M078); при подаче обязателен. */
  fundingScope: FundingScopeSchema.nullable(),
  fundingScopeNote: z.string().nullable(),
  investmentAsk: MoneyAmountSchema.nullable(),
  askCurrency: CurrencySchema,
  schemaVersion: z.number().int().nonnegative(),
  answers: ApplicationAnswersSchema,
  evidence: ApplicationEvidenceSchema,
  currentVersionId: UuidSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  submittedAt: IsoDateTimeSchema.nullable(),
  archivedAt: IsoDateTimeSchema.nullable(),
});
export type InvestmentApplication = z.infer<typeof InvestmentApplicationSchema>;

/** Создание черновика. Всё необязательно: стадия по умолчанию берётся из проекта. */
export const CreateApplicationRequestSchema = z.object({
  title: boundedString(1, 120).optional(),
  stage: ProjectStageSchema.optional(),
  businessType: BusinessTypeSchema.optional(),
  fundingScope: FundingScopeSchema.optional(),
  fundingScopeNote: boundedString(1, 200).optional(),
  investmentAsk: MoneyAmountSchema.optional(),
});
export type CreateApplicationRequest = z.infer<typeof CreateApplicationRequestSchema>;

/**
 * Частичное сохранение черновика (автосохранение). `null` очищает поле,
 * отсутствие поля — не трогает. `answers` и `evidence` сливаются по ключам,
 * а не заменяют целиком: мастер шлёт только изменённый раздел.
 */
export const UpdateApplicationRequestSchema = z.object({
  title: boundedString(1, 120).nullable().optional(),
  stage: ProjectStageSchema.optional(),
  businessType: BusinessTypeSchema.nullable().optional(),
  fundingScope: FundingScopeSchema.optional(),
  fundingScopeNote: boundedString(1, 200).nullable().optional(),
  investmentAsk: MoneyAmountSchema.nullable().optional(),
  answers: ApplicationAnswersSchema.optional(),
  evidence: ApplicationEvidenceSchema.optional(),
});
export type UpdateApplicationRequest = z.infer<typeof UpdateApplicationRequestSchema>;

/**
 * Что мешает подаче. Считается сервером по core-полям и активной политике;
 * с этапа 3 сюда же входит обязательный набор вопросов схемы. `canSubmit`
 * — единственный критерий кнопки «Подать».
 */
export const ApplicationSubmissionCheckSchema = z.object({
  canSubmit: z.boolean(),
  missing: z.array(z.object({ path: z.string(), message: z.string() })),
});
export type ApplicationSubmissionCheck = z.infer<typeof ApplicationSubmissionCheckSchema>;

// --------------------------------------------------- политика ограничений

/**
 * Ограничения основателя (план 0.2 §2.8). Настройка админки, не тариф.
 * `count.submitted` всегда true и `count.archived` всегда false — это не
 * параметры, а правила подсчёта, зафиксированные в контракте.
 */
export const ApplicationPolicySchema = z.object({
  maxApplicationsPerProject: z.number().int().min(1).max(1000),
  maxApplicationsPerAccount: z.number().int().min(1).max(10_000).nullable(),
  count: z.object({
    draft: z.boolean(),
    submitted: z.literal(true),
    archived: z.literal(false),
  }),
  maxAskPerApplication: MoneyAmountSchema.nullable(),
  maxOpenAskTotalPerProject: MoneyAmountSchema.nullable(),
});
export type ApplicationPolicy = z.infer<typeof ApplicationPolicySchema>;

export const ApplicationPolicyVersionSchema = z.object({
  id: UuidSchema,
  version: z.number().int().positive(),
  config: ApplicationPolicySchema,
  isActive: z.boolean(),
  createdBy: UuidSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  reason: z.string(),
});
export type ApplicationPolicyVersion = z.infer<typeof ApplicationPolicyVersionSchema>;

export const ActivateApplicationPolicyRequestSchema = z.object({
  config: ApplicationPolicySchema,
  reason: boundedString(3, 500),
});
export type ActivateApplicationPolicyRequest = z.infer<
  typeof ActivateApplicationPolicyRequestSchema
>;

/** Сумма как строка NUMERIC, допускающая ноль (сумма открытых заявок может быть 0). */
const NonNegativeAmountSchema = z.string().regex(/^\d{1,14}(\.\d{1,2})?$/);

/** Остаток и потолки — то, что основатель видит до создания заявки. */
export const ApplicationLimitsSchema = z.object({
  policyVersion: z.number().int().positive(),
  applications: z.object({
    limit: z.number().int(),
    used: z.number().int(),
    remaining: z.number().int(),
  }),
  account: z
    .object({
      limit: z.number().int(),
      used: z.number().int(),
      remaining: z.number().int(),
    })
    .nullable(),
  maxAskPerApplication: MoneyAmountSchema.nullable(),
  maxOpenAskTotalPerProject: MoneyAmountSchema.nullable(),
  openAskTotal: NonNegativeAmountSchema,
});
export type ApplicationLimits = z.infer<typeof ApplicationLimitsSchema>;

export const ApplicationListSchema = z.object({
  items: z.array(InvestmentApplicationSchema),
  limits: ApplicationLimitsSchema,
});
export type ApplicationList = z.infer<typeof ApplicationListSchema>;

export const ApplicationWithChecksSchema = z.object({
  application: InvestmentApplicationSchema,
  submission: ApplicationSubmissionCheckSchema,
});
export type ApplicationWithChecks = z.infer<typeof ApplicationWithChecksSchema>;

// ------------------------------------------------------- публичные флаги

/**
 * Флаги, которые кабинеты читают без входа. Строгий allowlist: остальные
 * флаги — состояние платформы, а не интерфейса, и наружу не отдаются.
 */
export const PUBLIC_FEATURE_KEYS = [
  'billing.listing_requires_subscription',
  'lab.ui.application_v2',
] as const;
export type PublicFeatureKey = (typeof PUBLIC_FEATURE_KEYS)[number];

export const FeaturesSchema = z.object({
  flags: z.record(z.enum(PUBLIC_FEATURE_KEYS), z.boolean()),
});
export type Features = z.infer<typeof FeaturesSchema>;
