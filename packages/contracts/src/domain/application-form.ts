import { z } from 'zod';
import { IsoDateTimeSchema, MoneyAmountSchema, UuidSchema } from '../common/primitives';
import { ProjectStageSchema, type ProjectStage } from './lab';
import { BusinessTypeSchema, FundingScopeSchema, QuestionKeySchema } from './application';

/**
 * Конфигурация вопросов инвестиционной заявки
 * (docs/architecture/заявка-02-технический-план.md §0в).
 *
 * Состав вопросов, их порядок, тексты и обязательность по стадиям — ДАННЫЕ:
 * документ этой формы лежит в `lab.application_form_versions`, публикуется
 * версиями и откатывается активацией прежней версии. Кодом остаются типы
 * полей, системные (core) поля, правила проверки документа и всё, что из
 * него выводится: схема ответов, применимость по стадии, форма для стадии.
 *
 * JSONB-документ — внутренняя реализация. Администратор его не редактирует:
 * он работает с таблицей стадий, карточкой вопроса и предпросмотром; клиент
 * админки собирает документ, сервер принимает его только через
 * `ApplicationFormConfigSchema` и проверки публикации (`checkAgainstPublished`).
 *
 * Три состояния на стадии и ничего больше: `mandatory` — обязателен ПРИ
 * ПОДАЧЕ (черновик свободен), `recommended` — поднимает готовность, не
 * блокирует, `hidden` — не показывается и не считается. Тип бизнеса в первой
 * версии на состав не влияет; место под правило по типу зарезервировано
 * (`businessTypes`), но не читается.
 */

// ------------------------------------------------------------ словари

export const FORM_STAGE_STATES = ['mandatory', 'recommended', 'hidden'] as const;
export const FormStageStateSchema = z.enum(FORM_STAGE_STATES);
export type FormStageState = z.infer<typeof FormStageStateSchema>;

export const FORM_QUESTION_TYPES = [
  'text',
  'textarea',
  'number',
  'money',
  'select',
  'multiselect',
  'boolean',
  'url',
  'date',
  'material_ref',
] as const;
export const FormQuestionTypeSchema = z.enum(FORM_QUESTION_TYPES);
export type FormQuestionType = z.infer<typeof FormQuestionTypeSchema>;

export const FormVisibilitySchema = z.enum(['public', 'investors', 'platform', 'private']);
export type FormVisibility = z.infer<typeof FormVisibilitySchema>;

/** Код языка как в `content.languages`: `ru-RU`, `en-US`. */
export const FormLocaleSchema = z.string().regex(/^[a-z]{2}-[A-Z]{2}$/, 'код языка');
export const DEFAULT_FORM_LOCALE = 'ru-RU';

export const QUESTION_TEXT_FIELDS = [
  'label',
  'placeholder',
  'help_md',
  'example_good_md',
  'example_weak_md',
] as const;
export const SECTION_TEXT_FIELDS = ['title', 'intro_md'] as const;

/** Код варианта `select` / `multiselect` — как ключ вопроса: стабилен, латиница. */
export const OptionCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'код варианта');

const TextFieldNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, 'имя текстового поля');
const TextBodySchema = z.string().max(20_000);

/** `{ 'ru-RU': { label: '…', help_md: '…' }, 'en-US': { … } }` */
export const LocalizedTextsSchema = z.record(
  FormLocaleSchema,
  z.record(TextFieldNameSchema, TextBodySchema),
);
export type LocalizedTexts = z.infer<typeof LocalizedTextsSchema>;

// ------------------------------------------------------------ документ

export const FormOptionSchema = z.object({
  code: OptionCodeSchema,
  texts: LocalizedTextsSchema,
});
export type FormOption = z.infer<typeof FormOptionSchema>;

/**
 * Назначение раздела (план 0.2 §0г, заявка-03 §2.4): `profile` — вопросы
 * инвестиционного профиля; `round` — вопросы раунда привлечения. Раздел
 * раунда остаётся в той же конфигурации (тексты и обязательность правятся
 * той же таблицей), но показывается только при раунде, а его ответы живут в
 * раунде, не в заявке. Это системная зависимость кодом, не редактор условий.
 */
export const FormSectionScopeSchema = z.enum(['profile', 'round']);
export type FormSectionScope = z.infer<typeof FormSectionScopeSchema>;

export const FormSectionSchema = z.object({
  key: QuestionKeySchema,
  order: z.number().int().min(0),
  texts: LocalizedTextsSchema,
  /** Отсутствие = совместимость: раздел `funding` конфигураций до M081 — раунд. */
  scope: FormSectionScopeSchema.optional(),
});
export type FormSection = z.infer<typeof FormSectionSchema>;

/**
 * Назначение раздела с учётом совместимости: конфигурации, опубликованные до
 * появления признака (версия 1, схема 0), держат вопросы раунда в разделе
 * `funding`. Явный признак имеет приоритет.
 */
export function sectionScope(section: Pick<FormSection, 'key' | 'scope'>): FormSectionScope {
  return section.scope ?? (section.key === 'funding' ? 'round' : 'profile');
}

export const FormStageStatesSchema = z.object({
  idea: FormStageStateSchema,
  mvp: FormStageStateSchema,
  early_revenue: FormStageStateSchema,
  growth: FormStageStateSchema,
});
export type FormStageStates = z.infer<typeof FormStageStatesSchema>;

export const FormConstraintsSchema = z
  .object({
    minLength: z.number().int().min(0).optional(),
    maxLength: z.number().int().min(1).max(20_000).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    maxItems: z.number().int().min(1).max(50).optional(),
  })
  .strict();
export type FormConstraints = z.infer<typeof FormConstraintsSchema>;

export const FORM_CORE_FIELDS = [
  'stage',
  'business_type',
  'funding_scope',
  'funding_scope_note',
  'investment_ask',
] as const;
export const FormCoreFieldSchema = z.enum(FORM_CORE_FIELDS);
export type FormCoreField = z.infer<typeof FormCoreFieldSchema>;

/**
 * Системные вопросы — колонки `lab.investment_applications` (M071), а не
 * `answers`. Ключ, тип и коды вариантов — код; админка меняет только
 * подписи. `fixedState` — состояние, которое админка менять не может: сумма,
 * стадия и предмет финансирования обязательны при подаче по CHECK таблицы.
 * `funding_scope_note` формально `mandatory`, а показывается и требуется
 * только при `funding_scope = direction` — единственное условие по ответу,
 * и оно системное (§0в.3).
 */
export const FORM_CORE_QUESTIONS: Record<
  FormCoreField,
  { type: FormQuestionType; options?: readonly string[]; fixedState?: FormStageState }
> = {
  stage: { type: 'select', options: ProjectStageSchema.options, fixedState: 'mandatory' },
  business_type: { type: 'select', options: BusinessTypeSchema.options },
  funding_scope: { type: 'select', options: FundingScopeSchema.options, fixedState: 'mandatory' },
  funding_scope_note: { type: 'text', fixedState: 'mandatory' },
  investment_ask: { type: 'money', fixedState: 'mandatory' },
};

export const FormQuestionSchema = z.object({
  key: QuestionKeySchema,
  section: QuestionKeySchema,
  order: z.number().int().min(0),
  type: FormQuestionTypeSchema,
  options: z.array(FormOptionSchema).max(50).optional(),
  stages: FormStageStatesSchema,
  visibility: FormVisibilitySchema,
  evidence: z.boolean().optional(),
  constraints: FormConstraintsSchema.optional(),
  coreField: FormCoreFieldSchema.optional(),
  archivedAt: IsoDateTimeSchema.nullable().optional(),
  texts: LocalizedTextsSchema,
  /** Зарезервировано под правила по типу бизнеса; в первой версии не читается. */
  businessTypes: z.array(BusinessTypeSchema).optional(),
});
export type FormQuestion = z.infer<typeof FormQuestionSchema>;

const FormConfigShapeSchema = z.object({
  locales: z.array(FormLocaleSchema).min(1).max(20),
  defaultLocale: FormLocaleSchema,
  sections: z.array(FormSectionSchema).min(1).max(50),
  questions: z.array(FormQuestionSchema).max(500),
});
export type ApplicationFormConfig = z.infer<typeof FormConfigShapeSchema>;

export interface FormConfigIssue {
  path: string;
  message: string;
}

/**
 * Структурные правила документа — то, без чего форму нельзя ни показать, ни
 * посчитать. Возвращает список, а не бросает: админка показывает всё сразу.
 */
export function validateFormConfig(config: ApplicationFormConfig): FormConfigIssue[] {
  const issues: FormConfigIssue[] = [];
  const push = (path: string, message: string) => issues.push({ path, message });

  if (!config.locales.includes(config.defaultLocale)) {
    push('defaultLocale', 'язык по умолчанию должен быть в списке языков');
  }

  const sectionKeys = new Set<string>();
  for (const section of config.sections) {
    if (sectionKeys.has(section.key)) push(`sections.${section.key}`, 'ключ раздела повторяется');
    sectionKeys.add(section.key);
    if (!section.texts[config.defaultLocale]?.title?.trim()) {
      push(
        `sections.${section.key}.texts.${config.defaultLocale}.title`,
        'у раздела нет заголовка',
      );
    }
  }

  const questionKeys = new Set<string>();
  const coreSeen = new Map<FormCoreField, string>();
  for (const q of config.questions) {
    const at = `questions.${q.key}`;
    if (questionKeys.has(q.key)) push(at, 'ключ вопроса повторяется');
    questionKeys.add(q.key);
    if (!sectionKeys.has(q.section)) push(`${at}.section`, `раздел «${q.section}» не существует`);

    const isChoice = q.type === 'select' || q.type === 'multiselect';
    if (isChoice) {
      if (!q.options?.length) push(`${at}.options`, 'у вопроса с выбором нет вариантов');
      const codes = new Set<string>();
      for (const option of q.options ?? []) {
        if (codes.has(option.code))
          push(`${at}.options.${option.code}`, 'код варианта повторяется');
        codes.add(option.code);
        if (!option.texts[config.defaultLocale]?.label?.trim()) {
          push(`${at}.options.${option.code}`, 'у варианта нет подписи на языке по умолчанию');
        }
      }
    } else if (q.options?.length) {
      push(`${at}.options`, 'варианты допустимы только у select / multiselect');
    }

    const c = q.constraints;
    if (c) {
      if (c.minLength !== undefined && c.maxLength !== undefined && c.minLength > c.maxLength) {
        push(`${at}.constraints`, 'minLength больше maxLength');
      }
      if (c.min !== undefined && c.max !== undefined && c.min > c.max) {
        push(`${at}.constraints`, 'min больше max');
      }
    }

    if (!q.archivedAt && !q.texts[config.defaultLocale]?.label?.trim()) {
      push(
        `${at}.texts.${config.defaultLocale}.label`,
        'у вопроса нет формулировки на языке по умолчанию',
      );
    }

    if (q.coreField) {
      const rule = FORM_CORE_QUESTIONS[q.coreField];
      if (coreSeen.has(q.coreField)) {
        push(
          `${at}.coreField`,
          `системное поле ${q.coreField} уже занято вопросом ${coreSeen.get(q.coreField)}`,
        );
      }
      coreSeen.set(q.coreField, q.key);
      if (q.key !== q.coreField)
        push(`${at}.coreField`, 'ключ системного вопроса равен имени поля');
      if (q.type !== rule.type)
        push(`${at}.type`, `тип системного поля ${q.coreField} — ${rule.type}`);
      if (q.archivedAt) push(`${at}.archivedAt`, 'системный вопрос нельзя архивировать');
      if (rule.options) {
        const codes = (q.options ?? []).map((o) => o.code);
        const expected = [...rule.options];
        if (codes.length !== expected.length || expected.some((code) => !codes.includes(code))) {
          push(
            `${at}.options`,
            `коды вариантов системного поля фиксированы: ${expected.join(', ')}`,
          );
        }
      }
      if (rule.fixedState) {
        for (const stage of ProjectStageSchema.options) {
          if (q.stages[stage] !== rule.fixedState) {
            push(
              `${at}.stages.${stage}`,
              `состояние системного поля ${q.coreField} фиксировано: ${rule.fixedState}`,
            );
          }
        }
      }
    }
  }
  for (const field of FORM_CORE_FIELDS) {
    if (!coreSeen.has(field))
      push(`questions.${field}`, `системный вопрос ${field} обязан присутствовать`);
  }
  return issues;
}

/** Документ конфигурации: форма + структурные правила одним разбором. */
export const ApplicationFormConfigSchema = FormConfigShapeSchema.superRefine((config, ctx) => {
  for (const issue of validateFormConfig(config)) {
    ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path.split('.') });
  }
});

/** Что известно о ключе из уже опубликованных версий. */
export interface PublishedQuestionKey {
  key: string;
  type: FormQuestionType;
}

/**
 * Правила эволюции между версиями (§0в п.5, поправка владельца): ключ,
 * встречавшийся в опубликованной версии, нельзя убрать из документа — только
 * архивировать; его тип нельзя менять; завести «новый» вопрос под старым
 * ключом невозможно, потому что ключ уже занят. Смена смысла — новый ключ.
 */
export function checkAgainstPublished(
  next: ApplicationFormConfig,
  published: readonly PublishedQuestionKey[],
): FormConfigIssue[] {
  const issues: FormConfigIssue[] = [];
  const byKey = new Map(next.questions.map((q) => [q.key, q]));
  for (const prev of published) {
    const q = byKey.get(prev.key);
    if (!q) {
      issues.push({
        path: `questions.${prev.key}`,
        message: 'опубликованный ключ нельзя удалить — только архивировать',
      });
    } else if (q.type !== prev.type) {
      issues.push({
        path: `questions.${prev.key}.type`,
        message: `тип опубликованного ключа фиксирован: ${prev.type}; для другого типа нужен новый ключ`,
      });
    }
  }
  return issues;
}

/** Собрать реестр ключей по всем опубликованным версиям. */
export function collectPublishedKeys(
  configs: readonly ApplicationFormConfig[],
): PublishedQuestionKey[] {
  const seen = new Map<string, FormQuestionType>();
  for (const config of configs) {
    for (const q of config.questions) if (!seen.has(q.key)) seen.set(q.key, q.type);
  }
  return [...seen].map(([key, type]) => ({ key, type }));
}

// ------------------------------------------------------------ выводимое

const byOrder = <T extends { order: number; key: string }>(a: T, b: T) =>
  a.order - b.order || a.key.localeCompare(b.key);

export function sortedSections(config: ApplicationFormConfig): FormSection[] {
  return [...config.sections].sort(byOrder);
}

/** Вопросы в порядке разделов и внутри раздела; архивные исключены. */
export function sortedQuestions(config: ApplicationFormConfig): FormQuestion[] {
  const sectionOrder = new Map(sortedSections(config).map((s, i) => [s.key, i]));
  return config.questions
    .filter((q) => !q.archivedAt)
    .sort(
      (a, b) =>
        (sectionOrder.get(a.section) ?? 0) - (sectionOrder.get(b.section) ?? 0) || byOrder(a, b),
    );
}

export type ApplicableLevel = Exclude<FormStageState, 'hidden'>;

/**
 * Что показывается на стадии и с каким состоянием, в порядке формы.
 * `hidden` и архивные не попадают; системные вопросы попадают (они
 * показываются), хотя ответы на них живут в колонках.
 */
export function applicableQuestions(
  config: ApplicationFormConfig,
  stage: ProjectStage,
): Map<string, ApplicableLevel> {
  const result = new Map<string, ApplicableLevel>();
  for (const q of sortedQuestions(config)) {
    const state = q.stages[stage];
    if (state !== 'hidden') result.set(q.key, state);
  }
  return result;
}

/** Текст поля с fallback на язык по умолчанию. `fallback` — взят ли запасной. */
export function resolveText(
  texts: LocalizedTexts,
  field: string,
  locale: string,
  defaultLocale: string,
): { value: string | null; fallback: boolean } {
  const own = texts[locale]?.[field];
  if (own !== undefined && own !== '') return { value: own, fallback: false };
  const base = texts[defaultLocale]?.[field];
  if (base !== undefined && base !== '') return { value: base, fallback: true };
  return { value: null, fallback: true };
}

// ------------------------------------------------------------ форма для стадии

export const FormOptionViewSchema = z.object({ code: OptionCodeSchema, label: z.string() });

export const FormQuestionViewSchema = z.object({
  key: QuestionKeySchema,
  type: FormQuestionTypeSchema,
  state: z.enum(['mandatory', 'recommended']),
  visibility: FormVisibilitySchema,
  evidence: z.boolean(),
  coreField: FormCoreFieldSchema.nullable(),
  constraints: FormConstraintsSchema.nullable(),
  label: z.string(),
  placeholder: z.string().nullable(),
  helpMd: z.string().nullable(),
  exampleGoodMd: z.string().nullable(),
  exampleWeakMd: z.string().nullable(),
  options: z.array(FormOptionViewSchema).nullable(),
});
export type FormQuestionView = z.infer<typeof FormQuestionViewSchema>;

export const FormSectionViewSchema = z.object({
  key: QuestionKeySchema,
  scope: FormSectionScopeSchema,
  title: z.string(),
  introMd: z.string().nullable(),
  questions: z.array(FormQuestionViewSchema),
});
export type FormSectionView = z.infer<typeof FormSectionViewSchema>;

/**
 * Форма, как её видит основатель: версия, стадия, язык, разделы с
 * вопросами в порядке и с текстами. Разделы без видимых вопросов не
 * показываются. `missing` — пути текстов, которых нет на запрошенном языке
 * (взят запасной или пусто): индикатор перевода для админки.
 */
export const ApplicationFormViewSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  stage: ProjectStageSchema,
  locale: FormLocaleSchema,
  sections: z.array(FormSectionViewSchema),
  missing: z.array(z.string()),
});
export type ApplicationFormView = z.infer<typeof ApplicationFormViewSchema>;

export function buildStageForm(
  config: ApplicationFormConfig,
  params: { schemaVersion: number; stage: ProjectStage; locale: string },
): ApplicationFormView {
  const { defaultLocale } = config;
  const missing: string[] = [];
  const text = (texts: LocalizedTexts, field: string, path: string): string | null => {
    const r = resolveText(texts, field, params.locale, defaultLocale);
    if (r.fallback && texts[defaultLocale]?.[field] !== undefined) missing.push(`${path}.${field}`);
    return r.value;
  };

  const questionsBySection = new Map<string, FormQuestionView[]>();
  for (const q of sortedQuestions(config)) {
    const state = q.stages[params.stage];
    if (state === 'hidden') continue;
    const path = `question.${q.key}`;
    const view: FormQuestionView = {
      key: q.key,
      type: q.type,
      state,
      visibility: q.visibility,
      evidence: q.evidence ?? false,
      coreField: q.coreField ?? null,
      constraints: q.constraints ?? null,
      label: text(q.texts, 'label', path) ?? q.key,
      placeholder: text(q.texts, 'placeholder', path),
      helpMd: text(q.texts, 'help_md', path),
      exampleGoodMd: text(q.texts, 'example_good_md', path),
      exampleWeakMd: text(q.texts, 'example_weak_md', path),
      options: q.options
        ? q.options.map((o) => ({
            code: o.code,
            label: text(o.texts, 'label', `option.${q.key}.${o.code}`) ?? o.code,
          }))
        : null,
    };
    const list = questionsBySection.get(q.section) ?? [];
    list.push(view);
    questionsBySection.set(q.section, list);
  }

  const sections: FormSectionView[] = [];
  for (const s of sortedSections(config)) {
    const questions = questionsBySection.get(s.key);
    if (!questions?.length) continue;
    const path = `section.${s.key}`;
    sections.push({
      key: s.key,
      scope: sectionScope(s),
      title: text(s.texts, 'title', path) ?? s.key,
      introMd: text(s.texts, 'intro_md', path),
      questions,
    });
  }
  return {
    schemaVersion: params.schemaVersion,
    stage: params.stage,
    locale: params.locale,
    sections,
    missing,
  };
}

// ------------------------------------------------------------ версии (админка)

export const FormVersionStatusSchema = z.enum(['draft', 'published']);

/** Строка `lab.application_form_versions` без документа — для списка и истории. */
export const ApplicationFormVersionSummarySchema = z.object({
  id: UuidSchema,
  /** Номер присваивается при публикации; у черновика `null`. */
  version: z.number().int().positive().nullable(),
  status: FormVersionStatusSchema,
  isActive: z.boolean(),
  basedOnVersion: z.number().int().positive().nullable(),
  reason: z.string().nullable(),
  createdBy: UuidSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  publishedBy: UuidSchema.nullable(),
  publishedAt: IsoDateTimeSchema.nullable(),
  activatedAt: IsoDateTimeSchema.nullable(),
  sections: z.number().int().nonnegative(),
  questions: z.number().int().nonnegative(),
});
export type ApplicationFormVersionSummary = z.infer<typeof ApplicationFormVersionSummarySchema>;

export const ApplicationFormVersionSchema = ApplicationFormVersionSummarySchema.extend({
  config: FormConfigShapeSchema,
});
export type ApplicationFormVersion = z.infer<typeof ApplicationFormVersionSchema>;

/** Обзор: какая версия активна, есть ли черновик, история публикаций. */
export const ApplicationFormVersionsSchema = z.object({
  activeVersion: z.number().int().positive().nullable(),
  draft: ApplicationFormVersionSummarySchema.nullable(),
  items: z.array(ApplicationFormVersionSummarySchema),
});
export type ApplicationFormVersions = z.infer<typeof ApplicationFormVersionsSchema>;

/**
 * Сохранить черновик: документ целиком. Клиент админки собирает его из
 * таблицы стадий и карточек вопросов; сервер принимает только документ,
 * прошедший схему и правила эволюции (`checkAgainstPublished`).
 */
export const SaveApplicationFormDraftRequestSchema = z.object({
  config: ApplicationFormConfigSchema,
});
export type SaveApplicationFormDraftRequest = z.infer<typeof SaveApplicationFormDraftRequestSchema>;

export const PublishApplicationFormRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type PublishApplicationFormRequest = z.infer<typeof PublishApplicationFormRequestSchema>;

export const ActivateApplicationFormRequestSchema = PublishApplicationFormRequestSchema;
export type ActivateApplicationFormRequest = PublishApplicationFormRequest;

export const ApplicationFormQuerySchema = z.object({
  locale: FormLocaleSchema.optional(),
});
export type ApplicationFormQuery = z.infer<typeof ApplicationFormQuerySchema>;

export const ApplicationFormPreviewQuerySchema = z.object({
  stage: ProjectStageSchema,
  locale: FormLocaleSchema.optional(),
});
export type ApplicationFormPreviewQuery = z.infer<typeof ApplicationFormPreviewQuerySchema>;

/**
 * Схема 0 — заявки переноса M071 и созданные до первой публикации: старая
 * форма из девяти полей проекта. Для них форма состоит из одних системных
 * вопросов, чтобы маршрут формы отвечал одинаково любой заявке; сами поля
 * этих заявок правит кабинет v1.
 */
export function legacyFormConfig(): ApplicationFormConfig {
  const ru = (label: string) => ({ [DEFAULT_FORM_LOCALE]: { label } });
  const mandatory: FormStageStates = {
    idea: 'mandatory',
    mvp: 'mandatory',
    early_revenue: 'mandatory',
    growth: 'mandatory',
  };
  const recommended: FormStageStates = {
    idea: 'recommended',
    mvp: 'recommended',
    early_revenue: 'recommended',
    growth: 'recommended',
  };
  const options = (codes: readonly string[]) => codes.map((code) => ({ code, texts: ru(code) }));
  return {
    locales: [DEFAULT_FORM_LOCALE],
    defaultLocale: DEFAULT_FORM_LOCALE,
    sections: [
      { key: 'project', order: 10, texts: { [DEFAULT_FORM_LOCALE]: { title: 'Проект' } } },
      {
        key: 'funding',
        order: 20,
        scope: 'round',
        texts: { [DEFAULT_FORM_LOCALE]: { title: 'Инвестиционный запрос' } },
      },
    ],
    questions: [
      {
        key: 'stage',
        section: 'project',
        order: 10,
        type: 'select',
        options: options(ProjectStageSchema.options),
        stages: mandatory,
        visibility: 'public',
        coreField: 'stage',
        texts: ru('Стадия проекта'),
      },
      {
        key: 'business_type',
        section: 'project',
        order: 20,
        type: 'select',
        options: options(BusinessTypeSchema.options),
        stages: recommended,
        visibility: 'public',
        coreField: 'business_type',
        texts: ru('Тип бизнеса'),
      },
      {
        key: 'funding_scope',
        section: 'funding',
        order: 10,
        type: 'select',
        options: options(FundingScopeSchema.options),
        stages: mandatory,
        visibility: 'public',
        coreField: 'funding_scope',
        texts: ru('На что привлекаются инвестиции'),
      },
      {
        key: 'funding_scope_note',
        section: 'funding',
        order: 20,
        type: 'text',
        stages: mandatory,
        visibility: 'public',
        constraints: { maxLength: 200 },
        coreField: 'funding_scope_note',
        texts: ru('Какое направление или этап'),
      },
      {
        key: 'investment_ask',
        section: 'funding',
        order: 30,
        type: 'money',
        stages: mandatory,
        visibility: 'public',
        coreField: 'investment_ask',
        texts: ru('Сумма запроса'),
      },
    ],
  };
}

// ------------------------------------------------------------ ответы

/** `YYYY-MM-DD` — дата без времени: даты в анкете — календарные. */
const IsoDateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'дата YYYY-MM-DD');
const HttpsUrlSchema = z
  .string()
  .max(2048)
  .refine((v) => /^https:\/\/[^\s]+$/i.test(v), 'ссылка только https://');

/** Схема значения одного вопроса по его типу и ограничениям. */
export function answerValueSchema(q: FormQuestion): z.ZodType {
  const c = q.constraints ?? {};
  switch (q.type) {
    case 'text':
    case 'textarea': {
      let s = z.string().max(c.maxLength ?? (q.type === 'text' ? 200 : 2000));
      if (c.minLength) s = s.min(c.minLength);
      return s;
    }
    case 'number': {
      let s = z.number().finite();
      if (c.min !== undefined) s = s.min(c.min);
      if (c.max !== undefined) s = s.max(c.max);
      return s;
    }
    case 'money':
      return MoneyAmountSchema;
    case 'select':
      return z.enum((q.options ?? []).map((o) => o.code) as [string, ...string[]]);
    case 'multiselect':
      return z
        .array(z.enum((q.options ?? []).map((o) => o.code) as [string, ...string[]]))
        .max(c.maxItems ?? 50);
    case 'boolean':
      return z.boolean();
    case 'url':
      return HttpsUrlSchema;
    case 'date':
      return IsoDateOnlySchema;
    case 'material_ref':
      return z.array(UuidSchema).max(c.maxItems ?? 20);
  }
}

/**
 * Схема `answers` для версии конфигурации: все неархивные несистемные
 * вопросы, каждый необязателен и допускает `null` (очистить). Скрытые по
 * стадии вопросы тоже здесь: при смене стадии ответы не теряются. Ключи вне
 * документа отвергаются — ответ без вопроса не имеет смысла.
 */
export function buildAnswersSchema(config: ApplicationFormConfig) {
  const shape: Record<string, z.ZodType> = {};
  for (const q of config.questions) {
    if (q.archivedAt || q.coreField) continue;
    shape[q.key] = answerValueSchema(q).nullable().optional();
  }
  return z.object(shape).strict();
}

/**
 * «Заполнено» по типу (план 0.2 §4 п.2): строка после trim не короче
 * `minLength ?? 1`, число/дата/булево заданы, `select` — код из вариантов,
 * `multiselect` и `material_ref` — непустой массив, `url` — валидный https.
 * Для `material_ref` учитывается и `evidence[key]`: привязанный материал —
 * тоже ответ.
 */
export function isAnswerFilled(
  q: FormQuestion,
  value: unknown,
  evidence?: readonly string[] | null,
): boolean {
  if (value === undefined || value === null) {
    return q.type === 'material_ref' && !!evidence?.length;
  }
  switch (q.type) {
    case 'text':
    case 'textarea':
      return typeof value === 'string' && value.trim().length >= (q.constraints?.minLength ?? 1);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'money':
      return typeof value === 'string' && MoneyAmountSchema.safeParse(value).success;
    case 'select':
      return typeof value === 'string' && (q.options ?? []).some((o) => o.code === value);
    case 'multiselect':
      return Array.isArray(value) && value.length > 0;
    case 'boolean':
      return typeof value === 'boolean';
    case 'url':
      return typeof value === 'string' && HttpsUrlSchema.safeParse(value).success;
    case 'date':
      return typeof value === 'string' && IsoDateOnlySchema.safeParse(value).success;
    case 'material_ref':
      return (Array.isArray(value) && value.length > 0) || !!evidence?.length;
  }
}
