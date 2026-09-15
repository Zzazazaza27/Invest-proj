import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from '../common/primitives';
import { type ProjectStage } from './lab';
import { ApplicationWithChecksSchema, QuestionKeySchema, type FundingScope } from './application';
import {
  applicableQuestions,
  isAnswerFilled,
  sortedQuestions,
  sortedSections,
  type ApplicationFormConfig,
  type FormQuestion,
} from './application-form';

/**
 * Готовность заявки — расчёт без ИИ (план 0.2 §4, постановка §9).
 *
 * «Готовность заявки: 74%» — насколько полно заполнен набор вопросов,
 * применимый к стадии; не инвестиционная оценка и не проверка смысла.
 * Формула чистая и детерминированная: одна и та же для ядра (подача,
 * снимок) и для мастера (полоса прогресса).
 *
 * Веса — ОТДЕЛЬНАЯ конфигурация с собственной версией и активацией
 * (`lab.readiness_configs`, §2.7), не часть документа вопросов: правка
 * текста или откат анкеты не должны менять формулу (поправка владельца
 * 2026-09-15). Раздел, для которого вес не задан, считается с весом 1.
 */

export const ReadinessConfigSchema = z.object({
  /** Вес раздела в проценте; 0 — раздел не влияет на процент. */
  sections: z.record(QuestionKeySchema, z.object({ weight: z.number().min(0).max(1000) })),
  /** Баллы за заполненный вопрос по состоянию. */
  levelPoints: z.object({
    mandatory: z.number().positive().max(100),
    recommended: z.number().min(0).max(100),
  }),
});
export type ReadinessConfig = z.infer<typeof ReadinessConfigSchema>;

export const ReadinessConfigVersionSchema = z.object({
  id: UuidSchema,
  version: z.number().int().positive(),
  /** К какой версии конфигурации вопросов относились веса при активации. */
  schemaVersion: z.number().int().nonnegative(),
  config: ReadinessConfigSchema,
  isActive: z.boolean(),
  createdBy: UuidSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  reason: z.string(),
});
export type ReadinessConfigVersion = z.infer<typeof ReadinessConfigVersionSchema>;

export const ActivateReadinessConfigRequestSchema = z.object({
  config: ReadinessConfigSchema,
  reason: z.string().trim().min(3).max(500),
});
export type ActivateReadinessConfigRequest = z.infer<typeof ActivateReadinessConfigRequestSchema>;

/** Стартовые веса: все разделы формы по 1, обязательный вопрос вдвое дороже рекомендуемого. */
export function defaultReadinessConfig(form: ApplicationFormConfig): ReadinessConfig {
  return {
    sections: Object.fromEntries(form.sections.map((s) => [s.key, { weight: 1 }])),
    levelPoints: { mandatory: 2, recommended: 1 },
  };
}

// ------------------------------------------------------------ результат

export const ReadinessSectionStatusSchema = z.enum([
  'not_started',
  'partial',
  'complete',
  'attention',
]);
export type ReadinessSectionStatus = z.infer<typeof ReadinessSectionStatusSchema>;

export const ReadinessSectionSchema = z.object({
  key: QuestionKeySchema,
  status: ReadinessSectionStatusSchema,
  applicable: z.number().int().nonnegative(),
  filled: z.number().int().nonnegative(),
  missingMandatory: z.array(QuestionKeySchema),
});
export type ReadinessSection = z.infer<typeof ReadinessSectionSchema>;

export const ApplicationReadinessSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  readinessConfigVersion: z.number().int().positive().nullable(),
  percent: z.number().int().min(0).max(100),
  /** Все обязательные для стадии вопросы заполнены. Единственный критерий кнопки «Подать». */
  canSubmit: z.boolean(),
  missingMandatory: z.array(QuestionKeySchema),
  sections: z.array(ReadinessSectionSchema),
});
export type ApplicationReadiness = z.infer<typeof ApplicationReadinessSchema>;

/** Заявка с условиями подачи и готовностью — ответ `GET/PATCH /applications/:id`. */
export const ApplicationDetailSchema = ApplicationWithChecksSchema.extend({
  readiness: ApplicationReadinessSchema,
});
export type ApplicationDetail = z.infer<typeof ApplicationDetailSchema>;

/** Что нужно от заявки для расчёта: системные поля и ответы. */
export interface ReadinessInput {
  stage: ProjectStage;
  businessType: string | null;
  fundingScope: FundingScope;
  fundingScopeNote: string | null;
  investmentAsk: string | null;
  answers: Record<string, unknown>;
  evidence: Record<string, readonly string[] | undefined>;
}

/** Значение системного вопроса — из колонок, не из `answers`. */
function coreValue(question: FormQuestion, input: ReadinessInput): unknown {
  switch (question.coreField) {
    case 'stage':
      return input.stage;
    case 'business_type':
      return input.businessType;
    case 'funding_scope':
      return input.fundingScope;
    case 'funding_scope_note':
      return input.fundingScopeNote;
    case 'investment_ask':
      return input.investmentAsk;
    default:
      return input.answers[question.key];
  }
}

/**
 * Расчёт (план 0.2 §4):
 *
 *  1. применимое = вопросы стадии с состоянием mandatory / recommended
 *     (hidden и архивные не участвуют); `funding_scope_note` применим только
 *     при предмете финансирования «направление» — системное условие;
 *  2. «заполнено» — по типу (`isAnswerFilled`); системные поля читаются из
 *     колонок;
 *  3. балл раздела = Σ баллов заполненных / Σ баллов применимых; раздел без
 *     применимых вопросов из расчёта исключается;
 *  4. процент = round(100 · Σ w·s / Σ w) по оставшимся разделам; веса
 *     нормализуются, раздел без веса — 1, вес 0 — раздел не влияет;
 *  5. `canSubmit` — все mandatory заполнены; `missingMandatory` — их ключи в
 *     порядке формы.
 */
export function computeCompleteness(
  form: ApplicationFormConfig,
  readiness: ReadinessConfig,
  input: ReadinessInput,
  meta: { schemaVersion: number; readinessConfigVersion: number | null },
): ApplicationReadiness {
  const levels = applicableQuestions(form, input.stage);
  const questions = new Map(sortedQuestions(form).map((q) => [q.key, q]));

  const perSection = new Map<
    string,
    { earned: number; possible: number; applicable: number; filled: number; missing: string[] }
  >();
  const missingMandatory: string[] = [];

  for (const [key, level] of levels) {
    const question = questions.get(key);
    if (!question) continue;
    if (question.coreField === 'funding_scope_note' && input.fundingScope !== 'direction') {
      continue;
    }
    const points = readiness.levelPoints[level];
    const filled = isAnswerFilled(question, coreValue(question, input), input.evidence[key]);
    const bucket = perSection.get(question.section) ?? {
      earned: 0,
      possible: 0,
      applicable: 0,
      filled: 0,
      missing: [],
    };
    bucket.applicable += 1;
    bucket.possible += points;
    if (filled) {
      bucket.filled += 1;
      bucket.earned += points;
    } else if (level === 'mandatory') {
      bucket.missing.push(key);
      missingMandatory.push(key);
    }
    perSection.set(question.section, bucket);
  }

  const sections: ReadinessSection[] = [];
  let weightedSum = 0;
  let weightTotal = 0;
  for (const section of sortedSections(form)) {
    const bucket = perSection.get(section.key);
    if (!bucket || bucket.applicable === 0) continue;
    const weight = readiness.sections[section.key]?.weight ?? 1;
    const score = bucket.possible > 0 ? bucket.earned / bucket.possible : 1;
    weightedSum += weight * score;
    weightTotal += weight;
    // Нетронутый раздел — «не начат», даже если в нём есть обязательные:
    // «требует внимания» — сигнал о начатом, но не доведённом разделе, а не
    // оранжевая метка на всём подряд до первого ответа.
    sections.push({
      key: section.key,
      status:
        bucket.filled === 0
          ? 'not_started'
          : bucket.missing.length > 0
            ? 'attention'
            : bucket.filled === bucket.applicable
              ? 'complete'
              : 'partial',
      applicable: bucket.applicable,
      filled: bucket.filled,
      missingMandatory: bucket.missing,
    });
  }

  const percent = weightTotal > 0 ? Math.round((100 * weightedSum) / weightTotal) : 0;
  return {
    schemaVersion: meta.schemaVersion,
    readinessConfigVersion: meta.readinessConfigVersion,
    percent: Math.max(0, Math.min(100, percent)),
    canSubmit: missingMandatory.length === 0,
    missingMandatory,
    sections,
  };
}
