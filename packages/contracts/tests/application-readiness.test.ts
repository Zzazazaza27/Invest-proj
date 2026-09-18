import { describe, expect, it } from 'vitest';
import {
  APPLICATION_FORM_V1,
  applicableQuestions,
  computeCompleteness,
  computeRoundReadiness,
  defaultReadinessConfig,
  legacyFormConfig,
  type ApplicationFormConfig,
  type ReadinessConfig,
  type ReadinessInput,
} from '../src/index';

/**
 * Готовность заявки (план 0.2 §4): чистая формула на стартовой конфигурации.
 * Свойства, которые обещает план: неприменимое не снижает процент; при смене
 * стадии набор меняется, а ответы не теряются; веса нормализуются;
 * результат детерминирован; подача — только при заполненных обязательных.
 */

const form: ApplicationFormConfig = APPLICATION_FORM_V1;
const weights: ReadinessConfig = defaultReadinessConfig(form);
const meta = { schemaVersion: 1, readinessConfigVersion: 1 };

const empty: ReadinessInput = {
  stage: 'idea',
  businessType: null,
  fundingScope: 'project',
  fundingScopeNote: null,
  investmentAsk: null,
  answers: {},
  evidence: {},
};

/** Заполняет все вопросы стадии с указанными состояниями правдоподобными значениями. */
function fillFor(
  stage: ReadinessInput['stage'],
  levels: readonly ('mandatory' | 'recommended')[],
): ReadinessInput['answers'] {
  const answers: Record<string, unknown> = {};
  for (const [key, level] of applicableQuestions(form, stage)) {
    if (!levels.includes(level)) continue;
    const q = form.questions.find((x) => x.key === key)!;
    if (q.coreField) continue;
    switch (q.type) {
      case 'text':
      case 'textarea':
        answers[key] = 'ответ';
        break;
      case 'number':
        answers[key] = q.constraints?.min ?? 1;
        break;
      case 'money':
        answers[key] = '100.00';
        break;
      case 'select':
        answers[key] = q.options![0]!.code;
        break;
      case 'multiselect':
        answers[key] = [q.options![0]!.code];
        break;
      case 'boolean':
        answers[key] = true;
        break;
      case 'url':
        answers[key] = 'https://example.com';
        break;
      case 'date':
        answers[key] = '2026-01-01';
        break;
      case 'material_ref':
        answers[key] = ['0192b6f1-8d6a-7c3e-9d1b-2f4a6c8e0a12'];
        break;
    }
  }
  return answers;
}

describe('Готовность: обязательное и подача', () => {
  it('пустой черновик на idea: 0%, подача закрыта, перечислены обязательные', () => {
    const r = computeCompleteness(form, weights, empty, meta);
    // Стадия и предмет финансирования заполнены всегда — несколько процентов
    // у пустого черновика есть; остальное — нули.
    expect(r.percent).toBeLessThan(10);
    expect(r.canSubmit).toBe(false);
    // stage заполнена всегда; раздел раунда (сумма, use of funds, milestones)
    // в полноте профиля не участвует с 5.6.3.
    expect(r.missingMandatory).toEqual([
      'problem_statement',
      'current_alternatives',
      'problem_evidence',
      'customer_user',
      'solution_summary',
      'competitors_direct',
      'founders',
      'domain_expertise',
    ]);
    // Нетронутый раздел — «не начат», а не «требует внимания»: оранжевая метка
    // появляется только у начатого раздела с незаполненными обязательными.
    expect(r.sections.find((s) => s.key === 'problem')?.status).toBe('not_started');
    expect(r.sections.find((s) => s.key === 'market')?.status).toBe('not_started');
    const started = computeCompleteness(
      form,
      weights,
      { ...empty, answers: { problem_statement: 'есть' } },
      meta,
    );
    expect(started.sections.find((s) => s.key === 'problem')?.status).toBe('attention');
  });

  it('заполненные обязательные открывают подачу до 100%', () => {
    const r = computeCompleteness(
      form,
      weights,
      { ...empty, investmentAsk: '1000000.00', answers: fillFor('idea', ['mandatory']) },
      meta,
    );
    expect(r.canSubmit).toBe(true);
    expect(r.missingMandatory).toEqual([]);
    // Обязательных мало и они сосредоточены в нескольких разделах, а веса
    // разделов равны: подача открыта задолго до высокого процента.
    expect(r.percent).toBeGreaterThan(10);
    expect(r.percent).toBeLessThan(50);
    expect(r.sections.find((s) => s.key === 'risks')?.status).toBe('not_started');
  });

  it('всё применимое заполнено — 100%', () => {
    const r = computeCompleteness(
      form,
      weights,
      {
        ...empty,
        businessType: 'saas',
        investmentAsk: '1000000.00',
        answers: fillFor('idea', ['mandatory', 'recommended']),
      },
      meta,
    );
    expect(r.percent).toBe(100);
    expect(r.sections.every((s) => s.status === 'complete')).toBe(true);
  });

  it('раздел раунда не участвует в полноте профиля (5.6.3)', () => {
    const r = computeCompleteness(
      form,
      weights,
      {
        ...empty,
        fundingScope: null,
        investmentAsk: null,
        answers: fillFor('idea', ['mandatory']),
      },
      meta,
    );
    expect(r.missingMandatory).toEqual([]);
    expect(r.sections.some((s) => s.key === 'funding')).toBe(false);
    expect(r.canSubmit).toBe(true);
  });

  it('готовность раунда — отдельно: сумма, валюта, предмет, обязательные вопросы раунда', () => {
    const none = computeRoundReadiness(form, 'idea', {
      fundingScope: null,
      fundingScopeNote: null,
      target: null,
      currency: null,
      answers: {},
      evidence: {},
    });
    expect(none.canOpen).toBe(false);
    expect(none.missing.map((m) => m.path)).toEqual(
      expect.arrayContaining([
        'target',
        'currency',
        'fundingScope',
        'answers.use_of_funds',
        'answers.milestones',
      ]),
    );
    const direction = computeRoundReadiness(form, 'idea', {
      fundingScope: 'direction',
      fundingScopeNote: null,
      target: '3000000.00',
      currency: 'RUB',
      answers: { use_of_funds: 'маркетинг', milestones: '50 клиентов' },
      evidence: {},
    });
    expect(direction.missing.map((m) => m.path)).toEqual(['fundingScopeNote']);
    const ready = computeRoundReadiness(form, 'idea', {
      fundingScope: 'project',
      fundingScopeNote: null,
      target: '3000000.00',
      currency: 'RUB',
      answers: { use_of_funds: 'маркетинг', milestones: '50 клиентов' },
      evidence: {},
    });
    expect(ready.canOpen).toBe(true);
    expect(ready.percent).toBeGreaterThan(0);
    expect(ready.percent).toBeLessThan(100);
  });
});

describe('Готовность: применимость и веса', () => {
  it('скрытые для стадии вопросы не снижают процент и не требуются', () => {
    const answers = fillFor('idea', ['mandatory', 'recommended']);
    const withHidden = { ...answers, mrr: '100.00', paying_customers: 3 };
    const full = { ...empty, businessType: 'saas', investmentAsk: '1.00' };
    const a = computeCompleteness(form, weights, { ...full, answers }, meta);
    const b = computeCompleteness(form, weights, { ...full, answers: withHidden }, meta);
    expect(a.percent).toBe(100);
    expect(b.percent).toBe(100);
  });

  it('при смене стадии набор меняется, введённые ответы не теряются', () => {
    const answers = fillFor('idea', ['mandatory', 'recommended']);
    const idea = computeCompleteness(
      form,
      weights,
      { ...empty, investmentAsk: '1.00', answers },
      meta,
    );
    const growth = computeCompleteness(
      form,
      weights,
      { ...empty, stage: 'growth', investmentAsk: '1.00', answers },
      meta,
    );
    expect(idea.canSubmit).toBe(true);
    expect(growth.canSubmit).toBe(false);
    expect(growth.missingMandatory).toContain('paying_customers');
    expect(growth.percent).toBeLessThan(idea.percent);
    // Ответ на idea-вопрос сохранился и по-прежнему засчитан на growth.
    expect(growth.sections.find((s) => s.key === 'problem')?.filled).toBeGreaterThan(0);
  });

  it('веса нормализуются: все по 5 — то же, что все по 1; вес 0 исключает раздел', () => {
    const input = { ...empty, investmentAsk: '1.00', answers: fillFor('idea', ['mandatory']) };
    const fives: ReadinessConfig = {
      sections: Object.fromEntries(form.sections.map((s) => [s.key, { weight: 5 }])),
      levelPoints: weights.levelPoints,
    };
    expect(computeCompleteness(form, fives, input, meta).percent).toBe(
      computeCompleteness(form, weights, input, meta).percent,
    );
    const onlyProblem: ReadinessConfig = {
      sections: { problem: { weight: 1 } },
      levelPoints: weights.levelPoints,
    };
    // Раздел без веса считается с весом 1 — ещё не «только problem».
    expect(computeCompleteness(form, onlyProblem, input, meta).percent).toBe(
      computeCompleteness(form, weights, input, meta).percent,
    );
    const zeroRest: ReadinessConfig = {
      sections: Object.fromEntries(
        form.sections.map((s) => [s.key, { weight: s.key === 'problem' ? 1 : 0 }]),
      ),
      levelPoints: weights.levelPoints,
    };
    const r = computeCompleteness(form, zeroRest, input, meta);
    expect(r.percent).toBeLessThan(100); // в problem есть рекомендуемые незаполненные
    expect(r.sections.length).toBeGreaterThan(1); // разделы в списке остаются
  });

  it('результат не зависит от порядка ключей в ответах', () => {
    const answers = fillFor('mvp', ['mandatory', 'recommended']);
    const reversed = Object.fromEntries(Object.entries(answers).reverse());
    const a = computeCompleteness(
      form,
      weights,
      { ...empty, stage: 'mvp', investmentAsk: '1.00', answers },
      meta,
    );
    const b = computeCompleteness(
      form,
      weights,
      { ...empty, stage: 'mvp', investmentAsk: '1.00', answers: reversed },
      meta,
    );
    expect(b).toEqual(a);
  });

  it('подтверждение засчитывает материал-вопрос без значения', () => {
    const answers = fillFor('idea', ['mandatory', 'recommended']);
    delete answers.demo;
    const full = { ...empty, businessType: 'saas', investmentAsk: '1.00' };
    const without = computeCompleteness(form, weights, { ...full, answers }, meta);
    const withEvidence = computeCompleteness(
      form,
      weights,
      { ...full, answers, evidence: { demo: ['0192b6f1-8d6a-7c3e-9d1b-2f4a6c8e0a12'] } },
      meta,
    );
    expect(without.percent).toBeLessThan(100);
    expect(withEvidence.percent).toBe(100);
  });

  it('схема 0: только системные поля; сумма — у раунда, подача профиля открыта', () => {
    const legacy = legacyFormConfig();
    const r = computeCompleteness(
      legacy,
      defaultReadinessConfig(legacy),
      { ...empty, stage: 'mvp' },
      { schemaVersion: 0, readinessConfigVersion: null },
    );
    expect(r.missingMandatory).toEqual([]);
    expect(r.canSubmit).toBe(true);
    expect(r.sections.some((s) => s.key === 'funding')).toBe(false);
  });
});
