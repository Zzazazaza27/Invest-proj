import { describe, expect, it } from 'vitest';
import {
  APPLICATION_FORM_V1,
  ApplicationPreviewSchema,
  buildApplicationPreview,
  type PreviewSource,
} from '../src/index';

/**
 * Инвесторское представление по правилам видимости (план 0.2 §2.11).
 * Проверяется критерий этапа 4.4: в сводке нет ни одного поля `private` /
 * `platform`, и из одних и тех же данных (черновик, снимок) получается одно
 * и то же представление.
 */

const form = APPLICATION_FORM_V1;
const params = { schemaVersion: 1, stage: 'idea' as const, locale: 'ru-RU' };

const source: PreviewSource = {
  core: {
    title: 'Раунд seed',
    stage: 'idea',
    businessType: 'saas',
    fundingScope: 'direction',
    fundingScopeNote: 'Запуск Taxi',
    investmentAsk: '3000000.00',
    askCurrency: 'RUB',
  },
  answers: {
    problem_statement: 'Владельцы сервисов теряют записи',
    stage_evidence: 'мы так считаем', // platform — инвестору не показывается
    ownership: 'Петров 55%', // private, на idea скрыт вовсе
    deal_terms: '15% за 17 млн', // investors
    customer_model: 'b2b',
    defensibility_types: ['ip', 'network_effects'],
    founded_year: 2025,
    paying_customers: 12, // на idea скрыт стадией
    website_url: 'https://example.com',
  },
  evidence: { problem_evidence: ['0192b6f1-8d6a-7c3e-9d1b-2f4a6c8e0a12'] },
  project: {
    title: 'Проект',
    tagline: 'Коротко',
    description: null,
    taxonomyId: null,
    geoCountry: 'RU',
    geoRegion: null,
  },
  round: {
    raising: 'open',
    investmentAsk: '3000000.00',
    askCurrency: 'RUB',
    fundingScope: 'project',
    fundingScopeNote: null,
  },
};

describe('Предпросмотр для анонимного посетителя', () => {
  it('содержит только public; investors считаются скрытыми; проекция раунда — как передана', () => {
    const investors = buildApplicationPreview(form, params, source);
    const view = buildApplicationPreview(form, { ...params, audience: 'public' }, source);
    expect(ApplicationPreviewSchema.safeParse(view).success).toBe(true);
    expect(view.audience).toBe('public');
    const keys = view.sections.flatMap((s) => s.questions.map((q) => q.key));
    expect(keys).toContain('stage');
    expect(keys).not.toContain('deal_terms'); // investors
    expect(view.withheld).toBeGreaterThan(investors.withheld);
    expect(view.round).toEqual(source.round);
    for (const q of view.sections.flatMap((s) => s.questions)) {
      expect(q.visibility).toBe('public');
    }
  });
});

describe('Предпросмотр для инвестора', () => {
  it('содержит только public / investors и только заполненное', () => {
    const view = buildApplicationPreview(form, params, source);
    expect(ApplicationPreviewSchema.safeParse(view).success).toBe(true);
    const keys = view.sections.flatMap((s) => s.questions.map((q) => q.key));
    expect(keys).toContain('problem_statement');
    expect(keys).toContain('deal_terms');
    expect(keys).toContain('stage');
    expect(keys).toContain('funding_scope_note');
    expect(keys).not.toContain('stage_evidence'); // platform
    expect(keys).not.toContain('ownership'); // private и скрыт на idea
    expect(keys).not.toContain('paying_customers'); // скрыт стадией
    expect(keys).not.toContain('current_alternatives'); // не заполнен
    expect(
      view.sections
        .flatMap((s) => s.questions)
        .every((q) => ['public', 'investors'].includes(q.visibility)),
    ).toBe(true);
    expect(view.withheld).toBe(1); // stage_evidence заполнен, но удержан
  });

  it('подписи вариантов и подтверждения читаются человеком', () => {
    const view = buildApplicationPreview(form, params, source);
    const q = (key: string) => view.sections.flatMap((s) => s.questions).find((x) => x.key === key);
    expect(q('customer_model')?.display).toBe('Компаниям');
    expect(q('defensibility_types')?.display).toBe('Патенты и права, Сетевой эффект');
    expect(q('stage')?.display).toBe('Идея');
    expect(q('founded_year')?.display).toBe('2025');
    expect(q('problem_statement')?.evidence).toEqual([]);
  });

  it('уточнение направления не показывается при «проекте в целом»', () => {
    const view = buildApplicationPreview(form, params, {
      ...source,
      core: { ...source.core, fundingScope: 'project' },
    });
    const keys = view.sections.flatMap((s) => s.questions.map((q) => q.key));
    expect(keys).not.toContain('funding_scope_note');
  });

  it('черновик и снимок с одними данными дают одно представление', () => {
    // Снимок хранит те же core / answers / evidence — представление то же.
    const fromDraft = buildApplicationPreview(form, params, source);
    const snapshot = JSON.parse(JSON.stringify(source)) as PreviewSource;
    const fromSnapshot = buildApplicationPreview(form, params, snapshot);
    expect(fromSnapshot).toEqual(fromDraft);
  });

  it('разделы без показанных ответов не выводятся, порядок — по форме', () => {
    const view = buildApplicationPreview(form, params, source);
    expect(view.sections.every((s) => s.questions.length > 0)).toBe(true);
    expect(view.sections.map((s) => s.key)).toEqual([
      'project',
      'problem',
      'competition',
      'funding',
    ]);
  });
});
