import { z } from 'zod';
import { ScoreAxisSchema } from './misc';

/**
 * Паспорт проекта в форме, которую возвращает модель (promt_aiscoring.md, раздел 3).
 *
 * До этого `passport` был `z.record(z.string(), z.unknown())` — единственное
 * поле ответа модели без проверки, и оно целиком уезжало в `jsonb_data` и в
 * публичный API. Рядом со строго проверяемыми `scores` это создавало ложное
 * ощущение защищённости.
 *
 * Все перечисления ЗАКРЫТЫ, схема `.strict()`: неизвестный ключ или свободный
 * текст в поле кодов — отказ разбора, а не «доедет само». Свободная строка в
 * `integrityFlags` была бы публикацией текста заявителя от имени платформы.
 */

export const IntegrityFlagSchema = z.enum([
  'instruction_override',
  'score_demand',
  'role_switch',
  'fake_system_marker',
  'fake_metadata',
  'delimiter_escape',
  'quotation_not_attempt',
]);
export type IntegrityFlag = z.infer<typeof IntegrityFlagSchema>;

export const ComplianceFlagSchema = z.enum([
  'guaranteed_return',
  'no_risk_claim',
  'unlicensed_regulated_activity',
  'third_party_allegation',
  'misleading_authority_claim',
]);
export type ComplianceFlag = z.infer<typeof ComplianceFlagSchema>;

/** Токены источников оценки. Строка ложится в `scoring.scores.sources[].type`. */
export const ScoreSourceTokenSchema = z.enum([
  'application_text',
  'title',
  'stage',
  'materials',
  'material:deck',
  'material:doc',
  'material:video',
  'material:product_link',
  'reference_data',
]);
export type ScoreSourceToken = z.infer<typeof ScoreSourceTokenSchema>;

/** Категории фактов — ровно список `CHECK` в `scoring.passport_facts`. */
export const FactCategorySchema = z.enum([
  'team',
  'tech',
  'market',
  'competitors',
  'legal',
  'finance',
  'traction',
  'ip',
]);
export type FactCategory = z.infer<typeof FactCategorySchema>;

export const FactSourceTypeSchema = z.enum([
  'application_text',
  'title',
  'metadata',
  'materials',
  'reference_data',
]);

/**
 * Коды потолков. Значение потолка код считает САМ по коду и стадии — число,
 * присланное моделью, служит контролем, а не источником (ADR-008 §3).
 */
export const CapRuleSchema = z.enum([
  'no_verifiable_activity_claims',
  'business_model_missing',
  'numbers_contradict',
  'no_product_customer_money',
  'legal_form_missing',
  'ask_without_use_of_funds',
]);
export type CapRule = z.infer<typeof CapRuleSchema>;

export const PenaltyRuleSchema = z.enum([
  'no_competitors_claim',
  'single_channel',
  'single_supplier_dependency',
  'growth_without_absolute_numbers',
  'stage_mismatch',
]);
export type PenaltyRule = z.infer<typeof PenaltyRuleSchema>;

export const ScoreBasisSchema = z.enum(['disclosure', 'business']);
export const EvidenceLevelSchema = z.enum(['confirmed', 'claimed', 'absent']);

const AXES = ScoreAxisSchema.options;

/** Разбор IRS по осям: `<ось>`, `<ось>_w` и `sum`. Ключи — ровно 19. */
export const IrsBreakdownSchema = z
  .object({
    sum: z.number().min(0).max(100),
    ...Object.fromEntries(AXES.map((axis) => [axis, z.number().min(0).max(100)])),
    ...Object.fromEntries(AXES.map((axis) => [`${axis}_w`, z.number().min(0).max(100)])),
  })
  .strict();

const Short = (max: number) => z.string().max(max);

export const PassportSchema = z
  .object({
    score10: z.number().int().min(1).max(10),
    irsBreakdown: IrsBreakdownSchema,
    scoreBasis: ScoreBasisSchema,
    verdict: Short(600),
    strengths: z.array(Short(200)).max(5),
    weaknesses: z.array(Short(200)).max(5),
    risks: z.array(z.object({ risk: Short(300), mitigation: Short(300) }).strict()).max(7),
    capsApplied: z
      .array(z.object({ rule: CapRuleSchema, cap: z.number().int().min(1).max(10) }).strict())
      .max(6),
    penaltiesApplied: z.array(PenaltyRuleSchema).max(5),
    integrityFlags: z.array(IntegrityFlagSchema).max(7),
    complianceFlags: z.array(ComplianceFlagSchema).max(5),
    businessModel: Short(300),
    askSanity: Short(300),
    investorExit: Short(300),
    evidenceLevel: EvidenceLevelSchema,
  })
  .strict();
export type Passport = z.infer<typeof PassportSchema>;

/**
 * То, что ДОБАВЛЯЕТ ядро после проверки правилами (ADR-008 §3–4).
 *
 * `score10` в исходной форме — значение модели, оно служит контролем.
 * Публикуемое число — `score10Published`: равно базовому, пока человек не
 * подтвердил потолки и штрафы.
 */
export const PassportComputedSchema = z
  .object({
    score10Base: z.number().int().min(1).max(10),
    score10Proposed: z.number().int().min(1).max(10),
    score10Published: z.number().int().min(1).max(10),
    irsComputed: z.number().min(0).max(100),
    /** Расхождения модели с кодом — журнал, не отказ. */
    discrepancies: z.array(Short(200)).max(20),
    review: z
      .object({
        status: z.enum(['none', 'pending', 'confirmed', 'rejected']),
        decidedBy: z.string().uuid().nullable(),
        decidedAt: z.string().nullable(),
      })
      .strict(),
    /**
     * Решение человека по флагам комплаенса. `pending` блокирует публикацию
     * листинга (ADR-008 §4): обещание гарантированной доходности — не минус
     * балл, а признак, требующий остановки и разбора.
     */
    complianceReview: z
      .object({
        status: z.enum(['none', 'pending', 'allowed', 'blocked']),
        decidedBy: z.string().uuid().nullable(),
        decidedAt: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export type PassportComputed = z.infer<typeof PassportComputedSchema>;

/** Очередь решений человека по оценкам ИИ — для админки. */
export const ScoringReviewItemSchema = z.object({
  passportId: z.string().uuid(),
  projectId: z.string().uuid(),
  projectTitle: z.string(),
  passportVersion: z.number().int().positive(),
  publishedAt: z.string().nullable(),
  score10Base: z.number().int(),
  score10Proposed: z.number().int(),
  score10Published: z.number().int(),
  capsApplied: z.array(z.object({ rule: CapRuleSchema, cap: z.number().int() })),
  penaltiesApplied: z.array(PenaltyRuleSchema),
  complianceFlags: z.array(ComplianceFlagSchema),
  integrityFlags: z.array(IntegrityFlagSchema),
  reviewStatus: z.enum(['none', 'pending', 'confirmed', 'rejected']),
  complianceStatus: z.enum(['none', 'pending', 'allowed', 'blocked']),
});
export type ScoringReviewItem = z.infer<typeof ScoringReviewItemSchema>;

export const ScoringReviewDecisionSchema = z.object({
  decision: z.enum(['confirm', 'reject', 'allow', 'block']),
  reason: z.string().min(3).max(500),
});
export type ScoringReviewDecision = z.infer<typeof ScoringReviewDecisionSchema>;

export const StoredPassportSchema = PassportSchema.merge(PassportComputedSchema).strict();
export type StoredPassport = z.infer<typeof StoredPassportSchema>;

// ------------------------------------------------------------------ панель: ключ провайдера

/** Провайдеры, для которых панель принимает ключ. Совпадает с CHECK в M066 и политикой шлюза. */
export const LlmProviderSchema = z.enum(['yandex_gpt', 'gigachat', 'anthropic', 'openai']);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

/** Что панель видит о ключе: отпечаток и метаданные, самого ключа здесь нет и не будет. */
export const AiProviderCredentialSchema = z.object({
  provider: LlmProviderSchema,
  keyFingerprint: z.string().regex(/^[0-9a-f]{12}$/),
  modelName: z.string().max(120).nullable(),
  isActive: z.boolean(),
  setBy: z.string().uuid(),
  setAt: z.string(),
  lastCheckedAt: z.string().nullable(),
  lastCheckOk: z.boolean().nullable(),
});
export type AiProviderCredential = z.infer<typeof AiProviderCredentialSchema>;

export const UpsertAiProviderCredentialRequestSchema = z.object({
  provider: LlmProviderSchema,
  apiKey: z.string().min(8).max(512),
  modelName: z.string().max(120).optional(),
  /** Основание — в неизменяемый журнал: задать ключ — операция с деньгами. */
  reason: z.string().min(3).max(500),
});
export type UpsertAiProviderCredentialRequest = z.infer<
  typeof UpsertAiProviderCredentialRequestSchema
>;

export const AiProviderCheckResultSchema = z.object({
  ok: z.boolean(),
  provider: LlmProviderSchema,
  model: z.string().max(120).nullable().optional(),
  code: z.string().max(60).optional(),
  durationMs: z.number().nonnegative(),
});
export type AiProviderCheckResult = z.infer<typeof AiProviderCheckResultSchema>;
