import { z } from 'zod';
import { UuidSchema, MoneyAmountSchema, CurrencySchema } from '../common/primitives';
import { ProjectStageSchema, type ProjectStage } from './lab';
import { BusinessTypeSchema, FundingScopeSchema, QuestionKeySchema } from './application';
import {
  FormLocaleSchema,
  FormQuestionTypeSchema,
  isAnswerFilled,
  resolveText,
  sortedQuestions,
  sortedSections,
  type ApplicationFormConfig,
  type FormQuestion,
} from './application-form';

/**
 * Представления заявки по правилам видимости (план 0.2 §2.11).
 *
 * Один модуль собирает то, что увидит инвестор, — из черновика (предпросмотр
 * в мастере, этап 4.4) и из снимка (карточка, этап 7). Правило одно: в
 * представление попадают только вопросы с видимостью `public` или
 * `investors`; `platform` (только платформа и скоринг) и `private` (владелец
 * и админ) не попадают никогда. Пустые ответы не показываются — инвестор
 * видит то, что есть, а не форму с прочерками.
 *
 * Предпросмотр честен ровно потому, что собирается этой же функцией из тех
 * же данных, что и представление после подачи: расхождения нет по
 * конструкции, а не по обещанию.
 */

export const PreviewVisibilitySchema = z.enum(['public', 'investors']);

export const ApplicationPreviewQuestionSchema = z.object({
  key: QuestionKeySchema,
  type: FormQuestionTypeSchema,
  visibility: PreviewVisibilitySchema,
  label: z.string(),
  /** Значение как хранится: строка, число, коды, идентификаторы материалов. */
  value: z.unknown(),
  /** Человекочитаемое значение: подписи вариантов, «да/нет», число материалов. */
  display: z.string(),
  /** Подтверждения, привязанные к ответу (идентификаторы материалов проекта). */
  evidence: z.array(UuidSchema),
});
export type ApplicationPreviewQuestion = z.infer<typeof ApplicationPreviewQuestionSchema>;

export const ApplicationPreviewSectionSchema = z.object({
  key: QuestionKeySchema,
  title: z.string(),
  questions: z.array(ApplicationPreviewQuestionSchema),
});

export const ApplicationPreviewSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  stage: ProjectStageSchema,
  locale: FormLocaleSchema,
  /** Для кого собрано: инвестор с подпиской видит `public` + `investors`. */
  audience: z.literal('investors'),
  project: z.object({
    title: z.string(),
    tagline: z.string().nullable(),
    description: z.string().nullable(),
    taxonomyId: UuidSchema.nullable(),
    geoCountry: z.string().nullable(),
    geoRegion: z.string().nullable(),
  }),
  core: z.object({
    title: z.string().nullable(),
    stage: ProjectStageSchema,
    businessType: BusinessTypeSchema.nullable(),
    fundingScope: FundingScopeSchema.nullable(),
    fundingScopeNote: z.string().nullable(),
    investmentAsk: MoneyAmountSchema.nullable(),
    askCurrency: CurrencySchema,
  }),
  sections: z.array(ApplicationPreviewSectionSchema),
  /** Сколько заполненных ответов НЕ показано инвестору (platform / private). */
  withheld: z.number().int().nonnegative(),
});
export type ApplicationPreview = z.infer<typeof ApplicationPreviewSchema>;

export interface PreviewSource {
  core: ApplicationPreview['core'];
  answers: Record<string, unknown>;
  evidence: Record<string, readonly string[] | undefined>;
  project: ApplicationPreview['project'];
}

function coreValue(question: FormQuestion, core: ApplicationPreview['core']): unknown {
  switch (question.coreField) {
    case 'stage':
      return core.stage;
    case 'business_type':
      return core.businessType;
    case 'funding_scope':
      return core.fundingScope;
    case 'funding_scope_note':
      return core.fundingScopeNote;
    case 'investment_ask':
      return core.investmentAsk;
    default:
      return undefined;
  }
}

function displayValue(
  question: FormQuestion,
  value: unknown,
  evidence: readonly string[],
  locale: string,
  defaultLocale: string,
): string {
  const optionLabel = (code: unknown): string => {
    const option = (question.options ?? []).find((o) => o.code === code);
    if (!option) return String(code);
    return resolveText(option.texts, 'label', locale, defaultLocale).value ?? option.code;
  };
  switch (question.type) {
    case 'select':
      return optionLabel(value);
    case 'multiselect':
      return Array.isArray(value) ? value.map(optionLabel).join(', ') : '';
    case 'boolean':
      return value ? 'да' : 'нет';
    case 'material_ref': {
      const count = (Array.isArray(value) ? value.length : 0) + evidence.length;
      return `материалов: ${count}`;
    }
    case 'number':
      return typeof value === 'number' ? String(value) : '';
    default:
      return typeof value === 'string'
        ? value
        : value === null || value === undefined
          ? ''
          : String(value);
  }
}

/**
 * Собрать инвесторское представление из формы версии и данных заявки
 * (черновик или снимок — форма данных одна: `core`, `answers`, `evidence`).
 */
export function buildApplicationPreview(
  form: ApplicationFormConfig,
  params: { schemaVersion: number; stage: ProjectStage; locale: string },
  source: PreviewSource,
): ApplicationPreview {
  const { defaultLocale } = form;
  const bySection = new Map<string, ApplicationPreviewQuestion[]>();
  let withheld = 0;

  for (const question of sortedQuestions(form)) {
    if (question.stages[params.stage] === 'hidden') continue;
    if (question.coreField === 'funding_scope_note' && source.core.fundingScope !== 'direction') {
      continue;
    }
    const value = question.coreField
      ? coreValue(question, source.core)
      : source.answers[question.key];
    const evidence = [...(source.evidence[question.key] ?? [])];
    if (!isAnswerFilled(question, value, evidence)) continue;

    if (question.visibility === 'platform' || question.visibility === 'private') {
      withheld += 1;
      continue;
    }
    const label =
      resolveText(question.texts, 'label', params.locale, defaultLocale).value ?? question.key;
    const list = bySection.get(question.section) ?? [];
    list.push({
      key: question.key,
      type: question.type,
      visibility: question.visibility,
      label,
      value: value ?? null,
      display: displayValue(question, value, evidence, params.locale, defaultLocale),
      evidence,
    });
    bySection.set(question.section, list);
  }

  const sections = sortedSections(form)
    .filter((section) => (bySection.get(section.key)?.length ?? 0) > 0)
    .map((section) => ({
      key: section.key,
      title: resolveText(section.texts, 'title', params.locale, defaultLocale).value ?? section.key,
      questions: bySection.get(section.key)!,
    }));

  return {
    schemaVersion: params.schemaVersion,
    stage: params.stage,
    locale: params.locale,
    audience: 'investors',
    project: source.project,
    core: source.core,
    sections,
    withheld,
  };
}
