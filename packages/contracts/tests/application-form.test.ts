import { describe, expect, it } from 'vitest';
import {
  APPLICATION_FORM_V1,
  ApplicationFormConfigSchema,
  ApplicationFormViewSchema,
  FORM_CORE_FIELDS,
  applicableQuestions,
  buildAnswersSchema,
  buildStageForm,
  checkAgainstPublished,
  collectPublishedKeys,
  isAnswerFilled,
  validateFormConfig,
  type ApplicationFormConfig,
  type FormQuestion,
} from '../src/index';

/** Глубокая копия стартовой конфигурации — тесты её мутируют. */
const clone = (): ApplicationFormConfig => JSON.parse(JSON.stringify(APPLICATION_FORM_V1));
const question = (config: ApplicationFormConfig, key: string): FormQuestion => {
  const q = config.questions.find((x) => x.key === key);
  if (!q) throw new Error(`нет вопроса ${key}`);
  return q;
};

describe('Стартовая конфигурация v1 (каталог версии 2)', () => {
  it('проходит схему документа и структурные правила', () => {
    const parsed = ApplicationFormConfigSchema.safeParse(APPLICATION_FORM_V1);
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 1)).toBe(true);
    expect(validateFormConfig(APPLICATION_FORM_V1)).toEqual([]);
  });

  it('14 разделов и 91 вопрос с уникальными ключами, 5 системных', () => {
    expect(APPLICATION_FORM_V1.sections).toHaveLength(14);
    expect(APPLICATION_FORM_V1.questions).toHaveLength(91);
    const keys = APPLICATION_FORM_V1.questions.map((q) => q.key);
    expect(new Set(keys).size).toBe(keys.length);
    const core = APPLICATION_FORM_V1.questions.filter((q) => q.coreField).map((q) => q.key);
    expect(core.sort()).toEqual([...FORM_CORE_FIELDS].sort());
  });

  it('набор применимого по стадиям совпадает с каталогом §15', () => {
    // Числа — из сводки §15 каталога (считаются скриптом по таблицам).
    const expected = {
      idea: { shown: 67, mandatory: 14 },
      mvp: { shown: 75, mandatory: 18 },
      early_revenue: { shown: 83, mandatory: 20 },
      growth: { shown: 82, mandatory: 25 },
    } as const;
    for (const [stage, e] of Object.entries(expected)) {
      const map = applicableQuestions(APPLICATION_FORM_V1, stage as keyof typeof expected);
      expect(map.size, stage).toBe(e.shown);
      expect([...map.values()].filter((l) => l === 'mandatory').length, stage).toBe(e.mandatory);
    }
  });

  it('обязательные на idea — десять смысловых плюс системные', () => {
    const mandatory = [...applicableQuestions(APPLICATION_FORM_V1, 'idea')]
      .filter(([, level]) => level === 'mandatory')
      .map(([key]) => key);
    expect(mandatory).toEqual([
      'stage',
      'problem_statement',
      'current_alternatives',
      'problem_evidence',
      'customer_user',
      'solution_summary',
      'competitors_direct',
      'founders',
      'domain_expertise',
      'funding_scope',
      'funding_scope_note',
      'investment_ask',
      'use_of_funds',
      'milestones',
    ]);
  });

  it('типоспецифичные вопросы скрыты во всех стадиях, но остаются в банке', () => {
    for (const key of ['mrr', 'gmv_monthly', 'acv', 'take_rate', 'trl_level', 'unit_cost']) {
      const q = question(APPLICATION_FORM_V1, key);
      expect(
        Object.values(q.stages).every((s) => s === 'hidden'),
        key,
      ).toBe(true);
    }
    for (const stage of ['idea', 'mvp', 'early_revenue', 'growth'] as const) {
      expect(applicableQuestions(APPLICATION_FORM_V1, stage).has('mrr')).toBe(false);
    }
  });

  it('варианты системных полей — коды из контрактов, подписи на русском', () => {
    const stage = question(APPLICATION_FORM_V1, 'stage');
    expect(stage.options?.map((o) => o.code)).toEqual(['idea', 'mvp', 'early_revenue', 'growth']);
    expect(stage.options?.[2]?.texts['ru-RU']?.label).toBe('Первые продажи');
    const bt = question(APPLICATION_FORM_V1, 'business_type');
    expect(bt.options?.map((o) => o.code)).toContain('hardware_deeptech');
    expect(bt.stages.idea).toBe('recommended');
  });
});

describe('Структурные правила документа', () => {
  it('состояния stage / investment_ask / funding_scope зафиксированы как mandatory', () => {
    for (const key of ['stage', 'investment_ask', 'funding_scope']) {
      const config = clone();
      question(config, key).stages.growth = 'hidden';
      const issues = validateFormConfig(config);
      expect(
        issues.some((i) => i.path === `questions.${key}.stages.growth`),
        key,
      ).toBe(true);
      expect(ApplicationFormConfigSchema.safeParse(config).success).toBe(false);
    }
  });

  it('business_type можно скрыть — его состояние не зафиксировано', () => {
    const config = clone();
    question(config, 'business_type').stages.idea = 'hidden';
    expect(validateFormConfig(config)).toEqual([]);
  });

  it('системный вопрос нельзя убрать, архивировать или сменить ему тип', () => {
    const removed = clone();
    removed.questions = removed.questions.filter((q) => q.key !== 'investment_ask');
    expect(validateFormConfig(removed).map((i) => i.path)).toContain('questions.investment_ask');

    const archived = clone();
    question(archived, 'stage').archivedAt = '2026-09-15T00:00:00.000Z';
    expect(validateFormConfig(archived).map((i) => i.path)).toContain('questions.stage.archivedAt');

    const retyped = clone();
    question(retyped, 'investment_ask').type = 'textarea';
    expect(validateFormConfig(retyped).map((i) => i.path)).toContain(
      'questions.investment_ask.type',
    );
  });

  it('ловит дубли ключей, неизвестный раздел и select без вариантов', () => {
    const config = clone();
    const q = question(config, 'why_now');
    config.questions.push({ ...q });
    question(config, 'market_size').section = 'nowhere';
    question(config, 'round_type').options = [];
    const paths = validateFormConfig(config).map((i) => i.path);
    expect(paths).toContain('questions.why_now');
    expect(paths).toContain('questions.market_size.section');
    expect(paths).toContain('questions.round_type.options');
  });

  it('у неархивного вопроса должна быть формулировка на языке по умолчанию', () => {
    const config = clone();
    question(config, 'why_now').texts['ru-RU'] = { help_md: 'только подсказка' };
    expect(validateFormConfig(config).map((i) => i.path)).toContain(
      'questions.why_now.texts.ru-RU.label',
    );
    question(config, 'why_now').archivedAt = '2026-09-15T00:00:00.000Z';
    expect(validateFormConfig(config)).toEqual([]);
  });
});

describe('Правила эволюции между версиями', () => {
  const published = collectPublishedKeys([APPLICATION_FORM_V1]);

  it('опубликованный ключ нельзя удалить — только архивировать', () => {
    const next = clone();
    next.questions = next.questions.filter((q) => q.key !== 'why_now');
    expect(checkAgainstPublished(next, published).map((i) => i.path)).toEqual([
      'questions.why_now',
    ]);

    const archived = clone();
    question(archived, 'why_now').archivedAt = '2026-09-15T00:00:00.000Z';
    expect(checkAgainstPublished(archived, published)).toEqual([]);
    expect(applicableQuestions(archived, 'idea').has('why_now')).toBe(false);
  });

  it('тип опубликованного ключа нельзя менять', () => {
    const next = clone();
    question(next, 'founded_year').type = 'text';
    expect(checkAgainstPublished(next, published).map((i) => i.path)).toEqual([
      'questions.founded_year.type',
    ]);
  });

  it('новый ключ с новым типом допустим', () => {
    const next = clone();
    next.questions.push({
      key: 'new_question',
      section: 'market',
      order: 99,
      type: 'boolean',
      stages: { idea: 'recommended', mvp: 'hidden', early_revenue: 'hidden', growth: 'hidden' },
      visibility: 'investors',
      texts: { 'ru-RU': { label: 'Новый вопрос?' } },
    });
    expect(validateFormConfig(next)).toEqual([]);
    expect(checkAgainstPublished(next, published)).toEqual([]);
  });
});

describe('Форма для стадии', () => {
  it('скрытое не показывается, разделы в порядке, тексты на месте', () => {
    const view = buildStageForm(APPLICATION_FORM_V1, {
      schemaVersion: 1,
      stage: 'idea',
      locale: 'ru-RU',
    });
    expect(ApplicationFormViewSchema.safeParse(view).success).toBe(true);
    expect(view.sections.map((s) => s.key)).toEqual([
      'project',
      'problem',
      'solution',
      'traction',
      'market',
      'competition',
      'business_model',
      'team',
      'execution',
      'economics',
      'funding',
      'risks',
      'legal',
      'materials',
    ]);
    const keys = view.sections.flatMap((s) => s.questions.map((q) => q.key));
    expect(keys).toContain('problem_statement');
    expect(keys).not.toContain('paying_customers');
    expect(keys).not.toContain('mrr');
    expect(view.missing).toEqual([]);
    const first = view.sections[1]!.questions[0]!;
    expect(first.key).toBe('problem_statement');
    expect(first.state).toBe('mandatory');
    expect(first.label).toBe('Какую проблему вы решаете?');
    expect(first.helpMd).toContain('Без упоминания вашего продукта');
    expect(first.exampleWeakMd).toContain('удобного приложения');
  });

  it('early_revenue видит и требует платящих клиентов', () => {
    const view = buildStageForm(APPLICATION_FORM_V1, {
      schemaVersion: 1,
      stage: 'early_revenue',
      locale: 'ru-RU',
    });
    const q = view.sections.flatMap((s) => s.questions).find((x) => x.key === 'paying_customers');
    expect(q?.state).toBe('mandatory');
  });

  it('для языка без переводов берётся запасной текст, а пропуски перечислены', () => {
    const view = buildStageForm(APPLICATION_FORM_V1, {
      schemaVersion: 1,
      stage: 'idea',
      locale: 'en-US',
    });
    expect(view.sections[0]!.title).toBe('Проект');
    expect(view.missing).toContain('section.project.title');
    expect(view.missing).toContain('question.problem_statement.label');
    expect(view.missing).toContain('option.stage.idea.label');
  });

  it('раздел без видимых вопросов не показывается', () => {
    const config = clone();
    for (const q of config.questions) {
      if (q.section === 'materials') q.stages.idea = 'hidden';
    }
    const view = buildStageForm(config, { schemaVersion: 1, stage: 'idea', locale: 'ru-RU' });
    expect(view.sections.map((s) => s.key)).not.toContain('materials');
  });
});

describe('Ответы', () => {
  const schema = buildAnswersSchema(APPLICATION_FORM_V1);

  it('пустой черновик проходит, значения проверяются по типам', () => {
    expect(schema.safeParse({}).success).toBe(true);
    expect(
      schema.safeParse({
        problem_statement: 'Владельцы сервисов теряют записи',
        founded_year: 2025,
        customer_model: 'b2b',
        defensibility_types: ['ip', 'proprietary_data'],
        website_url: 'https://example.com',
        monthly_burn: '150000.00',
        demo: ['0192b6f1-8d6a-7c3e-9d1b-2f4a6c8e0a12'],
        why_now: null,
      }).success,
    ).toBe(true);
  });

  it('отвергает неверный тип, чужой код, http-ссылку и ключ вне документа', () => {
    expect(schema.safeParse({ founded_year: '2025' }).success).toBe(false);
    expect(schema.safeParse({ founded_year: 1800 }).success).toBe(false);
    expect(schema.safeParse({ customer_model: 'b2x' }).success).toBe(false);
    expect(schema.safeParse({ website_url: 'http://example.com' }).success).toBe(false);
    expect(schema.safeParse({ gross_margin: 140 }).success).toBe(false);
    expect(schema.safeParse({ unknown_key: 'x' }).success).toBe(false);
  });

  it('системные поля в answers не принимаются — они колонки', () => {
    expect(schema.safeParse({ investment_ask: '100' }).success).toBe(false);
    expect(schema.safeParse({ stage: 'idea' }).success).toBe(false);
  });

  it('«заполнено» по типу', () => {
    const q = (key: string) => question(APPLICATION_FORM_V1, key);
    expect(isAnswerFilled(q('problem_statement'), '   ')).toBe(false);
    expect(isAnswerFilled(q('problem_statement'), 'есть')).toBe(true);
    expect(isAnswerFilled(q('founded_year'), 0)).toBe(true);
    expect(isAnswerFilled(q('founded_year'), Number.NaN)).toBe(false);
    expect(isAnswerFilled(q('customer_model'), 'b2b')).toBe(true);
    expect(isAnswerFilled(q('customer_model'), 'nope')).toBe(false);
    expect(isAnswerFilled(q('defensibility_types'), [])).toBe(false);
    expect(isAnswerFilled(q('website_url'), 'http://x')).toBe(false);
    expect(isAnswerFilled(q('demo'), null, ['0192b6f1-8d6a-7c3e-9d1b-2f4a6c8e0a12'])).toBe(true);
    expect(isAnswerFilled(q('demo'), null, [])).toBe(false);
  });
});
