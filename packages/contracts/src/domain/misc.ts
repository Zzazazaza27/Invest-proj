import { z } from 'zod';
import {
  boundedString,
  CountryCodeSchema,
  IsoDateTimeSchema,
  UuidSchema,
} from '../common/primitives';

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
  /**
   * Имя заявителя — только в очереди комплаенса, где решение принимает человек.
   *
   * Оператор видел одну строку идентификатора и вид проверки: одобрять
   * неизвестно кого — это не решение, а нажатие кнопки. Адрес почты сюда НЕ
   * выносится: он лежит в базе зашифрованным, и вытаскивать его в список
   * означало бы потерять и шифрование на покое, и журнал доступа.
   */
  subjectName: z.string().nullable().optional(),
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

/**
 * Решение комплаенса по верификации. Принимается ТОЛЬКО ролью admin и только
 * над чужой заявкой: самоодобрение закрыто и политикой RLS, и сервисным слоем.
 */
export const KycDecisionRequestSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    /** Причина обязательна при отказе — это требование аудита, не UX. */
    reason: boundedString(3, 500).optional(),
    riskLevel: z.enum(['low', 'medium', 'high', 'prohibited']).optional(),
    /** Срок действия проверки: без него ежегодный пересмотр невозможен. */
    expiresAt: IsoDateTimeSchema.optional(),
  })
  .refine((v) => v.decision !== 'rejected' || Boolean(v.reason), {
    message: 'при отказе причина обязательна',
    path: ['reason'],
  });
export type KycDecisionRequest = z.infer<typeof KycDecisionRequestSchema>;

export const StartKybRequestSchema = z.object({
  kind: z.enum(['registry_check', 'beneficial_owners', 'accreditation', 'annual_review']),
});
export type StartKybRequest = z.infer<typeof StartKybRequestSchema>;

export const KybVerificationSchema = z.object({
  id: UuidSchema,
  entityId: UuidSchema,
  kind: z.string(),
  status: KycStatusSchema,
  rejectionSummary: z.string().nullable(),
  expiresAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type KybVerification = z.infer<typeof KybVerificationSchema>;

export const EntityMemberRoleSchema = z.enum(['signatory', 'beneficial_owner', 'representative']);

export const AddEntityMemberRequestSchema = z
  .object({
    userId: UuidSchema,
    memberRole: EntityMemberRoleSchema,
    sharePct: z
      .string()
      .regex(/^\d{1,3}(\.\d{1,2})?$/, 'доля: до 100 с двумя знаками')
      .optional(),
  })
  .refine((v) => v.memberRole !== 'beneficial_owner' || Boolean(v.sharePct), {
    message: 'для бенефициара доля обязательна',
    path: ['sharePct'],
  });
export type AddEntityMemberRequest = z.infer<typeof AddEntityMemberRequestSchema>;

export const EntityMemberSchema = z.object({
  entityId: UuidSchema,
  userId: UuidSchema,
  memberRole: EntityMemberRoleSchema,
  sharePct: z.string().nullable(),
  verifiedAt: IsoDateTimeSchema.nullable(),
});
export type EntityMember = z.infer<typeof EntityMemberSchema>;

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
  /**
   * Происхождение оценки — неотделимо от числа (ADR-008 §4): версия модели и
   * промпта показываются рядом с баллом. Необязательны ради совместимости со
   * старыми ответами, но сервер заполняет их всегда.
   */
  modelVersion: z.string().max(120).nullable().optional(),
  promptVersion: z.string().max(60).nullable().optional(),
});
export type InvestmentPassport = z.infer<typeof InvestmentPassportSchema>;

export const ReadinessDimensionSchema = z.enum([
  'problem',
  'solution',
  'product',
  'tech',
  'team',
  'market',
  'competition',
  'business_model',
  'unit_economics',
  'legal',
  'finance',
  'pitch',
  'data_room',
]);
export type ReadinessDimension = z.infer<typeof ReadinessDimensionSchema>;

/**
 * Уровень готовности по измерению.
 *
 * Вынесен отдельным именем, чтобы им пользовались и разбор ответа AI-шлюза, и
 * контракт наружу: список, переписанный во втором месте, рано или поздно
 * разойдётся с ограничением в БД (CODE-13).
 */
export const ReadinessLevelSchema = z.enum(['low', 'medium', 'high']);
export type ReadinessLevel = z.infer<typeof ReadinessLevelSchema>;

export const ReadinessEntrySchema = z.object({
  dimension: ReadinessDimensionSchema,
  level: ReadinessLevelSchema,
  recommendations: z.array(z.string()),
  updatedAt: IsoDateTimeSchema,
});
export type ReadinessEntry = z.infer<typeof ReadinessEntrySchema>;

export const RoadmapStepSchema = z.object({
  id: UuidSchema,
  title: z.string(),
  description: z.string().nullable(),
  dimension: z.string().nullable(),
  status: z.enum(['pending', 'in_progress', 'completed', 'skipped']),
  priority: z.number().int(),
  orderIndex: z.number().int(),
});
export type RoadmapStep = z.infer<typeof RoadmapStepSchema>;

export const RoadmapSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  generatedBy: z.enum(['ai', 'expert']),
  isActive: z.boolean(),
  createdAt: IsoDateTimeSchema,
  steps: z.array(RoadmapStepSchema),
});
export type Roadmap = z.infer<typeof RoadmapSchema>;

/**
 * Результат прогона анализа.
 *
 * `isLlm` возвращается наружу намеренно: пользователь имеет право знать, что
 * оценку посчитала воспроизводимая эвристика, а не языковая модель. Выдавать
 * одно за другое — то же самое, что выдавать сгенерированное за подтверждённое.
 */
export const AnalysisRunSchema = z.object({
  runId: UuidSchema,
  projectId: UuidSchema,
  status: z.enum(['succeeded', 'failed']),
  provider: z.string(),
  isLlm: z.boolean(),
  modelVersion: z.string(),
  passportVersion: z.number().int().positive(),
  irs: z.number().min(0).max(100),
  irsDelta: z.number().nullable(),
});
export type AnalysisRun = z.infer<typeof AnalysisRunSchema>;

/**
 * Ответ AI Mentor. `sources` непуст по контракту: ответ без источника из
 * passport_facts не выдаётся (docs/architecture/Architect_Launch.md §4.5).
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
  /**
   * Этап проекта в воронке платформы. Состояние рассмотрения складывается из
   * ДВУХ вещей — статуса назначения и этапа проекта, — и показывать только
   * первое означало бы, что эксперт не видит, что стало с проектом после его
   * рецензии.
   */
  projectStatus: z.string(),
  /** Подана ли рецензия по этому назначению. */
  reviewSubmitted: z.boolean(),
  /**
   * Можно ли ещё пересмотреть результат.
   *
   * `false` означает, что по проекту принято решение консенсуса: рецензия
   * стала основанием принятого решения, и переписывать её нельзя. Кабинет
   * обязан это показывать, а не выяснять отказом на кнопке.
   */
  revisable: z.boolean(),
});
export type ExpertAssignment = z.infer<typeof ExpertAssignmentSchema>;

export const DeclareConflictRequestSchema = z.object({
  projectId: UuidSchema,
  description: boundedString(10, 2000),
});
export type DeclareConflictRequest = z.infer<typeof DeclareConflictRequestSchema>;

/**
 * Назначение рецензентов. Список экспертов, а не один: рецензия одного
 * человека не даёт ни консенсуса, ни расхождения, которое можно измерить.
 */
export const CreateAssignmentsRequestSchema = z.object({
  projectId: UuidSchema,
  expertIds: z.array(UuidSchema).min(1).max(10),
  /** Срок рецензии. Без него назначение невозможно просрочить, а значит и вести. */
  dueAt: IsoDateTimeSchema,
  reason: z.enum(['auto_taxonomy', 'manual', 'third_reviewer']).default('manual'),
});
export type CreateAssignmentsRequest = z.infer<typeof CreateAssignmentsRequestSchema>;

/**
 * Ответ эксперта на назначение. Отказ — законный исход, а не сбой: эксперт,
 * который не может оценить проект честно, обязан иметь способ это сказать.
 */
export const AssignmentDecisionRequestSchema = z.object({
  decision: z.enum(['accepted', 'declined']),
});
export type AssignmentDecisionRequest = z.infer<typeof AssignmentDecisionRequestSchema>;

export const ExpertConflictSchema = z.object({
  id: UuidSchema,
  expertId: UuidSchema,
  projectId: UuidSchema,
  description: z.string(),
  resolution: z.enum(['recused', 'approved_with_disclosure']).nullable(),
  createdAt: IsoDateTimeSchema,
});
export type ExpertConflict = z.infer<typeof ExpertConflictSchema>;

export const ResolveConflictRequestSchema = z.object({
  resolution: z.enum(['recused', 'approved_with_disclosure']),
});
export type ResolveConflictRequest = z.infer<typeof ResolveConflictRequestSchema>;

/** Рецензия в сводке для организатора. Имя эксперта не раскрывается основателю. */
/** Внутренняя заметка эксперта по ходу рассмотрения. */
export const ExpertNoteSchema = z.object({
  id: UuidSchema,
  body: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type ExpertNote = z.infer<typeof ExpertNoteSchema>;

export const AddExpertNoteRequestSchema = z.object({
  body: boundedString(1, 4000),
});
export type AddExpertNoteRequest = z.infer<typeof AddExpertNoteRequestSchema>;

/**
 * Запись истории рассмотрения.
 *
 * Берётся из журнала `audit.events`, а не из отдельной таблицы: журнал уже
 * пишет каждое действие эксперта и хеш-сцеплен, то есть его нельзя
 * отредактировать задним числом. Вторая история рядом с ним расходилась бы с
 * ним при первой же ошибке.
 *
 * Наружу отдаётся РОЛЬ действующего лица, а не его идентификатор: эксперту
 * важно, что назначение сделал организатор, а не кто именно из них.
 */
export const ExpertHistoryEntrySchema = z.object({
  at: IsoDateTimeSchema,
  verb: z.string(),
  actorRole: z.string(),
  /** Только безопасные поля: статус, рекомендация. Оценок здесь нет. */
  details: z.record(z.string(), z.unknown()),
});
export type ExpertHistoryEntry = z.infer<typeof ExpertHistoryEntrySchema>;

export const ExpertReviewSchema = z.object({
  assignmentId: UuidSchema,
  expertId: UuidSchema,
  rubricScores: z.record(z.string(), z.number()),
  comment: z.string().nullable(),
  recommendation: ExpertRecommendationSchema,
  submittedAt: IsoDateTimeSchema,
});
export type ExpertReview = z.infer<typeof ExpertReviewSchema>;

/**
 * Финальное решение по проекту. Его фиксирует ЧЕЛОВЕК: `decidedBy` берётся из
 * контекста запроса, а не из тела — «AI ускоряет, человек решает»
 * (docs/architecture/Architect.md §3.6). Модель может посчитать расхождение, но не подписаться
 * за организатора.
 */
export const DecideConsensusRequestSchema = z.object({
  projectId: UuidSchema,
  finalDecision: ExpertRecommendationSchema,
  /** Третий рецензент, если решение принято после разведения оценок. */
  thirdReviewerId: UuidSchema.optional(),
});
export type DecideConsensusRequest = z.infer<typeof DecideConsensusRequestSchema>;

export const ReviewConsensusSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  seasonId: UuidSchema.nullable(),
  /** Разброс оценок рецензентов, 0–10. Считается сервером по рубрикам. */
  discrepancyScore: z.number().nullable(),
  finalDecision: ExpertRecommendationSchema,
  decidedAt: IsoDateTimeSchema,
});
export type ReviewConsensus = z.infer<typeof ReviewConsensusSchema>;

/**
 * Порог расхождения рецензий. Выше него решение без третьего рецензента
 * считается непроверяемым: два эксперта разошлись слишком сильно, чтобы
 * усреднение что-то значило.
 */
export const REVIEW_DISCREPANCY_THRESHOLD = 3;

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

/**
 * Перевод сезона по статусной машине. Клиент называет ЦЕЛЕВОЙ статус, а
 * допустимость перехода решает сервер: список разрешённых переходов — не
 * предмет договорённости с фронтендом.
 */
export const UpdateSeasonStatusRequestSchema = z.object({
  status: SeasonStatusSchema,
});
export type UpdateSeasonStatusRequest = z.infer<typeof UpdateSeasonStatusRequestSchema>;

/** Разрешённые переходы. Обратного хода нет: сезон — метроном, а не тумблер. */
export const SEASON_TRANSITIONS: Record<
  z.infer<typeof SeasonStatusSchema>,
  readonly z.infer<typeof SeasonStatusSchema>[]
> = {
  draft: ['applications_open'],
  applications_open: ['review', 'closed'],
  review: ['bootcamp', 'closed'],
  bootcamp: ['final', 'closed'],
  final: ['closed'],
  closed: [],
};

/**
 * Конфигурация воронки сезона: сколько проектов проходит на каждый этап и с
 * какого момента этап открыт.
 *
 * Живёт в `seasons.seasons.funnel_config_jsonb`, а не в отдельных колонках:
 * набор этапов воронки меняется вместе с продуктом, и каждая такая правка
 * означала бы миграцию с блокировкой таблицы сезонов.
 *
 * Квота — верхняя граница числа проектов НА этапе, а не число мест «сверх
 * уже занятых»: пересчёт квоты вниз не выкидывает тех, кто прошёл раньше,
 * но и добрать до старого числа больше не позволит.
 */
export const SeasonFunnelConfigSchema = z.object({
  quotas: z
    .object({
      ai_review: z.number().int().positive().optional(),
      expert_review: z.number().int().positive().optional(),
      bootcamp: z.number().int().positive().optional(),
      finalist: z.number().int().positive().optional(),
      graduated: z.number().int().positive().optional(),
    })
    .default({}),
  /** Момент открытия этапа. Раньше него перевести проект нельзя. */
  schedule: z
    .object({
      ai_review: IsoDateTimeSchema.optional(),
      expert_review: IsoDateTimeSchema.optional(),
      bootcamp: IsoDateTimeSchema.optional(),
      finalist: IsoDateTimeSchema.optional(),
      graduated: IsoDateTimeSchema.optional(),
    })
    .default({}),
});
export type SeasonFunnelConfig = z.infer<typeof SeasonFunnelConfigSchema>;

/** Занятость этапа: сколько проектов уже прошло и сколько мест осталось. */
export const SeasonStageOccupancySchema = z.object({
  stage: z.string(),
  occupied: z.number().int().nonnegative(),
  quota: z.number().int().positive().nullable(),
  opensAt: IsoDateTimeSchema.nullable(),
});
export type SeasonStageOccupancy = z.infer<typeof SeasonStageOccupancySchema>;

export const RatingEntrySchema = z.object({
  rank: z.number().int().positive(),
  projectId: UuidSchema,
  title: z.string(),
  irs: z.number().min(0).max(100),
  /** Публикуемый балл 1–10 (0 — паспорта ещё нет). Рейтинг сортируется по нему, IRS — тай-брейкер. */
  score10: z.number().int().min(0).max(10),
  computedAt: IsoDateTimeSchema,
});
export type RatingEntry = z.infer<typeof RatingEntrySchema>;

/**
 * Золотой билет — ручное решение организатора провести проект дальше вопреки
 * рейтингу. Причина обязательна: непрозрачная привилегия обесценивает сам
 * рейтинг. Лимит на выдающего в пределах сезона проверяется в БД триггером.
 */
export const GrantGoldenTicketRequestSchema = z.object({
  projectId: UuidSchema,
  reason: boundedString(10, 1000),
});
export type GrantGoldenTicketRequest = z.infer<typeof GrantGoldenTicketRequestSchema>;

export const GoldenTicketSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  seasonId: UuidSchema,
  reason: z.string(),
  usedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type GoldenTicket = z.infer<typeof GoldenTicketSchema>;

/** Сколько золотых билетов один организатор может выдать за сезон (M007). */
export const GOLDEN_TICKETS_PER_GRANTOR = 2;

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

/**
 * Устройство в ответе. Push-токена здесь НЕТ намеренно: он позволяет слать
 * уведомления от имени приложения, поэтому наружу не возвращается даже
 * владельцу — отдать его обратно клиенту незачем, а утечь он может.
 */
export const UserDeviceSchema = z.object({
  id: UuidSchema,
  platform: z.enum(['ios', 'android', 'web_pwa']),
  pushProvider: z.enum(['fcm', 'apns', 'web_push']),
  deviceName: z.string().nullable(),
  appVersion: z.string().nullable(),
  lastSeenAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
});
export type UserDevice = z.infer<typeof UserDeviceSchema>;

/**
 * Шаблон текста уведомления.
 *
 * Версия — часть идентичности шаблона, а не служебное поле: активной остаётся
 * одна версия на (code, channel, locale), прежние сохраняются как история того,
 * что платформа действительно писала пользователям.
 */
export const NotificationTemplateSchema = z.object({
  id: UuidSchema,
  code: z.string(),
  channel: NotificationChannelSchema,
  locale: z.string(),
  version: z.number().int().positive(),
  titleTemplate: z.string().nullable(),
  bodyTemplate: z.string(),
  fallbackChain: z.array(z.string()),
  isCritical: z.boolean(),
  isActive: z.boolean(),
});
export type NotificationTemplate = z.infer<typeof NotificationTemplateSchema>;

/**
 * Сохранение текста. Номер версии клиент НЕ называет: его выдаёт сервер, иначе
 * два администратора, редактирующих один шаблон, назначили бы одинаковую версию.
 */
export const UpsertNotificationTemplateSchema = z.object({
  code: boundedString(3, 100).regex(
    /^[a-z][a-z0-9_.]*$/,
    'код шаблона — латиница, точки, подчёркивания',
  ),
  channel: NotificationChannelSchema,
  locale: z.enum(['ru-RU', 'en-US']).default('ru-RU'),
  titleTemplate: boundedString(0, 200).nullable().optional(),
  bodyTemplate: boundedString(1, 4000),
  fallbackChain: z.array(NotificationChannelSchema).max(4).default([]),
  isCritical: z.boolean().default(false),
});
export type UpsertNotificationTemplate = z.infer<typeof UpsertNotificationTemplateSchema>;

/** Пакетное обновление предпочтений: настройки меняют экраном, а не по одной. */
export const UpdatePreferencesRequestSchema = z.object({
  items: z.array(NotificationPreferenceSchema).min(1).max(100),
});
export type UpdatePreferencesRequest = z.infer<typeof UpdatePreferencesRequestSchema>;

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

/**
 * Строка поиска пользователей для админки.
 *
 * Адрес почты сюда не выносится: он лежит зашифрованным, и показывать его
 * списком значило бы потерять и шифрование на покое, и журнал доступа. Для
 * различения тёзок хватает роли и первых знаков идентификатора — по ним же
 * сверяют записи в журнале.
 */
export const AdminUserSummarySchema = z.object({
  id: UuidSchema,
  displayName: z.string(),
  roles: z.array(z.string()),
  status: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type AdminUserSummary = z.infer<typeof AdminUserSummarySchema>;

/** Строка поиска проектов для админки: перевод по воронке идёт по идентификатору. */
export const AdminProjectSummarySchema = z.object({
  id: UuidSchema,
  title: z.string(),
  status: z.string(),
  listingStatus: z.string(),
  seasonId: UuidSchema.nullable(),
});
export type AdminProjectSummary = z.infer<typeof AdminProjectSummarySchema>;
