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
import { RoundProjectionSchema } from './funding-round';
import { visibleTo, type Audience } from './visibility';

/**
 * Представления заявки по правилам видимости (план 0.2 §2.11).
 *
 * Один модуль собирает то, что увидит зритель выбранной аудитории, — из
 * черновика (предпросмотр в мастере, этап 4.4) и из снимка (карточка, этап
 * 7). Правило одно (`visibleTo`): вопрос попадает в представление, если его
 * видимость не строже аудитории — анонимному посетителю только `public`,
 * инвестору `public` и `investors`; `platform` (только платформа и скоринг) и
 * `private` (владелец и админ) наружу не попадают никогда. Пустые ответы не
 * показываются — зритель видит то, что есть, а не форму с прочерками.
 *
 * Системные поля раунда (состояние, сумма, валюта, предмет) в предпросмотр
 * приходят готовой проекцией `round`, которую сервер считает по той же
 * настройке видимости из активной конфигурации (`lab.round_view_as`, M085) —
 * тем же путём, что каталог и карточки.
 *
 * Предпросмотр честен ровно потому, что собирается этой же функцией из тех
 * же данных, что и представление после подачи: расхождения нет по
 * конструкции, а не по обещанию.
 */

export const PreviewVisibilitySchema = z.enum(['public', 'investors']);
/** Аудитория предпросмотра: анонимный посетитель или инвестор с доступом. */
export const PreviewAudienceSchema = z.enum(['public', 'investors']);
export type PreviewAudience = z.infer<typeof PreviewAudienceSchema>;

export const ApplicationPreviewQuerySchema = z.object({
  locale: FormLocaleSchema.optional(),
  /** По умолчанию — инвестор с доступом (как до 5.6.4). */
  audience: PreviewAudienceSchema.optional(),
});
export type ApplicationPreviewQuery = z.infer<typeof ApplicationPreviewQuerySchema>;

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
  /** Для кого собрано: аноним видит `public`, инвестор с доступом — `public` + `investors`. */
  audience: PreviewAudienceSchema,
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
  /** Проекция раунда для этой аудитории — по настройке видимости, как в каталоге. */
  round: RoundProjectionSchema,
  sections: z.array(ApplicationPreviewSectionSchema),
  /** Сколько заполненных ответов НЕ показано этой аудитории. */
  withheld: z.number().int().nonnegative(),
  /**
   * Активная версия конфигурации на момент сборки (5.7.3): подача несёт её
   * обратно как подтверждение «я видел предпросмотр по этим условиям».
   * В чистой сборке (`buildApplicationPreview`) отсутствует — ставит сервер.
   */
  activeFormVersion: z.number().int().nonnegative().optional(),
  /**
   * Отпечаток показанного содержимого (5.7.4): подача возвращает его, и
   * сервер сверяет с текущим состоянием заявки — изменённые после
   * предпросмотра ответы нельзя подтвердить молча. Ставит сервер.
   */
  contentDigest: z.string().optional(),
});
export type ApplicationPreview = z.infer<typeof ApplicationPreviewSchema>;

/**
 * Подача профиля (5.7.3) = согласие владельца показывать поданный снимок по
 * условиям версии формы заявки. `activeFormVersion` — версия, которую
 * владелец видел в предпросмотре; если администратор успел опубликовать
 * другую, сервер отвечает 409 и просит посмотреть предпросмотр заново.
 */
export const SubmitApplicationRequestSchema = z.object({
  activeFormVersion: z.number().int().nonnegative(),
  /** Отпечаток содержимого из предпросмотра; расхождение с текущим черновиком — 409. */
  contentDigest: z.string().min(8).max(64),
});
export type SubmitApplicationRequest = z.infer<typeof SubmitApplicationRequestSchema>;

export interface PreviewSource {
  core: ApplicationPreview['core'];
  answers: Record<string, unknown>;
  evidence: Record<string, readonly string[] | undefined>;
  project: ApplicationPreview['project'];
  round: ApplicationPreview['round'];
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
  params: {
    schemaVersion: number;
    stage: ProjectStage;
    locale: string;
    audience?: PreviewAudience;
    /**
     * Эффективная видимость по ключу (5.7: строже из активной конфигурации и
     * версии условий, на которую согласился владелец). Без карты — видимость
     * вопроса из переданной формы; ключ, отсутствующий в карте, — `private`.
     */
    effectiveVisibility?: Readonly<Record<string, Audience>>;
  },
  source: PreviewSource,
): ApplicationPreview {
  const audience = params.audience ?? 'investors';
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

    const visibility = params.effectiveVisibility
      ? (params.effectiveVisibility[question.key] ?? 'private')
      : question.visibility;
    if (!visibleTo(visibility, audience)) {
      withheld += 1;
      continue;
    }
    const label =
      resolveText(question.texts, 'label', params.locale, defaultLocale).value ?? question.key;
    const list = bySection.get(question.section) ?? [];
    list.push({
      key: question.key,
      type: question.type,
      visibility: visibility as 'public' | 'investors',
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
    audience,
    project: source.project,
    core: source.core,
    round: source.round,
    sections,
    withheld,
  };
}
