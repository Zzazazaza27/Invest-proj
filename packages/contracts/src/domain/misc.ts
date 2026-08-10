import { z } from 'zod';
import {
  boundedString,
  CountryCodeSchema,
  IsoDateTimeSchema,
  UuidSchema,
} from '../common/primitives.ts';

// ------------------------------------------------------------------- KYC/KYB

export const KycStatusSchema = z.enum([
  'pending',
  'in_review',
  'approved',
  'rejected',
  'verification_pending',
]);
export type KycStatus = z.infer<typeof KycStatusSchema>;

export const StartKycRequestSchema = z.object({
  kind: z.enum(['identity', 'investor_status', 'accredited']),
  docType: z.enum(['passport', 'foreign_passport', 'id_card', 'driver_license']),
  docCountry: CountryCodeSchema,
});
export type StartKycRequest = z.infer<typeof StartKycRequestSchema>;

/**
 * Статус верификации. Наружу не отдаются ни документы, ни причина отказа в
 * терминах комплаенса: только статус и общая формулировка.
 */
export const KycVerificationSchema = z.object({
  id: UuidSchema,
  kind: z.string(),
  status: KycStatusSchema,
  /** Обобщённая причина. Детали остаются во внутреннем контуре комплаенса. */
  rejectionSummary: z.string().nullable(),
  expiresAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type KycVerification = z.infer<typeof KycVerificationSchema>;

export const CreateEntityRequestSchema = z.object({
  legalName: boundedString(2, 300),
  legalForm: boundedString(0, 100).optional(),
  inn: z.string().regex(/^\d{10}$|^\d{12}$/, 'ИНН: 10 цифр для юрлица, 12 для ИП'),
  ogrn: z.string().regex(/^\d{13}$|^\d{15}$/, 'ОГРН: 13 или 15 цифр'),
  jurisdiction: CountryCodeSchema,
});
export type CreateEntityRequest = z.infer<typeof CreateEntityRequestSchema>;

export const BusinessEntitySchema = z.object({
  id: UuidSchema,
  legalName: z.string(),
  legalForm: z.string().nullable(),
  /** ИНН маскируется: полное значение шифруется и наружу не выдаётся. */
  innMasked: z.string(),
  jurisdiction: CountryCodeSchema,
  registryStatus: z.enum(['active', 'liquidating', 'liquidated', 'unknown']),
  kybApproved: z.boolean(),
  createdAt: IsoDateTimeSchema,
});
export type BusinessEntity = z.infer<typeof BusinessEntitySchema>;

// ------------------------------------------------------------------- scoring

export const ScoreAxisSchema = z.enum([
  'market',
  'demand',
  'competitive_edge',
  'uniqueness',
  'profitability',
  'presentation_quality',
  'scalability',
  'investment_readiness',
  'product_readiness',
]);
export type ScoreAxis = z.infer<typeof ScoreAxisSchema>;

/**
 * Оценка по оси. `sources` обязателен и непуст: оценка без источников —
 * это мнение модели, выданное за факт. Такое наружу не отдаётся.
 */
export const ScoreSchema = z.object({
  axis: ScoreAxisSchema,
  value: z.number().min(0).max(100),
  confidenceLow: z.number().min(0).max(100),
  confidenceHigh: z.number().min(0).max(100),
  explanation: z.string(),
  sources: z.array(z.object({ type: z.string(), ref: z.string() })).min(1),
  modelVersion: z.string(),
  computedAt: IsoDateTimeSchema,
});
export type Score = z.infer<typeof ScoreSchema>;

export const IrsScoreSchema = z.object({
  value: z.number().min(0).max(100),
  previousValue: z.number().min(0).max(100).nullable(),
  delta: z.number().nullable(),
  computedAt: IsoDateTimeSchema,
});
export type IrsScore = z.infer<typeof IrsScoreSchema>;

export const DisclosureTierSchema = z.enum(['teaser', 'full', 'dataroom']);

export const InvestmentPassportSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  version: z.number().int().positive(),
  disclosureTier: DisclosureTierSchema,
  data: z.record(z.string(), z.unknown()),
  scores: z.array(ScoreSchema),
  irs: IrsScoreSchema.nullable(),
  publishedAt: IsoDateTimeSchema.nullable(),
});
export type InvestmentPassport = z.infer<typeof InvestmentPassportSchema>;

/**
 * Ответ AI Mentor. `sources` непуст по контракту: ответ без источника из
 * passport_facts не выдаётся (Architect_Launch.md §4.5).
 */
export const MentorAnswerSchema = z.object({
  answer: z.string(),
  sources: z
    .array(z.object({ factId: UuidSchema, category: z.string(), sourceRef: z.string() }))
    .min(1),
  runId: UuidSchema,
});
export type MentorAnswer = z.infer<typeof MentorAnswerSchema>;

export const MentorQuestionSchema = z.object({
  projectId: UuidSchema,
  question: boundedString(3, 2000),
});
export type MentorQuestion = z.infer<typeof MentorQuestionSchema>;

// ------------------------------------------------------------------- эксперты

export const ExpertRecommendationSchema = z.enum(['pass', 'fail', 'needs_review']);

export const RUBRIC_KEYS = [
  'team',
  'product',
  'strategy',
  'legal',
  'finmodel',
  'scalability',
] as const;

export const SubmitReviewRequestSchema = z.object({
  assignmentId: UuidSchema,
  rubricScores: z.object({
    team: z.number().min(0).max(10),
    product: z.number().min(0).max(10),
    strategy: z.number().min(0).max(10),
    legal: z.number().min(0).max(10),
    finmodel: z.number().min(0).max(10),
    scalability: z.number().min(0).max(10),
  }),
  comment: boundedString(0, 8000).optional(),
  recommendation: ExpertRecommendationSchema,
});
export type SubmitReviewRequest = z.infer<typeof SubmitReviewRequestSchema>;

export const ExpertAssignmentSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  projectTitle: z.string(),
  status: z.enum(['assigned', 'accepted', 'declined', 'completed', 'expired']),
  dueAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
});
export type ExpertAssignment = z.infer<typeof ExpertAssignmentSchema>;

export const DeclareConflictRequestSchema = z.object({
  projectId: UuidSchema,
  description: boundedString(10, 2000),
});

// -------------------------------------------------------------------- сезоны

export const SeasonStatusSchema = z.enum([
  'draft',
  'applications_open',
  'review',
  'bootcamp',
  'final',
  'closed',
]);

export const SeasonSchema = z.object({
  id: UuidSchema,
  number: z.number().int().positive(),
  title: z.string().nullable(),
  status: SeasonStatusSchema,
  startsAt: IsoDateTimeSchema,
  endsAt: IsoDateTimeSchema,
});
export type Season = z.infer<typeof SeasonSchema>;

export const RatingEntrySchema = z.object({
  rank: z.number().int().positive(),
  projectId: UuidSchema,
  title: z.string(),
  irs: z.number().min(0).max(100),
  computedAt: IsoDateTimeSchema,
});
export type RatingEntry = z.infer<typeof RatingEntrySchema>;

// -------------------------------------------------------------- уведомления

export const NotificationChannelSchema = z.enum(['push', 'telegram', 'email', 'sms', 'inapp']);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const NotificationTopicSchema = z.enum([
  'all',
  'projects',
  'deals',
  'billing',
  'experts',
  'seasons',
  'messages',
  'security',
  'marketing',
]);
export type NotificationTopic = z.infer<typeof NotificationTopicSchema>;

/** Темы, которые нельзя отключить. Дублируется CHECK-ограничением в БД. */
export const UNDISABLEABLE_TOPICS = ['security', 'billing'] as const;

export const NotificationPreferenceSchema = z
  .object({
    channel: NotificationChannelSchema,
    topic: NotificationTopicSchema,
    enabled: z.boolean(),
    quietHoursTz: z.string().max(64).nullable().optional(),
    quietFrom: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullable()
      .optional(),
    quietTo: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullable()
      .optional(),
  })
  .refine((v) => !(UNDISABLEABLE_TOPICS as readonly string[]).includes(v.topic) || v.enabled, {
    message: 'уведомления о безопасности и платежах отключить нельзя',
    path: ['enabled'],
  });
export type NotificationPreference = z.infer<typeof NotificationPreferenceSchema>;

export const RegisterDeviceRequestSchema = z.object({
  platform: z.enum(['ios', 'android', 'web_pwa']),
  pushProvider: z.enum(['fcm', 'apns', 'web_push']),
  pushToken: boundedString(10, 4096),
  deviceName: boundedString(0, 120).optional(),
  appVersion: boundedString(0, 40).optional(),
});
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequestSchema>;

export const NotificationSchema = z.object({
  id: UuidSchema,
  channel: NotificationChannelSchema,
  templateCode: z.string(),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(['queued', 'sending', 'sent', 'failed', 'skipped_by_preference']),
  createdAt: IsoDateTimeSchema,
  sentAt: IsoDateTimeSchema.nullable(),
});
export type Notification = z.infer<typeof NotificationSchema>;

// -------------------------------------------------------------- служебное

export const HealthSchema = z.object({
  /** Сигнатура сервиса: по ней внешние проверки отличают наш API от чужого. */
  service: z.literal('unicorn-launch-core'),
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  checks: z.record(z.string(), z.enum(['ok', 'fail'])),
});
export type Health = z.infer<typeof HealthSchema>;

export const FeatureFlagsSchema = z.record(z.string(), z.boolean());
export type FeatureFlags = z.infer<typeof FeatureFlagsSchema>;
