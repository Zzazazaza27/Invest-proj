import { describe, expect, it } from 'vitest';
import {
  buildAnalysisInput,
  renderApplicationText,
  type ProjectCard,
  type SubmittedSnapshot,
} from '../src/domain/analysis-input';

/**
 * Единый вход разбора (6.1).
 *
 * Проверяется не «функция собирает объект», а три обещания, которые она даёт
 * читателю отчёта: ответы идут с формулировками вопросов; поля, которых нет в
 * снимке, не выдумываются; источник каждого значения назван, и значения из
 * меняющейся карточки не выдаются за содержание поданной версии.
 */

const card: ProjectCard = {
  title: 'Карточка проекта',
  tagline: 'Подзаголовок карточки',
  description: 'Описание карточки',
  stage: 'idea',
  investmentAsk: '5000000',
  askCurrency: 'RUB',
  taxonomy: 'Финтех',
  geoCountry: 'RU',
};

const snapshot: SubmittedSnapshot = {
  core: {
    title: 'Заявка из снимка',
    stage: 'mvp',
    businessType: 'b2b',
    fundingScope: 'project',
    fundingScopeNote: null,
    investmentAsk: '12000000',
    askCurrency: 'RUB',
  },
  project: { geoCountry: 'KZ', tagline: 'подзаголовок снимка', description: null },
  applicableKeys: {
    problem_statement: 'required',
    use_of_funds: 'required',
    runway_current_months: 'recommended',
    empty_answer: 'recommended',
  },
  answers: {
    problem_statement: '  Клиенты теряют время на сверку документов  ',
    use_of_funds: ['разработка 60%', 'маркетинг 40%'],
    runway_current_months: 7,
    empty_answer: '   ',
  },
  form: {
    sections: [
      {
        title: 'Проблема',
        questions: [{ key: 'problem_statement', title: 'Какую проблему решаете?' }],
      },
      {
        title: 'Деньги',
        questions: [
          { key: 'use_of_funds', title: 'На что пойдут инвестиции?' },
          { key: 'runway_current_months', title: 'На сколько месяцев хватит средств?' },
          { key: 'empty_answer', title: 'Вопрос без ответа' },
        ],
      },
    ],
  },
};

describe('вход разбора: ответы с формулировками', () => {
  it('ответы идут вместе с вопросами и разделами', () => {
    const input = buildAnalysisInput({ snapshot, versionId: VERSION, versionNo: 3, card });

    expect(input.includesAnswers).toBe(true);
    expect(input.answers.map((a) => a.key)).toEqual([
      'problem_statement',
      'use_of_funds',
      'runway_current_months',
    ]);
    const problem = input.answers[0]!;
    expect(problem.question).toBe('Какую проблему решаете?');
    expect(problem.section).toBe('Проблема');
    // Пробелы по краям срезаны, содержание не тронуто.
    expect(problem.text).toBe('Клиенты теряют время на сверку документов');
  });

  it('пустой ответ в разбор не попадает', () => {
    const input = buildAnalysisInput({ snapshot, versionId: VERSION, versionNo: 3, card });
    expect(input.answers.some((a) => a.key === 'empty_answer')).toBe(false);
  });

  it('список и число сводятся к тексту без выдумывания', () => {
    const input = buildAnalysisInput({ snapshot, versionId: VERSION, versionNo: 3, card });
    expect(input.metadata.useOfFunds).toBe('разработка 60%; маркетинг 40%');
    expect(input.metadata.runwayCurrentMonths).toBe('7');
  });

  it('текст заявки содержит и вопрос, и ответ, и раздел', () => {
    const text = renderApplicationText([
      { key: 'a', question: 'Вопрос A?', section: 'Раздел', text: 'Ответ A' },
      { key: 'b', question: 'Вопрос B?', section: 'Раздел', text: 'Ответ B' },
    ]);
    expect(text).toContain('## Раздел');
    expect(text).toContain('Вопрос A?\nОтвет A');
    expect(text).toContain('Вопрос B?\nОтвет B');
  });
});

describe('вход разбора: источник каждого поля', () => {
  it('снимок побеждает карточку, и это записано', () => {
    const input = buildAnalysisInput({ snapshot, versionId: VERSION, versionNo: 3, card });

    expect(input.title).toBe('Заявка из снимка');
    expect(input.stage).toBe('mvp');
    expect(input.metadata.investmentAsk).toBe('12000000');
    expect(input.metadata.geoCountry).toBe('KZ');
    expect(input.sources.title).toBe('version');
    expect(input.sources.investmentAsk).toBe('version');
    expect(input.sources.geoCountry).toBe('version');
  });

  it('значение из карточки помечено как взятое из карточки', () => {
    const input = buildAnalysisInput({ snapshot, versionId: VERSION, versionNo: 3, card });
    // Отрасли в снимке нет — только идентификатор таксономии.
    expect(input.metadata.taxonomy).toBe('Финтех');
    expect(input.sources.taxonomy).toBe('card');
  });

  it('поле без источника остаётся пустым и помечено absent', () => {
    const input = buildAnalysisInput({ snapshot, versionId: VERSION, versionNo: 3, card });
    expect(input.metadata.launchCountry).toBeNull();
    expect(input.sources.launchCountry).toBe('absent');
  });
});

describe('вход разбора: заявка не подана', () => {
  it('без снимка ответов нет, версия не указывается, источник — карточка', () => {
    const input = buildAnalysisInput({ snapshot: null, versionId: null, versionNo: null, card });

    expect(input.includesAnswers).toBe(false);
    expect(input.versionId).toBeNull();
    expect(input.versionNo).toBeNull();
    expect(input.answers).toEqual([]);
    expect(input.summary).toContain('Подзаголовок карточки');
    expect(input.sources.summary).toBe('card');
    expect(input.sources.title).toBe('card');
  });

  it('снимок без единого заполненного ответа считается отсутствием ответов', () => {
    const empty: SubmittedSnapshot = {
      ...snapshot,
      answers: { problem_statement: '   ', use_of_funds: null },
      applicableKeys: { problem_statement: 'required', use_of_funds: 'required' },
    };
    const input = buildAnalysisInput({ snapshot: empty, versionId: VERSION, versionNo: 4, card });
    expect(input.includesAnswers).toBe(false);
    // Версия не проставляется: отчёт по пустым ответам не является отчётом по
    // версии заявки.
    expect(input.versionNo).toBeNull();
  });
});

const VERSION = '01920000-0000-7000-8000-000000000001';
